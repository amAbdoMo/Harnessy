/** Private device-preview replies are bounded, exactly correlated and retired with their Host effect. */
import { Context } from '@deepseek-ai/cordis'
import type {
  DevicePreviewObservation,
  DevicePreviewObserveRequest,
  DevicePreviewOpenRequest,
  DevicePreviewRequestId,
} from '@deepseek-ai/dsh-client-ui-device-preview/types'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { installDevicePreviewParentChannel } from '../src/device-preview-parent.ts'

const OPEN: Omit<DevicePreviewOpenRequest, 'type' | 'requestId'> = {
  previewId: '28df1ef0-4b04-4c59-b64a-13192d66a32c' as DevicePreviewOpenRequest['previewId'],
  sessionId: 'initiating-session' as DevicePreviewOpenRequest['sessionId'],
  server: { cwd: '/project', url: 'http://127.0.0.1:3000', ownership: 'external', status: 'external' },
}
const OBSERVE: Omit<DevicePreviewObserveRequest, 'type' | 'requestId'> = {
  previewId: OPEN.previewId, sessionId: OPEN.sessionId, slot: 'phone', operation: 'layout',
}
const OPENED = { kind: 'opened' as const, previewId: OPEN.previewId }
const LAYOUT: DevicePreviewObservation = { kind: 'layout', text: '{"viewport":{"width":390,"height":844},"document":{"width":390,"height":844},"horizontalOverflow":false,"truncated":false,"overflow":[]}', width: 390, height: 844 }
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const SCREENSHOT: DevicePreviewObservation = { kind: 'screenshot', base64: PNG, mimeType: 'image/png', width: 1, height: 1 }

afterEach(() => { vi.useRealTimers() })

it('delivers only exact Main retirement identifiers and removes callbacks on unsubscribe and channel close', () => {
  const f = fixture()
  const retired = vi.fn()
  const remove = f.channel.onRetired(retired)
  expect(f.channel.receive({ type: 'device-preview-retired', previewId: OPEN.previewId })).toBe(true)
  expect(retired).toHaveBeenCalledExactlyOnceWith(OPEN.previewId)
  remove()
  f.channel.receive({ type: 'device-preview-retired', previewId: OPEN.previewId })
  expect(retired).toHaveBeenCalledOnce()
  f.channel.onRetired(retired)
  f.channel.close()
  f.channel.receive({ type: 'device-preview-retired', previewId: OPEN.previewId })
  expect(retired).toHaveBeenCalledOnce()
})

it.each([{ previewId: 'not-a-preview' }, { previewId: OPEN.previewId, projectId: OPEN.previewId }, { previewId: undefined }])(
  'ignores malformed retirement fields %j without forgetting an occurrence', (fields) => {
    const f = fixture()
    const retired = vi.fn()
    f.channel.onRetired(retired)
    expect(f.channel.receive({ type: 'device-preview-retired', ...fields })).toBe(true)
    expect(retired).not.toHaveBeenCalled()
  },
)

it('contains a retirement consumer failure without losing another consumer', () => {
  const f = fixture()
  const retired = vi.fn()
  f.channel.onRetired(() => { throw new Error('Inert retirement consumer failed') })
  f.channel.onRetired(retired)
  expect(() => f.channel.receive({ type: 'device-preview-retired', previewId: OPEN.previewId })).not.toThrow()
  expect(retired).toHaveBeenCalledExactlyOnceWith(OPEN.previewId)
})

function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const send = vi.fn(async (_message: object) => {})
  const channel = installDevicePreviewParentChannel(ctx, send)
  return { ctx, send, channel }
}

function requestId(f: ReturnType<typeof fixture>, index = 0): DevicePreviewRequestId {
  const command = f.send.mock.calls[index]?.[0]
  if (command === undefined || !('requestId' in command) || typeof command.requestId !== 'string') {
    throw new Error('Expected a correlated private command')
  }
  return command.requestId as DevicePreviewRequestId
}

function success(requestId: DevicePreviewRequestId, result: object = OPENED) {
  return { type: 'device-preview-result', requestId, ok: true, result }
}

