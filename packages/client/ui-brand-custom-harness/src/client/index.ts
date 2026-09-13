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
import { AboutRow, type AboutRowInjected } from './AboutRow.tsx'
import { AccountLauncher, type AccountLauncherInjected } from './AccountLauncher.tsx'
import {
  AccountsManagerCard, type AccountsManagerInjected, type AccountsManagerOperations,
} from './AccountsManagerCard.tsx'
import { createAccountsMenuStore } from './accounts-menu-store.ts'
import { AccountsUsageController } from './accounts-usage.ts'
import { SharedSkillsRow, type SharedSkillsRowInjected } from './SharedSkillsRow.tsx'
import {
  McpServersSection, type McpManagerOperations, type McpServersInjected,
} from './McpServersSection.tsx'
import { createSharedSkillsRowStore } from './shared-skills-store.ts'
import {
  CustomHarnessMark, CustomHarnessName, CustomHarnessTagline, requiredBuildValue,
} from './Brand.tsx'
import { en, zh, type BrandKey } from './locales.ts'
import { CUSTOM_HARNESS_THEME_TOKENS } from './tokens.ts'
import {
  decodeSharedSkillsSettings, SHARED_SKILLS_SETTINGS_NAMESPACE, type SharedSkillsSettings,
} from '../shared-skills.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Harnessy identity and About copy. */
    'customHarnessBrand': BrandKey
  }
}

const BUILD_PROFILE = 'custom-harness'
const LOCALE_NS = 'customHarnessBrand'

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

  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'custom-harness brand: dictionaries')
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

  const mcpOperations: McpManagerOperations = {
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
    rename: (provider, accountId, name) => publishAccountState(accountRemoteOperations.rename(provider, accountId, name)),
    remove: (provider, accountId) => publishAccountState(accountRemoteOperations.remove(provider, accountId)),
    refreshUsage: signal => publishAccountState(accountRemoteOperations.refreshUsage(signal)),
  }
  const accountsMenuStore = createAccountsMenuStore()
  ctx.effect(() => accountsUsage.start(), 'custom-harness: automatic account usage refresh')
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
}
