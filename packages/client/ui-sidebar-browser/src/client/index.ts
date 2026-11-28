/** Register the HTTP(S) Browser tab type in the right Sidebar. */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { BrowserResponsiveInjected, BrowserTabParams } from './responsive.ts'
import { BrowserBody, type BrowserBodyProps } from './view/BrowserBody.tsx'
import { BrowserTitle } from './view/BrowserTitle.tsx'
import { BrowserProfileNotice, type BrowserProfileNoticeInjected } from './view/BrowserProfileNotice.tsx'
import { createBrowserControllers } from './browser/BrowserController.ts'
import { WebsiteRequestSession } from './browser/WebsiteRequestSession.ts'
import type { BrowserInjected } from './browser/BrowserController.ts'
import { absentWebsiteProfilesSource, createWebsiteProfilesModel } from './browser/profiles.ts'
import { createIframePage } from './pages.ts'
import { createElectronPage } from './electron/pages.ts'
import { observeBrowserBridge } from './electron/observed-bridge.ts'
import type { NativeBrowser } from './browser/native-browser.ts'
import type { DesktopBrowserBridge } from '../types.ts'
import { browserWorkspace } from './electron/workspace.ts'
import type { BrowserPageFactory } from './browser/BrowserPage.ts'
import { BROWSER_ID, BROWSER_KIND, browserDefinition } from './definition.tsx'
import { en, zh } from './locales.ts'
import { createBrowserStore } from './browser/store.ts'
import { createWebsiteProfileDraftStore } from './browser/profile-draft.ts'
import { BrowserProfilePicker, type BrowserProfilePickerInjected } from './view/BrowserProfilePicker.tsx'
import { BrowserDefaultsSection, type BrowserDefaultsInjected } from './view/BrowserDefaultsSection.tsx'
import { readBrowserDefaults } from './browser/defaults.ts'

export type { BrowserMode, BrowserResponsiveOwner, BrowserTabParams } from './responsive.ts'
export type { BrowserBodyProps } from './view/BrowserBody.tsx'
export type { BrowserControllerState, BrowserInjected, BrowserMountRequest, BrowserTabControllers } from './browser/BrowserController.ts'
export type { BrowserFrame, BrowserFrameState, BrowserLoadError, BrowserSandboxControl } from './browser/BrowserFrame.ts'
export type { BrowserPage, BrowserPageFactory, BrowserPageOptions } from './browser/BrowserPage.ts'
export type { NativeBrowser, NativeBrowserPageRequest } from './browser/native-browser.ts'
export type { BrowserPresentation } from './view/BrowserPresentation.ts'
export type { BrowserFailure, BrowserHistoryEntry, BrowserNavigationStatus, BrowserTabState } from './browser/BrowserPersistence.ts'
export type { SidebarBrowserKey } from './locales.ts'
export type { WebsiteProfileCommands, WebsiteProfileNotice, WebsiteProfilesModel, WebsiteProfilesState } from './browser/profiles.ts'
export type { BrowserState } from './browser/store.ts'
export type { BrowserAddressFailure, BrowserAddressResult, BrowserTarget } from './browser/url.ts'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /**
     * Optional initial Browser URL, and the saved website/account to open it in.
     * A page opened with a `profileId` uses that account's persistent storage and
     * never stores its own navigation.
     */
    browser: BrowserTabParams
  }
}

