/**
 * The `model-capabilities` plugin: it owns the public catalog store's lifecycle
 * and registers the capability source the LLM seam consults.
 *
 * Registration happens once per composition. What changes with configuration is
 * only *which* catalogs the store selects: the source reads the store per
 * lookup, so a settings change, a completed background refresh, or a disabled
 * layer takes effect on the next resolution without re-registering anything.
 *
 * The startup refresh is a background request with an owner: the plugin starts
 * it, keeps its abort controller, and aborts it on disposal. Startup itself
 * never waits for the network — the store already answers from the cache and the
 * bundled snapshot, so model discovery works whether or not the endpoints are
 * reachable.
 *
 * @module @deepseek-ai/dsh-model-capabilities/plugin
 */

import { deadline } from '@deepseek-ai/dsh-timeout'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { bundledSnapshotMetadata } from './bundled.ts'
import { createPublicCatalogCache } from './cache.ts'
import { fetchPublicCatalog } from './fetch.ts'
import { createPublicCapabilitySource } from './resolve.ts'
import { createPublicCatalogStore } from './store.ts'
import { ModelCapabilitiesInspector } from './remote.ts'
import { MODEL_CAPABILITY_STORE_SERVICE } from './store-service.ts'
import {
  assertServiceableConfig,
  MODEL_CAPABILITIES_DEFAULTS,
  MODEL_CAPABILITIES_NAMESPACE,
  ModelCapabilitiesConfigSchema,
  resolvePolicy,
} from './config.ts'
import type { ModelCapabilitiesConfig } from './config.ts'
import type { PublicCatalogStore, PublicCatalogStoreOptions } from './store.ts'
import type { PublicCatalogSource } from './types.ts'

/**
 * The plugin's registered name.
 */
export const name = 'model-capabilities'

/**
 * The capability source name this plugin registers, matching the slice-1 seam.
 */
export const CAPABILITY_SOURCE_NAME = 'public-metadata'

// Re-exported so every existing import path keeps working; the key itself lives
// in its own module because the Remote service requires it and this module
// mounts that service.
export { MODEL_CAPABILITY_STORE_SERVICE } from './store-service.ts'

/**
 * This plugin consumes no mandatory service: it registers on `ctx.llm`, which
 * is injected statically, and takes the settings seam through a dynamic
 * `ctx.inject` so a composition without one still mounts and serves the
 * bundled snapshot from its composition entry alone.
 */
export const inject = ['llm']

/** Composition-entry schema, so a Loader row validates before `apply` runs. */
export const Config: typeof ModelCapabilitiesConfigSchema = ModelCapabilitiesConfigSchema

/**
 * How long one refresh request may take before it is abandoned.
 *
 * A refresh is background work: when an endpoint is slow the previous catalog
 * keeps serving, so this bounds how long one attempt may occupy the store
 * rather than protecting any caller's latency.
 */
const REFRESH_TIMEOUT_MS = 30_000

/**
 * Age at which the bundled snapshot earns an advisory log line, in days.
 *
 * Roughly a quarter: long enough that a deployment refreshing on the default
 * weekly cadence never sees it, short enough that an offline one learns its
 * artifact predates the current quarter. It warns; it never fails.
 */
const SNAPSHOT_AGE_WARNING_DAYS = 90

/**
 * Report one database's failed attempt.
 *
 * A refresh failure keeps the previous catalog, so this is a diagnostic rather
 * than a failure: it names which database went stale and what went wrong.
 * @param logger - the plugin's logger.
 * @param source - the database that was not updated.
 * @param reason - why its catalog was kept.
 */
function reportFailure(logger: Context['logger'], source: PublicCatalogSource, reason: string): void {
  logger.warn(`model-capabilities: ${source} metadata not updated (${reason}); keeping the previous catalog`)
}

/**
 * Report the bundled snapshot's age at mount.
 *
 * This is advisory and never fatal: a deployment that refreshes replaces the
 * snapshot on its first successful fetch, and one that is deliberately offline
 * keeps serving it, so making age a failure would remove a capability the
 * snapshot still answers.
 * @param logger - the plugin's logger.
 * @param generatedAt - the snapshot's stated generation time.
 * @param now - current time in milliseconds.
 */
