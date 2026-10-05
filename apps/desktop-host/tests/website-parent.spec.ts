/** Private admission and operation settlement remain tied to exact captured replies and Host lifetime. */
import { Context } from '@deepseek-ai/cordis'
import type { DesktopWebsiteHostSnapshot, DesktopWebsitePageInfo } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installWebsiteParentChannel, WebsiteOperationUnknownOutcomeError } from '../src/website-parent.ts'

const REQUEST: DesktopWebsiteHostSnapshot = { id: '38ac2aa4-f8ce-4b37-951c-80a4c0c117ce' as DesktopWebsiteHostSnapshot['id'],
  profile: 'cd1b6493-c881-4967-a544-b0a49f2d847f' as DesktopWebsiteHostSnapshot['profile'],
  sessionId: 'owner' as DesktopWebsiteHostSnapshot['sessionId'], epoch: 1, status: 'pending' }

function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const send = vi.fn(async (_message: object) => {})
  const channel = installWebsiteParentChannel(ctx, send)
  return { ctx, send, channel }
}

it('waits for Main to capture its exact domain request and separately authorize an operation', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  const prepared = f.channel.prepare(REQUEST, signal)
  expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: 'website-prepared', snapshot: REQUEST })
  f.channel.receive({ type: 'website-prepared-ack', id: 'unrelated' })
  f.channel.receive({ type: 'website-prepared-ack', id: REQUEST.id })
  await prepared
  const granted = { ...REQUEST, status: 'granted' as const }
  const checking = f.channel.check(granted, signal)
  expect(f.send).toHaveBeenLastCalledWith({ type: 'website-check', requestId: 1, snapshot: granted })
  f.channel.receive({ type: 'website-check-result', requestId: 2, accepted: true })
  f.channel.receive({ type: 'website-check-result', requestId: 1, accepted: false, error: 'Native tab is hidden' })
  await expect(checking).rejects.toThrow('Native tab is hidden')
})

it('checks cancellation again even if an accepted native reply was already queued', async () => {
  const f = fixture()
  const cancellation = new AbortController()
  const pending = f.channel.check({ ...REQUEST, status: 'granted' }, cancellation.signal)
  f.channel.receive({ type: 'website-check-result', requestId: 1, accepted: true })
  cancellation.abort(new Error('Taken over'))
  await expect(pending).rejects.toThrow('Taken over')
})

it('cancels pending admission and ignores a late native response', async () => {
  const f = fixture()
  const cancellation = new AbortController()
  const pending = f.channel.check({ ...REQUEST, status: 'granted' }, cancellation.signal)
  const rejected = expect(pending).rejects.toThrow('canceled')
  cancellation.abort()
  await rejected
  expect(f.channel.receive({ type: 'website-check-result', requestId: 1, accepted: true })).toBe(true)
  const next = f.channel.check({ ...REQUEST, status: 'granted' }, new AbortController().signal)
  f.channel.receive({ type: 'website-check-result', requestId: 2, accepted: true })
  await next
})

it('bounds unanswered native admission and restores timer ownership', async () => {
  const f = fixture()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  onTestFinished(() => { vi.useRealTimers() })
  const pending = f.channel.check({ ...REQUEST, status: 'granted' }, new AbortController().signal)
  const rejected = expect(pending).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(10_000)
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects pending handoff when the Host effect disposes and blocks new calls', async () => {
  const f = fixture()
  const pending = f.channel.prepare(REQUEST, new AbortController().signal)
  const rejected = expect(pending).rejects.toThrow('stopping')
  await f.ctx.fiber.dispose()
  await rejected
  await expect(f.channel.prepare(REQUEST, new AbortController().signal)).rejects.toThrow('unavailable')
  expect(f.send).toHaveBeenCalledOnce()
})

it('refuses malformed native verdicts and errors without accepting another channel', async () => {
  const f = fixture()
  expect(f.channel.receive({ type: 'other', requestId: 1 })).toBe(false)
  const pending = f.channel.check({ ...REQUEST, status: 'granted' }, new AbortController().signal)
  f.channel.receive({ type: 'website-check-result', requestId: 1, accepted: 'true', error: 'x'.repeat(2049) })
  await expect(pending).rejects.toThrow('admission was refused')
})

