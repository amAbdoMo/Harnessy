/** Real connector and relay-proof crypto with the maintained ws API mocked only at network I/O. */
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRelayChallenge, derivePcId, exportPublicKey, generateP256KeyPair, parseHttpsOrigin, parseId, verifyRelayChallenge,
} from '@deepseek-ai/dsh-companion-protocol'
import type { ChannelId, SocketGeneration } from '@deepseek-ai/dsh-companion-protocol'
import { Connector } from '../src/connector.ts'
import type { RelayConnection, RelayInput } from '../src/connector.ts'
import type { HostBudgets } from '../src/config.ts'
import { config } from './composition.ts'
import { SocketTransport } from './transport.ts'

vi.mock('ws', async () => {
  const { SocketTransport: WebSocket } = await import('./transport.ts')
  return { WebSocket }
})

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  try { for (const release of cleanup.splice(0).reverse()) await release() }
  finally { SocketTransport.instances.length = 0; vi.useRealTimers(); vi.restoreAllMocks() }
})

const channelId = parseId<ChannelId>('phone-channel')
const phoneGeneration = parseId<SocketGeneration>('phone-first')
const otherChannel = parseId<ChannelId>('other-phone')
const otherGeneration = parseId<SocketGeneration>('phone-other')
const pcGeneration = parseId<SocketGeneration>('pc-first')

function fixture(override: Partial<HostBudgets> = {}, input?: (connection: RelayConnection, frame: RelayInput) => Promise<void>) {
  const key = generateP256KeyPair().privateKey
  const publicKey = exportPublicKey(key)
  const pcId = derivePcId(publicKey)
  const origin = parseHttpsOrigin('https://relay.invalid')
  const parent = new AbortController()
  const budgets = { ...config.budgets, ...override }
  const ready: RelayConnection[] = []
  const lost: RelayConnection[] = []
  const inputs: RelayInput[] = []
  const rejected: RelayInput[] = []
  const connector = new Connector({ origin, publicKey, privateKey: key, pcId, budgets, signal: parent.signal,
    ready: (connection) => { ready.push(connection) },
    input: (connection, frame) => { inputs.push(frame); return input?.(connection, frame) ?? Promise.resolve() },
    reject: (_connection, frame) => { rejected.push(frame) },
    lost: async (connection) => { lost.push(connection) },
  })
  cleanup.push(async () => { parent.abort(); await connector.dispose() })
  const ws = SocketTransport.instances.at(-1)!
  const activate = (socket = ws, generation = pcGeneration): RelayConnection => {
    socket.emit('open')
    expect(socket.packets[0]).toEqual({ v: 1, type: 'relay-register', role: 'pc', identityKey: publicKey, targetPcId: pcId })
    const challenge = createRelayChallenge({ role: 'pc', httpsOrigin: origin, identityKey: publicKey,
      targetPcId: pcId, socketGeneration: generation })
    socket.receive(challenge)
    expect(verifyRelayChallenge(challenge, socket.packets[1])).toBe(true)
    socket.receive({ v: 1, type: 'relay-ready', role: 'pc', targetPcId: pcId, socketGeneration: generation })
    return ready.at(-1)!
  }
  return { connector, ws, budgets, ready, lost, inputs, rejected, activate, parent, pcId, publicKey }
}

function envelope(payload: object, generation = phoneGeneration) {
  return { v: 1, type: 'relay-data', channelId, socketGeneration: pcGeneration, phoneSocketGeneration: generation, payload }
}

function packets(ws: SocketTransport): Record<string, unknown>[] { return ws.packets.slice(2) }

function openNotice(owner: ReturnType<typeof fixture>, id = channelId, generation = phoneGeneration) {
  return { v: 1, type: 'relay-channel-open', channelId: id, targetPcId: owner.pcId,
    phoneIdentityKey: owner.publicKey, phoneSocketGeneration: generation, pcSocketGeneration: pcGeneration }
}