function tracked<T>(promise: Promise<T>) {
  const state: { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = { status: 'pending' }
  const done = promise.then((value) => { state.status = 'resolved'; state.value = value },
    (error: unknown) => { state.status = 'rejected'; state.error = error })
  return { state, done }
}

function mutatedPng(change: (bytes: Buffer) => void): string {
  const bytes = Buffer.from(PNG, 'base64')
  change(bytes)
  return bytes.toString('base64')
}

it('keeps opening and observations separate and correlates concurrent UUID requests out of order', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  const opening = f.channel.open(OPEN, signal)
  const layout = f.channel.observe(OBSERVE, signal)
  const screenshot = f.channel.observe({ ...OBSERVE, slot: 'tablet', operation: 'screenshot' }, signal)
  const ids = [requestId(f), requestId(f, 1), requestId(f, 2)]
  expect(new Set(ids).size).toBe(3)
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(f.send.mock.calls.map(([message]) => message)).toEqual([
    { type: 'device-preview-open', requestId: ids[0], ...OPEN },
    { type: 'device-preview-observe', requestId: ids[1], ...OBSERVE },
    { type: 'device-preview-observe', requestId: ids[2], ...OBSERVE, slot: 'tablet', operation: 'screenshot' },
  ])
  f.channel.receive(success(ids[2]!, SCREENSHOT))
  f.channel.receive(success(ids[0]!))
  f.channel.receive(success(ids[1]!, LAYOUT))
  await expect(opening).resolves.toEqual(OPENED)
  await expect(layout).resolves.toEqual(LAYOUT)
  await expect(screenshot).resolves.toEqual(SCREENSHOT)
})

it('consumes invalid, unrelated, duplicate and late ids without settling another request', async () => {
  const f = fixture()
  expect(f.channel.receive(null)).toBe(false)
  expect(f.channel.receive([])).toBe(false)
  expect(f.channel.receive({ type: 'website-operation-result' })).toBe(false)
  const opening = tracked(f.channel.open(OPEN, new AbortController().signal))
  const id = requestId(f)
  for (const requestId of [undefined, 1, '', 'not-a-uuid', id.toUpperCase(), '00000000-0000-4000-8000-000000000000']) {
    expect(f.channel.receive({ ...success(id), requestId })).toBe(true)
  }
  await Promise.resolve()
  expect(opening.state.status).toBe('pending')
  expect(f.channel.receive(success(id))).toBe(true)
  await opening.done
  expect(opening.state.value).toEqual(OPENED)
  const next = tracked(f.channel.observe(OBSERVE, new AbortController().signal))
  f.channel.receive(success(id, { kind: 'layout', text: 'late', width: 1, height: 1 }))
  await Promise.resolve()
  expect(next.state.status).toBe('pending')
  f.channel.receive(success(requestId(f, 1), LAYOUT))
  await next.done
  expect(next.state.value).toEqual(LAYOUT)
})

it.each([
  ['other preview', { ...OPENED, previewId: 'other' }],
  ['observation instead of opening', LAYOUT],
  ['launcher stop instead of opening', { kind: 'stopped', projectId: 'owned-project' }],
  ['missing preview', { kind: 'opened' }],
  ['extra opening fields', { ...OPENED, token: 'secret' }],
])('rejects a correlated opening with %s', async (_name, result) => {
  const f = fixture()
  const pending = f.channel.open(OPEN, new AbortController().signal)
  f.channel.receive(success(requestId(f), result))
  await expect(pending).rejects.toThrow('response is invalid')
})

