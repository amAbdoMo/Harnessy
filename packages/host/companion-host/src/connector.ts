/** Outbound WSS only; one cancellation controller owns each fresh relay connection incarnation. */
import type { KeyObject } from 'node:crypto'
import { WebSocket } from 'ws'
import type { RawData } from 'ws'
import {
  exactRecord, parseId, parsePublicKey, parseRelayChallenge, signRelayChallenge,
} from '@deepseek-ai/dsh-companion-protocol'
import type { ChannelId, HttpsOrigin, PcId, PublicKeySpki, SocketGeneration } from '@deepseek-ai/dsh-companion-protocol'
import type { HostBudgets } from './config.ts'

/** Parsed relay routing notice; all endpoint identity authentication remains end-to-end. */
export type RelayInput =
  | { readonly type: 'open'; readonly channelId: ChannelId; readonly phoneKey: PublicKeySpki; readonly phoneGeneration: SocketGeneration }
  | { readonly type: 'close'; readonly channelId: ChannelId; readonly phoneGeneration: SocketGeneration }
  | { readonly type: 'data'; readonly channelId: ChannelId; readonly phoneKey: PublicKeySpki; readonly phoneGeneration: SocketGeneration; readonly payload: unknown }

/** Incarnation-owned send capability; stale send callbacks cannot target a new socket. */
export interface RelayConnection {
  /** Socket lifetime; abort withdraws every capability bound to this PC incarnation. */
  readonly signal: AbortSignal
  /**
   * Queue one complete relay envelope for the caller-owned phone incarnation.
   * @param channelId - Parent-owned channel identifier.
   * @param phoneSocketGeneration - Exact phone incarnation, never inferred from current routing state.
   * @param payload - Endpoint message; admitted and serialized in call order.
   * @param signal - Caller-owned write cancellation; cancellation never retires another channel.
   * @returns Local ws completion, not peer receipt. Cancellation after ws.send means delivery is unknown;
   * its byte/count reservation remains until the actual callback or transport close. Admission rejects only this write.
   * Queue expiry rejects only that write; an in-flight write deadline may retire a stalled shared socket.
   */
  send(channelId: ChannelId, phoneSocketGeneration: SocketGeneration, payload: object, signal: AbortSignal): Promise<void>
  /**
   * Best-effort close notification, bound to both socket incarnations; admission failure does not stop the PC.
   * @param channelId - Parent-owned channel identifier.
   * @param phoneSocketGeneration - Exact phone incarnation to retire.
   * @returns Local ws completion; rejection does not imply peer receipt or rollback.
   */
  closeChannel(channelId: ChannelId, phoneSocketGeneration: SocketGeneration): Promise<void>
  /** Withdraw this socket's capabilities and reject pending writes synchronously; close is joined by dispose(). */
  stop(): void
}

interface ConnectorOptions {
  readonly origin: HttpsOrigin
  readonly pcId: PcId
  readonly publicKey: PublicKeySpki
  readonly privateKey: KeyObject
  readonly budgets: HostBudgets
  readonly signal: AbortSignal
  readonly ready: (connection: RelayConnection) => void
  /** Parent owns phone generations and per-channel rejection; delivery must settle on connection.signal abort. */
  readonly input: (connection: RelayConnection, frame: RelayInput) => Promise<void>
  /** Synchronous channel-scoped withdrawal on shared input saturation; it must not retire the PC socket. */
  readonly reject: (connection: RelayConnection, frame: RelayInput) => void
  /** Incarnation-owned application teardown, joined before another connection attempt. */
  readonly lost: (connection: RelayConnection) => Promise<void>
}

function bytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
}

interface WriteQuota { bytes: number; count: number }
interface LocalWrite {
  readonly text: string
  readonly size: number
  readonly channel: { readonly key: string; readonly quota: WriteQuota } | undefined
  readonly timer: ReturnType<typeof setTimeout>
  readonly settle: (error?: Error) => void
  sent: boolean
}
interface WriteOptions {
  readonly ws: WebSocket
  readonly signal: AbortSignal
  readonly budget: HostBudgets
  readonly inputCount: () => number
  readonly charge: (size: number) => void
  readonly stop: () => void
}

/** Caller settlement and transport reservation have independent completion points after ws.send. */
class RelayWrites {
  private readonly pending = new Set<LocalWrite>()
  private readonly channels = new Map<string, WriteQuota>()
  private queuedBytes = 0
  private writing: LocalWrite | undefined
  private draining = false

  constructor(private readonly options: WriteOptions) {}

  get count(): number { return this.pending.size }