const GRANTED: DesktopWebsiteHostSnapshot = { ...REQUEST, status: 'granted' }
const PAGE_INFO: DesktopWebsitePageInfo = { origin: 'https://example.com', title: 'Account home', titleTruncated: false }

function terminal(operationId = 1, snapshot = GRANTED, value = PAGE_INFO) {
  return { type: 'website-operation-result', operationId, snapshot, outcome: 'success', value }
}

function deferredOutcome<T>(promise: Promise<T>) {
  const outcome: { state: 'pending' | 'resolved' | 'rejected'; error?: unknown; value?: T } = { state: 'pending' }
  const observed = promise.then((value) => {
    outcome.state = 'resolved'
    outcome.value = value
  }, (error: unknown) => {
    outcome.state = 'rejected'
    outcome.error = error
  })
  return { outcome, observed }
}

it('correlates concurrent observations, captures the snapshot, and returns only native page info', async () => {
  const f = fixture()
  const snapshot = { ...GRANTED }
  const first = f.channel.beginOperation(snapshot, 'page-info', new AbortController().signal)
  const second = f.channel.beginOperation(GRANTED, 'page-info', new AbortController().signal)
  expect(f.send.mock.calls.map(([message]) => message)).toEqual([
    { type: 'website-operation', operationId: 1, snapshot: GRANTED, operation: 'page-info' },
    { type: 'website-operation', operationId: 2, snapshot: GRANTED, operation: 'page-info' },
  ])
  snapshot.epoch = 2
  expect(f.channel.receive(terminal(2))).toBe(true)
  f.channel.receive(terminal(1))
  await expect(first.result).resolves.toEqual(PAGE_INFO)
  await expect(second.result).resolves.toEqual(PAGE_INFO)
  await Promise.all([first.settled, second.settled])
})

it('rejects logical cancellation while blocked native work retains physical settlement', async () => {
  const f = fixture()
  const cancellation = new AbortController()
  const handle = f.channel.beginOperation(GRANTED, 'page-info', cancellation.signal)
  const settled = deferredOutcome(handle.settled)
  const rejected = expect(handle.result).rejects.toThrow('canceled')
  const nativeCompletion = Promise.withResolvers<undefined>()
  const nativeReply = nativeCompletion.promise.then(() => f.channel.receive(terminal()))
  cancellation.abort(new Error('secret abort reason'))
  await rejected
  expect(f.send).toHaveBeenLastCalledWith({ type: 'website-operation-cancel', operationId: 1 })
  expect(settled.outcome.state).toBe('pending')
  nativeCompletion.resolve(undefined)
  await nativeReply
  await settled.observed
  expect(settled.outcome.state).toBe('resolved')
  await expect(handle.result).rejects.toThrow('canceled')
})

it('uses caller deadlines without treating elapsed time as physical completion', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  onTestFinished(() => { vi.useRealTimers() })
  const f = fixture()
  const cancellation = new AbortController()
  const handle = f.channel.beginOperation(GRANTED, 'page-info', cancellation.signal)
  const settled = deferredOutcome(handle.settled)
  const rejected = expect(handle.result).rejects.toThrow('canceled')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(settled.outcome.state).toBe('pending')
  cancellation.abort()
  await rejected
  await vi.advanceTimersByTimeAsync(60_000)
  expect(settled.outcome.state).toBe('pending')
  f.channel.receive({ type: 'website-operation-result', operationId: 1, snapshot: GRANTED, outcome: 'rejected' })
  await settled.observed
  expect(settled.outcome.state).toBe('resolved')
  expect(vi.getTimerCount()).toBe(0)
})

it('settles native rejection without poisoning request drainage or disclosing wire errors', async () => {
  const f = fixture()
  const handle = f.channel.beginOperation(GRANTED, 'page-info', new AbortController().signal)
  f.channel.receive({ type: 'website-operation-result', operationId: 1, snapshot: GRANTED, outcome: 'rejected' })
  await expect(handle.result).rejects.toThrow('Website operation was rejected')
  await expect(handle.settled).resolves.toBeUndefined()
})