it.each([
  ['wrong observation kind', 'layout', SCREENSHOT],
  ['opening instead of observation', 'screenshot', OPENED],
  ['non-PNG MIME', 'screenshot', { ...SCREENSHOT, mimeType: 'image/jpeg' }],
  ['empty PNG', 'screenshot', { ...SCREENSHOT, base64: '' }],
  ['invalid alphabet', 'screenshot', { ...SCREENSHOT, base64: '!!!!' }],
  ['base64 whitespace', 'screenshot', { ...SCREENSHOT, base64: `${PNG}\n` }],
  ['missing base64 padding', 'screenshot', { ...SCREENSHOT, base64: PNG.slice(0, -1) }],
  ['noncanonical padding bits', 'screenshot', { ...SCREENSHOT, base64: `${PNG.slice(0, -2)}J=` }],
  ['truncated IHDR', 'screenshot', { ...SCREENSHOT, base64: Buffer.from(PNG, 'base64').subarray(0, 24).toString('base64') }],
  ['wrong signature', 'screenshot', { ...SCREENSHOT, base64: mutatedPng((bytes) => { bytes[0] = 0 }) }],
  ['wrong first chunk', 'screenshot', { ...SCREENSHOT, base64: mutatedPng((bytes) => { bytes.write('IDAT', 12, 'ascii') }) }],
  ['wrong IHDR length', 'screenshot', { ...SCREENSHOT, base64: mutatedPng((bytes) => { bytes.writeUInt32BE(12, 8) }) }],
  ['invalid bit depth', 'screenshot', { ...SCREENSHOT, base64: mutatedPng((bytes) => { bytes[24] = 3 }) }],
  ['invalid color type', 'screenshot', { ...SCREENSHOT, base64: mutatedPng((bytes) => { bytes[25] = 1 }) }],
  ['invalid compression', 'screenshot', { ...SCREENSHOT, base64: mutatedPng((bytes) => { bytes[26] = 1 }) }],
  ['invalid filter', 'screenshot', { ...SCREENSHOT, base64: mutatedPng((bytes) => { bytes[27] = 1 }) }],
  ['invalid interlace', 'screenshot', { ...SCREENSHOT, base64: mutatedPng((bytes) => { bytes[28] = 2 }) }],
  ['header width mismatch', 'screenshot', { ...SCREENSHOT, width: 2 }],
  ['header height mismatch', 'screenshot', { ...SCREENSHOT, height: 2 }],
  ['nonstring layout', 'layout', { ...LAYOUT, text: 1 }],
  ['oversized ASCII layout', 'layout', { ...LAYOUT, text: 'x'.repeat(32 * 1024 + 1) }],
  ['extra layout fields', 'layout', { ...LAYOUT, html: '<secret>' }],
  ['extra screenshot fields', 'screenshot', { ...SCREENSHOT, url: 'file:///secret' }],
] as const)('rejects %s before returning observation data', async (_name, operation, result) => {
  const f = fixture()
  const pending = f.channel.observe({ ...OBSERVE, operation }, new AbortController().signal)
  f.channel.receive(success(requestId(f), result))
  await expect(pending).rejects.toThrow('response is invalid')
})

it.each([0, -1, 1.5, NaN, Infinity, 8193, '390', undefined])('rejects invalid layout dimensions: %s', async (dimension) => {
  const f = fixture()
  const width = f.channel.observe(OBSERVE, new AbortController().signal)
  const height = f.channel.observe(OBSERVE, new AbortController().signal)
  f.channel.receive(success(requestId(f), { ...LAYOUT, width: dimension }))
  f.channel.receive(success(requestId(f, 1), { ...LAYOUT, height: dimension }))
  await expect(width).rejects.toThrow('response is invalid')
  await expect(height).rejects.toThrow('response is invalid')
})

it.each([
  ['missing verdict', { ok: undefined }],
  ['nonboolean verdict', { ok: 'true' }],
  ['missing result', { result: undefined }],
  ['null result', { result: null }],
  ['array result', { result: [] }],
  ['extra envelope field', { extra: 'secret' }],
  ['error alongside success', { error: 'secret' }],
  ['result alongside failure', { ok: false, error: 'refused' }],
])('rejects malformed correlated responses: %s', async (_name, change) => {
  const f = fixture()
  const pending = f.channel.open(OPEN, new AbortController().signal)
  f.channel.receive({ ...success(requestId(f)), ...change })
  await expect(pending).rejects.toThrow('response is invalid')
})

it.each([undefined, null, 42, {}, 'x'.repeat(2049)])('rejects invalid native errors without reflecting their contents: %s', async (error) => {
  const f = fixture()
  const pending = f.channel.open(OPEN, new AbortController().signal)
  f.channel.receive({ type: 'device-preview-result', requestId: requestId(f), ok: false, error })
  await expect(pending).rejects.toThrow('response is invalid')
})

it.each([1, 8192])('accepts layout dimensions at the inclusive limit %i', async (dimension) => {
  const f = fixture()
  const pending = f.channel.observe(OBSERVE, new AbortController().signal)
  const layout = { ...LAYOUT, width: dimension, height: dimension }
  f.channel.receive(success(requestId(f), layout))
  await expect(pending).resolves.toEqual(layout)
})

it('validates all response fields before serializing unknown or cyclic content', async () => {
  const f = fixture()
  const toJSON = vi.fn(() => { throw new Error('Untrusted serializer executed') })
  const cycle: { self?: object; toJSON: typeof toJSON } = { toJSON }
  cycle.self = cycle
  const pending = f.channel.open(OPEN, new AbortController().signal)
  expect(() => f.channel.receive({ ...success(requestId(f)), extra: cycle })).not.toThrow()
  await expect(pending).rejects.toThrow('response is invalid')
  expect(toJSON).not.toHaveBeenCalled()
})

