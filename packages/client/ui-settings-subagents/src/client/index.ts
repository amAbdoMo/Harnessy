/** Harnessy Subagents settings page: the unified roster's roles, workspace overrides, and automatic routing. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the ctx.remote merge (the generated roster, session, and Command
// Code namespaces) and the section shape the settings scope hands back.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  CommandCodeCatalog,
  CommandCodeHealth,
  RemoteResult,
  SubagentSettings,
} from '@deepseek-ai/dsh-api-remotes/client'
import { COMMAND_CODE_BACKEND, SUBAGENT_ROSTER_NAMESPACE } from './contract.ts'
import { SubagentsSection } from './SubagentsSection.tsx'
import type { SubagentsOperations, SubagentsSectionInjected } from './SubagentsSection.tsx'
import { createSubagentsSectionStore } from './section-store.ts'
import { en, zh, type SubagentsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Harnessy unified-subagent roster copy. */
    'settings.subagents': SubagentsKey
  }
}

const BUILD_PROFILE = 'custom-harness'
const LOCALE_NS = 'settings.subagents'

/** Required services: slots, locale, settings scope, and the roster and session Remote namespaces. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.subagentRoster', 'remote.session', 'settingsScope',
]

/** The two reads this page makes through a backend's own Remote namespace. */
interface BackendRemoteReads {
  readonly health: (signal?: AbortSignal) => Promise<RemoteResult<CommandCodeHealth>>
  readonly catalog: (signal?: AbortSignal) => Promise<RemoteResult<CommandCodeCatalog>>
}

/**
 * Read the Command Code Remote namespace when this deployment composes it.
 *
 * The page mounts in a Harnessy build without the Command Code package, so this
 * namespace is deliberately absent from {@link inject} and read from the
 * carrier instead: an unmounted namespace has no property there at all, and the
 * page then reports the backend as one Harnessy cannot ask.
 * @param ctx - Client root context carrying the Remote carrier.
 * @returns the namespace's reads, or undefined when it is not mounted.
 */
function backendRemoteReads(ctx: ClientContext): BackendRemoteReads | undefined {
  return (ctx.remote as unknown as { readonly commandcode?: BackendRemoteReads }).commandcode
}

/**
 * Install the Subagents section only in the Harnessy browser build.
 * @param ctx - Client root context carrying slots, locale, and the settings scope.
 */
export function apply(ctx: ClientContext): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== BUILD_PROFILE) return

  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'subagents settings: dictionaries')

  const scope = ctx.settingsScope.bind<SubagentSettings>({ namespace: SUBAGENT_ROSTER_NAMESPACE })
  const backendReads = backendRemoteReads(ctx)

  const operations: SubagentsOperations = {
    snapshot: () => {
      const snapshot = scope.getSnapshot()
      return {
        status: snapshot.status,
        writable: snapshot.writable,
        revision: snapshot.revision,
        value: snapshot.value,
      }
    },
    subscribe: listener => scope.subscribe(listener),
    write: async (patch, expectedRevision) => {
      // The section is JSON by construction; the write path re-validates it
      // against the registered schema on the Host.
      const ops = Object.entries(patch as Readonly<Record<string, JsonValue>>).map(([field, value]) => ({
        op: 'set' as const,
        path: [field],
        value,
      }))
      await scope.mutate(ops, expectedRevision)
    },
    storedRoster: async (signal) => {
      const response = await ctx.remote.subagentRoster.storedRoster(signal)
      if (!response.ok) throw new Error(response.error.message)
      return response.value
    },
    resolvedRoster: async (workspace, signal) => {
      const response = await ctx.remote.subagentRoster.resolvedRoster(workspace, signal)
      if (!response.ok) throw new Error(response.error.message)
      return response.value
    },
    automaticRouting: async (signal) => {
      const response = await ctx.remote.subagentRoster.automaticRouting(signal)
      if (!response.ok) throw new Error(response.error.message)
      return response.value
    },
    modelCatalog: async () => {
      const response = await ctx.remote.session.modelCatalog()
      if (!response.ok) throw new Error(response.error.message)
      return response.value
    },
    // A deployment without the Command Code package composes no probe, and the
    // page then reports that backend as one Harnessy cannot ask about.
    ...backendReads === undefined ? {} : {
      backendProbe: {
        backend: COMMAND_CODE_BACKEND,
        health: async (signal): Promise<CommandCodeHealth> => {
          const response = await backendReads.health(signal)
          if (!response.ok) throw new Error(response.error.message)
          return response.value
        },
        catalog: async (signal): Promise<CommandCodeCatalog> => {
          const response = await backendReads.catalog(signal)
          if (!response.ok) throw new Error(response.error.message)
          return response.value
        },
      },
    },
  }

  const store = createSubagentsSectionStore()
  let actions: BoundActions<typeof store> | undefined
  const sync = (): void => { actions?.sync(operations.snapshot()) }
  ctx.effect(() => operations.subscribe(sync), 'subagents settings: settings row')
  const injected = (bound: BoundActions<typeof store>): SubagentsSectionInjected => {
    actions = bound
    sync()
    return { operations }
  }

  const nav = ctx.locale.bind(LOCALE_NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'subagents',
    order: 20,
    label: () => nav('nav'),
    locale: LOCALE_NS,
    store,
    inject: injected,
  }, SubagentsSection))
}
