// @vitest-environment jsdom
import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopBrowserReservation, DesktopWebsiteProfileId } from '../src/types.ts'
import { electronFixture } from './electron-harness.client.ts'

const target = { kind: 'https' as const, url: 'https://example.test/', title: 'Example' }
const fixtures: ReturnType<typeof electronFixture>[] = []
const releases = new Set<() => void>()
function fixture(profile?: DesktopWebsiteProfileId) {
  const h = electronFixture(undefined, profile)
  fixtures.push(h)
  return h
}
afterEach(async () => {
  for (const release of releases) release()
  releases.clear()
  const results = await Promise.allSettled(fixtures.splice(0).map(h => h.dispose()))
  vi.restoreAllMocks()
  const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
  if (failures.length !== 0) throw new AggregateError(failures, 'Electron lifecycle fixtures failed to drain')
})

it('waits for a mounted container and observes native history, titles and new-tab requests', async () => {
  const h = fixture()
  h.frame.goBack()
  h.frame.goForward()
  h.frame.reload()
  h.frame.loadUrl(target)
  expect(h.bridge.acquire).not.toHaveBeenCalled()
  h.mount()
  const guest = await h.guest()
  expect(guest.element.getAttribute('name')).toBe(h.reservation.lease)
  expect(guest.element.getAttribute('partition')).toBe(h.reservation.partition)
  expect(guest.element.getAttribute('src')).toBe(`about:blank#${h.reservation.lease}`)
  guest.emit('dom-ready')
  expect(guest.loadURL).toHaveBeenCalledWith(target.url)
  guest.state.url = target.url
  guest.state.title = 'Title'
  guest.state.back = true
  guest.state.forward = true
  guest.emit('did-navigate')
  expect(guest.clearHistory).toHaveBeenCalledOnce()
  expect(h.frame.getSnapshot()).toMatchObject({ address: 'observed', target: { ...target, title: 'Title' } })
  expect(guest.element.getAttribute('aria-label')).toBe('Title')
  const writes = h.persist.mock.calls.length
  guest.emit('page-title-updated')
  expect(h.persist).toHaveBeenCalledTimes(writes)
  h.frame.loadUrl(target)
  h.frame.goBack()
  h.frame.goForward()
  expect(guest.reload).toHaveBeenCalledOnce()
  expect(guest.goBack).toHaveBeenCalledOnce()
  expect(guest.goForward).toHaveBeenCalledOnce()
  guest.state.url = `${target.url}next`
  guest.emit('did-navigate-in-page', { isMainFrame: false })
  expect(h.frame.getSnapshot().target?.url).toBe(target.url)
  guest.emit('did-navigate-in-page', { isMainFrame: true })
  guest.state.title = ''
  guest.state.loading = false
  guest.emit('page-title-updated')
  guest.emit('did-stop-loading')
  expect(h.frame.getSnapshot()).toMatchObject({ loading: false, target: { url: guest.state.url, title: 'example.test' } })
  const open = h.bridge.onOpenRequested.mock.calls[0]![1]
  open('https://new.example/')
  expect(h.openRequested).toHaveBeenCalledOnce()
  await h.frame.dispose()
  open('https://late.example/')
  guest.emit('did-navigate')
  h.frame.loadUrl(target)
  h.frame.reload()
  h.frame.goBack()
  expect(h.openRequested).toHaveBeenCalledOnce()
  expect(h.opens.size).toBe(0)
  expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
})

it('releases an acquisition that finishes after attachment cancellation', async () => {
  const h = fixture()
  const pending = Promise.withResolvers<DesktopBrowserReservation>()
  h.bridge.acquire.mockReturnValueOnce(pending.promise)
  const unmount = h.mount()
  h.frame.loadUrl(target)
  try {
    await vi.waitFor(() => { expect(h.bridge.acquire).toHaveBeenCalledOnce() })
    unmount()
    const disposed = h.frame.dispose()
    expect(h.frame.dispose()).toBe(disposed)
    pending.resolve(h.reservation)
    await disposed
    expect(h.guests).toHaveLength(0)
    expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
  } finally {
    pending.resolve(h.reservation)
  }
})

it('does not acquire a guest when Workspace resolution finishes after disposal', async () => {
  const h = fixture()
  const pending = Promise.withResolvers<string>()
  h.workspace.mockReturnValueOnce(pending.promise)
  h.mount()
  h.frame.loadUrl(target)
  try {
    const disposed = h.frame.dispose()
    pending.resolve('cwd:/late')
    await disposed
    expect(h.bridge.acquire).not.toHaveBeenCalled()
    h.mount()
    expect(h.guests).toHaveLength(0)
  } finally {
    pending.resolve('cwd:/late')
  }
})

