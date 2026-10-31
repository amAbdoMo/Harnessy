// @vitest-environment jsdom
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Include from '@deepseek-ai/cordis-plugin-include'
import { act, fireEvent, within } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { TestClient, remoteDefaultResponses } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { RemoteMock, ok } from '@deepseek-ai/dsh-remote-mock'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BrowserPage, BrowserPageOptions } from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId, DesktopWebsiteProfileId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import * as browserPlugin from '@deepseek-ai/dsh-client-ui-sidebar-browser/src/client/index.ts'
import { en as browserEn } from '@deepseek-ai/dsh-client-ui-sidebar-browser/src/client/locales.ts'
import { SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionFollowFrame, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { DevicePreviewInjected } from '../src/client/model.ts'
import type { DevicePreviewStore } from '../src/client/store.ts'
import * as featurePlugin from '../src/client/index.ts'
import { DevicePreview } from '../src/client/DevicePreview.tsx'
import { devicePreviewRuntimePlan } from './device-preview-runtime.client.ts'
import { InertNativeBrowser, InertPreviewBridge } from './inert-native-browser.client.ts'

const SESSION = 'device-composition-session' as SessionId
const RESPONSIVE = 'sidebar.right.pane.tab.browser.responsive'
const nativePage = vi.hoisted(() => ({
  create: undefined as ((options: BrowserPageOptions, bridge: DesktopBrowserBridge) => BrowserPage) | undefined,
}))
// Only the external Electron page carrier is inert; Browser registration and nativeBrowser stay real.
vi.mock('@deepseek-ai/dsh-client-ui-sidebar-browser/src/client/electron/pages.ts', () => ({
  createElectronPage: (options: BrowserPageOptions, bridge: DesktopBrowserBridge) => {
    if (nativePage.create === undefined) throw new Error('Native page fixture is not installed')
    return nativePage.create(options, bridge)
  },
}))

/** Deterministic external panel measurements, not a replacement for DeviceFrame or its callbacks. */
class PanelMeasurements implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.callback([{ target, contentRect: new DOMRectReadOnly(0, 0, 1000, 1400),
      borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this)
  }
  unobserve(): void {}
  disconnect(): void {}
}

async function bench() {
  const previousNativePage = nativePage.create
  const native = new InertNativeBrowser()
  const bridge = new InertPreviewBridge()
  const language = document.documentElement.getAttribute('lang')
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  const savedStorage = new Map<string, string>()
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key !== null) savedStorage.set(key, localStorage.getItem(key)!)
  }
  let clientStarted = false
  let unmount: (() => void) | undefined
  const container = document.createElement('div')
  onTestFinished(async () => {
    try { await act(async () => { unmount?.(); if (clientStarted) await client.dispose() }) }
    finally {
      nativePage.create = previousNativePage
      if (animations === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
      else Object.defineProperty(Element.prototype, 'getAnimations', animations)
      container.remove()
      vi.unstubAllGlobals()
      localStorage.clear()
      for (const [key, value] of savedStorage) localStorage.setItem(key, value)
      if (language === null) document.documentElement.removeAttribute('lang')
      else document.documentElement.setAttribute('lang', language)
    }
  })
  localStorage.clear()
  // jsdom has no Web Animations API; the real sidebar observes an idle rendering surface.
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
  let leaseSequence = 0
  const browser: DesktopBrowserBridge = {
    acquire: async () => ({ lease: `composition-lease-${++leaseSequence}` as DesktopBrowserLeaseId, partition: 'test' }),
    command: async () => {}, release: async () => {}, onOpenRequested: () => () => {}, onReacquireRequested: () => () => {},
    profiles: { list: async () => [], create: async input => ({ ...input, id: 'profile' as DesktopWebsiteProfileId, control: 'human', access: 'ask', hasSavedLogin: false }),
      acquire: async () => ({ lease: 'profile-lease' as DesktopBrowserLeaseId, partition: 'profile' }),
      setUrl: async () => {}, setAccess: async () => {}, saveLogin: async () => {}, removeLogin: async () => {},
      setControl: async () => {}, signOut: async () => {}, forget: async () => {}, onChanged: () => () => {} },
    requests: {
      onPrepared: () => () => {}, list: async () => [], prepare: async () => { throw new Error('No profile handoff requested') },
      visible: async () => undefined, acknowledge: async () => {}, resume: async receipt => receipt,
      takeover: async () => {}, onChanged: () => () => {} },
  }
  nativePage.create = (options, carrier) => native.createPage({ sessionId: SESSION, options,
    leaseChanged: (_lease, viewport) => {
      if (viewport !== undefined) void carrier.acquire('composition').then(reservation =>
        carrier.command(reservation.lease, { kind: 'preview-viewport', viewport }))
    },
  })
  vi.stubGlobal('dshDesktop', { protocolVersion: 1, browser, preview: bridge })
  vi.stubGlobal('ResizeObserver', PanelMeasurements)
  const mock = RemoteMock.create().load(remoteDefaultResponses)
  const summary: SessionSummary = { sessionId: SESSION, updatedAt: 1, agentAvailable: true, running: false, blank: false }
  mock.unary('session/list', ok({ items: [summary] }))
  mock.unary('session/projections', ok({ asOfSeq: -1, values: {} }))
  const baseline: SessionFollowFrame = { type: 'snapshot', cursor: -1, records: [], hasMore: false,
    header: { version: SESSION_FORMAT_VERSION, id: SESSION, createdAt: 1, isSeeded: false },
    projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } }
  mock.stream('session/follow', (_args, stream) => { stream.push(baseline) })
  const client = await TestClient.start(devicePreviewRuntimePlan, mock)
  clientStarted = true
  const c = client
  c.ctx.loader.builtins.include = Include
  c.ctx.loader.builtins.browserUnderTest = browserPlugin
  c.ctx.loader.builtins.devicePreviewUnderTest = featurePlugin
  await c.ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(resolve(import.meta.dirname, 'fixtures/cordis.yml')).href } })
  await c.ctx.loader.await()
  const feature = [...c.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:devicePreviewUnderTest')
  if (feature === undefined || feature.fiber === undefined) throw new Error('YAML-loaded Device Preview is missing')
  await c.ctx.sessions.refresh()
  await act(async () => {
    c.ctx.uiWorkspace.openSession(SESSION)
    await mock.streams.opened('session/follow', 1)
    await mock.streams.drained('session/follow')
  })
  document.body.append(container)
  await act(async () => { unmount = c.ctx.uiRenderer.mount(container) })
  await c.flush()
  await feature.fiber.await()
  return { client: c, mock, native, bridge, feature, container, view: within(container) }
}