it('checks cancellation again when a successful terminal has already been queued', async () => {
  const f = fixture()
  const cancellation = new AbortController()
  const handle = f.channel.beginOperation(GRANTED, 'page-info', cancellation.signal)
  f.channel.receive(terminal())
  cancellation.abort(new Error('secret'))
  await expect(handle.result).rejects.toThrow('Website operation was canceled')
  await handle.settled
})

it.each(['async', 'sync'] as const)('retains ambiguous %s start-send failure until a valid terminal without recovering failed drainage', async (failure) => {
  const f = fixture()
  if (failure === 'async') f.send.mockRejectedValueOnce(new Error('secret channel details'))
  else f.send.mockImplementationOnce(() => { throw new Error('secret channel details') })
  const cancellation = new AbortController()
  const handle = f.channel.beginOperation(GRANTED, 'page-info', cancellation.signal)
  await expect(handle.result).rejects.toBeInstanceOf(WebsiteOperationUnknownOutcomeError)
  await expect(handle.settled).rejects.toThrow('Website operation settlement is unknown')
  cancellation.abort()
  expect(f.send).toHaveBeenLastCalledWith({ type: 'website-operation-cancel', operationId: 1 })
  f.channel.receive(terminal())
  await expect(handle.settled).rejects.toBeInstanceOf(WebsiteOperationUnknownOutcomeError)
  await expect(handle.result).rejects.toBeInstanceOf(WebsiteOperationUnknownOutcomeError)
})

it('ignores a late delivery failure once native completion has already been confirmed', async () => {
  const f = fixture()
  const delivery = Promise.withResolvers<undefined>()
  f.send.mockImplementationOnce(() => delivery.promise)
  const handle = f.channel.beginOperation(GRANTED, 'page-info', new AbortController().signal)
  f.channel.receive(terminal())
  await expect(handle.result).resolves.toEqual(PAGE_INFO)
  await handle.settled
  delivery.reject(new Error('late secret channel error'))
  await delivery.promise.catch((_error: unknown) => {})
  await expect(handle.result).resolves.toEqual(PAGE_INFO)
  await expect(handle.settled).resolves.toBeUndefined()
})

it('reports cancellation-send failure as unknown settlement even after logical cancellation', async () => {
  const f = fixture()
  const cancellation = new AbortController()
  const handle = f.channel.beginOperation(GRANTED, 'page-info', cancellation.signal)
  f.send.mockRejectedValueOnce(new Error('secret IPC failure'))
  const rejected = expect(handle.result).rejects.toThrow('canceled')
  cancellation.abort()
  await rejected
  await expect(handle.settled).rejects.toBeInstanceOf(WebsiteOperationUnknownOutcomeError)
  f.channel.receive(terminal())
  await expect(handle.settled).rejects.toBeInstanceOf(WebsiteOperationUnknownOutcomeError)
})

it.each([
  ['request id', { id: 'different' }],
  ['profile', { profile: 'different' }],
  ['session', { sessionId: 'different' }],
  ['epoch', { epoch: 2 }],
  ['status', { status: 'revoked' }],
  ['terminal state', { terminal: true }],
  ['unexpected snapshot field', { token: 'secret' }],
] as const)('treats a matching correlation with the wrong %s as unknown native completion', async (_name, change) => {
  const f = fixture()
  const handle = f.channel.beginOperation(GRANTED, 'page-info', new AbortController().signal)
  f.channel.receive({ ...terminal(), snapshot: { ...GRANTED, ...change } })
  await expect(handle.result).rejects.toBeInstanceOf(WebsiteOperationUnknownOutcomeError)
  await expect(handle.settled).rejects.toBeInstanceOf(WebsiteOperationUnknownOutcomeError)
})