it.each([['layout', 32 * 1024], ['error', 2048]] as const)('bounds %s content in UTF-8 bytes', async (kind, limit) => {
  const f = fixture()
  for (const bytes of [0, limit, limit + 1]) {
    const text = `${'é'.repeat(Math.floor(bytes / 2))}${'x'.repeat(bytes % 2)}`
    const pending = f.channel.observe(OBSERVE, new AbortController().signal)
    const id = requestId(f, f.send.mock.calls.length - 1)
    const packet = kind === 'layout' ? success(id, { ...LAYOUT, text }) : { type: 'device-preview-result', requestId: id, ok: false, error: text }
    f.channel.receive(packet)
    if (bytes > limit || (kind === 'layout' && Buffer.byteLength(JSON.stringify(packet)) > 32 * 1024)) {
      await expect(pending).rejects.toThrow('response is invalid')
    }
    else if (kind === 'layout') await expect(pending).resolves.toEqual({ ...LAYOUT, text })
    else await expect(pending).rejects.toThrow(text)
  }
})

it.each([32 * 1024, 32 * 1024 + 1])('bounds the complete escaped layout envelope at %i bytes', async (bytes) => {
  const f = fixture()
  const pending = f.channel.observe(OBSERVE, new AbortController().signal)
  const id = requestId(f)
  const baseBytes = Buffer.byteLength(JSON.stringify(success(id, { ...LAYOUT, text: '' })))
  const padding = bytes - baseBytes
  const text = `${'\n'.repeat(Math.floor(padding / 2))}${'x'.repeat(padding % 2)}`
  const packet = success(id, { ...LAYOUT, text })
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32 * 1024)
  expect(Buffer.byteLength(JSON.stringify(packet))).toBe(bytes)
  f.channel.receive(packet)
  if (bytes === 32 * 1024) await expect(pending).resolves.toEqual({ ...LAYOUT, text })
  else await expect(pending).rejects.toThrow('response is invalid')
})

it('rejects an individually bounded error whose JSON escaping exceeds the envelope ceiling', async () => {
  const f = fixture()
  const pending = f.channel.open(OPEN, new AbortController().signal)
  f.channel.receive({ type: 'device-preview-result', requestId: requestId(f), ok: false, error: '\u0000'.repeat(2048) })
  await expect(pending).rejects.toThrow('response is invalid')
})

it('rejects PNG content beyond the raw and encoded ceilings', async () => {
  const f = fixture()
  const bytes = Buffer.alloc(6 * 1024 * 1024 + 1)
  Buffer.from(PNG, 'base64').copy(bytes)
  const pending = f.channel.observe({ ...OBSERVE, operation: 'screenshot' }, new AbortController().signal)
  f.channel.receive(success(requestId(f), { ...SCREENSHOT, base64: bytes.toString('base64') }))
  await expect(pending).rejects.toThrow('response is invalid')
})

it.each(['abort', 'open-timeout', 'observe-timeout'] as const)('sends an exact cancel on %s and ignores a late response', async (cause) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture()
  const cancellation = new AbortController()
  const pending = cause === 'observe-timeout' ? f.channel.observe(OBSERVE, cancellation.signal) : f.channel.open(OPEN, cancellation.signal)
  const id = requestId(f)
  const rejected = expect(pending).rejects.toThrow(cause === 'abort' ? 'canceled' : 'timed out')
  if (cause === 'abort') cancellation.abort(new Error('private caller details'))
  else {
    const deadline = cause === 'open-timeout' ? 60_000 : 30_000
    await vi.advanceTimersByTimeAsync(deadline - 1)
    expect(f.send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
  }
  await rejected
  expect(f.send).toHaveBeenLastCalledWith({ type: 'device-preview-cancel', requestId: id })
  expect(vi.getTimerCount()).toBe(0)
  f.channel.receive(success(id))
  cancellation.abort()
  expect(f.send).toHaveBeenCalledTimes(2)
})

