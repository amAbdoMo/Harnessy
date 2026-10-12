/** Live-only rendezvous state; admission precedes key parsing and no endpoint plaintext is interpreted. */
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  createRelayChallenge, derivePcId, encodeBase64Url, parseHttpsOrigin, verifyRelayChallenge,
} from '@deepseek-ai/dsh-companion-protocol'
import type {
  ChannelId, PcId, RelayChallenge, Role, SocketGeneration,
} from '@deepseek-ai/dsh-companion-protocol'
import type { Config } from './config.ts'
import { parseOperation, parseRegistration } from './wire.ts'
import type { DataFrame } from './wire.ts'

interface Rate {
  tokens: number
  updated: number
}
interface Counts {
  connections: number
  pending: number
  pc: number
  phone: number
}
interface IpBucket extends Counts {
  readonly bytes: Rate
  readonly upgrades: Rate
  touched: number
}
type Phase =
  | { readonly kind: 'register' }
  | { readonly kind: 'proof'; readonly challenge: RelayChallenge; readonly expires: number }
  | { readonly kind: 'pc'; readonly challenge: RelayChallenge; readonly channels: Map<ChannelId, Channel> }
  | { readonly kind: 'phone'; readonly challenge: RelayChallenge; readonly pc: Connection; channel?: Channel }
interface Connection {
  readonly ws: WebSocket
  readonly role: Role
  readonly generation: SocketGeneration
  readonly ip: IpBucket
  readonly born: number
  readonly bytes: Rate
  readonly closed: Promise<void>
  readonly settleClosed: () => void
  phase: Phase
  lastActivity: number
  queued: number
  stopping: boolean
  ended: boolean
  readonly listeners: {
    message: (data: RawData, binary: boolean) => void
    close: () => void
    error: (error: Error) => void
    ping: () => void
    pong: () => void
  }
}
interface Channel {
  readonly id: ChannelId
  readonly pc: Connection
  readonly phone: Connection
  readonly born: number
  established: boolean
  phoneToPcQueued: number
  pcToPhoneQueued: number
}

const emptyCounts = (): Counts => ({ connections: 0, pending: 0, pc: 0, phone: 0 })
const rate = (capacity: number, now: number): Rate => ({ tokens: capacity, updated: now })

function take(bucket: Rate, capacity: number, interval: number, amount: number, now: number): boolean {
  bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.updated) * capacity / interval)
  bucket.updated = now
  if (amount > bucket.tokens) return false
  bucket.tokens -= amount
  return true
}

function dataBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

function oneHeader(req: IncomingMessage, key: string): string | undefined {
  let count = 0
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === key) count++
  }
  if (count > 1) throw new Error('Duplicate security header')
  const value = req.headers[key]
  if (Array.isArray(value)) throw new Error('Repeated security header')
  return value
}

/** Bounded, connection-incarnation-owned relay; dispose awaits every upgraded socket close. */
export class Relay {
  private readonly server: WebSocketServer
  private readonly counts = emptyCounts()
  private readonly ips = new Map<string, IpBucket>()
  private readonly sockets = new Set<Connection>()
  private readonly upgrading = new Map<Duplex, Promise<void>>()
  private readonly pcs = new Map<PcId, Connection>()
  private readonly bytes: Rate
  private readonly upgrades: Rate
  private readonly origin: ReturnType<typeof parseHttpsOrigin>
  private readonly host: string
  private readonly timer: ReturnType<typeof setInterval>
  private active = true

  constructor(private readonly config: Config) {
    this.origin = parseHttpsOrigin(config.httpsOrigin)
    this.host = new URL(this.origin).host
    const now = performance.now()
    this.bytes = rate(config.bytesPerSecond, now)
    this.upgrades = rate(config.upgradesPerWindow, now)
    this.server = new WebSocketServer({
      noServer: true, clientTracking: false, perMessageDeflate: false,
      maxPayload: config.maxFrameBytes, autoPong: false,
    })
    this.timer = setInterval(() => { this.sweep() }, config.sweepIntervalMs)
    this.timer.unref()
  }