it('recreates the guest after physical remount or crash without resolving Workspace again', async () => {
  const h = fixture()
  const unmount = h.mount()
  h.frame.loadUrl(target)
  const first = await h.guest()
  first.emit('dom-ready')
  unmount()
  h.mount()
  const second = await h.guest()
  expect(second.element).not.toBe(first.element)
  expect(h.workspace).toHaveBeenCalledOnce()
  second.emit('dom-ready')
  expect(second.loadURL).toHaveBeenCalledWith(target.url)
  second.emit('render-process-gone')
  expect(h.frame.getSnapshot().error).toBeDefined()
  h.frame.reload()
  const third = await h.guest()
  third.emit('dom-ready')
  expect(third.loadURL).toHaveBeenCalledWith(target.url)
  expect(h.frame.getSnapshot().error).toBeUndefined()
  third.emit('destroyed')
  expect(h.frame.getSnapshot().error).toBeDefined()
})

it('contains acquisition and native command failures and keeps retry available', async () => {
  const h = fixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  h.bridge.acquire.mockRejectedValueOnce(new Error('acquire failed'))
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  h.frame.reload()
  const guest = await h.guest()
  guest.emit('dom-ready')
  guest.state.url = target.url
  guest.emit('did-navigate')
  guest.reload.mockImplementationOnce(() => { throw new Error('command failed') })
  h.frame.reload()
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  h.frame.reload()
  expect(h.frame.getSnapshot().error).toBeUndefined()
  guest.getURL.mockImplementationOnce(() => { throw new Error('observation failed') })
  guest.emit('did-navigate')
  expect(h.frame.getSnapshot().error).toBeDefined()
})

it('does not retry a rejected deferred Human load or publish saved-account diagnostics', async () => {
  const h = fixture('cd1b6493-c881-4967-a544-b0a49f2d847f' as DesktopWebsiteProfileId)
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  h.bridge.command.mockRejectedValueOnce(new Error('private saved-account native diagnostics'))
  guest.emit('dom-ready')
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  guest.emit('dom-ready')
  guest.emit('did-stop-loading')
  expect(h.bridge.command).toHaveBeenCalledExactlyOnceWith(h.reservation.lease, { kind: 'navigate', url: target.url, revision: 1 })
  expect(guest.loadURL).not.toHaveBeenCalled()
  expect(diagnostic).not.toHaveBeenCalled()
  h.frame.reload()
  expect(guest.loadURL).toHaveBeenCalledExactlyOnceWith(target.url)
})

it.each(['detach', 'crash'] as const)('blocks retry after failed %s drainage and retains the failure for disposal', async (retirement) => {
  const h = fixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const diagnostic = new Error('private guest release diagnostic')
  h.bridge.release.mockRejectedValueOnce(diagnostic)
  const unmount = h.mount()
  h.frame.loadUrl(target)
  const first = await h.guest()
  if (retirement === 'detach') { unmount(); h.mount() }
  else { first.emit('render-process-gone'); h.frame.reload() }
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  expect(h.bridge.acquire).toHaveBeenCalledOnce()
  expect(h.host.firstElementChild).toBeNull()
  const disposed = h.frame.dispose()
  expect(h.frame.dispose()).toBe(disposed)
  await expect(disposed).rejects.toMatchObject({ errors: [diagnostic] })
  await expect(h.dispose()).rejects.toMatchObject({ errors: [{ errors: [diagnostic] }] })
  fixtures.splice(fixtures.indexOf(h), 1)
})

it('forwards the latest pending address after Workspace resolution', async () => {
  const h = fixture()
  const resolved = Promise.withResolvers<string>()
  releases.add(() => { resolved.resolve('cwd:/workspace') })
  h.workspace.mockReturnValueOnce(resolved.promise)
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.workspace).toHaveBeenCalledOnce() })
  const latest = { ...target, url: 'https://192.168.1.10/latest' }
  h.frame.loadUrl(latest)
  resolved.resolve('cwd:/workspace')
  const guest = await h.guest()
  expect(h.bridge.acquire).toHaveBeenCalledExactlyOnceWith('cwd:/workspace', latest.url)
  expect(guest.loadURL).not.toHaveBeenCalled()
  guest.emit('dom-ready')
  expect(guest.loadURL).toHaveBeenCalledExactlyOnceWith(latest.url)
})

