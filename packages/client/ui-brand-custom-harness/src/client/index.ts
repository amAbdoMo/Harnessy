/** Harnessy occupants for brand slots, product tokens, and the About row. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { AccountsState } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { AboutRow, type AboutRowInjected } from './AboutRow.tsx'
import { AccountLauncher, type AccountLauncherInjected } from './AccountLauncher.tsx'
import {
  AccountsManagerCard, type AccountsManagerInjected, type AccountsManagerOperations,
} from './AccountsManagerCard.tsx'
import { createAccountsMenuStore } from './accounts-menu-store.ts'
import { AccountsUsageController } from './accounts-usage.ts'
import { NotificationCenter, type NotificationCenterInjected } from './NotificationCenter.tsx'
import {
  accountSwitchNotification,
  type HarnessNotificationEvent,
  NotificationHistoryController,
} from './notification-history.ts'
import { notificationPresentation, shouldShowNativeNotification } from './notification-presentation.ts'
import { SharedSkillsRow, type SharedSkillsRowInjected } from './SharedSkillsRow.tsx'
import { SessionWorkspaceRow, type SessionWorkspaceRowInjected } from './SessionWorkspaceRow.tsx'
import {
  McpServersSection, type McpManagerOperations, type McpServersInjected,
} from './McpServersSection.tsx'
import {
  McpConfigurationAction, type McpConfigurationActionInjected,
} from './McpConfigurationAction.tsx'
import { McpSessionStatus, type McpSessionStatusInjected } from './McpSessionStatus.tsx'
import { McpStatusController } from './mcp-status.ts'
import { createSharedSkillsRowStore } from './shared-skills-store.ts'
import { createSessionWorkspaceRowStore } from './session-workspace-store.ts'
import {
  CustomHarnessMark, CustomHarnessName, CustomHarnessTagline, requiredBuildValue,
} from './Brand.tsx'
import { en, type BrandKey } from './locales.ts'
import { CUSTOM_HARNESS_THEME_TOKENS } from './tokens.ts'
import {
  decodeSharedSkillsSettings, SHARED_SKILLS_SETTINGS_NAMESPACE, type SharedSkillsSettings,
} from '../shared-skills.ts'
import {
  decodeSessionWorkspaceSettings,
  SESSION_WORKSPACE_SETTINGS_NAMESPACE,
  type SessionWorkspaceMode,
  type SessionWorkspaceSettings,
} from '../session-workspace.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Harnessy identity and About copy. */
    'customHarnessBrand': BrandKey
  }
}

const BUILD_PROFILE = 'custom-harness'
const LOCALE_NS = 'customHarnessBrand'

interface DesktopNotificationBridge {
  readonly notifications?: {
    show(payload: { readonly title: string; readonly body: string }): Promise<boolean>
  }
}

function shortenNotificationCopy(copy: string, limit: number): string {
  return copy.length <= limit ? copy : `${copy.slice(0, limit - 1).trimEnd()}…`
}

function showNativeNotification(title: string, body: string): void {
  const bridge = (globalThis as typeof globalThis & { dshDesktop?: DesktopNotificationBridge }).dshDesktop
  const notifications = bridge?.notifications
  if (notifications === undefined) return
  void notifications.show({
    title: shortenNotificationCopy(title, 120),
    body: shortenNotificationCopy(body, 500),
  }).catch((reason: unknown) => {
    console.warn('Harnessy native notification failed:', reason)
  })
}

/** Required services: slots, locale, and theme token composition. */
export const inject = [
  'slots', 'locale', 'theme', 'remote', 'remote.accounts', 'remote.directoryPicker',
  'remote.mcpManager', 'settingsScope',
]

/**
 * Install the Harnessy identity only in its named browser build.
 * @param ctx - Client root context carrying slots, locale, and theme services.
 */
