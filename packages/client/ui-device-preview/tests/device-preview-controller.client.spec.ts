// @vitest-environment jsdom
import { describe, expect, it, onTestFinished } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DevicePreviewControllers } from '../src/client/controller.ts'
import { createDevicePreviewStore } from '../src/client/store.ts'
import type { DevicePreviewId, DevicePreviewOpenRequest, DevicePreviewProjectId, DevicePreviewRequestId } from '../src/types.ts'
import { dispatchBarrier, InertNativeBrowser, InertPreviewBridge } from './inert-native-browser.client.ts'

const SESSION = 'device-controller-session' as SessionId
const TAB = 'device-controller-tab' as TabId
const PHONE_LEASE = 'phone-native-lease' as DesktopBrowserLeaseId
const TABLET_LEASE = 'tablet-native-lease' as DesktopBrowserLeaseId
const PHONE = { width: 393, height: 852, scale: 0.5 }
const TABLET = { width: 820, height: 1180, scale: 0.4 }

function opening(identity = 'first'): DevicePreviewOpenRequest {
  return { type: 'device-preview-open', sessionId: SESSION,
    previewId: `preview-${identity}` as DevicePreviewId, requestId: `request-${identity}` as DevicePreviewRequestId,
    server: { cwd: '/project', url: 'https://project.test/', ownership: 'owned', status: 'running',
      projectId: 'owned-project' as DevicePreviewProjectId } }
}

function bench(request = opening()) {
  const native = new InertNativeBrowser()
  const bridge = new InertPreviewBridge()
  const requests = new Map([[request.previewId, request]])
  const store = createDevicePreviewStore().create()
  const closed: TabId[] = []
  const stopNotices: { success: boolean; url: string }[] = []
  const stopNoticeEntered = Promise.withResolvers<undefined>()
  const lifetime = new AbortController()
  const controllers = new DevicePreviewControllers({ sessionId: SESSION, native, bridge,
    applicationOrigin: 'https://harness.test', request: id => requests.get(id), openLink: () => {},
    closed: (id) => { closed.push(id); store.actions.forget(id) },
    stopNotice: (success, url) => { stopNotices.push({ success, url }); stopNoticeEntered.resolve(undefined) } })
  const releaseBarriers: (() => void)[] = []
  onTestFinished(async () => { for (const release of releaseBarriers) release(); lifetime.abort(); await controllers.dispose() })
  store.actions.initialize(TAB, request.server.url)
  controllers.retainTab(TAB, lifetime.signal, request.server.url, request.previewId)
  const phone = native.guests[0]!
  const tablet = native.guests[1]!
  const phoneHost = document.createElement('div')
  const tabletHost = document.createElement('div')
  const unmountPhone = controllers.mountSurface(TAB, 'phone', phoneHost, PHONE)
  onTestFinished(unmountPhone)
  const unmountTablet = controllers.mountSurface(TAB, 'tablet', tabletHost, TABLET)
  onTestFinished(unmountTablet)
  controllers.updateSurface(TAB, 'phone', PHONE, true)
  controllers.updateSurface(TAB, 'tablet', TABLET, true)
  return { controllers, native, bridge, requests, store, closed, lifetime, phone, tablet, phoneHost, tabletHost, request, releaseBarriers,
    stopNotices, stopNoticeEntered: stopNoticeEntered.promise }
}

function runtimeState(controllers: DevicePreviewControllers) {
  const state = controllers.source.getSnapshot().byTab[TAB]
  if (state === undefined) throw new Error('retained preview is missing')
  return state
}

function nextFailure(controllers: DevicePreviewControllers, failure: 'approval') {
  const barrier = Promise.withResolvers<undefined>()
  const unsubscribe = controllers.source.subscribe(() => {
    if (controllers.source.getSnapshot().byTab[TAB]?.phone.failure === failure) { unsubscribe(); barrier.resolve(undefined) }
  })
  onTestFinished(unsubscribe)
  return barrier.promise
}