  /**
   * Admit one exact upgrade request; forwarded source and origin headers confer no authority.
   * @param role - Role determined by the registered route, not request JSON.
   * @param req - Reverse-proxy HTTP request retaining the public Host.
   * @param socket - Transport owned after admission.
   * @param head - Upgrade bytes supplied by webServer.
   */
  upgrade(role: Role, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const now = performance.now()
    let ip: IpBucket | undefined
    try {
      if (!this.active || !req.socket.remoteAddress) throw new Error('Relay unavailable')
      ip = this.ips.get(req.socket.remoteAddress)
      if (!ip) {
        if (this.ips.size >= this.config.maxIpBuckets) throw new Error('IP budget exhausted')
        ip = {
          ...emptyCounts(), bytes: rate(this.config.bytesPerSecondPerIp, now),
          upgrades: rate(this.config.upgradesPerWindowPerIp, now), touched: now,
        }
        this.ips.set(req.socket.remoteAddress, ip)
      }
      ip.touched = now
      if (!take(this.upgrades, this.config.upgradesPerWindow, this.config.upgradeWindowMs, 1, now)
        || !take(ip.upgrades, this.config.upgradesPerWindowPerIp, this.config.upgradeWindowMs, 1, now)) {
        throw new Error('Upgrade rate exhausted')
      }
      const origin = oneHeader(req, 'origin')
      if (oneHeader(req, 'host') !== this.host || (origin !== undefined && origin !== this.origin)
        || req.url !== `/companion/${role}` || req.method !== 'GET' || head.length > this.config.maxFrameBytes) {
        throw new Error('Invalid upgrade authority or path')
      }
      const limit = role === 'pc' ? this.config.maxRoutes : this.config.maxPhones
      const ipLimit = role === 'pc' ? this.config.maxRoutesPerIp : this.config.maxPhonesPerIp
      if (this.counts.connections >= this.config.maxConnections || ip.connections >= this.config.maxConnectionsPerIp
        || this.counts.pending >= this.config.maxPending || ip.pending >= this.config.maxPendingPerIp
        || this.counts[role] >= limit || ip[role] >= ipLimit) throw new Error('Admission budget exhausted')
      this.reserve(role, ip)
      const admittedIp = ip
      let accepted = false
      const releaseFailed = (): void => {
        if (accepted) return
        accepted = true
        this.release(role, admittedIp, true)
      }
      let settleUpgradeClosed = (): void => {}
      const upgradeClosed = new Promise<void>((resolve) => { settleUpgradeClosed = resolve })
      const onUpgradeClose = (): void => {
        releaseFailed()
        this.upgrading.delete(socket)
        settleUpgradeClosed()
      }
      this.upgrading.set(socket, upgradeClosed)
      socket.once('close', onUpgradeClose)
      try {
        this.server.handleUpgrade(req, socket, head, (ws) => {
          accepted = true
          socket.off('close', onUpgradeClose)
          this.upgrading.delete(socket)
          settleUpgradeClosed()
          this.connect(ws, role, admittedIp, now)
        })
      } catch (error) {
        releaseFailed()
        throw error
      }
    } catch (_error) {
      // Rejection destroys the transport without reflecting identity or admission diagnostics.
      socket.destroy()
    }
  }

  private reserve(role: Role, ip: IpBucket): void {
    for (const count of [this.counts, ip]) {
      count.connections++
      count.pending++
      count[role]++
    }
  }

  private release(role: Role, ip: IpBucket, pending: boolean): void {
    for (const count of [this.counts, ip]) {
      count.connections--
      if (pending) count.pending--
      count[role]--
    }
    ip.touched = performance.now()
  }

