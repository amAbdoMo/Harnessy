// @vitest-environment jsdom
/** Browser type, Slot, locale, and HMR disposal through the real registries. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestStubs } from './website-request-stubs.client.ts'
import { ShortcutRegistry } from '@deepseek-ai/dsh-client-shortcuts/src/client/registry.ts'
import type { ShortcutCommand, ShortcutPlatform } from '@deepseek-ai/dsh-client-shortcuts/client'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { BrowserBody } from '../src/client/view/BrowserBody.tsx'
import { BrowserTitle } from '../src/client/view/BrowserTitle.tsx'
import { BrowserProfileNotice } from '../src/client/view/BrowserProfileNotice.tsx'
import type { BrowserInjected } from '../src/client/browser/BrowserController.ts'
import { BROWSER_ID, BROWSER_KIND } from '../src/client/definition.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type {
  DesktopBrowserBridge, DesktopBrowserLeaseId, DesktopWebsiteProfile, DesktopWebsiteProfileId,
  DesktopWebsiteProfileInput, DesktopWebsiteProfilesBridge,
} from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
})

/** @returns the desktop profile bridge as preload exposes it; each test drives what it asserts. */
function profileStubs() {
  return {
    list: vi.fn<DesktopWebsiteProfilesBridge['list']>(async () => []),
    create: vi.fn(async (input: DesktopWebsiteProfileInput): Promise<DesktopWebsiteProfile> =>
      ({ ...input, id: 'created-profile' as DesktopWebsiteProfileId, control: 'human' })),
    acquire: vi.fn(async () => ({ lease: 'profile-lease' as DesktopBrowserLeaseId, partition: 'persist:dsh-website-created-profile' })),
    setControl: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
    onChanged: vi.fn(() => () => {}),
  }
}

interface Recorded {
  name: string
  id?: string
  key: string
  locale?: string
  store?: unknown
  inject?: unknown
  component: unknown
}

async function boot(platform: ShortcutPlatform = 'macos', runtime: 'desktop' | 'web' = 'desktop') {
  const ctx = new Context()
  contexts.push(ctx)
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((namespace: string, value: unknown) => {
      dictionaries.set(namespace, value)
      return () => { dictionaries.delete(namespace) }
    }),
  }
  const openTabs = createSnapshotStore<readonly { sessionId: string; tabId: TabId }[]>([])
  const target = { sessionId: 'session', paneId: 'pane' }
  const sidebar = { openTabs, commandTarget: vi.fn<() => typeof target | undefined>(() => target),
    openTabFromTarget: vi.fn() }
  const registry = new ShortcutRegistry(runtime, platform)
  ctx.provide('sidebarRight', sidebar as never)
  ctx.provide('shortcuts', { register: (command: ShortcutCommand) => registry.register(command) } as never)
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('workspaces', { list: createSnapshotStore({ phase: 'ready', items: [] }) } as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { tabs, registered, dictionaries, fiber, openTabs, registry, sidebar, target }
}

