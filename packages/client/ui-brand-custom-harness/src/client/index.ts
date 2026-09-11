/** Harnessy occupants for brand slots, product tokens, and the About row. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { AboutRow, type AboutRowInjected } from './AboutRow.tsx'
import {
  OpenAIAccountCard, type OpenAIAccountInjected, type OpenAIAccountOperations,
} from './OpenAIAccountCard.tsx'
import {
  CustomHarnessMark, CustomHarnessName, CustomHarnessTagline, requiredBuildValue,
} from './Brand.tsx'
import { en, zh, type BrandKey } from './locales.ts'
import { CUSTOM_HARNESS_THEME_TOKENS } from './tokens.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Harnessy identity and About copy. */
    'customHarnessBrand': BrandKey
  }
}

const BUILD_PROFILE = 'custom-harness'
const LOCALE_NS = 'customHarnessBrand'

/** Required services: slots, locale, and theme token composition. */
export const inject = ['slots', 'locale', 'theme', 'remote', 'remote.openAIAccount']

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

  const accountOperations: OpenAIAccountOperations = {
    describe: async () => {
      const response = await ctx.remote.openAIAccount.describe()
      return response.ok ? { state: response.value } : { error: response.error.message }
    },
    signIn: async (signal) => {
      const response = await ctx.remote.openAIAccount.signIn(signal)
      return response.ok
        ? { authorized: response.value.status === 'authorized' }
        : { authorized: false, error: response.error.message }
    },
    signOut: async () => {
      const response = await ctx.remote.openAIAccount.signOut()
      return response.ok ? undefined : response.error.message
    },
  }
  const account = (): OpenAIAccountInjected => ({ operations: accountOperations })
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'custom-harness-openai-account',
    order: -100,
    locale: LOCALE_NS,
    inject: account,
  }, OpenAIAccountCard))
}