  private connect(ws: WebSocket, role: Role, ip: IpBucket, now: number): void {
    let settleClosed = (): void => {}
    const closed = new Promise<void>((resolve) => { settleClosed = resolve })
    const connection: Connection = {
      ws, role, ip, born: now, lastActivity: now, phase: { kind: 'register' },
      generation: brandString<SocketGeneration>(encodeBase64Url(randomBytes(32))),
      bytes: rate(this.config.bytesPerSecondPerSocket, now), queued: 0, stopping: false, ended: false,
      closed, settleClosed,
      listeners: {
        message: (data, binary) => {
          if (connection.stopping || !this.active) return
          try { this.receive(connection, data, binary) } catch (_error) { this.stop(connection) }
        },
        close: () => { this.finished(connection) },
        error: (_error) => { this.stop(connection) },
        // Native ping/pong traffic never authenticates or extends application inactivity.
        ping: () => { this.stop(connection) },
        pong: () => { this.stop(connection) },
      },
    }
    this.sockets.add(connection)
    ws.on('message', connection.listeners.message)
    ws.on('close', connection.listeners.close)
    ws.on('error', connection.listeners.error)
    ws.on('ping', connection.listeners.ping)
    ws.on('pong', connection.listeners.pong)
    if (!this.active) this.stop(connection)
  }

  private expired(connection: Connection, now: number): boolean {
    if (now - connection.born >= this.config.maxConnectionLifetimeMs
      || now - connection.lastActivity >= this.config.idleTimeoutMs) return true
    const phase = connection.phase
    if (phase.kind === 'register' || phase.kind === 'proof') {
      return now - connection.born >= this.config.registrationTimeoutMs
        || (phase.kind === 'proof' && now >= phase.expires)
    }
    if (phase.kind === 'phone') {
      return !phase.channel ? now - connection.lastActivity >= this.config.channelHandshakeTimeoutMs
        : !phase.channel.established && now - phase.channel.born >= this.config.channelHandshakeTimeoutMs
    }
    return false
  }

  private charge(connection: Connection, length: number, now: number): boolean {
    return take(this.bytes, this.config.bytesPerSecond, 1000, length, now)
      && take(connection.ip.bytes, this.config.bytesPerSecondPerIp, 1000, length, now)
      && take(connection.bytes, this.config.bytesPerSecondPerSocket, 1000, length, now)
  }

  private receive(connection: Connection, data: RawData, binary: boolean): void {
    const now = performance.now()
    if (this.expired(connection, now) || binary) throw new Error('Expired or binary relay message')
    const bytes = dataBytes(data)
    if (bytes.length > this.config.maxFrameBytes) throw new Error('Frame budget exhausted')
    if (!this.charge(connection, bytes.length, now)) throw new Error('Byte rate exhausted')
    // Fatal UTF-8 decoding forbids replacement characters changing signed input text.
    const wire: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    const phase = connection.phase
    if (phase.kind === 'register') {
      const registration = parseRegistration(wire, connection.role, (target) => {
        const pc = this.pcs.get(target)
        if (connection.role === 'pc') {
          if (pc) throw new Error('PC already owned')
        } else if (!pc || pc.stopping || this.phoneCount(pc) >= this.config.maxPhonesPerPc) {
          throw new Error('PC unavailable or phone budget exhausted')
        }
      })
      if (connection.role === 'pc' && derivePcId(registration.identityKey) !== registration.targetPcId) {
        throw new Error('PC identity and target differ')
      }
      if (connection.role === 'phone' && !this.pcs.has(registration.targetPcId)) throw new Error('PC offline')
      const challenge = createRelayChallenge({
        role: connection.role, httpsOrigin: this.origin, ...registration, socketGeneration: connection.generation,
      })
      connection.phase = { kind: 'proof', challenge, expires: now + this.config.challengeTimeoutMs }
      this.send(connection, challenge)
    } else if (phase.kind === 'proof') {
      // Consumption precedes cryptography; failed or replayed proofs cannot retry this nonce.
      connection.phase = { kind: 'register' }
      if (!verifyRelayChallenge(phase.challenge, wire)) throw new Error('Invalid identity proof')
      if (connection.role === 'pc') {
        if (this.pcs.has(phase.challenge.targetPcId)) throw new Error('PC already owned')
        connection.phase = { kind: 'pc', challenge: phase.challenge, channels: new Map() }
        this.pcs.set(phase.challenge.targetPcId, connection)
      } else {
        const pc = this.pcs.get(phase.challenge.targetPcId)
        if (!pc || pc.stopping || pc.phase.kind !== 'pc'
          || this.phoneCount(pc) >= this.config.maxPhonesPerPc) throw new Error('PC unavailable or phone budget exhausted')
        connection.phase = { kind: 'phone', challenge: phase.challenge, pc }
      }
      this.counts.pending--
      connection.ip.pending--
      this.send(connection, {
        v: 1, type: 'relay-ready', role: connection.role,
        targetPcId: phase.challenge.targetPcId, socketGeneration: connection.generation,
      })
    } else {
      const operation = parseOperation(wire, connection.role)
      if (operation.socketGeneration !== connection.generation) throw new Error('Stale socket generation')
      if (operation.type === 'relay-close') {
        if (phase.kind !== 'pc') throw new Error('PC role required')
        const channel = phase.channels.get(operation.channelId)
        if (channel?.pc === connection && channel.phone.generation === operation.phoneSocketGeneration) {
          this.stop(channel.phone)
        }
      } else this.forward(connection, operation)
    }
    connection.lastActivity = now
  }