it('replaces in the same tab only after physical release, using the latest target and ignoring stale notices', async () => {
  const h = fixture()
  const drained = Promise.withResolvers<undefined>()
  releases.add(() => { drained.resolve(undefined) })
  const replacement = { lease: 'replacement-lease' as DesktopBrowserReservation['lease'], partition: 'exclusive-session' }
  h.mount()
  h.frame.loadUrl(target)
  const first = await h.guest()
  first.emit('dom-ready')
  const notice = h.bridge.onReacquireRequested.mock.calls[0]![1]
  const revision = h.bridge.command.mock.calls.at(-1)![1].revision!
  notice('file:///not-approved', revision)
  expect(h.bridge.release).not.toHaveBeenCalled()
  h.bridge.release.mockReturnValueOnce(drained.promise)
  h.bridge.acquire.mockResolvedValueOnce(replacement)
  notice('https://192.168.1.10/redirect', revision)
  expect(h.host.firstElementChild).toBeNull()
  expect(h.opens.size).toBe(0)
  expect(h.reacquires.size).toBe(0)
  expect(h.frame.getSnapshot()).toMatchObject({ address: 'requested', loading: true, canGoBack: false, canGoForward: false })
  await vi.waitFor(() => { expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease) })
  expect(h.bridge.acquire).toHaveBeenCalledOnce()
  const latest = { ...target, url: 'https://192.168.1.20/latest' }
  h.frame.loadUrl(latest)
  notice('https://192.168.1.10/stale', revision)
  first.state.url = 'https://stale.example/'
  first.emit('did-navigate')
  expect(h.frame.getSnapshot().target).toEqual(latest)
  drained.resolve(undefined)
  const second = await h.guest()
  expect(second.element).not.toBe(first.element)
  expect(second.element.parentElement).toBe(h.host)
  expect(second.element.getAttribute('name')).toBe(replacement.lease)
  expect(second.element.getAttribute('partition')).toBe(replacement.partition)
  expect(h.bridge.acquire).toHaveBeenLastCalledWith('cwd:/workspace', latest.url)
  expect(second.loadURL).not.toHaveBeenCalled()
  second.emit('dom-ready')
  expect(second.loadURL).toHaveBeenCalledExactlyOnceWith(latest.url)
  expect(h.openRequested).not.toHaveBeenCalled()
  notice('https://old.example/', revision)
  expect(h.frame.getSnapshot().target).toEqual(latest)
  expect(h.reacquires.size).toBe(1)
})

it.each(['requested', 'observed'] as const)('ignores queued A replacement after B is submitted and %s, then accepts B replacement', async (address) => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const first = await h.guest()
  first.emit('dom-ready')
  const notice = h.bridge.onReacquireRequested.mock.calls[0]![1]
  const oldRevision = h.bridge.command.mock.calls.at(-1)![1].revision!
  const latest = { ...target, url: 'https://192.168.1.20/submitted-b' }
  h.frame.loadUrl(latest)
  const currentRevision = h.bridge.command.mock.calls.at(-1)![1].revision!
  expect(currentRevision).toBeGreaterThan(oldRevision)
  expect(h.bridge.command).toHaveBeenLastCalledWith(h.reservation.lease,
    { kind: 'navigate', url: latest.url, revision: currentRevision })
  if (address === 'observed') {
    first.state.url = latest.url
    first.state.title = latest.title
    first.emit('did-navigate')
  }
  const snapshot = h.frame.getSnapshot()
  const writes = h.persist.mock.calls.length
  expect(snapshot.address).toBe(address)
  notice('https://192.168.1.10/queued-a', oldRevision)
  expect(h.frame.getSnapshot()).toBe(snapshot)
  expect(h.persist).toHaveBeenCalledTimes(writes)
  expect(h.bridge.release).not.toHaveBeenCalled()
  expect(h.host.firstElementChild).toBe(first.element)
  expect(h.reacquires.size).toBe(1)

  const approved = 'https://192.168.1.20/approved-b'
  notice(approved, currentRevision)
  expect(h.frame.getSnapshot()).toMatchObject({ address: 'requested', target: { url: approved } })
  expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
  const second = await h.guest()
  second.emit('dom-ready')
  expect(second.loadURL).toHaveBeenCalledExactlyOnceWith(approved)
  expect(h.bridge.command.mock.calls.at(-1)![1].revision).toBe(currentRevision + 1)
})

