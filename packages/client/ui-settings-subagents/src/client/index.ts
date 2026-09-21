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
import type {
  SubagentBackendProbe,
  SubagentsOperations,
  SubagentsSectionInjected,
} from './SubagentsSection.tsx'
import { createSubagentsSectionStore } from './section-store.ts'
import { en, type SubagentsKey } from './locales.ts'

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
 * Unwrap one Remote read, turning a refused call into the failure its caller
 * reports.
 * @param read - the namespace method, as the generated client answers it.
 * @param signal - this read's lifetime; the page aborts a superseded one.
 * @returns the method's value.
 * @throws {Error} when the namespace refused the read.
 */
async function backendValue<T>(
  read: (signal?: AbortSignal) => Promise<RemoteResult<T>>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await read(signal)
  if (!response.ok) throw new Error(response.error.message)
  return response.value
}

/**
 * Compose the Command Code backend probe when this deployment mounts that
 * Remote namespace.
 *
 * The namespace belongs to the optional Command Code package, so it stays out
 * of {@link inject}: a required dependency would park this page, and the boot
 * gate behind it, on a service a Harnessy build without Command Code never
 * provides. A scope that injects it applies and disposes with the namespace
 * instead, and the page reports the backend as one Harnessy cannot ask
 * whenever no such scope is mounted.
 * @param ctx - Client root context carrying the Remote namespace services.
 * @param publish - receives the probe, and undefined when its scope leaves.
 */
function composeBackendProbe(
  ctx: ClientContext,
  publish: (probe: SubagentBackendProbe | undefined) => void,
): void {
  ctx.inject(['remote', 'remote.commandcode'], (commandCode: ClientContext) => {
    const reads: BackendRemoteReads = commandCode.remote.commandcode
    const probe: SubagentBackendProbe = {
      backend: COMMAND_CODE_BACKEND,
      health: signal => backendValue(reads.health, signal),
      catalog: signal => backendValue(reads.catalog, signal),
    }
    publish(probe)
    commandCode.effect(() => () => { publish(undefined) }, 'subagents settings: Command Code probe')
  })
}

/**
 * Install the Subagents section only in the Harnessy browser build.
 * @param ctx - Client root context carrying slots, locale, and the settings scope.
 */
export function apply(ctx: ClientContext): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== BUILD_PROFILE) return

  ctx.effect(() => ctx.locale.register(LOCALE_NS, { en }), 'subagents settings: dictionaries')

  const scope = ctx.settingsScope.bind<SubagentSettings>({ namespace: SUBAGENT_ROSTER_NAMESPACE })
  let backendProbe: SubagentBackendProbe | undefined
  composeBackendProbe(ctx, (probe) => { backendProbe = probe })

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
    // A deployment without the Command Code package mounts no backend scope,
    // and the page then reports that backend as one Harnessy cannot ask about.
    get backendProbe() { return backendProbe },
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
