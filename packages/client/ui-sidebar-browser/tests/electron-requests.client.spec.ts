// @vitest-environment jsdom
/** Request admission through the real Electron page, guest events and Session ownership. */
import { afterEach, expect, it, vi } from 'vitest'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { DesktopWebsiteProfileId, DesktopWebsiteRequestId, DesktopWebsiteVisibilityId } from '../src/types.ts'
import { electronFixture } from './electron-harness.client.ts'

const SESSION = 'session' as Branded<'SessionId'>
const PROFILE = 'profile' as DesktopWebsiteProfileId
const REQUEST = 'request' as DesktopWebsiteRequestId
const fixtures: ReturnType<typeof electronFixture>[] = []
const releases = new Set<() => void>()

async function fixture() {
  const h = electronFixture(undefined, PROFILE, SESSION)
  fixtures.push(h)
  const { requests, requestsSession } = h
  if (requests === undefined || requestsSession === undefined) throw new Error('Expected saved-profile request ownership')
  vi.mocked(h.bridge.requests.list).mockResolvedValue([{ id: REQUEST, sessionId: SESSION, profile: PROFILE, epoch: 1, status: 'pending' }])
  const receipt = { requestId: REQUEST, epoch: 7, lease: h.reservation.lease, visibility: 'visible' as DesktopWebsiteVisibilityId }
  vi.mocked(h.bridge.requests.prepare).mockResolvedValue(receipt)
  vi.mocked(h.bridge.requests.resume).mockImplementation(async current => current)
  await requestsSession.reload()
  requests.select(REQUEST)
  requests.setVisible(true)
  h.frame.loadUrl({ kind: 'https', url: 'https://work.example/', title: 'work.example' })
  return { ...h, requests, requestsSession, receipt }
}

afterEach(async () => {
  for (const release of releases) release()
  releases.clear()
  const results = await Promise.allSettled(fixtures.splice(0).map(h => h.dispose()))
  vi.restoreAllMocks()
  const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
  if (failures.length !== 0) throw new AggregateError(failures, 'Electron request fixtures failed to drain')
})

it.each(['unmount', 'crash'] as const)('admits only the ready guest and revokes on %s without granting its replacement', async (loss) => {
  const h = await fixture()
  await h.requests.resume()
  expect(h.bridge.requests.prepare).not.toHaveBeenCalled()
  const unmount = h.mount()
  const first = await h.guest()
  await h.requests.resume()
  expect(h.bridge.requests.prepare).not.toHaveBeenCalled()
  first.emit('dom-ready')
  await h.requests.resume()
  expect(h.bridge.requests.prepare).toHaveBeenCalledExactlyOnceWith({ requestId: REQUEST, sessionId: SESSION, lease: h.reservation.lease })
  expect(h.requests.getSnapshot().granted).toBe(true)
  if (loss === 'unmount') unmount()
  else first.emit('render-process-gone')
  expect(h.bridge.requests.takeover).toHaveBeenCalledWith(REQUEST)
  expect(h.requests.getSnapshot()).toMatchObject({ granted: false, canResume: false })
  await h.requests.takeover()
  if (loss === 'unmount') h.mount()
  else h.frame.reload()
  const replacement = await h.guest()
  expect(replacement.element).not.toBe(first.element)
  expect(h.requests.getSnapshot().canResume).toBe(false)
  replacement.emit('dom-ready')
  expect(h.requests.getSnapshot()).toMatchObject({ granted: false, canResume: true })
  expect(h.bridge.requests.resume).toHaveBeenCalledTimes(1)
  expect(h.persist).not.toHaveBeenCalled()
  await h.requests.resume()
  expect(h.requests.getSnapshot().granted).toBe(true)
})

it('joins a held acknowledgement during teardown and revokes its late completion before releasing ownership', async () => {
  const h = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const held = Promise.withResolvers<undefined>()
  releases.add(() => { held.resolve(undefined) })
  vi.mocked(h.bridge.requests.acknowledge).mockImplementation(async () => {
    entered.resolve(undefined)
    await held.promise
  })
  h.mount()
  const guest = await h.guest()
  guest.emit('dom-ready')
  const admitting = h.requests.resume()
  await entered.promise
  let disposed = false
  const disposal = h.dispose().then(() => { disposed = true })
  expect(h.bridge.requests.takeover).toHaveBeenCalledWith(REQUEST)
  await Promise.resolve()
  expect(disposed).toBe(false)
  held.resolve(undefined)
  await Promise.all([admitting, disposal])
  expect(h.bridge.requests.resume).not.toHaveBeenCalled()
  expect(h.bridge.requests.takeover).toHaveBeenCalledTimes(2)
  expect(h.report).not.toHaveBeenCalledWith(PROFILE, 'resumed')
  expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
  expect(h.host.isConnected).toBe(false)
  guest.emit('dom-ready')
  guest.emit('did-navigate')
  expect(h.bridge.requests.prepare).toHaveBeenCalledTimes(1)
})
