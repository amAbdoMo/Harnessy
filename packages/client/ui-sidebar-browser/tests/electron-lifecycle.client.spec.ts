// @vitest-environment jsdom
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
  expect(h.bridge.command).toHaveBeenCalledExactlyOnceWith(h.reservation.lease, { kind: 'navigate', url: target.url })
  expect(guest.loadURL).not.toHaveBeenCalled()
  expect(diagnostic).not.toHaveBeenCalled()
  h.frame.reload()
  expect(guest.loadURL).toHaveBeenCalledExactlyOnceWith(target.url)
})

it.each(['detach', 'crash'] as const)('joins failed %s releases and late acquisitions before rejecting disposal', async (retirement) => {
  const h = fixture()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const diagnostic = new Error('private guest release diagnostic')
  const secondRelease = Promise.withResolvers<undefined>()
  const lateAcquisition = Promise.withResolvers<DesktopBrowserReservation>()
  const lateRelease = Promise.withResolvers<undefined>()
  releases.add(() => {
    secondRelease.resolve(undefined)
    lateAcquisition.resolve(h.reservation)
    lateRelease.resolve(undefined)
  })
  h.bridge.release.mockRejectedValueOnce(diagnostic)
    .mockReturnValueOnce(secondRelease.promise)
    .mockReturnValueOnce(lateRelease.promise)
  try {
    const unmount = h.mount()
    h.frame.loadUrl(target)
    const first = await h.guest()
    if (retirement === 'detach') unmount()
    else first.emit('render-process-gone')
    await Promise.resolve()
    const remount = retirement === 'detach' ? h.mount() : unmount
    if (retirement === 'crash') h.frame.reload()
    await h.guest()
    remount()
    h.bridge.acquire.mockReturnValueOnce(lateAcquisition.promise)
    h.mount()
    await vi.waitFor(() => { expect(h.bridge.acquire).toHaveBeenCalledTimes(3) })
    const disposed = h.frame.dispose()
    expect(h.frame.dispose()).toBe(disposed)
    let settled = false
    void disposed.then(() => { settled = true }, () => { settled = true })
    lateAcquisition.resolve(h.reservation)
    await vi.waitFor(() => { expect(h.bridge.release).toHaveBeenCalledTimes(3) })
    expect(settled).toBe(false)
    lateRelease.resolve(undefined)
    await lateRelease.promise
    expect(settled).toBe(false)
    secondRelease.resolve(undefined)
    await expect(disposed).rejects.toMatchObject({ errors: [diagnostic] })
    expect(h.guests).toHaveLength(2)
    expect(error).not.toHaveBeenCalled()
    h.mount()
    expect(h.bridge.acquire).toHaveBeenCalledTimes(3)
    await expect(h.dispose()).rejects.toMatchObject({ errors: [{ errors: [diagnostic] }] })
    fixtures.splice(fixtures.indexOf(h), 1)
  } finally {
    secondRelease.resolve(undefined)
    lateAcquisition.resolve(h.reservation)
    lateRelease.resolve(undefined)
  }
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