it.each([
  ['missing snapshot', { snapshot: undefined }],
  ['missing outcome', { outcome: undefined }],
  ['nonterminal outcome', { outcome: 'running' }],
  ['missing value', { value: undefined }],
  ['extra error', { error: 'secret native stack' }],
  ['payload on rejection', { outcome: 'rejected' }],
  ['missing truncation flag', { value: { origin: PAGE_INFO.origin, title: PAGE_INFO.title } }],
  ['nonboolean truncation flag', { value: { ...PAGE_INFO, titleTruncated: 'false' } }],
  ['unexpected page field', { value: { ...PAGE_INFO, cookies: 'secret' } }],
  ['oversized origin', { value: { ...PAGE_INFO, origin: `https://${'a'.repeat(2048)}.com` } }],
  ['oversized ASCII title', { value: { ...PAGE_INFO, title: 'a'.repeat(513) } }],
  ['oversized multibyte title', { value: { ...PAGE_INFO, title: '🙂'.repeat(129) } }],
  ['native control stripping missing', { value: { ...PAGE_INFO, title: 'hello\nworld' } }],
  ['C1 title control', { value: { ...PAGE_INFO, title: 'hello\u0085world' } }],
  ['credentials', { value: { ...PAGE_INFO, origin: 'https://user:password@example.com' } }],
  ['path', { value: { ...PAGE_INFO, origin: 'https://example.com/login' } }],
  ['trailing slash', { value: { ...PAGE_INFO, origin: 'https://example.com/' } }],
  ['query', { value: { ...PAGE_INFO, origin: 'https://example.com?token=secret' } }],
  ['fragment', { value: { ...PAGE_INFO, origin: 'https://example.com#secret' } }],
  ['un-normalized origin', { value: { ...PAGE_INFO, origin: 'https://EXAMPLE.com:443' } }],
  ['non-HTTP origin', { value: { ...PAGE_INFO, origin: 'file:///secret' } }],
] as const)('rejects matching malformed terminal: %s', async (_name, change) => {
  const f = fixture()
  const handle = f.channel.beginOperation(GRANTED, 'page-info', new AbortController().signal)
  f.channel.receive({ ...terminal(), ...change })
  await expect(handle.result).rejects.toThrow('Website operation settlement is unknown')
  await expect(handle.settled).rejects.toBeInstanceOf(WebsiteOperationUnknownOutcomeError)
})

it.each([
  { title: '🙂'.repeat(128), titleTruncated: true },
  { title: 'é'.repeat(256), titleTruncated: false },
  { title: '', titleTruncated: false },
])('accepts bounded native-normalized titles: $titleTruncated', async (value) => {
  const f = fixture()
  const handle = f.channel.beginOperation(GRANTED, 'page-info', new AbortController().signal)
  const pageInfo = { ...PAGE_INFO, ...value }
  f.channel.receive(terminal(1, GRANTED, pageInfo))
  await expect(handle.result).resolves.toEqual(pageInfo)
  await handle.settled
})

it.each([4096, 4097])('bounds the complete escaped multibyte terminal envelope at %i UTF-8 bytes', async (bytes) => {
  const f = fixture()
  const pageInfo = { ...PAGE_INFO, title: '"'.repeat(512) }
  const empty = { ...GRANTED, sessionId: '' as DesktopWebsiteHostSnapshot['sessionId'] }
  const baseBytes = Buffer.byteLength(JSON.stringify(terminal(1, empty, pageInfo)), 'utf8')
  const paddingBytes = bytes - baseBytes
  const sessionId = `${'é'.repeat(Math.floor(paddingBytes / 2))}${'a'.repeat(paddingBytes % 2)}` as DesktopWebsiteHostSnapshot['sessionId']
  const snapshot = { ...GRANTED, sessionId }
  const response = terminal(1, snapshot, pageInfo)
  expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBe(bytes)
  const handle = f.channel.beginOperation(snapshot, 'page-info', new AbortController().signal)
  f.channel.receive(response)
  if (bytes === 4096) {
    await expect(handle.result).resolves.toEqual(pageInfo)
    await handle.settled
  } else {
    await expect(handle.result).rejects.toBeInstanceOf(WebsiteOperationUnknownOutcomeError)
    await expect(handle.settled).rejects.toBeInstanceOf(WebsiteOperationUnknownOutcomeError)
  }
})