it.each(['back', 'forward', 'reload'] as const)('ignores queued replacement superseded by %s and accepts that command revision', async (kind) => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const first = await h.guest()
  first.emit('dom-ready')
  first.state.url = target.url
  first.state.back = true
  first.state.forward = true
  first.emit('did-navigate')
  const notice = h.bridge.onReacquireRequested.mock.calls[0]![1]
  const oldRevision = h.bridge.command.mock.calls.at(-1)![1].revision!
  if (kind === 'back') h.frame.goBack()
  else if (kind === 'forward') h.frame.goForward()
  else h.frame.reload()
  const currentRevision = h.bridge.command.mock.calls.at(-1)![1].revision!
  expect(h.bridge.command).toHaveBeenLastCalledWith(h.reservation.lease, { kind, revision: oldRevision + 1 })
  const snapshot = h.frame.getSnapshot()
  const writes = h.persist.mock.calls.length
  notice('https://192.168.1.10/queued', oldRevision)
  expect(h.frame.getSnapshot()).toBe(snapshot)
  expect(h.persist).toHaveBeenCalledTimes(writes)
  expect(h.bridge.release).not.toHaveBeenCalled()
  expect(h.host.firstElementChild).toBe(first.element)
  const approved = 'https://192.168.1.20/history-target'
  notice(approved, currentRevision)
  const second = await h.guest()
  second.emit('dom-ready')
  expect(second.loadURL).toHaveBeenCalledExactlyOnceWith(approved)
  expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
})

it('serializes a replacement requested before the original initialization settles', async () => {
  const h = fixture()
  const url = 'https://192.168.1.10/early'
  h.bridge.onReacquireRequested.mockImplementationOnce((_lease, listener) => {
    queueMicrotask(() => {
      h.guests[0]!.emit('dom-ready')
      listener(url, h.bridge.command.mock.calls.at(-1)![1].revision!)
    })
    return () => {}
  })
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.guests).toHaveLength(2) })
  const second = await h.guest()
  expect(h.bridge.release).toHaveBeenCalledOnce()
  expect(h.bridge.acquire).toHaveBeenLastCalledWith('cwd:/workspace', url)
  expect(h.host.firstElementChild).toBe(second.element)
  second.emit('dom-ready')
  expect(second.loadURL).toHaveBeenCalledExactlyOnceWith(url)
  h.bridge.onReacquireRequested.mock.calls[1]![1]('https://192.168.1.20/again', h.bridge.command.mock.calls.at(-1)![1].revision!)
  await vi.waitFor(() => { expect(h.guests).toHaveLength(3) })
})

it('drains an acquisition for a superseded target before reserving the latest address without publishing the stale guest', async () => {
  const h = fixture()
  const acquired = Promise.withResolvers<DesktopBrowserReservation>()
  const drained = Promise.withResolvers<undefined>()
  releases.add(() => { acquired.resolve(h.reservation); drained.resolve(undefined) })
  h.bridge.acquire.mockReturnValueOnce(acquired.promise)
  h.bridge.release.mockReturnValueOnce(drained.promise)
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.bridge.acquire).toHaveBeenCalledOnce() })
  const latest = { ...target, url: 'https://192.168.1.20/latest' }
  h.frame.loadUrl(latest)
  acquired.resolve(h.reservation)
  await vi.waitFor(() => { expect(h.bridge.release).toHaveBeenCalledOnce() })
  expect(h.guests).toHaveLength(0)
  expect(h.bridge.acquire).toHaveBeenCalledOnce()
  drained.resolve(undefined)
  const guest = await h.guest()
  expect(h.bridge.acquire).toHaveBeenLastCalledWith('cwd:/workspace', latest.url)
  guest.emit('dom-ready')
  expect(guest.loadURL).toHaveBeenCalledExactlyOnceWith(latest.url)
})

it('blocks replacement and retry after failed drainage and joins that failure during disposal', async () => {
  const h = fixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const failure = new Error('native release failed')
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  guest.emit('dom-ready')
  h.bridge.release.mockRejectedValueOnce(failure)
  const revision = h.bridge.command.mock.calls.at(-1)![1].revision!
  const notice = h.bridge.onReacquireRequested.mock.calls[0]![1]
  notice('https://192.168.1.10/redirect', revision)
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  h.frame.reload()
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  notice('https://192.168.1.10/late', revision)
  expect(h.bridge.acquire).toHaveBeenCalledOnce()
  expect(h.guests).toHaveLength(1)
  expect(h.reacquires.size).toBe(0)
  await expect(h.frame.dispose()).rejects.toMatchObject({ errors: [failure] })
  await expect(h.dispose()).rejects.toMatchObject({ errors: [{ errors: [failure] }] })
  fixtures.splice(fixtures.indexOf(h), 1)
})