  private phoneCount(pc: Connection): number {
    let count = 0
    for (const connection of this.sockets) {
      if (connection.stopping) continue
      if ((connection.phase.kind === 'phone' && connection.phase.pc === pc)
        || (pc.phase.kind === 'pc' && connection.role === 'phone' && connection.phase.kind === 'proof'
          && connection.phase.challenge.targetPcId === pc.phase.challenge.targetPcId)) count++
    }
    return count
  }

  private forward(source: Connection, operation: DataFrame): void {
    const phase = source.phase
    let channel: Channel | undefined
    if (operation.role !== source.role) throw new Error('Operation role differs from authenticated source')
    if (phase.kind === 'phone' && operation.role === 'phone') {
      channel = phase.channel
      if (!channel) {
        const pc = phase.pc
        const hello = operation.payload
        if (pc.phase.kind !== 'pc' || pc.stopping || hello.type !== 'hello'
          || hello.phoneIdentityKey !== phase.challenge.identityKey || hello.pcIdentityKey !== pc.phase.challenge.identityKey
          || hello.httpsOrigin !== this.origin || pc.phase.channels.has(operation.channelId)) {
          throw new Error('Invalid phone handshake binding')
        }
        channel = {
          id: operation.channelId, pc, phone: source, born: performance.now(), established: false,
          phoneToPcQueued: 0, pcToPhoneQueued: 0,
        }
        phase.channel = channel
        pc.phase.channels.set(channel.id, channel)
        if (!this.send(pc, {
          v: 1, type: 'relay-channel-open', channelId: channel.id,
          targetPcId: phase.challenge.targetPcId, phoneIdentityKey: phase.challenge.identityKey,
          phoneSocketGeneration: source.generation, pcSocketGeneration: pc.generation,
        }, channel, 'phoneToPcQueued')) return
      } else if (operation.payload.type !== 'encrypted' || !channel.established) {
        throw new Error('Repeated hello or incomplete channel')
      }
    } else if (phase.kind === 'pc' && operation.role === 'pc') {
      channel = phase.channels.get(operation.channelId)
      // Only active exact incarnations may forward; retired traffic needs no retained tombstones.
      if (!channel || channel.pc !== source || channel.phone.generation !== operation.phoneSocketGeneration
        || channel.phone.stopping) return
      if (!channel.established && operation.payload.type === 'welcome') channel.established = true
      else if (!channel.established || operation.payload.type !== 'encrypted') {
        this.stop(channel.phone)
        return
      }
    } else throw new Error('Authentication required')
    if (channel.id !== operation.channelId || channel.phone.stopping || channel.pc.stopping) {
      throw new Error('Unavailable or mismatched channel')
    }
    const target = source.role === 'phone' ? channel.pc : channel.phone
    this.send(target, {
      v: 1, type: 'relay-data', channelId: channel.id, targetPcId: phase.challenge.targetPcId,
      sourceRole: source.role, sourceIdentityKey: phase.challenge.identityKey,
      sourceSocketGeneration: source.generation, targetSocketGeneration: target.generation,
      payload: operation.payload,
    }, channel, source.role === 'phone' ? 'phoneToPcQueued' : 'pcToPhoneQueued')
  }

