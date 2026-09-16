/** Harnessy Delegation settings section: Command Code lanes, limits, and workspace overrides. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CommandCodeCatalog,
  CommandCodeDelegationView,
  CommandCodeHealth,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  COMMAND_CODE_DELEGATION_NAMESPACE,
  decodeCommandCodeDelegationSettings,
} from './contract.ts'
import type { CommandCodeDelegationSettings } from './contract.ts'
import { DelegationSection } from './DelegationSection.tsx'
import type { DelegationOperations, DelegationSectionInjected } from './DelegationSection.tsx'
import { createDelegationSectionStore } from './delegation-section-store.ts'
import { en, zh, type DelegationKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Harnessy Command Code delegation copy. */
    'commandCodeDelegation': DelegationKey
  }
}

const BUILD_PROFILE = 'custom-harness'
const LOCALE_NS = 'commandCodeDelegation'

/** Required services: slots, locale, settings scope, and the Command Code Remote namespace. */
export const inject = ['slots', 'locale', 'remote', 'remote.commandcode', 'settingsScope']

/**
 * Install the Delegation section only in the Harnessy browser build.
 * @param ctx - Client root context carrying slots, locale, and the settings scope.
 */
export function apply(ctx: ClientContext): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== BUILD_PROFILE) return

  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'commandcode delegation: dictionaries')

  const scope = ctx.settingsScope.bind<CommandCodeDelegationSettings>({
    namespace: COMMAND_CODE_DELEGATION_NAMESPACE,
    decode: decodeCommandCodeDelegationSettings,
  })

  const operations: DelegationOperations = {
    snapshot: () => {
      const snapshot = scope.getSnapshot()
      return {
        status: snapshot.status,
        writable: snapshot.writable,
        value: snapshot.value,
      }
    },
    subscribe: listener => scope.subscribe(listener),
    write: async (patch) => {
      // The section is JSON by construction; the write path re-validates it
      // against the registered schema on the Host.
      const ops = Object.entries(patch).map(([field, value]) => ({
        op: 'set' as const,
        path: [field],
        value: value as JsonValue,
      }))
      await scope.mutate(ops)
    },
    health: async (signal): Promise<CommandCodeHealth> => {
      const response = await ctx.remote.commandcode.health(signal)
      if (!response.ok) throw new Error(response.error.message)
      return response.value
    },
    catalog: async (signal): Promise<CommandCodeCatalog> => {
      const response = await ctx.remote.commandcode.catalog(signal)
      if (!response.ok) throw new Error(response.error.message)
      return response.value
    },
    view: async (workspace: string | null, signal: AbortSignal): Promise<CommandCodeDelegationView> => {
      const response = await ctx.remote.commandcode.delegation(workspace, signal)
      if (!response.ok) throw new Error(response.error.message)
      return response.value
    },
  }

  const store = createDelegationSectionStore()
  let actions: BoundActions<typeof store> | undefined
  const sync = (): void => { actions?.sync(operations.snapshot()) }
  ctx.effect(() => operations.subscribe(sync), 'commandcode delegation: settings row')
  const injected = (bound: BoundActions<typeof store>): DelegationSectionInjected => {
    actions = bound
    sync()
    return { operations }
  }

  const nav = ctx.locale.bind(LOCALE_NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'commandcode-delegation',
    order: 20,
    label: () => nav('nav'),
    locale: LOCALE_NS,
    store,
    inject: injected,
  }, DelegationSection))
}
