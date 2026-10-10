// @vitest-environment jsdom
import Include from '@deepseek-ai/cordis-plugin-include'
import { act, fireEvent, within } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { TestClient, remoteDefaultResponses } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { RemoteMock, ok } from '@deepseek-ai/dsh-remote-mock'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionFollowFrame, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { DevicePreviewInjected } from '../src/client/model.ts'
import type { DevicePreviewStore } from '../src/client/store.ts'
import type { DevicePreviewId, DevicePreviewOpenRequest, DevicePreviewRequestId } from '../src/types.ts'
import * as featurePlugin from '../src/client/index.ts'
import { en } from '../src/client/copy.ts'
import { devicePreviewRuntimePlan } from './device-preview-runtime.client.ts'
import { InertNativeBrowser, InertPreviewBridge } from './inert-native-browser.client.ts'

const SESSION = 'device-composition-session' as SessionId
const ID = '@deepseek-ai/dsh-client-ui-device-preview'

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
  const native = new InertNativeBrowser()
  const bridge = new InertPreviewBridge()
  const language = document.documentElement.getAttribute('lang')
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
      container.remove()
      vi.unstubAllGlobals()
      localStorage.clear()
      for (const [key, value] of savedStorage) localStorage.setItem(key, value)
      if (language === null) document.documentElement.removeAttribute('lang')
      else document.documentElement.setAttribute('lang', language)
    }
  })
  localStorage.clear()
  vi.stubGlobal('dshDesktop', { preview: bridge })
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
  c.ctx.loader.builtins.inertNativeBrowser = { apply: (ctx: Context) => { ctx.provide('nativeBrowser', native) } }
  c.ctx.loader.builtins.devicePreviewUnderTest = featurePlugin
  await c.ctx.loader.create({ name: 'cordis:include', config: { path: new URL('./fixtures/cordis.yml', import.meta.url).href } })
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
  await act(async () => { if (!c.ctx.sidebarRight.isExpanded()) c.ctx.sidebarRight.toggleExpanded() })
  return { client: c, mock, native, bridge, feature, container, view: within(container) }
}

function ownEntries(client: TestClient, slot: Parameters<Context['slots']['entries']>[0]) {
  return client.ctx.slots.entries(slot).filter(entry => entry.options.key === ID || entry.options.id === 'device-preview.stop-notice')
}