  private send(target: Connection, payload: object, channel?: Channel,
    direction?: 'phoneToPcQueued' | 'pcToPhoneQueued'): boolean {
    const now = performance.now()
    if (!this.active || target.stopping) return false
    if (target.ws.readyState !== WebSocket.OPEN || this.expired(target, now)) {
      this.stop(target)
      return false
    }
    const text = JSON.stringify(payload)
    const size = Buffer.byteLength(text)
    if (size > this.config.maxFrameBytes || size + target.queued > this.config.maxOutboundQueueBytes
      || target.ws.bufferedAmount + size > this.config.maxOutboundQueueBytes
      || (channel && direction && size + channel[direction] > this.config.maxChannelQueueBytes)
      || !this.charge(target, size, now)) {
      // A single channel cannot revoke a shared PC transport by exhausting a destination budget.
      this.stop(channel ? channel.phone : target)
      return false
    }
    target.queued += size
    if (channel && direction) channel[direction] += size
    const complete = (error?: Error): void => {
      target.queued -= size
      if (channel && direction) channel[direction] -= size
      if (error) this.stop(target)
      if (target.ended && target.queued === 0) this.settle(target)
    }
    try { target.ws.send(text, { binary: false, compress: false }, complete) } catch (error) {
      complete(error instanceof Error ? error : new Error('WebSocket send failed'))
      return false
    }
    return true
  }

  private stop(connection: Connection): void {
    if (connection.stopping) return
    connection.stopping = true
    connection.ws.off('message', connection.listeners.message)
    connection.ws.off('ping', connection.listeners.ping)
    connection.ws.off('pong', connection.listeners.pong)
    const phase = connection.phase
    if (phase.kind === 'pc') {
      // Incarnation comparison prevents old teardown deleting a replacement owner.
      if (this.pcs.get(phase.challenge.targetPcId) === connection) this.pcs.delete(phase.challenge.targetPcId)
      for (const phone of this.sockets) {
        if (phone.phase.kind === 'phone' && phone.phase.pc === connection) this.stop(phone)
      }
    } else if (phase.kind === 'phone' && phase.channel) {
      const channel = phase.channel
      const pcPhase = channel.pc.phase
      if (pcPhase.kind === 'pc' && pcPhase.channels.get(channel.id) === channel) {
        pcPhase.channels.delete(channel.id)
        if (this.active && !channel.pc.stopping) {
          // Budget rejection drops this notification; transport failure still stops its actual owner.
          this.send(channel.pc, {
            v: 1, type: 'relay-channel-close', channelId: channel.id,
            phoneSocketGeneration: connection.generation, pcSocketGeneration: channel.pc.generation,
          }, channel, 'phoneToPcQueued')
        }
      }
    }
    connection.ws.terminate()
  }

  private finished(connection: Connection): void {
    this.stop(connection)
    connection.ended = true
    connection.ws.off('close', connection.listeners.close)
    connection.ws.off('error', connection.listeners.error)
    if (connection.queued === 0) this.settle(connection)
  }

  private settle(connection: Connection): void {
    if (this.sockets.delete(connection)) {
      const pending = connection.phase.kind === 'register' || connection.phase.kind === 'proof'
      this.release(connection.role, connection.ip, pending)
    }
    connection.settleClosed()
  }

  private sweep(): void {
    if (!this.active) return
    const now = performance.now()
    for (const connection of this.sockets) if (this.expired(connection, now)) this.stop(connection)
    for (const [address, bucket] of this.ips) {
      if (!bucket.connections && now - bucket.touched >= this.config.ipBucketTtlMs) this.ips.delete(address)
    }
  }

  /**
   * Stop callbacks and await socket/server close before the caller remounts routes.
   * @returns Quiescent completion; all in-memory routing and IP state is discarded.
   */
  async dispose(): Promise<void> {
    this.active = false
    clearInterval(this.timer)
    const owned = [...this.sockets]
    const upgrading = [...this.upgrading.entries()]
    for (const [socket] of upgrading) socket.destroy()
    for (const connection of owned) this.stop(connection)
    await Promise.all([...owned.map(connection => connection.closed), ...upgrading.map(([, closed]) => closed)])
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
    this.pcs.clear()
    this.ips.clear()
  }
}
