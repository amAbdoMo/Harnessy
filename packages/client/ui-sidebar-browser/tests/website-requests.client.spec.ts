/** Real Session/page admission with deferred Main-process transport replies. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  DesktopBrowserLeaseId, DesktopWebsiteHostSnapshot, DesktopWebsiteProfileId,
  DesktopWebsiteRequestId, DesktopWebsiteRequestReceipt, DesktopWebsiteVisibilityId,
} from '../src/types.ts'
import { WebsiteRequestSession } from '../src/client/browser/WebsiteRequestSession.ts'
import { requestStubs } from './website-request-stubs.client.ts'

const SESSION = 'session' as Branded<'SessionId'>
const PROFILE = 'profile' as DesktopWebsiteProfileId
const LEASE = 'lease' as DesktopBrowserLeaseId
const REQUEST = 'request' as DesktopWebsiteRequestId
const owners: WebsiteRequestSession[] = []
const releases = new Set<() => void>()

function barrier() {
  const deferred = Promise.withResolvers<undefined>()
  releases.add(() => { deferred.resolve(undefined) })
  return deferred
}

function row(id = REQUEST, epoch = 1): DesktopWebsiteHostSnapshot {
  return { id, profile: PROFILE, sessionId: SESSION, epoch, status: 'pending' }
}

async function fixture() {
  const bridge = requestStubs()
  let rows: readonly DesktopWebsiteHostSnapshot[] = [row()]
  const listeners = new Set<() => void>()
  vi.mocked(bridge.list).mockImplementation(async () => rows)
  vi.mocked(bridge.onChanged).mockImplementation((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  const receipt: DesktopWebsiteRequestReceipt = {
    requestId: REQUEST, epoch: 7, lease: LEASE, visibility: 'visible' as DesktopWebsiteVisibilityId,
  }
  vi.mocked(bridge.prepare).mockResolvedValue(receipt)
  vi.mocked(bridge.resume).mockImplementation(async current => current)
  const report = vi.fn()
  const session = new WebsiteRequestSession(SESSION, bridge, report)
  owners.push(session)
  const page = session.createPage(PROFILE)
  const guest = new AbortController()
  page.bind({ lease: LEASE, signal: guest.signal })
  page.setVisible(true)
  await session.reload()
  return {
    bridge, session, page, guest, report, receipt, listeners,
    setRows: (next: readonly DesktopWebsiteHostSnapshot[]) => { rows = next },
    change: () => { for (const listener of listeners) listener() },
  }
}

afterEach(async () => {
  for (const release of releases) release()
  releases.clear()
  const results = await Promise.allSettled(owners.splice(0).map(owner => owner.dispose()))
  vi.restoreAllMocks()
  const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
  if (failures.length !== 0) throw new AggregateError(failures, 'Request fixture cleanup failed')
})

describe('request admission', () => {
  it('requires explicit selection and uses the captured Session, attached guest and exact receipt', async () => {
    const h = await fixture()
    await h.page.resume()
    expect(h.bridge.prepare).not.toHaveBeenCalled()
    h.page.select(REQUEST)
    await h.page.resume()
    expect(h.bridge.prepare).toHaveBeenCalledExactlyOnceWith({ requestId: REQUEST, sessionId: SESSION, lease: LEASE })
    expect(h.bridge.acknowledge).toHaveBeenCalledExactlyOnceWith(h.receipt)
    expect(h.bridge.resume).toHaveBeenCalledExactlyOnceWith(h.receipt)
    expect(h.page.getSnapshot()).toMatchObject({ granted: true, canResume: false, canTakeover: true })
    expect(h.report).toHaveBeenCalledWith(PROFILE, 'resumed')
    h.page.setVisible(false)
    expect(h.page.getSnapshot()).toMatchObject({ granted: false, busy: 'draining' })
    await h.page.takeover()
    h.page.setVisible(true)
    expect(h.page.getSnapshot()).toMatchObject({ granted: false, canResume: true })
    expect(h.bridge.resume).toHaveBeenCalledTimes(1)
  })

  it.each(['prepare', 'acknowledge', 'resume'] as const)('Takeover revokes immediately while %s is held and drains its late reply', async (stage) => {
    const h = await fixture()
    const entered = barrier()
    const held = barrier()
    if (stage === 'acknowledge') {
      vi.mocked(h.bridge.acknowledge).mockImplementation(async () => {
        entered.resolve(undefined)
        await held.promise
      })
    } else {
      vi.mocked(h.bridge[stage]).mockImplementation(async () => {
        entered.resolve(undefined)
        await held.promise
        return h.receipt
      })
    }
    h.page.select(REQUEST)
    const admitting = h.page.resume()
    await entered.promise
    let drained = false
    const taking = h.page.takeover().then(() => { drained = true })
    expect(h.bridge.takeover).toHaveBeenCalledWith(REQUEST)
    expect(h.page.getSnapshot()).toMatchObject({ granted: false, busy: 'draining', canResume: false })
    await Promise.resolve()
    expect(drained).toBe(false)
    held.resolve(undefined)
    await Promise.all([admitting, taking])
    expect(h.bridge.takeover).toHaveBeenCalledTimes(2)
    if (stage !== 'resume') expect(h.bridge.resume).not.toHaveBeenCalled()
    if (stage === 'prepare') expect(h.bridge.acknowledge).not.toHaveBeenCalled()
    expect(h.page.getSnapshot()).toMatchObject({ granted: false, busy: undefined, blocked: false })
    expect(h.report).not.toHaveBeenCalledWith(PROFILE, 'resumed')
  })

  it.each(['settled', 'failed'] as const)('contains private reporter exceptions while revocation is %s', async (outcome) => {
    const h = await fixture()
    const diagnostic = new Error('private reporter account token')
    const upstream = new Error('request outcome unknown')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.report.mockImplementation(() => { throw diagnostic })
    h.page.select(REQUEST)
    await h.page.resume()
    expect(h.page.getSnapshot().granted).toBe(true)
    if (outcome === 'failed') vi.mocked(h.bridge.takeover).mockRejectedValue(upstream)
    await h.page.takeover()
    expect(h.page.getSnapshot()).toMatchObject({ granted: false, blocked: outcome === 'failed' })
    expect(JSON.stringify(h.page.getSnapshot())).not.toContain(diagnostic.message)
    expect(consoleError).not.toHaveBeenCalled()
    const other = h.session.createPage(PROFILE)
    if (outcome === 'failed') {
      await expect(h.page.dispose()).rejects.toMatchObject({ errors: [upstream] })
      other.select(REQUEST)
      expect(other.getSnapshot().selected).toBeUndefined()
      await expect(h.session.dispose()).rejects.toBeInstanceOf(AggregateError)
      owners.splice(owners.indexOf(h.session), 1)
    } else {
      await h.page.dispose()
      other.select(REQUEST)
      expect(other.getSnapshot().selected).toBe(REQUEST)
      await h.session.dispose()
    }
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('rejects a late grant from an old Host epoch but permits a new explicit Resume', async () => {
    const h = await fixture()
    const entered = barrier()
    const held = barrier()
    vi.mocked(h.bridge.resume).mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await held.promise
      return h.receipt
    })
    h.page.select(REQUEST)
    const admitting = h.page.resume()
    await entered.promise
    h.setRows([row(REQUEST, 2)])
    await h.session.reload()
    expect(h.page.getSnapshot()).toMatchObject({ granted: false, busy: 'draining' })
    held.resolve(undefined)
    await admitting
    await h.page.takeover()
    expect(h.report).not.toHaveBeenCalledWith(PROFILE, 'resumed')
    expect(h.page.getSnapshot().canResume).toBe(true)
    await h.page.resume()
    expect(h.page.getSnapshot().granted).toBe(true)
  })

  it('retains a failed drain and its request claim even when rejection has no reason', async () => {
    const h = await fixture()
    h.page.select(REQUEST)
    await h.page.resume()
    vi.mocked(h.bridge.takeover).mockRejectedValue(undefined)
    await h.page.takeover()
    expect(h.report).toHaveBeenLastCalledWith(PROFILE, 'requestFailed')
    expect(h.page.getSnapshot()).toMatchObject({ granted: false, blocked: true, canResume: false })
    const other = h.session.createPage(PROFILE)
    other.select(REQUEST)
    expect(other.getSnapshot().selected).toBeUndefined()
    await expect(h.page.dispose()).rejects.toMatchObject({ errors: [undefined] })
    await expect(h.session.dispose()).rejects.toBeInstanceOf(AggregateError)
    owners.splice(owners.indexOf(h.session), 1)
  })

  it('releases settled historical selections rather than exhausting the Session claim limit', async () => {
    const h = await fixture()
    for (let index = 0; index < 130; index++) {
      const id = `request-${index}` as DesktopWebsiteRequestId
      h.setRows([row(id)])
      await h.session.reload()
      h.page.select(id)
      expect(h.page.getSnapshot().selected).toBe(id)
    }
    const current = h.page.getSnapshot().selected!
    h.page.select(undefined)
    const other = h.session.createPage(PROFILE)
    other.select(current)
    expect(other.getSnapshot().selected).toBe(current)
  })
})

describe('Session request roster', () => {
  it('joins an invalidation queued after read publication but before refresh finalization', async () => {
    const h = await fixture()
    const reread = barrier()
    const held = barrier()
    vi.mocked(h.bridge.list).mockResolvedValueOnce([row(REQUEST, 2)]).mockImplementationOnce(async () => {
      reread.resolve(undefined)
      await held.promise
      return [row(REQUEST, 3)]
    })
    const unsubscribe = h.page.subscribe(() => {
      if (h.page.getSnapshot().requests[0]?.epoch === 2) queueMicrotask(h.change)
    })
    let finished = false
    const refreshing = h.session.reload().then(() => { finished = true })
    await reread.promise
    expect(finished).toBe(false)
    held.resolve(undefined)
    await refreshing
    unsubscribe()
    expect(h.page.getSnapshot().requests[0]?.epoch).toBe(3)
  })

  it('coalesces invalidations and disposal joins pending reads without late publication', async () => {
    const h = await fixture()
    const entered = barrier()
    const held = barrier()
    vi.mocked(h.bridge.list).mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await held.promise
      return [row(REQUEST, 2)]
    })
    const before = h.page.getSnapshot()
    const refreshing = h.session.reload()
    await entered.promise
    h.change()
    h.change()
    expect(h.session.reload()).toBe(refreshing)
    let disposed = false
    const disposing = h.session.dispose().then(() => { disposed = true })
    expect(h.listeners.size).toBe(0)
    await Promise.resolve()
    expect(disposed).toBe(false)
    held.resolve(undefined)
    await Promise.all([refreshing, disposing])
    expect(h.page.getSnapshot().requests).toBe(before.requests)
    expect(h.page.getSnapshot().granted).toBe(false)
  })

  it('keeps failed reads retryable without leaking transport diagnostics or permitting Resume', async () => {
    const h = await fixture()
    h.page.select(REQUEST)
    vi.mocked(h.bridge.list).mockRejectedValueOnce(new Error('private transport diagnostic'))
    await h.session.reload()
    expect(h.page.getSnapshot()).toMatchObject({ phase: 'failed', selected: REQUEST, canResume: false })
    expect(JSON.stringify(h.page.getSnapshot())).not.toContain('private transport diagnostic')
    await h.session.reload()
    expect(h.page.getSnapshot()).toMatchObject({ phase: 'ready', canResume: true })
  })
})