export function reportSnapshotAge(logger: Context['logger'], generatedAt: string, now: number): void {
  const generated = Date.parse(generatedAt)
  if (Number.isNaN(generated)) {
    logger.warn('model-capabilities: the bundled snapshot states no usable generation time')
    return
  }
  const ageDays = Math.floor((now - generated) / (24 * 60 * 60 * 1000))
  if (ageDays >= SNAPSHOT_AGE_WARNING_DAYS) {
    logger.warn(
      `model-capabilities: the bundled snapshot is ${String(ageDays)} days old; `
      + 'run `pnpm run gen-model-capability-snapshot` when refreshing it is intended',
    )
  }
}

/**
 * Install the public metadata layer.
 * @param ctx - the plugin's context.
 * @param config - the composition entry's configuration.
 * @param openStore - builds the catalog store; a seam for a test or an embedding
 *   that supplies its own cache, fetcher, or clock.
 */
export function apply(
  ctx: Context,
  config: ModelCapabilitiesConfig = MODEL_CAPABILITIES_DEFAULTS,
  openStore: (options: PublicCatalogStoreOptions) => PublicCatalogStore = createPublicCatalogStore,
): void {
  const store = openStore({
    policy: () => resolvePolicy(current),
    fetchCatalog: (source, signal) => fetchPublicCatalog(source, signal),
    cache: createPublicCatalogCache(),
    onFailure: (source, reason) => {
      reportFailure(ctx.logger, source, reason)
    },
  })
  let current: ModelCapabilitiesConfig = config

  /** The cancellation of the in-flight refresh, so no request outlives the plugin. */
  let refresh: AbortController | undefined

  /**
   * Start one background refresh under the active policy.
   *
   * `enabled: false`, `refresh: manual`, and `refresh: never` each return before
   * any request is constructed, which makes "no request happens" a property of
   * this layer rather than of a caller's restraint. A refresh already in flight
   * is left alone; eligibility after it settles is the store's judgement.
   */
  const startRefresh = (): void => {
    const policy = resolvePolicy(current)
    if (!policy.enabled || policy.refresh !== 'auto' || refresh !== undefined) return
    const controller = new AbortController()
    refresh = controller
    // The deadline's timer must outlive this frame, so it is disposed when the
    // request settles rather than by a `using` declaration.
    const guard = deadline(controller.signal, REFRESH_TIMEOUT_MS, 'MODEL_CAPABILITY_REFRESH')
    void store.refresh(guard.signal).catch(() => {
      // The store owns per-database failure handling and reports it through
      // `onFailure`; this only keeps a programming error inside the refresh
      // from surfacing as an unhandled rejection.
      ctx.logger.warn('model-capabilities: the public metadata refresh failed unexpectedly')
    }).finally(() => {
      guard[Symbol.dispose]()
      if (refresh === controller) refresh = undefined
    })
  }

  ctx.effect(
    () => ctx.llm.registerModelCapabilitySource(
      CAPABILITY_SOURCE_NAME,
      createPublicCapabilitySource(() => store.catalogs()),
    ),
    'model-capabilities.registerModelCapabilitySource()',
  )

  // Published so a diagnostics command reads the store the source answers from
  // rather than constructing a second one; withdrawn with this fiber.
  ctx.provide(MODEL_CAPABILITY_STORE_SERVICE, store)

  // The Models page's provenance read, over the same store and the same
  // inspection the command surface renders. Mounted as a child plugin, so its
  // Remote registration is withdrawn with this one.
  ctx.plugin(ModelCapabilitiesInspector)

  ctx.effect(() => () => {
    refresh?.abort()
    refresh = undefined
  }, 'model-capabilities.abortRefresh()')

  reportSnapshotAge(ctx.logger, bundledSnapshotMetadata.generatedAt, Date.now())

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, MODEL_CAPABILITIES_NAMESPACE, ModelCapabilitiesConfigSchema, config, {
      // A duration this build cannot read is refused where it is written,
      // rather than becoming a refresh that silently never runs.
      validate: assertServiceableConfig,
      setSource: (source: () => ModelCapabilitiesConfig) => {
        current = source()
      },
      // Runs at attach and at every committed change, which is also the first
      // point a refresh may start: the seam falls back to the composition entry
      // when no settings provider is mounted, so this covers both cases.
      onChange: () => {
        startRefresh()
      },
    })
  })

  // A background request that does not block startup: the first read serves the
  // cache or the bundled snapshot, and the fetch lands when it lands.
  void store.load().then(startRefresh, startRefresh)
}