  send(wire: object, signal: AbortSignal, channelKey?: string): Promise<void> {
    try {
      this.options.signal.throwIfAborted()
      signal.throwIfAborted()
      this.available()
      const text = JSON.stringify(wire)
      const size = Buffer.byteLength(text)
      this.options.signal.throwIfAborted()
      signal.throwIfAborted()
      this.admit(size, channelKey)
      return this.reserve(text, size, signal, channelKey)
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('companion-host: local write failed')) }
  }

  private available(): void {
    if (this.options.ws.readyState === WebSocket.OPEN) return
    this.options.stop()
    throw new Error('companion-host: socket unavailable')
  }

  private admit(size: number, channelKey: string | undefined): void {
    const { budget, ws } = this.options
    const quota = channelKey === undefined ? undefined : this.channels.get(channelKey)
    if (size > budget.maxFrameBytes || this.queuedBytes + size > budget.maxSendQueuedBytes
      || ws.bufferedAmount + size > budget.maxSendQueuedBytes
      || this.pending.size + this.options.inputCount() >= budget.maxPendingMessages
      || (channelKey !== undefined && (size + (quota?.bytes ?? 0) > budget.channel.maxQueuedSendBytes
        || (quota?.count ?? 0) >= budget.channel.maxPendingSends))) {
      throw new Error('companion-host: relay send budget')
    }
    this.options.charge(size)
  }

  private reserve(text: string, size: number, signal: AbortSignal, channelKey: string | undefined): Promise<void> {
    const sending = new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', cancel)
        if (error) reject(error)
        else resolve()
      }
      const cancel = (): void => {
        settle(new Error(write.sent ? 'companion-host: write cancelled; delivery unknown' : 'companion-host: write cancelled',
          { cause: signal.reason }))
        if (!write.sent) { this.release(write); this.drain() }
      }
      const channel = channelKey === undefined ? undefined : {
        key: channelKey, quota: this.channels.get(channelKey) ?? { bytes: 0, count: 0 },
      }
      const write: LocalWrite = { text, size, channel, sent: false, settle,
        timer: setTimeout(() => {
          if (write.sent) this.options.stop()
          else { settle(new Error('companion-host: write queue deadline')); this.release(write); this.drain() }
        }, this.options.budget.channel.sendTimeoutMs) }
      this.pending.add(write)
      this.queuedBytes += size
      if (channel !== undefined) {
        channel.quota.bytes += size
        channel.quota.count++
        this.channels.set(channel.key, channel.quota)
      }
      signal.addEventListener('abort', cancel, { once: true })
      // Serialization may invoke caller code; cancellation must be checked again before sending.
      if (signal.aborted) cancel()
      else this.drain()
    })
    // The connector owns rejection observation even when teardown precedes the caller's await.
    void sending.catch((_error: unknown) => {})
    return sending
  }

  private release(write: LocalWrite): boolean {
    if (!this.pending.delete(write)) return false
    clearTimeout(write.timer)
    this.queuedBytes -= write.size
    if (this.writing === write) this.writing = undefined
    if (write.channel !== undefined) {
      write.channel.quota.bytes -= write.size
      if (--write.channel.quota.count === 0) this.channels.delete(write.channel.key)
    }
    return true
  }

  private drain(): void {
    if (this.draining || this.options.signal.aborted) return
    this.draining = true
    try {
      while (this.writing === undefined) {
        try { this.options.signal.throwIfAborted() }
        catch (_error) { break /* Transport retirement owns pending reservations. */ }
        const write = this.pending.values().next().value
        if (write === undefined) break
        if (this.options.ws.readyState !== WebSocket.OPEN) { this.options.stop(); break }
        this.writing = write
        write.sent = true
        try { this.options.ws.send(write.text, { binary: false, compress: false }, (error) => { this.complete(write, error) }) }
        catch (error) { this.complete(write, error instanceof Error ? error : new Error('WebSocket send failed')) }
      }
    } finally { this.draining = false }
  }

  private complete(write: LocalWrite, error?: Error): void {
    if (!this.release(write)) return
    write.settle(error || this.options.signal.aborted
      ? new Error('companion-host: send failed; delivery unknown', { cause: error }) : undefined)
    if (error) this.options.stop()
    else this.drain()
  }

  stop(): void {
    for (const write of this.pending) {
      clearTimeout(write.timer)
      write.settle(new Error(write.sent ? 'companion-host: socket stopped; delivery unknown' : 'companion-host: socket stopped'))
      if (!write.sent) this.release(write)
    }
  }

  closed(): void {
    for (const write of this.pending) this.release(write)
  }
}