/** Required Browser services. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** Register the Browser type, localized guide entry, body, title, and saved-profile notice. */
export function apply(ctx: Context): void {
  const namespace = 'sidebarBrowser'
  const t = ctx.locale.bind(namespace)
  ctx.inject(['shortcuts'], (ctx) => {
    ctx.effect(() => ctx.shortcuts.register({
      id: 'browser.new' as ShortcutCommandId, label: () => t('guide.title'), aliases: ['browser', 'new browser tab'],
      defaults: {
        'desktop:macos': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyT', modifiers: ['primary'] },
        'web:macos': { code: 'KeyT', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyT', modifiers: ['primary', 'alt'] },
      },
      // Each tab plugin owns its command's availability, localized refusal, and tab kind.
      /* jscpd:ignore-start */
      regions: ['page', 'editable', 'terminal'], modals: [],
      resolve: ({ target: element }) => {
        const target = ctx.sidebarRight.commandTarget(element)
        if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
        return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget('browser', target) } }
      },
      /* jscpd:ignore-end */
    }), 'ui-sidebar-browser: shortcut')
    if (ctx.shortcuts.runtime === 'desktop') ctx.effect(() => ctx.shortcuts.register({
      id: 'browser.find' as ShortcutCommandId, label: () => t('find.label'), aliases: ['search current web page'],
      defaults: { 'desktop:windows': { code: 'KeyF', modifiers: ['primary'] } },
      regions: ['page', 'editable'], modals: [],
      resolve: ({ target: element, modal }) => {
        if (modal !== null) return { status: 'pass' }
        const target = ctx.sidebarRight.focusedTarget(element)
        const find = target?.occurrence?.commands.find
        if (target === undefined || find === undefined) return { status: 'blocked', reason: t('shortcut.noFindPage') }
        return { status: 'handled', run: () => {
          if (ctx.sidebarRight.isTargetCurrent(target) && target.occurrence?.commands.find === find) find()
        } }
      },
    }), 'ui-sidebar-browser: find shortcut')
  })
  const store = createBrowserStore()
  const openTabs = ctx.sidebarRight.openTabs
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { readonly protocolVersion: number; readonly browser?: DesktopBrowserBridge }
  }).dshDesktop
  const desktop = carrier?.protocolVersion === 1 ? carrier.browser : undefined
  // Saved profiles exist only where the desktop bridge owns their storage, so a
  // carrier without it publishes no commands and one unchanging empty state.
  const profiles = desktop === undefined ? undefined : createWebsiteProfilesModel(desktop.profiles)
  const profileCommands = profiles?.commands
  const websiteProfiles = profiles?.source ?? absentWebsiteProfilesSource()
  if (desktop !== undefined && profiles !== undefined) ctx.effect(() => {
    const pending = new Map<string, import('../types.ts').DesktopWebsiteHostSnapshot>()
    let retrying = false
    const retry = (): void => {
      if (retrying) return
      retrying = true
      try {
        for (const [requestId, request] of pending) {
          const profile = websiteProfiles.getSnapshot().profiles.find(candidate => candidate.id === request.profile)
          if (profile === undefined) continue
          const tabs = ctx.sidebarRight.tabsIn(request.sessionId)
          let inspectionPending = false
          let existing: typeof tabs[number] | undefined
          for (const tab of tabs) {
            if (tab.kind !== 'browser') continue
            try {
              const params = ctx.sidebarRight.tabDomain.occurrence(request.sessionId, { id: tab.id })
                .navigation.getSnapshot().params
              if (params?.profileId === profile.id) { existing = tab; break }
            } catch (_notCommitted) {
              inspectionPending = true
            }
          }
          if (existing !== undefined) {
            ctx.sidebarRight.focusIn(request.sessionId, existing.id)
            pending.delete(requestId)
            continue
          }
          if (inspectionPending) continue
          const before = tabs.length
          ctx.sidebarRight.openTabIn(request.sessionId, 'browser', { params: { url: profile.url, profileId: profile.id }, revealIfOpened: false })
          if (ctx.sidebarRight.tabsIn(request.sessionId).length !== before) pending.delete(requestId)
        }
      } finally { retrying = false }
    }
    const unsubscribePrepared = desktop.requests.onPrepared((request) => { pending.set(request.id, request); retry() })
    const unsubscribeProfiles = websiteProfiles.subscribe(retry)
    const unsubscribeTabs = openTabs.subscribe(retry)
    const unsubscribeMounted = ctx.sidebarRight.mounted.subscribe(retry)
    retry()
    return () => {
      unsubscribePrepared()
      unsubscribeProfiles()
      unsubscribeTabs()
      unsubscribeMounted()
      pending.clear()
    }
  }, 'ui-sidebar-browser.prepared-tabs')
  const onAgentOpen = desktop?.onAgentOpen?.bind(desktop)
  if (onAgentOpen !== undefined) ctx.effect(() => onAgentOpen((request) => {
    ctx.sidebarRight.openTabIn(request.sessionId as BrowserBodyProps['sessionId'], 'browser', {
      params: { url: request.url, openRequestId: request.requestId,
        ...(request.profileId === undefined ? {} : { profileId: request.profileId }) }, revealIfOpened: false,
      floating: readBrowserDefaults().autoShowFloatingPreview,
    })
  }), 'ui-sidebar-browser.agent-open')
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-sidebar-browser.copy')
  if (profiles !== undefined) ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'browser', label: () => t('guide.title'), order: 35, locale: namespace,
    children: { 'settings.browser.link-opening': { kind: 'single', scope: 'root' } },
    inject: (): BrowserDefaultsInjected => ({ hooks: { websiteProfiles }, reloadProfiles: profiles.commands.reload,
      projectAccess: desktop?.projectAccess, projects: ctx.get('workspaces')?.list }),
  }, BrowserDefaultsSection)), 'ui-sidebar-browser.settings')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    ...browserDefinition(t),
    keepMounted: desktop !== undefined,
    ...(desktop === undefined ? {} : { floatOnCollapse: () => readBrowserDefaults().autoShowFloatingPreview }),
    ...(profiles === undefined ? {} : {
      defaultParams: () => {
        const { profileId } = readBrowserDefaults()
        const { phase, profiles } = websiteProfiles.getSnapshot()
        if (profileId === undefined || (phase === 'ready' && !profiles.some(profile => profile.id === profileId))) return undefined
        return { profileId }
      },
    }),
  }), 'ui-sidebar-browser.type')
  const installFrames = (scope: Context): void => {
    const responsiveAvailable = {
      getSnapshot: () => scope.slots.entries('sidebar.right.pane.tab.browser.responsive').length !== 0,
      subscribe: (listener: () => void) => scope.slots.subscribe('sidebar.right.pane.tab.browser.responsive', listener),
    }
    const controllers = new Map<BrowserBodyProps['sessionId'], BrowserInjected & BrowserResponsiveInjected>()
    const requests = new Map<BrowserBodyProps['sessionId'], WebsiteRequestSession>()
    if (desktop !== undefined) scope.effect(() => scope.sidebarRight.registerCloseHandler(BROWSER_KIND, (sessionId, tab) => {
      const { params } = scope.sidebarRight.tabDomain.occurrence(sessionId, tab).navigation.getSnapshot()
      const browser = params as BrowserTabParams | undefined
      if (browser?.profileId !== undefined) return { params: { profileId: browser.profileId } }
      if (browser?.previewId !== undefined || browser?.responsiveOpenId !== undefined) return
      const url = controllers.get(sessionId)?.reopenAddress(tab.id) ?? browser?.url
      return { params: url === undefined ? {} : { url } }
    }), 'ui-sidebar-browser: record closed tabs')
    const native: NativeBrowser | undefined = desktop === undefined ? undefined : {
      createPage: ({ sessionId, options, leaseChanged }) => {
        let session = requests.get(sessionId)
        if (session === undefined) {
          session = new WebsiteRequestSession(sessionId, desktop.requests,
            (profile, outcome) => { profiles?.reportRequest(profile, outcome) },
            profile => websiteProfiles.getSnapshot().profiles.find(candidate => candidate.id === profile)?.access ?? 'ask')
          requests.set(sessionId, session)
        }
        const bridge = leaseChanged === undefined ? desktop : observeBrowserBridge(desktop, leaseChanged)
        const defaults = leaseChanged === undefined && options.profileId === undefined ? readBrowserDefaults() : undefined
        return createElectronPage(options, bridge,
          signal => browserWorkspace(scope.workspaces.list, sessionId, signal), session, defaults)
      },
    }
    if (native !== undefined) scope.provide('nativeBrowser', native)
    const factory = (sessionId: BrowserBodyProps['sessionId']): BrowserPageFactory =>
      native === undefined ? createIframePage : options => native.createPage({ sessionId, options })
    scope.effect(() => websiteProfiles.subscribe(() => {
      for (const session of requests.values()) void session.reload()
    }), 'ui-sidebar-browser.profile-access')
    scope.effect(() => async () => {
      // Stop every roster listener before joining any page's physical cleanup.
      const results = await Promise.allSettled([
        ...[...requests.values()].map(session => session.dispose()),
        ...[...controllers.values()].map(controller => controller.dispose()),
      ])
      const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (failures.length !== 0) throw new AggregateError(failures, 'Browser Sessions failed to drain')
      requests.clear()
      controllers.clear()
    }, 'ui-sidebar-browser.frames')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: BROWSER_ID, locale: namespace, store,
      children: {
        'sidebar.right.pane.tab.browser.profiles': { kind: 'single', scope: 'session' },
        'sidebar.right.pane.tab.browser.responsive': { kind: 'single', scope: 'session' },
      },
      inject: (sessionId, actions) => {
        let face = controllers.get(sessionId)
        if (face === undefined) {
          face = {
            ...createBrowserControllers(actions, factory(sessionId), tabId =>
              openTabs.getSnapshot().some(tab => tab.sessionId === sessionId && tab.tabId === tabId), () => websiteProfiles.getSnapshot()),
            profiles: profileCommands,
            addFeedback: desktop === undefined ? undefined : (file, text) => {
              const actx = scope.sessions.scope(sessionId)
              const conversation = actx?.get('conversation')
              if (actx === undefined || conversation === undefined || !conversation.attachFiles([file])) return false
              const input = conversation.input.for(actx)
              input.insertQuote(text)
              input.focus()
              return true
            },
            hooks: { websiteProfiles, responsiveAvailable },
          }
          controllers.set(sessionId, face)
        } else face.rebind(actions)
        return face
      },
    }, BrowserBody)), 'ui-sidebar-browser.body')
  }
  if (desktop === undefined) installFrames(ctx)
  else ctx.inject(['workspaces', 'conversation', 'sessions'], installFrames)
  if (profiles !== undefined) {
    let describeMcpServers: Context['remote']['mcpManager']['describe'] | undefined
    ctx.inject(['remote', 'remote.mcpManager'], (scope) => {
      describeMcpServers = () => scope.remote.mcpManager.describe()
      scope.effect(() => () => { describeMcpServers = undefined }, 'ui-sidebar-browser.mcp-inventory')
    })
    const listMcpServers: BrowserProfilePickerInjected['listMcpServers'] = async () => {
      const response = await describeMcpServers?.()
      if (response?.ok !== true || !response.value.available) throw new Error('MCP registry unavailable')
      return response.value.servers.map(({ name, serverName, enabled, status }) =>
        ({ name, serverName, connected: enabled && status === 'connected' }))
    }
    ctx.effect(() => () => profiles.dispose(), 'ui-sidebar-browser.profiles')
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.browser.profiles', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.browser.profiles', locale: namespace, store: createWebsiteProfileDraftStore(),
      inject: (): BrowserProfilePickerInjected => ({ profiles: profiles.commands, hooks: { websiteProfiles }, listMcpServers }),
    }, BrowserProfilePicker)), 'ui-sidebar-browser.profile-picker')
    // The notice outlives the tab body that asked for the action.
    ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'browser.profile-notice', locale: namespace,
      inject: (): BrowserProfileNoticeInjected => ({
        dismissWebsiteProfileNotice: () => { profiles.commands.dismiss() },
        hooks: { websiteProfiles: profiles.source },
      }),
    }, BrowserProfileNotice)), 'ui-sidebar-browser.profile-notice')
  }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: BROWSER_ID, store,
  }, BrowserTitle)), 'ui-sidebar-browser.title')
}