describe('Device Preview through test-only YAML and the real client application', () => {
  usePinnedBrowserLanguages('en')

  it('shows the localized guide and label, starts both real controllers, and retains guests through frame and source changes', async () => {
    const h = await bench()
    expect(h.view.getByRole('button', { name: `${en.title} ${en['guide.description']}` })).toBeTruthy()
    expect(h.native.guests).toEqual([])
    await act(async () => { fireEvent.click(h.view.getByRole('button', { name: `${en.title} ${en['guide.description']}` })) })
    expect(h.view.getByRole('tab', { name: new RegExp(en.title) })).toBeTruthy()
    expect(h.view.getByText(en.limitation)).toBeTruthy()
    expect(h.native.guests).toHaveLength(2)
    expect(h.native.guests.every(guest => guest.history.length === 0)).toBe(true)
    await act(async () => {
      fireEvent.change(h.view.getAllByRole('textbox', { name: en.url })[0]!, { target: { value: 'https://design.test/' } })
    })
    await act(async () => {
      fireEvent.click(h.view.getByRole('button', { name: en.start }))
      fireEvent.click(h.view.getByRole('button', { name: en.compare }))
    })
    const [phone, tablet] = h.native.guests
    if (phone === undefined || tablet === undefined) throw new Error('comparison guests are missing')
    expect(phone.history.map(target => target.url)).toEqual(['https://design.test/'])
    expect(tablet.history.map(target => target.url)).toEqual(['https://design.test/'])
    const phoneView = within(h.view.getByRole('region', { name: en.phone }))
    await act(async () => {
      fireEvent.change(phoneView.getByRole('textbox', { name: en.url }), { target: { value: 'https://design.test/phone' } })
    })
    await act(async () => {
      fireEvent.click(phoneView.getByRole('button', { name: en.go }))
      fireEvent.click(phoneView.getByRole('button', { name: en.landscape }))
      fireEvent.click(phoneView.getByRole('button', { name: en.actual }))
      fireEvent.click(phoneView.getByRole('button', { name: en.image }))
    })
    expect(phone.history.map(target => target.url)).toEqual(['https://design.test/', 'https://design.test/phone'])
    expect(tablet.history.map(target => target.url)).toEqual(['https://design.test/'])
    expect(phoneView.getByText(en['image.label'])).toBeTruthy()
    expect(phone.mounts).toHaveLength(1)
    expect(phone.detached).toBe(0)
    expect(phone.disposed).toBe(false)
    expect(phone.reloads).toBe(0)
    expect(phone.viewports.at(-1)).toEqual({ width: 852, height: 393, scale: 1 })
  }, 60_000)

  it('shows a fresh explicit native web opening even when the retained pane was displaying a design image', async () => {
    const h = await bench()
    await act(async () => { fireEvent.click(h.view.getByRole('button', { name: `${en.title} ${en['guide.description']}` })) })
    const phone = within(h.view.getByRole('region', { name: en.phone }))
    await act(async () => {
      fireEvent.click(phone.getByRole('button', { name: en.landscape }))
      fireEvent.click(phone.getByRole('button', { name: en.image }))
    })
    expect(phone.getByText(en['image.label'])).toBeTruthy()
    const request: DevicePreviewOpenRequest = { type: 'device-preview-open', sessionId: SESSION,
      previewId: '30000000-0000-4000-8000-000000000001' as DevicePreviewId,
      requestId: '30000000-0000-4000-8000-000000000002' as DevicePreviewRequestId,
      server: { cwd: '', url: 'https://fresh-app.test/', ownership: 'external', status: 'external' } }
    await act(async () => { h.bridge.open(request) })
    expect(phone.queryByText(en['image.label'])).toBeNull()
    expect(phone.getByRole('button', { name: en.live }).getAttribute('aria-pressed')).toBe('true')
    expect(phone.getByRole('button', { name: en.landscape }).getAttribute('aria-pressed')).toBe('true')
    expect(h.native.guests).toHaveLength(2)
    expect(h.native.guests.map(guest => guest.history.at(-1)?.url)).toEqual([request.server.url, request.server.url])
    expect(h.native.guests.every(guest => guest.mounts.length === 1)).toBe(true)
    await act(async () => {
      h.native.guests.forEach((guest, index) => {
        const viewport = guest.viewports.at(-1)
        if (viewport === undefined) throw new Error('Expected requested native metrics')
        guest.acknowledge(`30000000-0000-4000-8000-00000000000${index + 3}` as DesktopBrowserLeaseId, viewport)
      })
    })
    expect(h.bridge.acknowledgements).toContainEqual({ previewId: request.previewId, requestId: request.requestId, opened: true })
  }, 60_000)

  it('removes guide, body, title, overlay and native opening listener on fiber disposal and installs each once after re-add', async () => {
    const h = await bench()
    const originalFiber = h.feature.fiber
    expect(h.bridge.listeners.size).toBe(1)
    for (const slot of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'shell.overlay'] as const) expect(ownEntries(h.client, slot)).toHaveLength(1)
    await act(async () => {
      await h.feature.update({ disabled: true })
      await originalFiber?.dispose()
      await h.client.ctx.loader.await()
    })
    expect(h.client.ctx.sidebarRightTabs.get('device-preview')).toBeUndefined()
    expect(h.bridge.listeners.size).toBe(0)
    for (const slot of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'shell.overlay'] as const) expect(ownEntries(h.client, slot)).toHaveLength(0)
    expect(h.view.queryByRole('button', { name: `${en.title} ${en['guide.description']}` })).toBeNull()
    await act(async () => { await h.feature.update({ disabled: false }); await h.client.ctx.loader.await() })
    expect(h.feature.fiber).not.toBe(originalFiber)
    expect(h.bridge.listeners.size).toBe(1)
    for (const slot of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'shell.overlay'] as const) expect(ownEntries(h.client, slot)).toHaveLength(1)
    expect(h.view.getAllByRole('button', { name: `${en.title} ${en['guide.description']}` })).toHaveLength(1)
    const request: DevicePreviewOpenRequest = { type: 'device-preview-open', sessionId: SESSION,
      previewId: 'native-readded-preview' as DevicePreviewId, requestId: 'native-readded-request' as DevicePreviewRequestId,
      server: { cwd: '/design', url: 'https://native-design.test/', ownership: 'external', status: 'external' } }
    await act(async () => { h.bridge.open(request) })
    expect(h.view.getByRole('tab', { name: new RegExp(en.title) })).toBeTruthy()
    expect(h.native.guests).toHaveLength(2)
    expect(h.native.guests.map(guest => guest.history[0]?.url)).toEqual([request.server.url, request.server.url])
  }, 60_000)

  it('rebinds the registered Session face to current store Actions before forgetting a closed tab', async () => {
    const h = await bench()
    const entry = ownEntries(h.client, 'sidebar.right.pane.tab')[0]
    if (entry?.inject === undefined || entry.store === undefined) throw new Error('registered body lacks its store or inject face')
    // SlotCore erases the registration generics; the feature's own declared types recover them for this caller.
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