describe('retained Device Preview controllers over an inert native carrier', () => {
  it('starts both pages at one URL and changes orientation, dimensions, and fit without remounting or navigating', () => {
    const h = bench()
    const phonePage = h.phone.page
    const tabletPage = h.tablet.page
    const geometry = [
      { width: 852, height: 393, scale: 0.5 },
      { width: 852, height: 393, scale: 1 },
      { width: 600, height: 900, scale: 0.7 },
    ]
    for (const next of geometry) h.controllers.updateSurface(TAB, 'phone', next, true)
    expect(h.native.guests.map(guest => guest.page)).toEqual([phonePage, tabletPage])
    expect(h.phone.mounts).toEqual([h.phoneHost.id])
    expect(h.tablet.mounts).toEqual([h.tabletHost.id])
    expect(h.phone.detached).toBe(0)
    expect(h.phone.viewports).toEqual([PHONE, ...geometry])
    expect(h.phone.history.map(target => target.url)).toEqual([h.request.server.url])
    expect(h.tablet.history.map(target => target.url)).toEqual([h.request.server.url])
    expect(h.phone.reloads + h.tablet.reloads).toBe(0)
    h.controllers.navigate(TAB, 'phone', 'https://phone.test/second')
    h.controllers.navigate(TAB, 'tablet', 'https://tablet.test/second')
    h.controllers.goBack(TAB, 'phone')
    expect(runtimeState(h.controllers).phone).toMatchObject({ url: h.request.server.url, canGoForward: true })
    expect(runtimeState(h.controllers).tablet).toMatchObject({ url: 'https://tablet.test/second', canGoBack: true })
    h.controllers.goForward(TAB, 'phone')
    h.controllers.reload(TAB, 'tablet')
    expect(runtimeState(h.controllers).phone.url).toBe('https://phone.test/second')
    expect(h.phone.reloads).toBe(0)
    expect(h.tablet.reloads).toBe(1)
  })

  it('associates the exact request only after lease and matching native viewport ACK, never sent geometry', async () => {
    const h = bench()
    h.phone.acknowledge(PHONE_LEASE)
    await dispatchBarrier()
    expect(h.bridge.bindings).toEqual([])
    h.phone.acknowledge(PHONE_LEASE, { ...PHONE, scale: 1 })
    await dispatchBarrier()
    expect(h.bridge.bindings).toEqual([])
    h.phone.acknowledge(PHONE_LEASE, PHONE)
    await h.bridge.bound(1)
    expect(h.bridge.bindings).toEqual([{ previewId: h.request.previewId, slot: 'phone', lease: PHONE_LEASE,
      width: PHONE.width, height: PHONE.height, visible: true }])
    await dispatchBarrier()
    expect(h.bridge.acknowledgements).toEqual([{ previewId: h.request.previewId, requestId: h.request.requestId, opened: true }])
    h.tablet.acknowledge(TABLET_LEASE, TABLET)
    await h.bridge.bound(2)
    await dispatchBarrier()
    expect(h.bridge.bindings[1]).toMatchObject({ previewId: h.request.previewId, slot: 'tablet', lease: TABLET_LEASE })
    expect(h.bridge.acknowledgements).toHaveLength(1)
  })

  it('withdraws the previous inspection association before waiting for new viewport acknowledgement', async () => {
    const h = bench()
    h.phone.acknowledge(PHONE_LEASE, PHONE)
    await h.bridge.bound(1)
    const next = { width: 852, height: 393, scale: 0.5 }
    h.controllers.updateSurface(TAB, 'phone', next, true)
    expect(h.bridge.unbindings).toEqual([{ previewId: h.request.previewId, slot: 'phone', lease: PHONE_LEASE }])
    await dispatchBarrier()
    expect(h.bridge.bindings).toHaveLength(1)
    h.phone.acknowledge(PHONE_LEASE, next)
    await h.bridge.bound(2)
    expect(h.bridge.bindings.at(-1)).toMatchObject({ width: 852, height: 393, visible: true })
    expect(h.phone.detached).toBe(0)
  })

  it('gives a replacement opening fresh guests while the retired occurrence is still draining', async () => {
    const f = bench()
    f.phone.acknowledge('old-phone' as DesktopBrowserLeaseId, PHONE)
    f.tablet.acknowledge('old-tablet' as DesktopBrowserLeaseId, TABLET)
    await f.bridge.bound(2)
    await dispatchBarrier()
    const closing = Promise.withResolvers<undefined>()
    const nativeDrain = Promise.withResolvers<undefined>()
    f.bridge.closeGate = closing.promise
    f.phone.disposalGate = nativeDrain.promise
    f.tablet.disposalGate = nativeDrain.promise
    f.releaseBarriers.push(() => { closing.resolve(undefined); nativeDrain.resolve(undefined) })
    const replacement = opening('replacement-native')
    f.requests.set(replacement.previewId, replacement)
    expect(f.controllers.retainTab(TAB, f.lifetime.signal, replacement.server.url, replacement.previewId)).toBe(true)
    await f.phone.disposalStarted.promise
    const phone = f.native.guests[2]!
    const tablet = f.native.guests[3]!
    expect(phone.history.at(-1)?.url).toBe(replacement.server.url)
    expect(phone.mounts).toEqual([f.phoneHost.id])
    expect(tablet.mounts).toEqual([f.tabletHost.id])
    expect(f.phone.disposed).toBe(true)
    let oldDrained = false
    const oldDisposal = f.phone.page.frame.dispose().then(() => { oldDrained = true })
    expect(oldDrained).toBe(false)
    phone.acknowledge('new-phone' as DesktopBrowserLeaseId, PHONE)
    tablet.acknowledge('new-tablet' as DesktopBrowserLeaseId, TABLET)
    await f.bridge.bound(4)
    await dispatchBarrier()
    expect(f.bridge.acknowledgements).toContainEqual({ previewId: replacement.previewId, requestId: replacement.requestId, opened: true })
    f.phone.acknowledge(undefined)
    expect(f.controllers.retainTab(TAB, f.lifetime.signal, replacement.server.url, replacement.previewId)).toBe(false)
    expect(f.native.guests).toHaveLength(4)
    expect(phone.disposed).toBe(false)
    closing.resolve(undefined)
    nativeDrain.resolve(undefined)
    await oldDisposal
    expect(oldDrained).toBe(true)
    expect(phone.disposed).toBe(false)
    expect(f.bridge.stops).toEqual([])
  })

  it('keeps late Stop feedback attributed to the earlier launcher without marking its replacement stopped', async () => {
    const h = bench()
    const stopped = Promise.withResolvers<undefined>()
    h.releaseBarriers.push(() => { stopped.resolve(undefined) })
    h.bridge.stopGate = () => stopped.promise
    h.controllers.stopProject(TAB)
    expect(runtimeState(h.controllers).project?.phase).toBe('stopping')
    const replacement: DevicePreviewOpenRequest = { ...opening('second'), server: { ...h.request.server,
      projectId: 'owned-second-project' as DevicePreviewProjectId, url: 'https://second-project.test/' } }
    h.requests.set(replacement.previewId, replacement)
    h.controllers.retainTab(TAB, h.lifetime.signal, replacement.server.url, replacement.previewId)
    expect(runtimeState(h.controllers).project).toMatchObject({ phase: 'running', url: replacement.server.url, canStop: true })
    stopped.resolve(undefined)
    await h.stopNoticeEntered
    await dispatchBarrier()
    expect(h.stopNotices).toEqual([{ success: true, url: h.request.server.url }])
    expect(runtimeState(h.controllers).project).toMatchObject({ phase: 'running', url: replacement.server.url, canStop: true })
    expect(h.bridge.stops).toEqual([h.request.server.projectId])
  })

  it('does not let a late previous acknowledgement suppress the replacement acknowledgement', async () => {
    const h = bench()
    const previousAck = Promise.withResolvers<undefined>()
    h.releaseBarriers.push(() => { previousAck.resolve(undefined) })
    h.bridge.acknowledgementGate = acknowledgement => acknowledgement.previewId === h.request.previewId
      ? previousAck.promise : Promise.resolve()
    h.phone.acknowledge(PHONE_LEASE, PHONE)
    await h.bridge.bound(1)
    await dispatchBarrier()
    expect(h.bridge.acknowledgements).toHaveLength(1)
    const replacement = opening('late-ack-replacement')
    h.requests.set(replacement.previewId, replacement)
    h.controllers.retainTab(TAB, h.lifetime.signal, replacement.server.url, replacement.previewId)
    previousAck.resolve(undefined)
    await dispatchBarrier()
    h.native.guests[2]!.acknowledge('late-ack-replacement-phone' as DesktopBrowserLeaseId, PHONE)
    await h.bridge.bound(2)
    await dispatchBarrier()
    expect(h.bridge.acknowledgements.at(-1)).toEqual({ previewId: replacement.previewId, requestId: replacement.requestId, opened: true })
  })

  it('replaces a fresh opening association without reusing the earlier request acknowledgement', async () => {
    const h = bench()
    h.phone.acknowledge(PHONE_LEASE, PHONE)
    await h.bridge.bound(1)
    await dispatchBarrier()
    const replacement = opening('replacement')
    h.requests.set(replacement.previewId, replacement)
    h.controllers.retainTab(TAB, h.lifetime.signal, replacement.server.url, replacement.previewId)
    h.native.guests[2]!.acknowledge('replacement-phone' as DesktopBrowserLeaseId, PHONE)
    await h.bridge.bound(2)
    await dispatchBarrier()
    expect(h.bridge.closes).toEqual([h.request.previewId])
    expect(h.bridge.bindings.at(-1)?.previewId).toBe(replacement.previewId)
    expect(h.bridge.acknowledgements).toEqual([
      { requestId: h.request.requestId, previewId: h.request.previewId, opened: true },
      { requestId: replacement.requestId, previewId: replacement.previewId, opened: true },
    ])
  })

  it.each(['hidden tab', 'image source'] as const)('revokes inspection for %s while retaining physical pages and history', async (reason) => {
    const h = bench()
    h.phone.acknowledge(PHONE_LEASE, PHONE)
    await h.bridge.bound(1)
    await dispatchBarrier()
    if (reason === 'image source') h.store.actions.setSource(TAB, 'phone', 'image')
    h.controllers.updateSurface(TAB, 'phone', PHONE, false)
    await h.bridge.bound(2)
    expect(h.bridge.bindings.at(-1)).toMatchObject({ lease: PHONE_LEASE, visible: false })
    expect(h.phone.disposed).toBe(false)
    expect(h.phone.detached).toBe(0)
    expect(h.native.guests).toHaveLength(2)
    expect(h.phone.history.map(target => target.url)).toEqual([h.request.server.url])
    h.controllers.updateSurface(TAB, 'phone', PHONE, true)
    await h.bridge.bound(3)
    expect(h.bridge.bindings.at(-1)).toMatchObject({ lease: PHONE_LEASE, visible: true })
    expect(h.phone.mounts).toHaveLength(1)
    expect(h.phone.reloads).toBe(0)
  })

  it('drains both physical pages and preview.close after tab abort without stopping the owned launcher', async () => {
    const h = bench()
    const phoneRelease = Promise.withResolvers<undefined>()
    const tabletRelease = Promise.withResolvers<undefined>()
    const previewRelease = Promise.withResolvers<undefined>()
    h.releaseBarriers.push(() => {
      phoneRelease.resolve(undefined); tabletRelease.resolve(undefined); previewRelease.resolve(undefined)
    })
    h.phone.disposalGate = phoneRelease.promise
    h.tablet.disposalGate = tabletRelease.promise
    h.bridge.closeGate = previewRelease.promise
    h.lifetime.abort()
    await Promise.all([h.phone.disposalStarted.promise, h.tablet.disposalStarted.promise, h.bridge.closeStarted.promise])
    expect(h.closed).toEqual([TAB])
    expect(h.store.getSnapshot().byTab[TAB]).toBeUndefined()
    expect(h.controllers.source.getSnapshot().byTab[TAB]).toBeUndefined()
    let drained = false
    const drainage = h.controllers.dispose().then(() => { drained = true })
    phoneRelease.resolve(undefined)
    tabletRelease.resolve(undefined)
    await Promise.all([phoneRelease.promise, tabletRelease.promise])
    await dispatchBarrier()
    expect(drained).toBe(false)
    previewRelease.resolve(undefined)
    await drainage
    expect(h.bridge.closes).toEqual([h.request.previewId])
    expect(h.bridge.stops).toEqual([])
  })

  it('ignores a late native lease callback after tab closure', async () => {
    const h = bench()
    h.lifetime.abort()
    const closedSnapshot = h.controllers.source.getSnapshot()
    h.phone.acknowledge(PHONE_LEASE, PHONE)
    h.tablet.acknowledge(TABLET_LEASE, TABLET)
    h.phone.failLoad('Late guest load failure')
    expect(h.controllers.source.getSnapshot()).toBe(closedSnapshot)
    await h.controllers.dispose()
    expect(h.bridge.bindings).toEqual([])
    expect(h.bridge.acknowledgements).toEqual([])
    expect(h.controllers.source.getSnapshot().byTab[TAB]).toBeUndefined()
  })

  it('joins an in-flight native bind after closing without acknowledging or republishing the closed tab', async () => {
    const h = bench()
    const bindingRelease = Promise.withResolvers<undefined>()
    h.releaseBarriers.push(() => { bindingRelease.resolve(undefined) })
    h.bridge.bindGate = () => bindingRelease.promise
    h.phone.acknowledge(PHONE_LEASE, PHONE)
    await h.bridge.bound(1)
    h.lifetime.abort()
    h.phone.acknowledge('late-native-lease' as DesktopBrowserLeaseId, PHONE)
    let drained = false
    const drainage = h.controllers.dispose().then(() => { drained = true })
    await dispatchBarrier()
    expect(drained).toBe(false)
    bindingRelease.resolve(undefined)
    await drainage
    expect(h.bridge.bindings).toHaveLength(1)
    expect(h.bridge.acknowledgements).toEqual([])
    expect(h.controllers.source.getSnapshot().byTab[TAB]).toBeUndefined()
    expect(h.bridge.stops).toEqual([])
  })

  it('does not bind when the opening owner has withdrawn request authority before a native callback', async () => {
    const h = bench()
    h.requests.delete(h.request.previewId)
    h.phone.acknowledge(PHONE_LEASE, PHONE)
    await dispatchBarrier()
    expect(h.bridge.bindings).toEqual([])
    expect(h.bridge.acknowledgements).toEqual([])
  })

  it('keeps address, native-load, and binding failures observable until an explicit recovery succeeds', async () => {
    const h = bench()
    h.controllers.navigate(TAB, 'phone', 'file:///private/page')
    h.controllers.updateSurface(TAB, 'phone', PHONE, false)
    expect(runtimeState(h.controllers).phone).toMatchObject({ phase: 'error', failure: 'address' })
    expect(h.phone.history).toHaveLength(1)
    h.controllers.navigate(TAB, 'phone', 'https://phone.test/')
    h.phone.failLoad('Guest failed to load')
    h.controllers.updateSurface(TAB, 'phone', PHONE, true)
    expect(runtimeState(h.controllers).phone).toMatchObject({ phase: 'error', failure: 'load' })
    h.controllers.reload(TAB, 'phone')
    expect(runtimeState(h.controllers).phone).toMatchObject({ phase: 'ready', url: 'https://phone.test/' })
    const failure = nextFailure(h.controllers, 'approval')
    h.bridge.bindGate = () => Promise.reject(new Error('Native observation refused'))
    h.phone.acknowledge(PHONE_LEASE, PHONE)
    await failure
    expect(runtimeState(h.controllers).phone).toMatchObject({ phase: 'error', failure: 'approval' })
    h.controllers.updateSurface(TAB, 'tablet', TABLET, false)
    expect(runtimeState(h.controllers).phone.failure).toBe('approval')
    h.bridge.bindGate = () => Promise.resolve()
    h.controllers.updateSurface(TAB, 'phone', PHONE, true)
    await h.bridge.bound(2)
    await dispatchBarrier()
    expect(runtimeState(h.controllers).phone).toMatchObject({ phase: 'ready', url: 'https://phone.test/' })
    expect(runtimeState(h.controllers).phone.failure).toBeUndefined()
  })
})
