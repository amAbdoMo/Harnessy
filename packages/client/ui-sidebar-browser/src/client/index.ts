/** Register the HTTP(S) Browser tab type in the right Sidebar. */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { BrowserBody, type BrowserBodyProps } from './view/BrowserBody.tsx'
import { BrowserTitle } from './view/BrowserTitle.tsx'
import { BrowserProfileNotice, type BrowserProfileNoticeInjected } from './view/BrowserProfileNotice.tsx'
import { createBrowserControllers } from './browser/BrowserController.ts'
import { WebsiteRequestSession } from './browser/WebsiteRequestSession.ts'
import type { BrowserInjected } from './browser/BrowserController.ts'
import { absentWebsiteProfilesSource, createWebsiteProfilesModel } from './browser/profiles.ts'
import { createIframePage } from './pages.ts'
import { createElectronPage } from './electron/pages.ts'
import type { DesktopBrowserBridge, DesktopWebsiteProfileId } from '../types.ts'
import { browserWorkspace } from './electron/workspace.ts'
import type { BrowserPageFactory } from './browser/BrowserPage.ts'
import { BROWSER_ID, browserDefinition } from './definition.tsx'
import { en, zh } from './locales.ts'
import { createBrowserStore } from './browser/store.ts'
import { createWebsiteProfileDraftStore } from './browser/profile-draft.ts'
import { BrowserProfilePicker, type BrowserProfilePickerInjected } from './view/BrowserProfilePicker.tsx'

export type { BrowserBodyProps } from './view/BrowserBody.tsx'
export type { BrowserControllerState, BrowserInjected, BrowserMountRequest, BrowserTabControllers } from './browser/BrowserController.ts'
export type { BrowserFrame, BrowserFrameState, BrowserLoadError, BrowserSandboxControl } from './browser/BrowserFrame.ts'
export type { BrowserPage, BrowserPageFactory, BrowserPageOptions } from './browser/BrowserPage.ts'
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
    browser: { readonly url?: string; readonly profileId?: DesktopWebsiteProfileId }
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
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-sidebar-browser.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({ ...browserDefinition(t), keepMounted: desktop !== undefined }), 'ui-sidebar-browser.type')
  const installFrames = (scope: Context): void => {
    const controllers = new Map<BrowserBodyProps['sessionId'], BrowserInjected>()
    const requests = new Map<BrowserBodyProps['sessionId'], WebsiteRequestSession>()
    const factory = (sessionId: BrowserBodyProps['sessionId']): BrowserPageFactory => {
      if (desktop === undefined) return createIframePage
      const session = new WebsiteRequestSession(sessionId, desktop.requests,
        (profile, outcome) => { profiles?.reportRequest(profile, outcome) })
      requests.set(sessionId, session)
      return options => createElectronPage(options, desktop,
        signal => browserWorkspace(scope.workspaces.list, sessionId, signal), session)
    }
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
      children: { 'sidebar.right.pane.tab.browser.profiles': { kind: 'single', scope: 'session' } },
      inject: (sessionId, actions): BrowserInjected => {
        let face = controllers.get(sessionId)
        if (face === undefined) {
          face = {
            ...createBrowserControllers(actions, factory(sessionId), tabId =>
              openTabs.getSnapshot().some(tab => tab.sessionId === sessionId && tab.tabId === tabId), () => websiteProfiles.getSnapshot()),
            profiles: profileCommands,
            hooks: { websiteProfiles },
          }
          controllers.set(sessionId, face)
        } else face.rebind(actions)
        return face
      },
    }, BrowserBody)), 'ui-sidebar-browser.body')
  }
  if (desktop === undefined) installFrames(ctx)
  else ctx.inject(['workspaces'], installFrames)
  if (profiles !== undefined) {
    ctx.effect(() => () => profiles.dispose(), 'ui-sidebar-browser.profiles')
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.browser.profiles', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.browser.profiles', locale: namespace, store: createWebsiteProfileDraftStore(),
      inject: (): BrowserProfilePickerInjected => ({ profiles: profiles.commands, hooks: { websiteProfiles } }),
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