it('suppresses invalid, wrong, duplicate and late correlation ids without affecting another operation', async () => {
  const f = fixture()
  const first = f.channel.beginOperation(GRANTED, 'page-info', new AbortController().signal)
  const observed = deferredOutcome(first.result)
  const settled = deferredOutcome(first.settled)
  for (const operationId of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, 2, '1', undefined]) {
    expect(f.channel.receive({ ...terminal(), operationId })).toBe(true)
  }
  await Promise.resolve()
  expect(observed.outcome.state).toBe('pending')
  expect(settled.outcome.state).toBe('pending')
  f.channel.receive(terminal())
  await observed.observed
  await settled.observed
  const second = f.channel.beginOperation(GRANTED, 'page-info', new AbortController().signal)
  const next = deferredOutcome(second.result)
  f.channel.receive({ ...terminal(), value: { secret: 'late malformed duplicate' } })
  await Promise.resolve()
  expect(next.outcome.state).toBe('pending')
  f.channel.receive(terminal(2))
  await next.observed
  expect(next.outcome.value).toEqual(PAGE_INFO)
  await second.settled
})

it.each(['aborted', 'send-failed', 'invalid-terminal'] as const)('retains the 64-record cap for %s operations until native terminals arrive', async (disposition) => {
  const f = fixture()
  const cancellation = new AbortController()
  if (disposition === 'send-failed') f.send.mockRejectedValue(new Error('secret'))
  const handles = Array.from({ length: 64 }, () => {
    const handle = f.channel.beginOperation(GRANTED, 'page-info', cancellation.signal)
    return { handle, result: deferredOutcome(handle.result), settled: deferredOutcome(handle.settled) }
  })
  if (disposition === 'aborted') cancellation.abort()
  else if (disposition === 'invalid-terminal') {
    for (let id = 1; id <= 64; ++id) f.channel.receive({ ...terminal(id), value: null })
  }
  await Promise.all(handles.map(handle => handle.result.observed))
  expect(() => f.channel.beginOperation(GRANTED, 'page-info', new AbortController().signal)).toThrow('unavailable')
  expect(f.send.mock.calls.filter(([message]) => 'type' in message && message.type === 'website-operation')).toHaveLength(64)
  f.send.mockResolvedValue(undefined)
  f.channel.receive(terminal(1))
  const next = f.channel.beginOperation(GRANTED, 'page-info', new AbortController().signal)
  expect(f.send).toHaveBeenLastCalledWith({ type: 'website-operation', operationId: 65, snapshot: GRANTED, operation: 'page-info' })
  f.channel.receive(terminal(65))
  await next.result
  await next.settled
  for (let id = 2; id <= 64; ++id) f.channel.receive(terminal(id))
  await Promise.all(handles.map(handle => handle.settled.observed))
  expect(handles.every(handle => handle.settled.outcome.state === (disposition === 'aborted' ? 'resolved' : 'rejected'))).toBe(true)
})

it('removes cancellation listeners on terminal settlement and on Host channel disposal', async () => {
  const f = fixture()
  const firstCancellation = new AbortController()
  const first = f.channel.beginOperation(GRANTED, 'page-info', firstCancellation.signal)
  f.channel.receive(terminal())
  await first.result
  await first.settled
  firstCancellation.abort()
  expect(f.send).toHaveBeenCalledOnce()
  const cancellation = new AbortController()
  const handle = f.channel.beginOperation(GRANTED, 'page-info', cancellation.signal)
  const result = expect(handle.result).rejects.toBeInstanceOf(WebsiteOperationUnknownOutcomeError)
  const settled = expect(handle.settled).rejects.toBeInstanceOf(WebsiteOperationUnknownOutcomeError)
  await f.ctx.fiber.dispose()
  await result
  await settled
  cancellation.abort()
  expect(f.send).toHaveBeenCalledTimes(2)
  f.channel.receive(terminal(2))
  expect(() => f.channel.beginOperation(GRANTED, 'page-info', new AbortController().signal)).toThrow('unavailable')
  await expect(handle.settled).rejects.toBeInstanceOf(WebsiteOperationUnknownOutcomeError)
})

it('does not dispatch an already canceled or oversized operation request', () => {
  const f = fixture()
  const cancellation = new AbortController()
  cancellation.abort(new Error('secret'))
  expect(() => f.channel.beginOperation(GRANTED, 'page-info', cancellation.signal)).toThrow('canceled')
  const oversized = { ...GRANTED, sessionId: 'é'.repeat(2048) as DesktopWebsiteHostSnapshot['sessionId'] }
  expect(() => f.channel.beginOperation(oversized, 'page-info', new AbortController().signal)).toThrow('limit')
  expect(f.send).not.toHaveBeenCalled()
})