it.each(['sync', 'async'] as const)('contains %s delivery failure and removes request timers and abort listeners', async (failure) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture()
  if (failure === 'sync') f.send.mockImplementationOnce(() => { throw new Error('secret transport detail') })
  else f.send.mockRejectedValueOnce(new Error('secret transport detail'))
  const cancellation = new AbortController()
  await expect(f.channel.open(OPEN, cancellation.signal)).rejects.toThrow('request delivery failed')
  expect(vi.getTimerCount()).toBe(0)
  cancellation.abort()
  expect(f.send).toHaveBeenCalledOnce()
})

it.each(['sync', 'async'] as const)('keeps local cancellation final when the %s cancel send fails', async (failure) => {
  const f = fixture()
  const cancellation = new AbortController()
  const pending = f.channel.open(OPEN, cancellation.signal)
  if (failure === 'sync') f.send.mockImplementationOnce(() => { throw new Error('secret cancel detail') })
  else f.send.mockRejectedValueOnce(new Error('secret cancel detail'))
  cancellation.abort()
  await expect(pending).rejects.toThrow('canceled')
  f.channel.receive(success(requestId(f)))
  await expect(pending).rejects.toThrow('canceled')
})

it.each(['abort', 'close'] as const)('rejects a queued success overtaken by %s', async (cause) => {
  const f = fixture()
  const cancellation = new AbortController()
  const pending = f.channel.open(OPEN, cancellation.signal)
  f.channel.receive(success(requestId(f)))
  if (cause === 'abort') cancellation.abort()
  else f.channel.close()
  await expect(pending).rejects.toThrow(cause === 'abort' ? 'canceled' : 'stopping')
})

it('bounds pending admission and reuses capacity immediately after cancellation', async () => {
  const f = fixture()
  const cancellations = Array.from({ length: 64 }, () => new AbortController())
  const requests = cancellations.map(cancellation => tracked(f.channel.open(OPEN, cancellation.signal)))
  await expect(f.channel.observe(OBSERVE, new AbortController().signal)).rejects.toThrow('unavailable')
  expect(f.send).toHaveBeenCalledTimes(64)
  cancellations[0]!.abort()
  const next = f.channel.observe(OBSERVE, new AbortController().signal)
  f.channel.receive(success(requestId(f, 65), LAYOUT))
  await expect(next).resolves.toEqual(LAYOUT)
  f.channel.close()
  await Promise.all(requests.map(request => request.done))
  expect(requests.every(request => request.state.status === 'rejected')).toBe(true)
})

it('disposes the Host effect, removes timers/listeners and permanently refuses new requests', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture()
  const cancellation = new AbortController()
  const opening = tracked(f.channel.open(OPEN, cancellation.signal))
  const layout = tracked(f.channel.observe(OBSERVE, cancellation.signal))
  await f.ctx.fiber.dispose()
  await Promise.all([opening.done, layout.done])
  expect(opening.state.error).toEqual(new Error('Device preview Host is stopping'))
  expect(layout.state.error).toEqual(new Error('Device preview Host is stopping'))
  expect(vi.getTimerCount()).toBe(0)
  cancellation.abort()
  f.channel.close()
  f.channel.receive(success(requestId(f)))
  await expect(f.channel.open(OPEN, new AbortController().signal)).rejects.toThrow('unavailable')
  expect(f.send).toHaveBeenCalledTimes(2)
})

it('does not dispatch a pre-aborted request or cancel already completed work', async () => {
  const f = fixture()
  const cancellation = new AbortController()
  cancellation.abort(new Error('private reason'))
  await expect(f.channel.open(OPEN, cancellation.signal)).rejects.toThrow('canceled')
  expect(f.send).not.toHaveBeenCalled()
  const lifetime = new AbortController()
  const completed = f.channel.open(OPEN, lifetime.signal)
  f.channel.receive(success(requestId(f)))
  await completed
  lifetime.abort()
  expect(f.send).toHaveBeenCalledOnce()
})

it('ignores sender rejection after a valid native completion', async () => {
  const f = fixture()
  const delivery = Promise.withResolvers<undefined>()
  f.send.mockImplementationOnce(() => delivery.promise)
  const pending = f.channel.open(OPEN, new AbortController().signal)
  f.channel.receive(success(requestId(f)))
  await expect(pending).resolves.toEqual(OPENED)
  delivery.reject(new Error('late transport detail'))
  await delivery.promise.catch((_error: unknown) => { /* The parent channel also observes this delivery failure. */ })
  await expect(pending).resolves.toEqual(OPENED)
})