describe('ui-sidebar-browser apply', () => {
  it.each([0, 1])('binds and rebinds session controllers under desktop protocol %s', async (protocolVersion) => {
    const acquire = vi.fn(async () => ({ lease: 'test-lease' as DesktopBrowserLeaseId, partition: 'test-partition' }))
    const bridge: DesktopBrowserBridge = { profiles: profileStubs(), requests: requestStubs(), acquire, command: vi.fn(async () => {}),
      release: vi.fn(async () => {}), onOpenRequested: vi.fn(() => () => {}) }
    vi.stubGlobal('dshDesktop', { protocolVersion, browser: bridge })
    const h = await boot()
    expect(h.tabs.get(BROWSER_KIND)?.keepMounted).toBe(protocolVersion === 1)
    expect(h.registered.some(entry => entry.id === 'browser.profile-notice')).toBe(protocolVersion === 1)
    const injectFace = h.registered.find(entry => entry.name === 'sidebar.right.pane.tab')!.inject as
      (sessionId: string, actions: Parameters<BrowserInjected['rebind']>[0]) => BrowserInjected
    const firstStore = createBrowserStore().create(`apply-first-${protocolVersion}`)
    const replacementStore = createBrowserStore().create(`apply-replacement-${protocolVersion}`)
    const controller = injectFace('session', firstStore.actions)
    expect(controller.profiles === undefined).toBe(protocolVersion === 0)
    await vi.waitFor(() => { expect(controller.hooks.websiteProfiles.getSnapshot().phase).toBe('ready') })
    expect(injectFace('session', replacementStore.actions)).toBe(controller)
    const host = document.createElement('div')
    host.id = `browser-apply-${protocolVersion}`
    document.body.append(host)
    const signal = new AbortController()
    const tabId = 'apply-tab' as TabId
    try {
      controller.mount({ tabId, signal: signal.signal, viewportId: host.id, applicationOrigin: 'https://dsh.example',
        initial: undefined, initialUrl: 'https://example.test/', profileId: undefined, openTab: vi.fn() })
      expect(replacementStore.getSnapshot().byTab[tabId]).toBeDefined()
      expect(firstStore.getSnapshot().byTab[tabId]).toBeUndefined()
      if (protocolVersion === 1) await vi.waitFor(() => { expect(acquire).toHaveBeenCalledWith('session:session') })
      else expect(host.querySelector('iframe')).not.toBeNull()
      h.openTabs.set([{ sessionId: 'other', tabId }, { sessionId: 'session', tabId: 'other-tab' as TabId }])
      signal.abort()
      expect(replacementStore.getSnapshot().byTab[tabId]).toBeUndefined()
      const reopened = new AbortController()
      controller.mount({ tabId, signal: reopened.signal, viewportId: host.id, applicationOrigin: 'https://dsh.example',
        initial: undefined, initialUrl: 'https://retained.example/', profileId: undefined, openTab: vi.fn() })
      h.openTabs.set([{ sessionId: 'session', tabId }])
      reopened.abort()
      expect(replacementStore.getSnapshot().byTab[tabId]).toBeDefined()
      const active = new AbortController()
      controller.mount({ tabId, signal: active.signal, viewportId: host.id, applicationOrigin: 'https://dsh.example',
        initial: undefined, initialUrl: undefined, profileId: undefined, openTab: vi.fn() })
      await h.fiber.dispose()
      expect(controller.keyedHooks.browserState(tabId)).toBeUndefined()
    } finally {
      await h.fiber.dispose()
      host.remove()
    }
  })

  it('registers a multi-instance builtin and its body and title', async () => {
    const { tabs, registered, dictionaries } = await boot()
    const definition = tabs.get(BROWSER_KIND)
    expect(definition).toMatchObject({ id: BROWSER_ID, kind: BROWSER_KIND, multiple: true, priority: 'builtin' })
    expect(definition?.title('sidebar://browser')).toBe('type.label')
    expect(definition?.guide?.map(entry => [entry.order, entry.title(), entry.description?.()]))
      .toEqual([[30, 'guide.title', 'guide.description']])
    expect(dictionaries.get('sidebarBrowser')).toEqual({ zh, en })
    expect(dictionaries.get('sidebarBrowser')).toMatchObject({
      zh: { 'guide.description': '浏览网页' },
      en: { 'guide.description': 'Browse web pages' },
    })
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['sidebar.right.pane.tab', BROWSER_ID, 'sidebarBrowser', BrowserBody],
      ['sidebar.right.pane.tab.title', BROWSER_ID, undefined, BrowserTitle],
    ])
    expect(registered[0]?.store).toBeDefined()
    expect(registered[0]?.inject).toBeTypeOf('function')
    const injectFace = registered[0]?.inject as ((sessionId: string, actions: unknown) => unknown)
    const browser = injectFace('session', { replace: vi.fn(), forget: vi.fn() }) as BrowserInjected
    expect(browser.keyedHooks.browserState('missing')).toBeUndefined()
    expect(typeof browser.mount).toBe('function')
    // No desktop bridge: the tab keeps its chrome and publishes no profile commands.
    expect(browser.profiles).toBeUndefined()
    expect(browser.hooks.websiteProfiles.getSnapshot()).toMatchObject({ phase: 'ready', profiles: [] })
  })

  it('offers saved-profile commands and one notice overlay on the desktop bridge', async () => {
    const profiles = profileStubs()
    const unsubscribe = vi.fn()
    profiles.onChanged.mockReturnValue(unsubscribe)
    const id = 'profile-1' as DesktopWebsiteProfileId
    profiles.list.mockResolvedValue([{ id, name: 'Work', accountLabel: '', url: 'https://work.example/', mcpServerName: 'website', control: 'human' }])
    vi.stubGlobal('dshDesktop', {
      protocolVersion: 1,
      browser: { profiles, acquire: vi.fn(), command: vi.fn(async () => {}), release: vi.fn(), onOpenRequested: vi.fn(() => () => {}) },
    })
    const h = await boot()
    const notice = h.registered.find(entry => entry.id === 'browser.profile-notice')
    expect([notice?.name, notice?.locale, notice?.component]).toEqual(['shell.overlay', 'sidebarBrowser', BrowserProfileNotice])
    const bodyFace = h.registered.find(entry => entry.name === 'sidebar.right.pane.tab')!.inject as
      (sessionId: string, actions: unknown) => BrowserInjected
    const browser = bodyFace('session', { replace: vi.fn(), forget: vi.fn() })
    expect(browser.profiles).toBeDefined()
    await vi.waitFor(() => { expect(browser.hooks.websiteProfiles.getSnapshot().profiles).toHaveLength(1) })
    await browser.profiles!.signOut(id)
    expect(profiles.signOut).toHaveBeenCalledWith(id)
    expect(profiles.setControl).not.toHaveBeenCalled()
    expect(browser.hooks.websiteProfiles.getSnapshot().notice).toMatchObject({ kind: 'signedOut', name: 'Work' })
    const overlay = notice!.inject as () => { dismissWebsiteProfileNotice: () => void; hooks: BrowserInjected['hooks'] }
    const face = overlay()
    expect(face.hooks.websiteProfiles).toBe(browser.hooks.websiteProfiles)
    face.dismissWebsiteProfileNotice()
    expect(browser.hooks.websiteProfiles.getSnapshot().notice).toBeNull()
    await h.fiber.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it.each(['macos', 'windows'] as const)('opens the resolved Browser target with the %s default and releases the shortcut', async (platform) => {
    const h = await boot(platform)
    try {
      expect(h.registry.catalog.getSnapshot()[0]?.keys).toEqual(platform === 'macos' ? ['⌘', 'T'] : ['Ctrl', '+', 'T'])
      expect(h.tabs.get(BROWSER_KIND)?.guide?.[0]?.commandId).toBe('browser.new')
      const gesture = { code: 'KeyT', control: platform === 'windows', meta: platform === 'macos',
        alt: false, shift: false, repeat: false, composing: false, defaultPrevented: false }
      const context = { region: 'page' as const, modal: null, target: null }
      const consume = vi.fn()
      expect(h.registry.dispatch(gesture, context, consume).status).toBe('handled')
      expect(h.sidebar.openTabFromTarget).toHaveBeenCalledExactlyOnceWith('browser', h.target)
      h.registry.dispatch({ ...gesture, repeat: true }, context, consume)
      expect(h.sidebar.openTabFromTarget).toHaveBeenCalledOnce()
      h.sidebar.commandTarget.mockReturnValue(undefined)
      expect(h.registry.dispatch(gesture, context, consume).status).toBe('blocked')
    } finally { await h.fiber.dispose() }
    expect(h.registry.catalog.getSnapshot()).toEqual([])
  })

  it('publishes the macOS Web Browser default', async () => {
    const h = await boot('macos', 'web')
    try { expect(h.registry.catalog.getSnapshot()[0]?.binding).toEqual({ code: 'KeyT', modifiers: ['alt', 'meta'] }) }
    finally { await h.fiber.dispose() }
  })

  it('removes every registration when the plugin is disposed', async () => {
    const { tabs, registered, dictionaries, fiber } = await boot()
    await fiber.dispose()
    expect(tabs.get(BROWSER_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})