describe('companion connector socket ownership and local writes', () => {
  it('binds exact data and close envelopes to both socket generations and requires verified outbound WSS', async () => {
    const owner = fixture()
    const connection = owner.activate()
    expect(owner.ws.url).toBe('wss://relay.invalid/companion/pc')
    expect(owner.ws.options).toMatchObject({ perMessageDeflate: false, followRedirects: false,
      rejectUnauthorized: true, maxPayload: owner.budgets.maxFrameBytes, headers: { Origin: 'https://relay.invalid' } })
    const payload = { channelId, type: 'encrypted' }
    await connection.send(channelId, phoneGeneration, payload, new AbortController().signal)
    await connection.closeChannel(channelId, phoneGeneration)
    await connection.send(channelId, otherGeneration, payload, new AbortController().signal)
    expect(packets(owner.ws)).toEqual([envelope(payload),
      { v: 1, type: 'relay-close', channelId, socketGeneration: pcGeneration, phoneSocketGeneration: phoneGeneration },
      envelope(payload, otherGeneration)])
  })

  it('withdraws queued cancellation without sending and keeps the unrelated channel in order', async () => {
    const owner = fixture()
    const connection = owner.activate()
    owner.ws.blocked = true
    const first = connection.send(channelId, phoneGeneration, { order: 1 }, new AbortController().signal)
    const cancel = new AbortController()
    const second = connection.send(channelId, phoneGeneration, { order: 2 }, cancel.signal)
    const rejected = expect(second).rejects.toThrow('write cancelled')
    const third = connection.send(otherChannel, otherGeneration, { order: 3 }, new AbortController().signal)
    expect(packets(owner.ws)).toEqual([envelope({ order: 1 })])
    cancel.abort()
    await rejected
    owner.ws.blocked = false
    owner.ws.flush()
    await Promise.all([first, third])
    expect(packets(owner.ws).map(packet => packet.payload)).toEqual([{ order: 1 }, { order: 3 }])
    expect(connection.signal.aborted).toBe(false)
  })

  it('rejects cancellation before admission and during serialization without retaining a write', async () => {
    const owner = fixture()
    const connection = owner.activate()
    const cancel = new AbortController()
    cancel.abort()
    await expect(connection.send(channelId, phoneGeneration, { order: 1 }, cancel.signal)).rejects.toThrow()
    const serializeCancel = new AbortController()
    await expect(connection.send(channelId, phoneGeneration, {
      toJSON: () => { serializeCancel.abort(); return { order: 2 } },
    }, serializeCancel.signal)).rejects.toThrow()
    expect(packets(owner.ws)).toEqual([])
    await connection.send(otherChannel, otherGeneration, { order: 3 }, new AbortController().signal)
    expect(connection.signal.aborted).toBe(false)
  })

  it('retains cancelled in-flight byte and count reservations until its actual callback, exactly once', async () => {
    const payload = { text: 'é'.repeat(20) }
    const size = Buffer.byteLength(JSON.stringify(envelope(payload)))
    const owner = fixture({ channel: { ...config.budgets.channel, maxQueuedSendBytes: size, maxPendingSends: 1 } })
    const connection = owner.activate()
    owner.ws.blocked = true
    const cancel = new AbortController()
    const first = connection.send(channelId, phoneGeneration, payload, cancel.signal)
    const rejected = expect(first).rejects.toThrow('delivery unknown')
    const callback = owner.ws.takeCallback()
    cancel.abort()
    await rejected
    await expect(connection.send(channelId, phoneGeneration, {}, new AbortController().signal)).rejects.toThrow('send budget')
    await expect(connection.closeChannel(channelId, phoneGeneration)).rejects.toThrow('send budget')
    const unrelated = connection.send(otherChannel, otherGeneration, { other: true }, new AbortController().signal)
    expect(packets(owner.ws)).toHaveLength(1)
    callback()
    expect(packets(owner.ws)).toHaveLength(2)
    const unrelatedCallback = owner.ws.takeCallback()
    const next = connection.send(channelId, phoneGeneration, payload, new AbortController().signal)
    callback(new Error('late duplicate failure'))
    await expect(connection.send(channelId, phoneGeneration, {}, new AbortController().signal)).rejects.toThrow('send budget')
    expect(connection.signal.aborted).toBe(false)
    unrelatedCallback()
    owner.ws.blocked = false
    owner.ws.flush()
    await Promise.all([unrelated, next])
    expect(packets(owner.ws).map(packet => packet.payload)).toEqual([payload, { other: true }, payload])
  })

  it.each(['frame bytes', 'channel bytes', 'channel count', 'global bytes', 'global count', 'byte rate'] as const)(
    'rejects %s admission and best-effort close pressure without stopping the shared PC', async (limit) => {
      const owner = fixture({ maxPendingMessages: limit === 'global count' ? 1 : 20,
        bytesPerSecond: limit === 'byte rate' ? 2000 : 1000000,
        maxSendQueuedBytes: limit === 'global bytes' ? 16384 : 65536,
        channel: { ...config.budgets.channel,
          maxQueuedSendBytes: limit === 'channel bytes' ? 256 : 65536,
          maxPendingSends: limit === 'channel count' ? 1 : 20 } })
      const connection = owner.activate()
      const signal = new AbortController().signal
      owner.ws.blocked = true
      let admitted: Promise<void> | undefined
      if (limit.endsWith('count') || limit === 'global bytes') {
        admitted = connection.send(channelId, phoneGeneration,
          { text: limit === 'global bytes' ? 'x'.repeat(15000) : 'first' }, signal)
      }
      const payload = { text: 'é'.repeat(limit === 'frame bytes' ? Math.ceil(owner.budgets.maxFrameBytes / 2) : 1000) }
      await expect(connection.send(channelId, phoneGeneration, payload, signal)).rejects.toThrow('budget')
      if (limit.endsWith('count')) await expect(connection.closeChannel(channelId, phoneGeneration)).rejects.toThrow('budget')
      expect(connection.signal.aborted).toBe(false)
      owner.ws.blocked = false
      owner.ws.flush()
      await admitted
      await connection.send(otherChannel, otherGeneration, {}, signal)
      expect(owner.ws.readyState).toBe(SocketTransport.OPEN)
    },
  )

  it('admits an exact complete UTF-8 envelope and rejects the next byte without consuming queue capacity', async () => {
    const payload = { text: 'é"\n' }
    const size = Buffer.byteLength(JSON.stringify(envelope(payload)))
    const owner = fixture({ channel: { ...config.budgets.channel, maxQueuedSendBytes: size } })
    const connection = owner.activate()
    const signal = new AbortController().signal
    await connection.send(channelId, phoneGeneration, payload, signal)
    await expect(connection.send(channelId, phoneGeneration, { text: payload.text + 'x' }, signal)).rejects.toThrow('send budget')
    await connection.send(channelId, phoneGeneration, payload, signal)
    expect(packets(owner.ws)).toEqual([envelope(payload), envelope(payload)])
    expect(connection.signal.aborted).toBe(false)
  })

  it('bounds total retained envelope bytes and recovers capacity after a queued cancellation', async () => {
    const owner = fixture({ maxSendQueuedBytes: 16384 })
    const connection = owner.activate()
    owner.ws.blocked = true
    const payload = { text: 'x'.repeat(7800) }
    const first = connection.send(channelId, phoneGeneration, payload, new AbortController().signal)
    const cancel = new AbortController()
    const queued = connection.send(channelId, phoneGeneration, payload, cancel.signal)
    const rejected = expect(queued).rejects.toThrow('write cancelled')
    await expect(connection.send(otherChannel, otherGeneration, { text: 'x'.repeat(1000) }, new AbortController().signal))
      .rejects.toThrow('send budget')
    cancel.abort()
    await rejected
    const other = connection.send(otherChannel, otherGeneration, { text: 'x'.repeat(1000) }, new AbortController().signal)
    owner.ws.blocked = false
    owner.ws.flush()
    await Promise.all([first, other])
    expect(packets(owner.ws)).toHaveLength(2)
  })

  it('settles all writes and joins admitted delivery when the local sender never calls back on close', async () => {
    let finishDelivery = (): void => {}
    const delivered = new Promise<void>((resolve) => { finishDelivery = resolve })
    const owner = fixture({}, async (connection) => {
      await new Promise<void>((resolve) => { connection.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      finishDelivery()
    })
    const connection = owner.activate()
    owner.ws.receive({ v: 1, type: 'relay-channel-close', channelId,
      phoneSocketGeneration: phoneGeneration, pcSocketGeneration: pcGeneration })
    owner.ws.blocked = true
    owner.ws.flushOnTerminate = false
    const sent = connection.send(channelId, phoneGeneration, {}, new AbortController().signal)
    const queued = connection.send(otherChannel, otherGeneration, {}, new AbortController().signal)
    const sentRejection = expect(sent).rejects.toThrow('delivery unknown')
    const queuedRejection = expect(queued).rejects.toThrow('socket stopped')
    await owner.connector.dispose()
    await Promise.all([sentRejection, queuedRejection, delivered])
    expect(owner.lost).toEqual([connection])
    expect(owner.ws.listenerCount('message')).toBe(0)
    expect(owner.ws.listenerCount('error')).toBe(0)
    owner.ws.flush()
    expect(packets(owner.ws)).toHaveLength(1)
  })

  it('reconnects to the same PC without resending and ignores stale sender callbacks after socket close', async () => {
    vi.useFakeTimers()
    const owner = fixture({ reconnectAttempts: 2 })
    const firstConnection = owner.activate()
    owner.ws.blocked = true
    owner.ws.flushOnTerminate = false
    const sent = firstConnection.send(channelId, phoneGeneration, {}, new AbortController().signal)
    const rejected = expect(sent).rejects.toThrow('delivery unknown')
    const staleCallback = owner.ws.takeCallback()
    firstConnection.stop()
    await rejected
    await vi.advanceTimersByTimeAsync(owner.budgets.reconnectInitialMs)
    const nextSocket = SocketTransport.instances.at(-1)!
    expect(nextSocket).not.toBe(owner.ws)
    const nextGeneration = parseId<SocketGeneration>('pc-next')
    const successor = owner.activate(nextSocket, nextGeneration)
    await expect(firstConnection.send(channelId, otherGeneration, {}, new AbortController().signal)).rejects.toThrow()
    await expect(firstConnection.closeChannel(channelId, otherGeneration)).rejects.toThrow()
    owner.ws.receive({ v: 1, type: 'relay-ready', role: 'pc', targetPcId: owner.pcId, socketGeneration: pcGeneration })
    staleCallback(new Error('old transport failure'))
    staleCallback()
    expect(packets(nextSocket)).toEqual([])
    await successor.send(channelId, otherGeneration, {}, new AbortController().signal)
    expect(packets(nextSocket)).toEqual([{ v: 1, type: 'relay-data', channelId,
      socketGeneration: nextGeneration, phoneSocketGeneration: otherGeneration, payload: {} }])
    expect(successor.signal.aborted).toBe(false)
    successor.stop()
    await vi.advanceTimersByTimeAsync(owner.budgets.reconnectMaxMs)
    expect(SocketTransport.instances).toHaveLength(3)
    const thirdSocket = SocketTransport.instances.at(-1)!
    const third = owner.activate(thirdSocket, parseId<SocketGeneration>('pc-third'))
    expect(packets(thirdSocket)).toEqual([])
    third.stop()
    await vi.advanceTimersByTimeAsync(owner.budgets.reconnectInitialMs)
    expect(SocketTransport.instances).toHaveLength(4)
  })

  it.each(['pending registration', 'reconnect delay'] as const)('dispose interrupts %s without another socket', async (phase) => {
    vi.useFakeTimers()
    const owner = fixture({ reconnectAttempts: 2 })
    if (phase === 'reconnect delay') {
      owner.activate().stop()
      // Drain owned close/lost continuations without advancing the deployment retry clock.
      await vi.advanceTimersByTimeAsync(0)
    }
    await owner.connector.dispose()
    await vi.advanceTimersByTimeAsync(owner.budgets.reconnectMaxMs)
    expect(SocketTransport.instances).toHaveLength(1)
    expect(owner.ws.listenerCount('message')).toBe(0)
  })

  it('retires a genuinely stalled shared sender at the configured local-write deadline', async () => {
    vi.useFakeTimers()
    const owner = fixture()
    const connection = owner.activate()
    owner.ws.blocked = true
    owner.ws.flushOnTerminate = false
    const sent = connection.send(channelId, phoneGeneration, {}, new AbortController().signal)
    const rejected = expect(sent).rejects.toThrow('delivery unknown')
    await vi.advanceTimersByTimeAsync(owner.budgets.channel.sendTimeoutMs)
    await rejected
    await owner.connector.dispose()
    expect(connection.signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    owner.ws.flush()
  })

  it('attributes active receive-count saturation to the routed phone without retiring the shared PC', async () => {
    const held = Promise.withResolvers<undefined>()
    const owner = fixture({ maxPendingMessages: 1 }, (_connection, frame) =>
      frame.channelId === channelId ? held.promise : Promise.resolve())
    cleanup.push(() => { held.resolve(undefined); return Promise.resolve() })
    const connection = owner.activate()
    owner.ws.receive(openNotice(owner))
    owner.ws.receive({ v: 1, type: 'relay-channel-close', channelId,
      phoneSocketGeneration: phoneGeneration, pcSocketGeneration: pcGeneration })
    expect(owner.rejected).toEqual([{ type: 'close', channelId, phoneGeneration }])
    expect(connection.signal.aborted).toBe(false)
    expect(owner.lost).toEqual([])
    held.resolve(undefined)
    await held.promise
    owner.ws.receive(openNotice(owner, otherChannel, otherGeneration))
    expect(owner.inputs.at(-1)).toMatchObject({ type: 'open', channelId: otherChannel, phoneGeneration: otherGeneration })
    expect(connection.signal.aborted).toBe(false)
  })

  it('attributes active byte-rate saturation to the routed phone and resumes another phone after refill', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const owner = fixture({ bytesPerSecond: 2000 })
    const connection = owner.activate()
    const notice = openNotice(owner)
    const attempts = Math.ceil(owner.budgets.bytesPerSecond / Buffer.byteLength(JSON.stringify(notice))) + 1
    for (let index = 0; index < attempts; index++) {
      owner.ws.receive({ ...notice, phoneSocketGeneration: `phone-attempt-${index}` })
      await Promise.resolve()
    }
    expect(owner.rejected.length).toBeGreaterThan(0)
    expect(owner.rejected.every(frame => frame.channelId === channelId)).toBe(true)
    expect(connection.signal.aborted).toBe(false)
    expect(owner.lost).toEqual([])
    clock.mockReturnValue(1000)
    owner.ws.receive(openNotice(owner, otherChannel, otherGeneration))
    expect(owner.inputs.at(-1)).toMatchObject({ type: 'open', channelId: otherChannel, phoneGeneration: otherGeneration })
    expect(connection.signal.aborted).toBe(false)
  })

  it('delegates retired phone generations to the parent while rejecting stale PC authentication', async () => {
    const owner = fixture({}, async () => { throw new Error('Parent rejected one retired channel') })
    const connection = owner.activate()
    const close = { v: 1, type: 'relay-channel-close', channelId,
      phoneSocketGeneration: phoneGeneration, pcSocketGeneration: pcGeneration }
    owner.ws.receive(close)
    await Promise.resolve()
    expect(owner.inputs).toEqual([{ type: 'close', channelId, phoneGeneration }])
    await connection.send(otherChannel, otherGeneration, {}, new AbortController().signal)
    expect(connection.signal.aborted).toBe(false)
    owner.ws.receive({ ...close, pcSocketGeneration: 'retired-pc' })
    expect(connection.signal.aborted).toBe(true)
  })
})
