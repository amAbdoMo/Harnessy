// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { BrowserController, createBrowserControllers } from '../src/client/browser/BrowserController.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'
import { createIframePage } from '../src/client/pages.ts'
import type { BrowserPageFactory, BrowserPageOptions } from '../src/client/browser/BrowserPage.ts'
import { browserAddressCheckpoint } from '../src/client/browser/BrowserPersistence.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { emptyBrowserFrame, type BrowserFrameState } from '../src/client/browser/BrowserFrame.ts'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { DesktopBrowserLeaseId, DesktopWebsiteProfileId, DesktopWebsiteRequestId, DesktopWebsiteVisibilityId } from '../src/types.ts'
import { WebsiteRequestSession } from '../src/client/browser/WebsiteRequestSession.ts'
import { requestStubs } from './website-request-stubs.client.ts'

const TAB = 'tab' as TabId
const APP = 'https://dsh.example'
const lifetimes = new Set<AbortController>()
const disposables: { dispose(): Promise<void> }[] = []
const hosts: HTMLElement[] = []
const releaseDrainages = new Set<() => void>()
let sequence = 0

function lifetime(): AbortController {
  const controller = new AbortController()
  lifetimes.add(controller)
  return controller
}

function harness() {
  const id = `browser-controller-test-${String(++sequence)}`
  const store = createBrowserStore().create(id)
  let open = true
  const face = createBrowserControllers(store.actions, createIframePage, () => open)
  disposables.push(face)
  const host = document.createElement('div')
  host.id = id
  hosts.push(host)
  document.body.append(host)
  const mount = (signal: AbortSignal, profileId?: DesktopWebsiteProfileId): (() => void) => face.mount({
    tabId: TAB, signal, viewportId: id, applicationOrigin: APP,
    initial: store.getSnapshot().byTab[TAB], initialUrl: undefined, profileId, openTab: vi.fn(),
  })
  const iframe = (): HTMLIFrameElement => {
    const element = host.querySelector('iframe')
    if (element === null) throw new Error('expected a mounted iframe')
    return element
  }
  return { store, face, mount, iframe, close: () => { open = false } }
}

afterEach(async () => {
  for (const release of releaseDrainages) release()
  releaseDrainages.clear()
  const results = await Promise.allSettled(disposables.splice(0).map(value => value.dispose()))
  for (const controller of lifetimes) controller.abort()
  lifetimes.clear()
  for (const host of hosts.splice(0)) host.remove()
  localStorage.clear()
  vi.restoreAllMocks()
  const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
  if (failures.length !== 0) throw new AggregateError(failures, 'Browser controller fixtures failed to drain')
})

