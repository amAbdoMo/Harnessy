/**
 * In-process module arrival: import every roster row's `/client` module (or
 * the plan's replacement) and register each as a pre-arrived factory on a
 * production `ClientModuleSystem`, so neither the Loader's `internal.import`
 * nor a stage-one `prefetch` ever fetches a bundle.
 * @module @deepseek-ai/dsh-client-test-runtime/src/assembly/modules
 */
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import { createClientModuleSystem } from '@deepseek-ai/dsh-client-modules/client'
import type { ClientModuleLoader, ClientModuleLoaderTarget, WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import type { AssemblyPlan, ClientPluginModule } from './roster.ts'

/** The bootstrap row: always this process's static namespace, never a dynamic import or a `provide` replacement. */
export const MODULES_PACKAGE = '@deepseek-ai/dsh-client-modules'

/**
 * Resolve each roster row to its plugin module: `plan.provide[name]` when
 * present, otherwise a `/client` import resolved by the repository's tsconfig
 * path aliases under Vitest. The bootstrap row is the
 * statically imported `@deepseek-ai/dsh-client-modules/client` namespace. Imports
 * arrive concurrently; failures drain all arrivals before rejection, and the
 * returned table retains roster order. Plugin activation follows the Loader.
 * @param plan - validated plan.
 * @returns package name → module, in roster order.
 * @throws {Error} when an import fails (the package name prefixes the original message) or the bootstrap row is provided.
 */
export async function loadPluginModules(plan: AssemblyPlan): Promise<ReadonlyMap<string, ClientPluginModule>> {
  if (plan.roster.rows.some(row => row.name === MODULES_PACKAGE) && plan.provide?.[MODULES_PACKAGE] !== undefined) {
    throw new Error(`client-test-runtime: ${MODULES_PACKAGE} is the bootstrap module and cannot be provided`)
  }
  const arrivals = await Promise.allSettled(plan.roster.rows.map(async ({ name }) => {
    const namespace = name === MODULES_PACKAGE ? modulesClient : plan.provide?.[name] ?? await importClient(name)
    return [name, namespace] as const
  }))
  const modules = new Map<string, ClientPluginModule>()
  for (const arrival of arrivals) {
    if (arrival.status === 'rejected') {
      const error: unknown = arrival.reason
      throw error
    }
    modules.set(...arrival.value)
  }
  return modules
}

async function importClient(name: string): Promise<ClientPluginModule> {
  let namespace: unknown
  try {
    namespace = await import(/* @vite-ignore */ `${name}/client`)
  } catch (error) {
    throw new Error(`client-test-runtime: cannot import ${name}/client: ${String(error)}`, { cause: error })
  }
  return namespace as ClientPluginModule
}

/**
 * Build the production module system over queued factories returning the
 * loaded namespaces. The bootstrap row uses `bootstrapModule`; `staticModules`
 * is empty because namespaces already hold their own imports. Missing factories
 * reject through `loadBundle` without fetching.
 * @param graph - raw boot graph from `graphFromRoster`; `createClientModuleSystem` parses it.
 * @param modules - loaded plugin modules keyed by package name.
 * @returns module system to install as `loader.internal`; its `manifest` is the parsed graph.
 */
export function createInProcessModules(
  graph: WebBootGraph,
  modules: ReadonlyMap<string, ClientPluginModule>,
): ClientModuleLoader {
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue: [],
    /* v8 ignore next -- construction replaces this sink before draining the prefilled queue. */
    load: () => { throw new Error('client-test-runtime: module facade is not initialized') },
    create: options => createClientModuleSystem(target, { id: MODULES_PACKAGE, exports: modulesClient }, options),
  }
  for (const [id, namespace] of modules) {
    if (id === MODULES_PACKAGE) continue
    target.pendingQueue.push({ id, factory: () => namespace as unknown as Record<string, unknown> })
  }
  return target.create({
    boot: graph,
    staticModules: {},
    loadBundle: url => Promise.reject(new Error(`client-test-runtime: in-process modules never load bundles (${url})`)),
  })
}
