/** Source regressions boot real Loader/WebServer composition; only HTTP/ws network I/O is substituted. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance as nodePerformance } from 'node:perf_hooks'
import type { KeyObject } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {
  acceptClientHello, createPhoneHandshake, derivePcId, exactRecord, exportPublicKey, generateP256KeyPair,
  MAX_APPLICATION_BYTES, MAX_NORMALIZED_RELAY_FRAME_BYTES, encodeBase64Url, encodeCounter, parseEncryptedFrame,
  parseChannelBudget, parseHttpsOrigin, parseId, parseRelayChallenge, signRelayChallenge,
} from '@deepseek-ai/dsh-companion-protocol'
import type { ChannelId, GrantId, PcId, SocketGeneration } from '@deepseek-ai/dsh-companion-protocol'
import * as Plugin from '../src/index.ts'
import type { Config } from '../src/config.ts'
import { HttpTransport, SocketTransport, upgradeRequest } from './transport.ts'

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>()
  return { ...actual, createServer: () => new HttpTransport() }
})
vi.mock('ws', async () => {
  const { SocketTransport: Socket, WebSocketTransport: Server } = await import('./transport.ts')
  return { WebSocket: Socket, WebSocketServer: Server }
})

const origin = parseHttpsOrigin('https://relay.invalid')
const config = {
  httpsOrigin: origin, maxConnections: 20, maxConnectionsPerIp: 20,
  maxPending: 10, maxPendingPerIp: 10, maxRoutes: 5, maxRoutesPerIp: 5,
  maxPhones: 10, maxPhonesPerIp: 10, maxPhonesPerPc: 5, maxIpBuckets: 10,
  maxFrameBytes: 8192, maxOutboundQueueBytes: 16384, maxChannelQueueBytes: 8192,
  bytesPerSecond: 1000000, bytesPerSecondPerIp: 1000000, bytesPerSecondPerSocket: 1000000,
  upgradesPerWindow: 100, upgradesPerWindowPerIp: 100, upgradeWindowMs: 1000,
  ipBucketTtlMs: 1000, registrationTimeoutMs: 10000, challengeTimeoutMs: 5000,
  channelHandshakeTimeoutMs: 10000, idleTimeoutMs: 30000,
  maxConnectionLifetimeMs: 60000, sweepIntervalMs: 100,
} satisfies Config
const channelBudget = parseChannelBudget({
  maxQueuedSendBytes: 1_048_576, maxQueuedReceiveBytes: 1_048_576,
  maxPendingSends: 32, maxPendingReceives: 32, sendTimeoutMs: 5000,
})
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  try { for (const release of cleanup.splice(0).reverse()) await release() }
  finally {
    HttpTransport.instances.length = 0
    SocketTransport.instances.length = 0
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  // Fake timers replace the global clock, while the relay imports Node's clock.
  vi.spyOn(nodePerformance, 'now').mockImplementation(() => performance.now())
}

async function composition(override: Partial<Config> = {}): Promise<Context> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-composition-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  const yaml = join(directory, 'cordis.yml')
  await writeFile(yaml, [
    '- id: webserver', "  name: '@deepseek-ai/dsh-host-webserver'",
    "  config: {host: '127.0.0.1', port: 0}",
    '- id: relay', "  name: '@deepseek-ai/dsh-companion-relay'",
    `  config: ${JSON.stringify({ ...config, ...override })}`, '',
  ].join('\n'))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-companion-relay', Plugin],
  ])
  ctx.loader.internal = {
    version: 'v2', loadCache: new Map(),
    import: async (specifier) => {
      if (!modules.has(specifier)) throw new Error(`Unexpected source import ${specifier}`)
      return modules.get(specifier)
    },
    register(): never { throw new Error('Unexpected Node module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected Node module job') },
    resolveSync(): never { throw new Error('Unexpected Node synchronous resolution') },
    load(): never { throw new Error('Unexpected Node module load') },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(yaml).href } })
  await ctx.loader.await()
  return ctx
}

function connect(role: 'pc' | 'phone', path = `/companion/${role}`, requestOrigin?: string): SocketTransport | undefined {
  const before = SocketTransport.instances.length
  const request = upgradeRequest(path, requestOrigin)
  HttpTransport.instances.at(-1)!.emit('upgrade', request, request.socket, Buffer.alloc(0))
  return SocketTransport.instances.length > before ? SocketTransport.instances.at(-1) : undefined
}

function authenticate(socket: SocketTransport, role: 'pc' | 'phone', key: KeyObject, targetPcId: PcId): SocketGeneration {
  socket.receive({ v: 1, type: 'relay-register', role, identityKey: exportPublicKey(key), targetPcId })
  const challenge = parseRelayChallenge(socket.last())
  socket.receive(signRelayChallenge(key, challenge))
  const ready = exactRecord(socket.last(), ['v', 'type', 'role', 'targetPcId', 'socketGeneration'])
  expect(ready.type).toBe('relay-ready')
  return parseId<SocketGeneration>(ready.socketGeneration)
}

function handshake(pcKey: KeyObject, phoneKey: KeyObject, channel = 'channel') {
  const grantId = parseId<GrantId>('grant')
  const attempt = createPhoneHandshake({ channelBudget,
    identityPrivateKey: phoneKey, pcIdentityKey: exportPublicKey(pcKey), httpsOrigin: origin,
    channelId: parseId<ChannelId>(channel), authorization: { kind: 'grant', grantId, generation: 1 },
  })
  const accepted = acceptClientHello({ channelBudget,
    hello: attempt.hello, identityPrivateKey: pcKey, httpsOrigin: origin,
    authorization: { kind: 'grant', phoneIdentityKey: exportPublicKey(phoneKey), grantId, generation: 1 },
  })
  cleanup.push(async () => { attempt.close(); accepted.channel.close() })
  return { attempt, accepted }
}

const route = (socket: SocketTransport, generation: SocketGeneration, payload: { readonly channelId: ChannelId }) => {
  socket.receive({ v: 1, type: 'relay-data', channelId: payload.channelId, socketGeneration: generation, payload })
}

function dataPacketCount(socket: SocketTransport): number {
  return socket.packets.filter(packet => typeof packet === 'object' && packet !== null
    && 'type' in packet && packet.type === 'relay-data').length
}

function pcRoute(request: {
  socket: SocketTransport
  generation: SocketGeneration
  phoneGeneration: SocketGeneration
  payload: { channelId: ChannelId }
}): void {
  request.socket.receive({
    v: 1, type: 'relay-data', channelId: request.payload.channelId,
    socketGeneration: request.generation, phoneSocketGeneration: request.phoneGeneration, payload: request.payload,
  })
}

describe('companion relay source Loader composition', () => {
  it('authenticates both roles, opens only the selected PC channel and forwards opaque encrypted envelopes', async () => {
    const ctx = await composition()
    expect('default' in Plugin).toBe(false)
    expect(ctx.loader.unwrapExports(Plugin)).toBe(Plugin)
    const pcKey = generateP256KeyPair().privateKey
    const phoneKey = generateP256KeyPair().privateKey
    const target = derivePcId(exportPublicKey(pcKey))
    const pc = connect('pc')!
    const pcGeneration = authenticate(pc, 'pc', pcKey, target)
    const phone = connect('phone')!
    const phoneGeneration = authenticate(phone, 'phone', phoneKey, target)
    const { attempt, accepted } = handshake(pcKey, phoneKey)
    route(phone, phoneGeneration, attempt.hello)
    expect(pc.packets.at(-2)).toMatchObject({
      type: 'relay-channel-open', phoneIdentityKey: exportPublicKey(phoneKey),
      phoneSocketGeneration: phoneGeneration, pcSocketGeneration: pcGeneration,
    })
    expect(pc.last()).toMatchObject({ sourceRole: 'phone', sourceSocketGeneration: phoneGeneration, payload: attempt.hello })
    pcRoute({ socket: pc, generation: pcGeneration, phoneGeneration, payload: accepted.welcome })
    expect(phone.last()).toMatchObject({ sourceRole: 'pc', targetSocketGeneration: phoneGeneration, payload: accepted.welcome })
    const phoneChannel = attempt.complete(accepted.welcome)
    cleanup.push(async () => { phoneChannel.close() })
    await phoneChannel.sendConfirmation(async (frame) => { route(phone, phoneGeneration, frame) })
    const delivered = exactRecord(pc.last(), [
      'v', 'type', 'channelId', 'targetPcId', 'sourceRole', 'sourceIdentityKey',
      'sourceSocketGeneration', 'targetSocketGeneration', 'payload',
    ])
    expect(delivered.payload).toMatchObject({ type: 'encrypted', direction: 'phone-to-pc' })
    expect(await accepted.channel.receive(delivered.payload)).toEqual({ kind: 'confirmation' })
  })

  it('normalizes maximum permitted ciphertext below the shared PC receiver floor', async () => {
    await composition({ maxFrameBytes: MAX_NORMALIZED_RELAY_FRAME_BYTES,
      maxChannelQueueBytes: MAX_NORMALIZED_RELAY_FRAME_BYTES * 2,
      maxOutboundQueueBytes: MAX_NORMALIZED_RELAY_FRAME_BYTES * 3 })
    const pcKey = generateP256KeyPair().privateKey
    const phoneKey = generateP256KeyPair().privateKey
    const target = derivePcId(exportPublicKey(pcKey))
    const pc = connect('pc')!
    const pcGeneration = authenticate(pc, 'pc', pcKey, target)
    const phone = connect('phone')!
    const phoneGeneration = authenticate(phone, 'phone', phoneKey, target)
    const { attempt, accepted } = handshake(pcKey, phoneKey, 'x'.repeat(128))
    route(phone, phoneGeneration, attempt.hello)
    pcRoute({ socket: pc, generation: pcGeneration, phoneGeneration, payload: accepted.welcome })
    const maximum = parseEncryptedFrame({ v: 1, type: 'encrypted', direction: 'phone-to-pc',
      channelId: attempt.hello.channelId, grantId: 'x'.repeat(128), generation: 0xffffffff,
      counter: encodeCounter(0xffffffffffffffffn), ciphertext: encodeBase64Url(Buffer.alloc(MAX_APPLICATION_BYTES + 1)),
      tag: encodeBase64Url(Buffer.alloc(16)) })
    route(phone, phoneGeneration, maximum)
    expect(pc.last()).toMatchObject({ payload: maximum })
    expect(Buffer.byteLength(JSON.stringify(pc.last()))).toBeLessThanOrEqual(MAX_NORMALIZED_RELAY_FRAME_BYTES)
    expect(pc.readyState).toBe(1)
  })

  it('rejects structurally valid encrypted phone traffic before a PC welcome without stopping the PC', async () => {
    await composition()
    const pcKey = generateP256KeyPair().privateKey
    const phoneKey = generateP256KeyPair().privateKey
    const target = derivePcId(exportPublicKey(pcKey))
    const pc = connect('pc')!
    authenticate(pc, 'pc', pcKey, target)
    const phone = connect('phone')!
    const phoneGeneration = authenticate(phone, 'phone', phoneKey, target)
    const { attempt } = handshake(pcKey, phoneKey)
    route(phone, phoneGeneration, attempt.hello)
    const before = dataPacketCount(pc)
    route(phone, phoneGeneration, parseEncryptedFrame({ v: 1, type: 'encrypted', direction: 'phone-to-pc',
      channelId: attempt.hello.channelId, grantId: 'grant', generation: 1,
      counter: encodeCounter(0n), ciphertext: '', tag: encodeBase64Url(Buffer.alloc(16)) }))
    await phone.closed
    expect(dataPacketCount(pc)).toBe(before)
    expect(pc.readyState).toBe(1)
  })

  it('rejects duplicate PC ownership and proof replay without removing the live owner', async () => {
    await composition()
    const key = generateP256KeyPair().privateKey
    const id = derivePcId(exportPublicKey(key))
    const first = connect('pc')!
    authenticate(first, 'pc', key, id)
    const duplicate = connect('pc')!
    duplicate.receive({ v: 1, type: 'relay-register', role: 'pc', identityKey: exportPublicKey(key), targetPcId: id })
    await duplicate.closed
    expect(first.readyState).toBe(1)
    const phone = connect('phone')!
    phone.receive({ v: 1, type: 'relay-register', role: 'phone', identityKey: exportPublicKey(key), targetPcId: id })
    const proof = signRelayChallenge(key, parseRelayChallenge(phone.last()))
    phone.receive(proof)
    phone.receive(proof)
    await phone.closed
    expect(first.readyState).toBe(1)
  })

  it.each(['/companion/pc?extra=1', '/companion/pc/', '/companion/phone/extra'])('rejects nonexact path %s before websocket retention', async (path) => {
    await composition()
    expect(connect('pc', path)).toBeUndefined()
  })

  it('accepts absent native Origin but rejects a hostile Origin and unknown PC', async () => {
    await composition()
    expect(connect('pc', '/companion/pc', 'https://hostile.invalid')).toBeUndefined()
    const phone = connect('phone')!
    const key = generateP256KeyPair().privateKey
    phone.receive({ v: 1, type: 'relay-register', role: 'phone', identityKey: exportPublicKey(key), targetPcId: derivePcId(exportPublicKey(key)) })
    await phone.closed
  })

  it('unregisters routes and awaits socket teardown on Loader reload, then permits the same PC identity', async () => {
    const ctx = await composition()
    const key = generateP256KeyPair().privateKey
    const target = derivePcId(exportPublicKey(key))
    const old = connect('pc')!
    authenticate(old, 'pc', key, target)
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'relay')!
    await entry.update({ config: { ...config, maxRoutes: 4, maxRoutesPerIp: 4 } })
    await ctx.loader.await()
    await old.closed
    expect(old.listenerCount('message')).toBe(0)
    expect(old.listenerCount('error')).toBe(0)
    const replacement = connect('pc')!
    authenticate(replacement, 'pc', key, target)
    await ctx.loader.update(entry.id, { disabled: true })
    await ctx.loader.await()
    await replacement.closed
    expect(connect('pc')).toBeUndefined()
  })

  it('caps anonymous admission and expires socket-bound challenges before signature verification', async () => {
    fakeClock()
    await composition({ maxPending: 1, maxPendingPerIp: 1 })
    const first = connect('pc')!
    expect(connect('pc')).toBeUndefined()
    const key = generateP256KeyPair().privateKey
    const id = derivePcId(exportPublicKey(key))
    first.receive({ v: 1, type: 'relay-register', role: 'pc', identityKey: exportPublicKey(key), targetPcId: id })
    const proof = signRelayChallenge(key, parseRelayChallenge(first.last()))
    vi.advanceTimersByTime(config.challengeTimeoutMs)
    first.receive(proof)
    await first.closed
    expect(connect('pc')).toBeDefined()
  })

  it('caps retained anonymous IP buckets and deletes inactive buckets at the configured lifetime', async () => {
    fakeClock()
    await composition({ maxIpBuckets: 1 })
    const request = upgradeRequest('/companion/pc', undefined, '192.0.2.1')
    request.headers.host = 'hostile.invalid'
    request.rawHeaders = ['Host', 'hostile.invalid']
    HttpTransport.instances.at(-1)!.emit('upgrade', request, request.socket, Buffer.alloc(0))
    expect(request.socket.destroyed).toBe(true)
    expect(connect('pc')).toBeUndefined()
    vi.advanceTimersByTime(config.ipBucketTtlMs)
    expect(connect('pc')).toBeDefined()
  })

  it.each([
    { v: 2, type: 'relay-close' },
    { v: 1, type: 'relay-proof', signature: '' },
    { v: 1, type: 'broadcast', destination: 'other' },
  ])('closes authenticated sockets for closed-parser rejection %#', async (malformed) => {
    await composition()
    const key = generateP256KeyPair().privateKey
    const pc = connect('pc')!
    authenticate(pc, 'pc', key, derivePcId(exportPublicKey(key)))
    pc.receive(malformed)
    await pc.closed
  })

  it('rejects a phone channel id different from its authenticated hello', async () => {
    await composition()
    const pcKey = generateP256KeyPair().privateKey
    const phoneKey = generateP256KeyPair().privateKey
    const pc = connect('pc')!
    const target = derivePcId(exportPublicKey(pcKey))
    authenticate(pc, 'pc', pcKey, target)
    const phone = connect('phone')!
    const generation = authenticate(phone, 'phone', phoneKey, target)
    const { attempt } = handshake(pcKey, phoneKey)
    phone.receive({ v: 1, type: 'relay-data', channelId: 'different', socketGeneration: generation, payload: attempt.hello })
    await phone.closed
    expect(pc.readyState).toBe(1)
    expect(pc.last()).toMatchObject({ type: 'relay-ready' })
  })

  it('disconnects the offending phone at the per-channel queued-byte cap', async () => {
    await composition({ maxFrameBytes: 2048, maxChannelQueueBytes: 2048, maxOutboundQueueBytes: 4096 })
    const pcKey = generateP256KeyPair().privateKey
    const phoneKey = generateP256KeyPair().privateKey
    const id = derivePcId(exportPublicKey(pcKey))
    const pc = connect('pc')!
    const pcGeneration = authenticate(pc, 'pc', pcKey, id)
    const phone = connect('phone')!
    const phoneGeneration = authenticate(phone, 'phone', phoneKey, id)
    const { attempt, accepted } = handshake(pcKey, phoneKey)
    route(phone, phoneGeneration, attempt.hello)
    pcRoute({ socket: pc, generation: pcGeneration, phoneGeneration, payload: accepted.welcome })
    await Promise.resolve()
    pc.blocked = true
    const envelope = {
      v: 1, type: 'encrypted', direction: 'phone-to-pc', channelId: attempt.hello.channelId,
      grantId: parseId<GrantId>('grant'), generation: 1, counter: 'AAAAAAAAAAA',
      ciphertext: Buffer.alloc(800).toString('base64url'), tag: Buffer.alloc(16).toString('base64url'),
    }
    route(phone, phoneGeneration, envelope)
    const next = { ...envelope, counter: 'AAAAAAAAAAE' }
    route(phone, phoneGeneration, next)
    await phone.closed
    expect(pc.readyState).toBe(SocketTransport.OPEN)
  })
})