describe('BrowserController', () => {
  it.each(['closed', 'replaced'] as const)('retains a %s page failure and joins other pages before Session teardown rejects', async (retirement) => {
    const profile = 'profile' as DesktopWebsiteProfileId
    const sessionId = 'session' as Branded<'SessionId'>
    const firstId = 'first-request' as DesktopWebsiteRequestId
    const secondId = 'second-request' as DesktopWebsiteRequestId
    const bridge = requestStubs()
    vi.mocked(bridge.list).mockResolvedValue([firstId, secondId].map(id => ({ id, profile, sessionId, epoch: 1, status: 'pending' })))
    vi.mocked(bridge.prepare).mockImplementation(async input => ({ requestId: input.requestId, lease: input.lease,
      epoch: 2, visibility: 'visible' as DesktopWebsiteVisibilityId }))
    vi.mocked(bridge.resume).mockImplementation(async receipt => receipt)
    const diagnostic = new Error('private retired-page diagnostic')
    const held = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    releaseDrainages.add(() => { held.resolve(undefined) })
    vi.mocked(bridge.takeover).mockImplementation(async (id) => {
      if (id === firstId) throw diagnostic
      entered.resolve(undefined)
      await held.promise
    })
    const session = new WebsiteRequestSession(sessionId, bridge, vi.fn())
    const pages: ReturnType<WebsiteRequestSession['createPage']>[] = []
    const store = createBrowserStore().create(`retirement-${retirement}`)
    const face = createBrowserControllers(store.actions, (options) => {
      const requests = session.createPage(profile)
      requests.bind({ lease: `lease-${pages.length}` as DesktopBrowserLeaseId, signal: lifetime().signal })
      pages.push(requests)
      return { ...createIframePage(options), requests }
    }, () => false, () => ({ phase: 'ready', profiles: [{ id: profile, name: 'Account', accountLabel: '',
      url: 'https://work.example/', mcpServerName: 'website', control: 'human' }], busy: undefined, creating: false, notice: null }))
    disposables.push({ dispose: async () => { await expect(face.dispose()).rejects.toMatchObject({
      errors: [{ errors: [{ errors: [diagnostic] }] }],
    }) } })
    disposables.push({ dispose: async () => { await expect(session.dispose()).rejects.toMatchObject({
      errors: [{ errors: [diagnostic] }],
    }) } })
    const host = document.createElement('div')
    host.id = `retirement-host-${retirement}`
    hosts.push(host)
    document.body.append(host)
    const mount = (signal: AbortSignal) => face.mount({ tabId: TAB, signal, viewportId: host.id, applicationOrigin: APP,
      initial: undefined, initialUrl: undefined, profileId: profile, openTab: vi.fn() })
    const firstLifetime = lifetime()
    mount(firstLifetime.signal)
    await session.reload()
    face.setVisible(TAB, true)
    face.selectRequest(TAB, firstId)
    await face.resumeRequest(TAB)
    if (retirement === 'closed') firstLifetime.abort()
    mount(lifetime().signal)
    await expect(pages[0]!.dispose()).rejects.toMatchObject({ errors: [diagnostic] })
    face.setVisible(TAB, true)
    face.selectRequest(TAB, secondId)
    await face.resumeRequest(TAB)
    let settled = false
    const disposal = face.dispose()
    const joined = disposal.then(() => { settled = true }, () => { settled = true })
    expect(face.dispose()).toBe(disposal)
    await entered.promise
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(settled).toBe(false)
    held.resolve(undefined)
    await joined
    await expect(disposal).rejects.toMatchObject({ errors: [{ errors: [{ errors: [diagnostic] }] }] })
    mount(lifetime().signal)
    expect(pages).toHaveLength(2)
    expect(face.keyedHooks.browserState(TAB)).toBeUndefined()
    const competitor = session.createPage(profile)
    competitor.select(firstId)
    expect(competitor.getSnapshot().selected).toBeUndefined()
  })

  it('observes failed tab-close drainage without releasing its claim or exposing transport details', async () => {
    const profile = 'profile' as DesktopWebsiteProfileId
    const id = 'request' as DesktopWebsiteRequestId
    const sessionId = 'session' as Branded<'SessionId'>
    const lease = 'lease' as DesktopBrowserLeaseId
    const bridge = requestStubs()
    vi.mocked(bridge.list).mockResolvedValue([{ id, profile, sessionId, epoch: 1, status: 'pending' }])
    vi.mocked(bridge.prepare).mockResolvedValue({ requestId: id, epoch: 2, lease, visibility: 'visible' as DesktopWebsiteVisibilityId })
    vi.mocked(bridge.resume).mockImplementation(async receipt => receipt)
    const report = vi.fn()
    const session = new WebsiteRequestSession(sessionId, bridge, report)
    const requests = session.createPage(profile)
    const store = createBrowserStore().create('failed-close')
    const tabLifetime = lifetime()
    const controller = new BrowserController({
      tabId: TAB, signal: tabLifetime.signal, applicationOrigin: APP,
      initial: undefined, profileId: profile, actions: store.actions, openTab: vi.fn(),
      createPage: options => ({ ...createIframePage(options), requests }),
    })
    disposables.push(controller, session)
    requests.bind({ lease, signal: lifetime().signal })
    requests.setVisible(true)
    await session.reload()
    requests.select(id)
    await requests.resume()
    expect(requests.getSnapshot().granted).toBe(true)
    const diagnostic = new Error('private transport diagnostic')
    vi.mocked(bridge.takeover).mockRejectedValue(diagnostic)
    const pageFailure = { errors: [diagnostic] }
    const failedOwner = { errors: [pageFailure] }
    disposables.splice(disposables.indexOf(controller), 1, { dispose: async () => {
      await expect(controller.dispose()).rejects.toMatchObject(failedOwner)
    } })
    disposables.splice(disposables.indexOf(session), 1, { dispose: async () => {
      await expect(session.dispose()).rejects.toMatchObject(failedOwner)
    } })
    const consoleError = vi.spyOn(console, 'error')
    const consoleWarn = vi.spyOn(console, 'warn')
    tabLifetime.abort()
    expect(bridge.takeover).toHaveBeenCalledWith(id)
    await expect(requests.dispose()).rejects.toMatchObject(pageFailure)
    // Cross one event-loop turn before joining controller disposal, so an unobserved close failure fails the runner.
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(consoleError).not.toHaveBeenCalled()
    expect(consoleWarn).not.toHaveBeenCalled()
    expect(report).toHaveBeenLastCalledWith(profile, 'requestFailed')
    const competing = session.createPage(profile)
    competing.select(id)
    expect(competing.getSnapshot().selected).toBeUndefined()
    await expect(controller.dispose()).rejects.toMatchObject(failedOwner)
  })

  it('restores only on request and redirects saved checkpoints to a replacement binding', () => {
    const h = harness()
    const saved = browserAddressCheckpoint({ kind: 'https', url: 'https://saved.example/', title: 'Saved page' }, 2)
    h.store.actions.replace(TAB, saved)
    const tabLifetime = lifetime()
    h.mount(tabLifetime.signal)
    const state = h.face.keyedHooks.browserState(TAB)!
    expect(state.getSnapshot().restoreTarget?.title).toBe('Saved page')
    expect(state.getSnapshot().frame.target).toBeUndefined()
    const rebound = createBrowserStore().create('rebound-browser-controller')
    h.face.rebind(rebound.actions)
    h.mount(tabLifetime.signal)
    expect(rebound.getSnapshot().byTab[TAB]).toEqual(saved)
    h.face.restore(TAB)
    expect(h.iframe().src).toBe('https://saved.example/')
    h.face.restore(TAB)
    h.face.loadUrl(TAB, 'https://next.example/')
    expect(rebound.getSnapshot().byTab[TAB]?.entries.at(-1)?.url).toBe('https://next.example/')
    expect(h.store.getSnapshot().byTab[TAB]).toEqual(saved)
    tabLifetime.abort()
    expect(rebound.getSnapshot().byTab[TAB]).toBeDefined()
    h.face.restore(TAB)
    h.face.setSandbox(TAB, false)
    h.mount(tabLifetime.signal)()
    expect(h.face.keyedHooks.browserState(TAB)).toBeUndefined()
  })

  it('refresh restores a saved page and ignores cancellation from a retired physical mount', () => {
    const h = harness()
    h.store.actions.replace(TAB, browserAddressCheckpoint({ kind: 'https', url: 'https://saved.example/', title: 'Saved' }, 1))
    const tabLifetime = lifetime()
    const oldMount = h.mount(tabLifetime.signal)
    h.face.reload(TAB)
    const secondHost = document.createElement('div')
    secondHost.id = 'replacement-browser-host'
    document.body.append(secondHost)
    hosts.push(secondHost)
    h.face.mount({ tabId: TAB, signal: tabLifetime.signal, viewportId: secondHost.id,
      applicationOrigin: APP, initial: undefined, initialUrl: undefined, profileId: undefined, openTab: vi.fn() })
    oldMount()
    expect(secondHost.querySelector('iframe')?.src).toBe('https://saved.example/')
    expect(() => h.face.mount({ tabId: TAB, signal: tabLifetime.signal, viewportId: 'missing-browser-host',
      applicationOrigin: APP, initial: undefined, initialUrl: undefined, profileId: undefined, openTab: vi.fn() })).toThrow('not mounted')
  })

  it('never offers a saved checkpoint to a profile page and never stores its navigation', () => {
    const checkpoints: (BrowserPageOptions['initial'])[] = []
    const pageFactory: BrowserPageFactory = (options) => {
      checkpoints.push(options.initial)
      options.persist(browserAddressCheckpoint({ kind: 'https', url: 'https://example.test/login?otp=123456', title: 'Sign in' }, 1))
      return {
        frame: { getSnapshot: () => emptyBrowserFrame(), subscribe: () => () => {},
          loadUrl: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), dispose: async () => {} },
        presentation: { mount: () => () => {} },
      }
    }
    const store = createBrowserStore().create('profile-checkpoint')
    const replace = vi.spyOn(store.actions, 'replace')
    const saved = browserAddressCheckpoint({ kind: 'https', url: 'https://example.test/earlier?otp=1', title: 'Earlier' }, 1)
    const controller = new BrowserController({ tabId: TAB, signal: lifetime().signal, applicationOrigin: APP,
      actions: store.actions, initial: saved, profileId: 'profile-1' as DesktopWebsiteProfileId,
      createPage: pageFactory, openTab: vi.fn() })
    disposables.push(controller)
    expect(controller.getSnapshot().restoreTarget).toBeUndefined()
    expect(checkpoints).toEqual([undefined])
    expect(replace).not.toHaveBeenCalled()
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
  })

  it('validates provider open requests and ignores late provider callbacks after disposal', async () => {
    const saved = browserAddressCheckpoint({ kind: 'https', url: 'https://saved.example/', title: 'Saved' }, 1)
    const frames = createSnapshotStore<BrowserFrameState>(emptyBrowserFrame())
    const callbacks: BrowserPageOptions[] = []
    const pendingNotifications: (() => void)[] = []
    const pageFactory: BrowserPageFactory = (options) => {
      callbacks.push(options)
      return {
        frame: { getSnapshot: () => frames.getSnapshot(), subscribe: (listener) => {
          pendingNotifications.push(listener)
          return frames.subscribe(listener)
        }, loadUrl: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), dispose: async () => {} },
        presentation: { mount: () => () => {}, dispose: () => {} },
      }
    }
    const store = createBrowserStore().create('provider-callbacks')
    const openTab = vi.fn()
    const controller = new BrowserController({ tabId: TAB, signal: lifetime().signal, applicationOrigin: APP,
      actions: store.actions, initial: saved, profileId: undefined, createPage: pageFactory, openTab })
    disposables.push(controller)
    const provider = callbacks[0]!
    provider.openRequested('file:/secret')
    expect(controller.getSnapshot().addressFailure).toBe('protocol')
    provider.openRequested('https://new.example/path')
    expect(openTab).toHaveBeenCalledExactlyOnceWith('https://new.example/path')
    controller.setSandbox(false)
    frames.set({ ...emptyBrowserFrame(), loading: true })
    expect(controller.getSnapshot().restoreTarget?.title).toBe('Saved')
    expect(controller.getSnapshot().addressFailure).toBe('protocol')
    const before = controller.getSnapshot()
    await controller.dispose()
    controller.start('https://ignored.example/')
    provider.persist(saved)
    provider.openRequested('https://ignored.example/')
    for (const notify of pendingNotifications) notify()
    expect(controller.getSnapshot()).toBe(before)
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
    expect(openTab).toHaveBeenCalledOnce()
  })

  it('ignores navigation commands after its tab occurrence ends', async () => {
    const store = createBrowserStore().create('browser-controller-ended-test')
    const tabLifetime = lifetime()
    const controller = new BrowserController({
      tabId: TAB, signal: tabLifetime.signal, applicationOrigin: APP, actions: store.actions,
      initial: undefined, profileId: undefined, createPage: createIframePage, openTab: vi.fn(),
    })
    disposables.push(controller)
    tabLifetime.abort()
    await controller.dispose()

    controller.loadUrl('https://ignored.example/')
    controller.goBack()
    controller.goForward()
    controller.reload()
    expect(controller.getSnapshot().frame.target).toBeUndefined()
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
  })

  it('owns the four navigation commands and frame load state', () => {
    const { store, face, mount, iframe, close } = harness()
    const tabLifetime = lifetime()
    mount(tabLifetime.signal)
    const state = face.keyedHooks.browserState(TAB)!
    mount(tabLifetime.signal)
    expect(face.keyedHooks.browserState(TAB)).toBe(state)
    face.goBack(TAB)
    face.goForward(TAB)
    face.reload(TAB)

    face.loadUrl(TAB, 'https://example.test/one')
    const first = iframe()
    expect(first.src).toBe('https://example.test/one')
    first.dispatchEvent(new Event('load'))
    expect(store.getSnapshot().byTab[TAB]?.navigation.status).toBe('known')
    first.dispatchEvent(new Event('load'))
    expect(store.getSnapshot().byTab[TAB]?.navigation.status).toBe('unknown')
    face.goBack(TAB)
    face.goForward(TAB)
    expect(store.getSnapshot().byTab[TAB]?.navigation.status).toBe('unknown')

    face.loadUrl(TAB, 'https://example.test/two')
    face.goBack(TAB)
    expect(state.getSnapshot().frame.target?.url).toBe('https://example.test/one')
    face.goForward(TAB)
    expect(state.getSnapshot().frame.target?.url).toBe('https://example.test/two')
    const beforeReload = store.getSnapshot().byTab[TAB]!.request!.revision
    face.reload(TAB)
    expect(store.getSnapshot().byTab[TAB]?.request?.revision).toBe(beforeReload + 1)
    face.loadUrl(TAB, 'https://example.test/two')
    expect(store.getSnapshot().byTab[TAB]?.request?.revision).toBe(beforeReload + 2)

    close()
    tabLifetime.abort()
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
    first.dispatchEvent(new Event('load'))
    face.loadUrl(TAB, 'https://ignored.example/')
    face.goBack(TAB)
    face.goForward(TAB)
    face.reload(TAB)
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
    expect(face.keyedHooks.browserState(TAB)).toBeUndefined()
  })

  it('does not let an old occurrence delete a replacement controller', () => {
    const { store, face, mount } = harness()
    const first = lifetime()
    const second = lifetime()
    mount(first.signal)
    const original = face.keyedHooks.browserState(TAB)
    mount(second.signal)
    const replacement = face.keyedHooks.browserState(TAB)
    expect(replacement).not.toBe(original)
    first.abort()
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
    face.loadUrl(TAB, 'https://example.test/')
    expect(store.getSnapshot().byTab[TAB]).toBeDefined()
    mount(second.signal)
    expect(face.keyedHooks.browserState(TAB)).toBe(replacement)
  })

  it('loads loopback under sandbox and reloads it across sandbox changes', () => {
    const { store, face, mount, iframe } = harness()
    const tabLifetime = lifetime()
    mount(tabLifetime.signal)
    const state = face.keyedHooks.browserState(TAB)!

    face.loadUrl(TAB, 'http://localhost:5173/app')
    expect(state.getSnapshot().frame).toMatchObject({
      sandboxEnabled: true,
      target: { url: 'http://localhost:5173/app' },
    })
    const beforeToggle = store.getSnapshot().byTab[TAB]!.request!.revision

    face.setSandbox(TAB, false)
    expect(state.getSnapshot().frame.sandboxEnabled).toBe(false)
    expect(iframe().src).toBe('http://localhost:5173/app')
    expect(store.getSnapshot().byTab[TAB]?.request?.revision).toBe(beforeToggle + 1)

    face.setSandbox(TAB, true)
    expect(state.getSnapshot().frame).toMatchObject({
      sandboxEnabled: true,
      target: { url: 'http://localhost:5173/app' },
    })
    expect(store.getSnapshot().byTab[TAB]?.request?.revision).toBe(beforeToggle + 2)
  })

  it('loads public HTTP without changing the sandbox policy', () => {
    const { face, mount } = harness()
    const tabLifetime = lifetime()
    mount(tabLifetime.signal)

    face.loadUrl(TAB, 'http://example.test/path')
    const state = face.keyedHooks.browserState(TAB)!
    expect(state.getSnapshot().frame).toMatchObject({
      sandboxEnabled: true,
      target: { url: 'http://example.test/path' },
    })
    const beforeFailure = state.getSnapshot().frame
    face.loadUrl(TAB, 'javascript:alert(1)')
    expect(state.getSnapshot().addressFailure).toBe('protocol')
    expect(state.getSnapshot().frame).toBe(beforeFailure)
    face.reload(TAB)
    expect(state.getSnapshot().addressFailure).toBeUndefined()
  })
})