function ownEntries(client: TestClient, slot: Parameters<Context['slots']['entries']>[0]) {
  return client.ctx.slots.entries(slot).filter(entry => entry.component === DevicePreview || entry.options.id === 'device-preview.stop-notice')
}

async function openBrowser(h: Awaited<ReturnType<typeof bench>>) {
  await act(async () => { h.client.ctx.sidebarRight.openTab('browser') })
  const desktop = h.native.guests.find(guest => guest.viewports.length === 0)
  if (desktop === undefined) throw new Error('Browser page is missing')
  return { desktop }
}

describe('Simplified Browser with the legacy responsive contribution loaded', () => {
  usePinnedBrowserLanguages('en')

  it('uses one native page without device modes or extra responsive guests', async () => {
    const h = await bench()
    const { desktop } = await openBrowser(h)
    expect(h.client.ctx.sidebarRightTabs.get('device-preview')).toBeUndefined()
    expect(ownEntries(h.client, 'sidebar.right.pane.tab')).toHaveLength(0)
    expect(ownEntries(h.client, 'sidebar.right.pane.tab.title')).toHaveLength(0)
    expect(h.view.queryByRole('tablist', { name: browserEn['mode.label'] })).toBeNull()
    for (const mode of ['mode.desktop', 'mode.mobile', 'mode.tablet'] as const) {
      expect(h.view.queryByRole('tab', { name: browserEn[mode] })).toBeNull()
    }
    await act(async () => { fireEvent.change(h.view.getByRole('textbox', { name: browserEn['address.placeholder'] }), {
      target: { value: 'https://design.test/' },
    }) })
    await act(async () => { fireEvent.click(h.view.getByRole('button', { name: browserEn.go })) })
    expect(desktop.history.map(target => target.url)).toEqual(['https://design.test/'])
    expect(h.native.guests).toHaveLength(1)
    expect(desktop.viewports).toEqual([])
    expect(h.bridge.bindings).toEqual([])
  }, 60_000)

  it('keeps saved-account Browser pages in Desktop without responsive controls or viewport operations', async () => {
    const h = await bench()
    await act(async () => { h.client.ctx.sidebarRight.openTab('browser', { params: {
      url: 'https://account.test/', profileId: 'saved-account' as DesktopWebsiteProfileId,
    } }) })
    expect(h.view.queryByRole('tab', { name: browserEn['mode.mobile'] })).toBeNull()
    expect(h.view.queryByRole('tab', { name: browserEn['mode.tablet'] })).toBeNull()
    expect(h.native.guests).toHaveLength(1)
    expect(h.native.guests[0]?.request.options.profileId).toBe('saved-account')
    expect(h.native.guests[0]?.viewports).toEqual([])
    expect(h.bridge.bindings).toEqual([])
  }, 60_000)

  it('removes and re-adds integration exactly once while Browser retains its tab and Desktop page', async () => {
    const h = await bench()
    const { desktop } = await openBrowser(h)
    const originalFiber = h.feature.fiber
    expect(h.bridge.listeners.size).toBe(1)
    for (const slot of [RESPONSIVE, 'shell.overlay'] as const) expect(ownEntries(h.client, slot)).toHaveLength(1)
    await act(async () => {
      await h.feature.update({ disabled: true })
      await originalFiber?.dispose()
      await h.client.ctx.loader.await()
    })
    expect(h.client.ctx.sidebarRightTabs.get('browser')).toBeDefined()
    expect(h.client.ctx.sidebarRightTabs.get('device-preview')).toBeUndefined()
    expect(desktop.disposed).toBe(false)
    expect(h.native.guests).toHaveLength(1)
    expect(h.bridge.listeners.size).toBe(0)
    for (const slot of [RESPONSIVE, 'shell.overlay'] as const) expect(ownEntries(h.client, slot)).toHaveLength(0)
    expect(h.view.queryByRole('tab', { name: browserEn['mode.mobile'] })).toBeNull()
    expect(h.view.getByRole('textbox', { name: browserEn['address.placeholder'] })).toBeTruthy()
    await act(async () => { await h.feature.update({ disabled: false }); await h.client.ctx.loader.await() })
    expect(h.feature.fiber).not.toBe(originalFiber)
    expect(h.bridge.listeners.size).toBe(1)
    for (const slot of [RESPONSIVE, 'shell.overlay'] as const) expect(ownEntries(h.client, slot)).toHaveLength(1)
    expect(h.view.queryByRole('tablist', { name: browserEn['mode.label'] })).toBeNull()
    expect(h.native.guests).toHaveLength(1)
    expect(desktop.disposed).toBe(false)
  }, 60_000)

  it('rebinds the registered Session face to current store Actions before forgetting a closed Browser tab', async () => {
    const h = await bench()
    const entry = ownEntries(h.client, RESPONSIVE)[0]
    if (entry?.inject === undefined || entry.store === undefined) throw new Error('registered child lacks its store or inject face')
    const erasedInject = entry.inject
    const inject = (sessionId: SessionId, actions: PropsStore<DevicePreviewStore>['actions']): DevicePreviewInjected =>
      Reflect.apply(erasedInject, undefined, [sessionId, actions]) as DevicePreviewInjected
    const handle = entry.store as DevicePreviewStore
    const first = handle.create()
    const current = handle.create()
    const session = 'rebound-actions-session' as SessionId
    const tab = 'rebound-actions-tab' as TabId
    const lifetime = new AbortController()
    onTestFinished(() => { lifetime.abort() })
    first.actions.initialize(tab, 'https://draft.test/')
    current.actions.initialize(tab, 'https://current.test/')
    const firstFace = inject(session, first.actions)
    firstFace.retainTab(tab, lifetime.signal)
    const currentFace = inject(session, current.actions)
    expect(currentFace.hooks.devicePreview).toBe(firstFace.hooks.devicePreview)
    lifetime.abort()
    expect(current.getSnapshot().byTab[tab]).toBeUndefined()
    expect(first.getSnapshot().byTab[tab]?.urlDraft).toBe('https://draft.test/')
    expect(currentFace.hooks.devicePreview.getSnapshot().byTab[tab]).toBeUndefined()
    await act(async () => { await h.feature.update({ disabled: true }); await h.client.ctx.loader.await() })
    expect(h.native.guests.every(guest => guest.disposed)).toBe(true)
  }, 60_000)
})