/** Rate-bounded reconnect for the owned PC Host lifetime; no offline queue or mutation resend. */
export class Connector {
  private readonly life = new AbortController()
  private stopCurrent: (() => void) | undefined
  private readonly done: Promise<void>
  constructor(private readonly options: ConnectorOptions) {
    const abort = (): void => { this.stop() }
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) this.stop()
    this.done = this.run().finally(() => { options.signal.removeEventListener('abort', abort) })
  }

  private stop(): void {
    this.life.abort()
    this.stopCurrent?.()
  }

  private async run(): Promise<void> {
    const { budgets } = this.options
    let delay = budgets.reconnectInitialMs
    let attempts = 0
    while (!this.life.signal.aborted) {
      await this.connect()
      attempts++
      if (attempts >= budgets.reconnectAttempts) {
        await this.wait(budgets.reconnectMaxMs)
        attempts = 0
        delay = budgets.reconnectInitialMs
      } else {
        await this.wait(delay)
        delay = Math.min(budgets.reconnectMaxMs, delay * 2)
      }
    }
  }

  private wait(delay: number): Promise<void> {
    const signal = this.life.signal
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        if (this.stopCurrent === finish) this.stopCurrent = undefined
        resolve()
      }
      const timer = setTimeout(finish, delay)
      this.stopCurrent = finish
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
    })
  }

  private async connect(): Promise<void> {
    const options = this.options
    const budget = options.budgets
    const life = new AbortController()
    const ws = new WebSocket(`${options.origin.replace(/^https:/, 'wss:')}/companion/pc`, {
      perMessageDeflate: false, maxPayload: budget.maxFrameBytes, followRedirects: false,
      handshakeTimeout: budget.connectionTimeoutMs, rejectUnauthorized: true, headers: { Origin: options.origin },
    })
    let phase: 'challenge' | 'ready' | 'active' = 'challenge'
    let generation: SocketGeneration | undefined
    let tokens = budget.bytesPerSecond
    let tokenTime = performance.now()
    let lastActivity = tokenTime
    let settleClosed = (): void => {}
    const closed = new Promise<void>((resolve) => { settleClosed = resolve })
    const work = new Set<Promise<void>>()
    const stop = (): void => {
      if (life.signal.aborted) return
      life.abort()
      ws.off('message', receive)
      ws.off('open', opened)
      ws.off('ping', stop)
      ws.off('pong', stop)
      writes.stop()
      ws.terminate()
    }
    this.stopCurrent = stop
    const charge = (size: number): void => {
      const now = performance.now()
      tokens = Math.min(budget.bytesPerSecond, tokens + (now - tokenTime) * budget.bytesPerSecond / 1000)
      tokenTime = now
      if (size > tokens) throw new Error('companion-host: relay byte budget')
      tokens -= size
      lastActivity = now
    }
    const writes = new RelayWrites({ ws, signal: life.signal, budget, inputCount: () => work.size, charge, stop })
    const send = (wire: object): Promise<void> => writes.send(wire, life.signal)
    const connection: RelayConnection = {
      signal: life.signal,
      send: (channelId, phoneSocketGeneration, payload, signal) => writes.send({
        v: 1, type: 'relay-data', channelId, socketGeneration: generation, phoneSocketGeneration, payload,
      }, signal, JSON.stringify([channelId, phoneSocketGeneration])),
      closeChannel: (channelId, phoneSocketGeneration) => writes.send({
        v: 1, type: 'relay-close', channelId, socketGeneration: generation, phoneSocketGeneration,
      }, life.signal, JSON.stringify([channelId, phoneSocketGeneration])),
      stop,
    }
    const track = (pending: Promise<void>): void => {
      work.add(pending)
      // Channel ownership, including application rejection, belongs to the parent rather than this shared socket.
      void pending.then(() => work.delete(pending), (_error: unknown) => { work.delete(pending) })
    }
    const opened = (): void => {
      void send({ v: 1, type: 'relay-register', role: 'pc', identityKey: options.publicKey, targetPcId: options.pcId })
        .catch((_error: unknown) => { stop() })
    }
    const receive = (raw: RawData, binary: boolean): void => {
      try {
        life.signal.throwIfAborted()
        const buffer = bytes(raw)
        if (binary || buffer.length > budget.maxFrameBytes) throw new Error('Invalid relay message')
        if (phase !== 'active') {
          if (work.size + writes.count >= budget.maxPendingMessages) throw new Error('Relay authentication queue limit')
          charge(buffer.length)
        }
        const wire: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
        if (phase === 'challenge') {
          const challenge = parseRelayChallenge(wire)
          if (challenge.role !== 'pc' || challenge.httpsOrigin !== options.origin || challenge.identityKey !== options.publicKey
            || challenge.targetPcId !== options.pcId) throw new Error('Relay challenge binding mismatch')
          generation = challenge.socketGeneration
          phase = 'ready'
          void send(signRelayChallenge(options.privateKey, challenge)).catch((_error: unknown) => { stop() })
          return
        }
        if (phase === 'ready') {
          const row = exactRecord(wire, ['v', 'type', 'role', 'targetPcId', 'socketGeneration'])
          if (row.v !== 1 || row.type !== 'relay-ready' || row.role !== 'pc' || row.targetPcId !== options.pcId
            || row.socketGeneration !== generation) throw new Error('Invalid relay readiness')
          phase = 'active'
          options.ready(connection)
          return
        }
        const frame = this.parse(wire, generation)
        if (work.size + writes.count >= budget.maxPendingMessages) { options.reject(connection, frame); return }
        try { charge(buffer.length) }
        catch (_error) { options.reject(connection, frame); return }
        track(options.input(connection, frame))
      } catch (_error) { stop() }
    }
    const onClose = (): void => { stop(); writes.closed(); settleClosed() }
    const onError = (_error: Error): void => { stop() }
    const parentAbort = (): void => { stop() }
    ws.on('open', opened)
    ws.on('message', receive)
    ws.on('close', onClose)
    ws.on('error', onError)
    ws.on('ping', stop)
    ws.on('pong', stop)
    this.life.signal.addEventListener('abort', parentAbort, { once: true })
    const registrationTimer = setTimeout(() => { if (phase !== 'active') stop() }, budget.connectionTimeoutMs)
    const lifetimeTimer = setTimeout(stop, budget.maxConnectionLifetimeMs)
    const idleTimer = setInterval(() => {
      if (performance.now() - lastActivity >= budget.idleTimeoutMs) stop()
    }, Math.min(budget.idleTimeoutMs, budget.connectionTimeoutMs))
    try {
      if (this.life.signal.aborted) stop()
      await closed
      // Abort was synchronous at socket loss; application teardown now joins admitted work.
      try { await options.lost(connection) }
      finally { await Promise.allSettled([...work]) }
    } finally {
      clearTimeout(registrationTimer)
      clearTimeout(lifetimeTimer)
      clearInterval(idleTimer)
      this.life.signal.removeEventListener('abort', parentAbort)
      if (this.stopCurrent === stop) this.stopCurrent = undefined
      ws.removeAllListeners()
      ws.terminate()
    }
  }

  private parse(wire: unknown, generation: SocketGeneration | undefined): RelayInput {
    if (typeof wire !== 'object' || wire === null || !('type' in wire)) throw new Error('Invalid relay routing JSON')
    if (wire.type === 'relay-channel-open') {
      const row = exactRecord(wire, ['v', 'type', 'channelId', 'targetPcId', 'phoneIdentityKey', 'phoneSocketGeneration', 'pcSocketGeneration'])
      if (row.v !== 1 || row.targetPcId !== this.options.pcId || row.pcSocketGeneration !== generation) throw new Error('Stale relay channel')
      return { type: 'open', channelId: parseId<ChannelId>(row.channelId), phoneKey: parsePublicKey(row.phoneIdentityKey),
        phoneGeneration: parseId<SocketGeneration>(row.phoneSocketGeneration) }
    }
    if (wire.type === 'relay-channel-close') {
      const row = exactRecord(wire, ['v', 'type', 'channelId', 'phoneSocketGeneration', 'pcSocketGeneration'])
      if (row.v !== 1 || row.pcSocketGeneration !== generation) throw new Error('Stale relay close')
      return { type: 'close', channelId: parseId<ChannelId>(row.channelId), phoneGeneration: parseId<SocketGeneration>(row.phoneSocketGeneration) }
    }
    const row = exactRecord(wire, ['v', 'type', 'channelId', 'targetPcId', 'sourceRole', 'sourceIdentityKey',
      'sourceSocketGeneration', 'targetSocketGeneration', 'payload'])
    if (row.v !== 1 || row.type !== 'relay-data' || row.sourceRole !== 'phone' || row.targetPcId !== this.options.pcId
      || row.targetSocketGeneration !== generation) throw new Error('Invalid forwarded relay role or generation')
    return { type: 'data', channelId: parseId<ChannelId>(row.channelId), phoneKey: parsePublicKey(row.sourceIdentityKey),
      phoneGeneration: parseId<SocketGeneration>(row.sourceSocketGeneration), payload: row.payload }
  }

  /**
   * Retire the owned lifetime before joining socket callbacks and application teardown.
   * @returns Quiescent connector completion; all socket and application work has settled.
   */
  async dispose(): Promise<void> { this.stop(); await this.done }
}