export function apply(ctx: ClientContext): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== BUILD_PROFILE) return

  ctx.effect(() => ctx.locale.register(LOCALE_NS, { en }), 'custom-harness brand: dictionaries')
  ctx.effect(() => ctx.theme.overrideTokens(
    '@deepseek-ai/dsh-client-ui-brand-custom-harness',
    CUSTOM_HARNESS_THEME_TOKENS,
  ), 'custom-harness brand: theme tokens')

  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, CustomHarnessMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, CustomHarnessName)
    }))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, CustomHarnessMark))
  ctx.slots.inject('conversation.hero.brand.tagline', () => ctx.slots.register({
    name: 'conversation.hero.brand.tagline',
    locale: LOCALE_NS,
  }, CustomHarnessTagline))

  const about = (): AboutRowInjected => ({
    productName: requiredBuildValue('DSH_CLIENT_PRODUCT_NAME', process.env.DSH_CLIENT_PRODUCT_NAME),
    productUrl: requiredBuildValue('DSH_CLIENT_PRODUCT_URL', process.env.DSH_CLIENT_PRODUCT_URL),
    supportUrl: requiredBuildValue('DSH_CLIENT_SUPPORT_URL', process.env.DSH_CLIENT_SUPPORT_URL),
    version: requiredBuildValue('DSH_CLIENT_VERSION', process.env.DSH_CLIENT_VERSION),
  })
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'custom-harness-about',
    order: 100,
    locale: LOCALE_NS,
    inject: about,
  }, AboutRow))

  const sessionWorkspace = ctx.settingsScope.bind<SessionWorkspaceSettings>({
    namespace: SESSION_WORKSPACE_SETTINGS_NAMESPACE,
    decode: decodeSessionWorkspaceSettings,
  })
  const sessionWorkspaceStore = createSessionWorkspaceRowStore()
  let sessionWorkspaceActions: BoundActions<typeof sessionWorkspaceStore> | undefined
  const syncSessionWorkspace = (): void => {
    sessionWorkspaceActions?.sync(sessionWorkspace.getSnapshot())
  }
  ctx.effect(
    () => sessionWorkspace.subscribe(syncSessionWorkspace),
    'custom-harness: Session workspace settings row',
  )
  const sessionWorkspaceInjected = (
    actions: BoundActions<typeof sessionWorkspaceStore>,
  ): SessionWorkspaceRowInjected => {
    sessionWorkspaceActions = actions
    syncSessionWorkspace()
    return {
      chooseDirectory: async () => {
        const response = await ctx.remote.directoryPicker.pick()
        if (!response.ok) return { error: response.error.message }
        return response.value === null ? {} : { path: response.value }
      },
      setMode: (mode: SessionWorkspaceMode) => sessionWorkspace.set('mode', mode),
      useRemoteDirectory: directory => sessionWorkspace.mutate([
        { op: 'set', path: ['remoteRoot'], value: directory },
        { op: 'set', path: ['mode'], value: 'remote-website' },
      ]),
    }
  }
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'custom-harness-session-workspace',
    order: 20,
    locale: LOCALE_NS,
    store: sessionWorkspaceStore,
    inject: sessionWorkspaceInjected,
  }, SessionWorkspaceRow))

  const sharedSkills = ctx.settingsScope.bind<SharedSkillsSettings>({
    namespace: SHARED_SKILLS_SETTINGS_NAMESPACE,
    decode: decodeSharedSkillsSettings,
  })
  const sharedSkillsStore = createSharedSkillsRowStore()
  let sharedSkillsActions: BoundActions<typeof sharedSkillsStore> | undefined
  const syncSharedSkills = (): void => { sharedSkillsActions?.sync(sharedSkills.getSnapshot()) }
  ctx.effect(() => sharedSkills.subscribe(syncSharedSkills), 'custom-harness: shared skills settings row')
  const sharedSkillsInjected = (actions: BoundActions<typeof sharedSkillsStore>): SharedSkillsRowInjected => {
    sharedSkillsActions = actions
    syncSharedSkills()
    return {
      chooseDirectory: async () => {
        const response = await ctx.remote.directoryPicker.pick()
        if (!response.ok) return { error: response.error.message }
        return response.value === null ? {} : { path: response.value }
      },
      setDirectory: directory => sharedSkills.set('directory', directory),
      resetDirectory: () => sharedSkills.unset('directory'),
      setEnabled: enabled => sharedSkills.set('enabled', enabled),
    }
  }
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'custom-harness-shared-skills',
    order: 30,
    locale: LOCALE_NS,
    store: sharedSkillsStore,
    inject: sharedSkillsInjected,
  }, SharedSkillsRow))

  const notifications = new NotificationHistoryController()
  const notificationText = ctx.locale.bind(LOCALE_NS)
  const publishNotification = (event: HarnessNotificationEvent): void => {
    notifications.add(event)
    const pageIsForeground = document.visibilityState === 'visible' && document.hasFocus()
    if (!shouldShowNativeNotification(event, pageIsForeground)) return
    const presentation = notificationPresentation(event, notificationText)
    showNativeNotification(presentation.title, presentation.message)
  }
  ctx.effect(() => () => { notifications.dispose() }, 'custom-harness: notification history lifecycle')

  const mcpRemoteOperations: McpManagerOperations = {
    describe: async () => {
      const response = await ctx.remote.mcpManager.describe()
      return response.ok ? { state: response.value } : { error: response.error.message }
    },
    save: async (input) => {
      const response = await ctx.remote.mcpManager.save(input)
      return response.ok ? { state: response.value } : { error: response.error.message }
    },
    setEnabled: async (serverId, enabled) => {
      const response = await ctx.remote.mcpManager.setEnabled(serverId, enabled)
      return response.ok ? { state: response.value } : { error: response.error.message }
    },
    reconnect: async (serverId) => {
      const response = await ctx.remote.mcpManager.reconnect(serverId)
      return response.ok ? { state: response.value } : { error: response.error.message }
    },
    remove: async (serverId) => {
      const response = await ctx.remote.mcpManager.deleteServer(serverId)
      return response.ok ? { state: response.value } : { error: response.error.message }
    },
    openConfigurationFile: async () => {
      const response = await ctx.remote.mcpManager.openConfigurationFile()
      return response.ok ? {} : { error: response.error.message }
    },
  }
  const mcpStatus = new McpStatusController(mcpRemoteOperations, publishNotification)
  const publishMcpState = async (
    request: Promise<{ readonly state?: import('@deepseek-ai/dsh-api-remotes/client').McpManagerState; readonly error?: string }>,
  ): Promise<{ readonly state?: import('@deepseek-ai/dsh-api-remotes/client').McpManagerState; readonly error?: string }> => {
    const response = await request
    if (response.state !== undefined) mcpStatus.publish(response.state)
    return response
  }
  const mcpOperations: McpManagerOperations = {
    describe: () => publishMcpState(mcpRemoteOperations.describe()),
    save: input => publishMcpState(mcpRemoteOperations.save(input)),
    setEnabled: (serverId, enabled) => publishMcpState(mcpRemoteOperations.setEnabled(serverId, enabled)),
    reconnect: serverId => publishMcpState(mcpRemoteOperations.reconnect(serverId)),
    remove: serverId => publishMcpState(mcpRemoteOperations.remove(serverId)),
    openConfigurationFile: mcpRemoteOperations.openConfigurationFile,
  }
  const mcp = (): McpServersInjected => ({ operations: mcpOperations })
  const mcpNav = ctx.locale.bind(LOCALE_NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'custom-harness-mcp',
    order: 30,
    label: () => mcpNav('mcpNav'),
    locale: LOCALE_NS,
    inject: mcp,
  }, McpServersSection))
  ctx.slots.inject('settings.action', () => ctx.slots.register({
    name: 'settings.action',
    id: 'custom-harness-mcp-configuration',
    order: 10,
    locale: LOCALE_NS,
    inject: (): McpConfigurationActionInjected => ({
      openConfigurationFile: mcpOperations.openConfigurationFile,
    }),
  }, McpConfigurationAction))

  const accountRemoteOperations: AccountsManagerOperations = {
    describe: async () => {
      const response = await ctx.remote.accounts.describe()
      return response.ok ? { state: response.value } : { error: response.error.message }
    },
    addOAuth: async (provider, signal) => {
      const response = await ctx.remote.accounts.addOAuth(provider, signal)
      return response.ok
        ? { authorized: response.value.status === 'authorized' }
        : { authorized: false, error: response.error.message }
    },
    addApiKey: async (provider, name, key) => {
      const response = await ctx.remote.accounts.addApiKey(provider, name, key)
      return response.ok ? { state: response.value } : { error: response.error.message }
    },
    activate: async (provider, accountId) => {
      const response = await ctx.remote.accounts.activate(provider, accountId)
      return response.ok ? { state: response.value } : { error: response.error.message }
    },
    setAutoSwitch: async (provider, enabled) => {
      const response = await ctx.remote.accounts.setAutoSwitch(provider, enabled)
      return response.ok ? { state: response.value } : { error: response.error.message }
    },
    rename: async (provider, accountId, name) => {
      const response = await ctx.remote.accounts.rename(provider, accountId, name)
      return response.ok ? { state: response.value } : { error: response.error.message }
    },
    remove: async (provider, accountId) => {
      const response = await ctx.remote.accounts.deleteAccount(provider, accountId)
      return response.ok ? { state: response.value } : { error: response.error.message }
    },
    refreshUsage: async (signal) => {
      const response = await ctx.remote.accounts.refreshUsage(signal)
      return response.ok ? { state: response.value } : { error: response.error.message }
    },
  }
  const accountsUsage = new AccountsUsageController(accountRemoteOperations)
  const publishAccountState = async (
    request: Promise<{ readonly state?: AccountsState; readonly error?: string }>,
  ): Promise<{ readonly state?: AccountsState; readonly error?: string }> => {
    const response = await request
    accountsUsage.publish(response.state)
    return response
  }
  const accountOperations: AccountsManagerOperations = {
    describe: () => publishAccountState(accountRemoteOperations.describe()),
    addOAuth: (provider, signal) => accountRemoteOperations.addOAuth(provider, signal),
    addApiKey: (provider, name, key) => publishAccountState(accountRemoteOperations.addApiKey(provider, name, key)),
    activate: (provider, accountId) => publishAccountState(accountRemoteOperations.activate(provider, accountId)),
    setAutoSwitch: (provider, enabled) => publishAccountState(accountRemoteOperations.setAutoSwitch(provider, enabled)),
    rename: (provider, accountId, name) => publishAccountState(accountRemoteOperations.rename(provider, accountId, name)),
    remove: (provider, accountId) => publishAccountState(accountRemoteOperations.remove(provider, accountId)),
    refreshUsage: signal => publishAccountState(accountRemoteOperations.refreshUsage(signal)),
  }
  const accountsMenuStore = createAccountsMenuStore()
  ctx.effect(() => mcpStatus.start(), 'custom-harness: live MCP status')
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'custom-harness-mcp-status',
    order: 10,
    locale: LOCALE_NS,
    store: accountsMenuStore,
    inject: (): McpSessionStatusInjected => ({
      hooks: { mcpStatus: mcpStatus.snapshot },
      reconnect: serverId => mcpStatus.reconnect(serverId),
    }),
  }, McpSessionStatus))
  ctx.effect(() => accountsUsage.start(), 'custom-harness: automatic account usage refresh')
  ctx.effect(() => ctx.remote.$on('accounts/auto-switched', (event) => {
    publishNotification(accountSwitchNotification(event))
    void publishAccountState(accountRemoteOperations.describe())
  }), 'custom-harness: account switch notifications')
  const account = (): AccountsManagerInjected => ({ operations: accountOperations })
  const launcher = (): AccountLauncherInjected => ({
    hooks: { accountUsage: accountsUsage.state },
    refreshAccounts: () => { void accountsUsage.refresh() },
  })
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    name: 'settings.launcher',
    locale: LOCALE_NS,
    store: accountsMenuStore,
    inject: launcher,
  }, AccountLauncher))
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'custom-harness-accounts',
    order: -100,
    locale: LOCALE_NS,
    store: accountsMenuStore,
    inject: account,
  }, AccountsManagerCard))
  const notificationCenter = (): NotificationCenterInjected => ({
    hooks: {
      notifications: notifications.history,
      notificationToast: notifications.toast,
    },
    addNotification: publishNotification,
    markAllRead: () => { notifications.markAllRead() },
    clearNotifications: () => { notifications.clear() },
    dismissToast: (id) => { notifications.dismissToast(id) },
  })
  ctx.slots.inject('sidebar.workspaces.headerActions', () => ctx.slots.register({
    name: 'sidebar.workspaces.headerActions',
    id: 'custom-harness-notifications',
    order: 10,
    locale: LOCALE_NS,
    inject: notificationCenter,
  }, NotificationCenter))
}