it.each([
  { phase: 'release', cancellation: 'dispose' }, { phase: 'release', cancellation: 'detach' },
  { phase: 'acquire', cancellation: 'dispose' }, { phase: 'acquire', cancellation: 'detach' },
])('does not publish a late replacement after $cancellation during $phase', async ({ phase, cancellation }) => {
  const h = fixture()
  const drained = Promise.withResolvers<undefined>()
  const acquired = Promise.withResolvers<DesktopBrowserReservation>()
  const replacement = { lease: 'late-lease' as DesktopBrowserReservation['lease'], partition: 'late-session' }
  releases.add(() => { drained.resolve(undefined); acquired.resolve(replacement) })
  const unmount = h.mount()
  h.frame.loadUrl(target)
  const original = await h.guest()
  original.emit('dom-ready')
  if (phase === 'release') h.bridge.release.mockReturnValueOnce(drained.promise)
  else h.bridge.acquire.mockReturnValueOnce(acquired.promise)
  h.bridge.onReacquireRequested.mock.calls[0]![1]('https://192.168.1.10/redirect', h.bridge.command.mock.calls.at(-1)![1].revision!)
  await vi.waitFor(() => {
    if (phase === 'release') expect(h.bridge.release).toHaveBeenCalledOnce()
    else expect(h.bridge.acquire).toHaveBeenCalledTimes(2)
  })
  if (cancellation === 'dispose') {
    const disposed = h.frame.dispose()
    let settled = false
    void disposed.then(() => { settled = true })
    expect(settled).toBe(false)
    drained.resolve(undefined)
    acquired.resolve(replacement)
    await disposed
    expect(h.guests).toHaveLength(1)
    expect(h.host.firstElementChild).toBeNull()
    expect(h.reacquires.size).toBe(0)
    if (phase === 'release') expect(h.bridge.acquire).toHaveBeenCalledOnce()
    else expect(h.bridge.release).toHaveBeenLastCalledWith(replacement.lease)
  } else {
    unmount()
    drained.resolve(undefined)
    acquired.resolve(replacement)
    if (phase === 'acquire') {
      await vi.waitFor(() => { expect(h.bridge.release).toHaveBeenLastCalledWith(replacement.lease) })
    } else await drained.promise
    // The bridge has no remaining external work; finish its queued promise callbacks without disposing the frame.
    await nextTurn()
    expect(h.guests).toHaveLength(1)
    expect(h.bridge.acquire).toHaveBeenCalledTimes(phase === 'release' ? 1 : 2)
    expect(h.host.firstElementChild).toBeNull()
    expect(h.reacquires.size).toBe(0)
    const fresh = { lease: 'remounted-lease' as DesktopBrowserReservation['lease'], partition: 'remounted-session' }
    h.bridge.acquire.mockResolvedValueOnce(fresh)
    h.mount()
    const guest = await h.guest()
    expect(h.guests).toHaveLength(2)
    expect(guest.element.getAttribute('name')).toBe(fresh.lease)
    expect(h.bridge.acquire).toHaveBeenCalledTimes(phase === 'release' ? 2 : 3)
    guest.emit('dom-ready')
    expect(guest.loadURL).toHaveBeenCalledExactlyOnceWith('https://192.168.1.10/redirect')
  }
})

it('keeps saved-profile admission separate from ordinary Session replacement', async () => {
  const h = fixture('saved-profile' as DesktopWebsiteProfileId)
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  guest.emit('dom-ready')
  expect(h.profiles.acquire).toHaveBeenCalledOnce()
  expect(h.bridge.acquire).not.toHaveBeenCalled()
  expect(h.bridge.onReacquireRequested).not.toHaveBeenCalled()
  expect(guest.loadURL).toHaveBeenCalledExactlyOnceWith(target.url)
})

it('ignores superseded and aborted load promises, but publishes an active navigation rejection', async () => {
  const h = fixture()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  const stale = Promise.withResolvers<undefined>()
  guest.loadURL.mockReturnValueOnce(stale.promise)
  guest.emit('dom-ready')
  h.frame.loadUrl({ ...target, url: 'https://example.test/new' })
  stale.reject(new Error('old navigation failed'))
  await expect(stale.promise).rejects.toThrow('old navigation')
  expect(h.frame.getSnapshot().error).toBeUndefined()
  guest.loadURL.mockRejectedValueOnce(Object.assign(new Error('aborted'), { code: 'ERR_ABORTED' }))
  h.frame.loadUrl({ ...target, url: 'https://example.test/cancelled' })
  await Promise.resolve()
  expect(h.frame.getSnapshot().error).toBeUndefined()
  guest.loadURL.mockRejectedValueOnce(new Error('active navigation failed'))
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  expect(error).toHaveBeenCalledOnce()
})
