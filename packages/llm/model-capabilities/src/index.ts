/**
 * Public model capability discovery: what the world's public model databases
 * state about a configured route, and how far that statement may be trusted.
 *
 * A composition mounts the `model-capabilities` plugin, which selects the best
 * available catalog per public database — a successful fetch, else the durable
 * cache, else the bundled snapshot — and registers
 * {@link createPublicCapabilitySource} on `LlmRuntime`. Resolution itself stays
 * pure: it reads the catalogs it is handed and never performs network or
 * filesystem I/O.
 *
 * @module @deepseek-ai/dsh-model-capabilities
 */

export { bundledSnapshotMetadata, loadBundledPublicCatalogs } from './bundled.ts'
export {
  createPublicCatalogCache,
  CACHE_SCHEMA_VERSION,
  PUBLIC_CATALOG_CACHE_PATH,
} from './cache.ts'
export { createPublicCatalogStore, catalogFromResponse, PUBLIC_CATALOG_SOURCES } from './store.ts'
export { fetchPublicCatalog, MAX_CATALOG_RESPONSE_BYTES, PUBLIC_CATALOG_ENDPOINTS } from './fetch.ts'
export {
  capabilityInspectionViews,
  declaredCapabilityFields,
  explainModelCapability,
  inspectConfiguredModels,
  inspectModelCapability,
  readConfiguredRoutes,
} from './inspect.ts'
export type {
  ConfiguredModelRow,
  ConfiguredRoute,
  ModelCapabilityExplanation,
  ModelCapabilityInspection,
  ModelCapabilityRouteIdentity,
  ModelCapabilitySyncDecision,
  ModelCapabilityTarget,
  ModelCapabilityTier,
  ModelCapabilityTierState,
} from './inspect.ts'
export { CAPABILITY_SOURCE_NAME, MODEL_CAPABILITY_STORE_SERVICE } from './plugin.ts'
export { normalizeDefaultEffort, normalizeEfforts } from './efforts.ts'
export type { NormalizedEfforts } from './efforts.ts'
export { normalizeProviderId, normalizeRouteHost, openRouterRouteProvider, routeHostKey } from './routes.ts'
export type { NormalizedRouteHost } from './routes.ts'
export {
  assertServiceableConfig,
  MAX_CACHE_TTL_MS,
  MODEL_CAPABILITIES_DEFAULTS,
  MODEL_CAPABILITIES_NAMESPACE,
  ModelCapabilitiesConfigSchema,
  parseCacheTtl,
  resolvePolicy,
} from './config.ts'
export type { ModelCapabilitiesConfig, PublicMetadataConfig } from './config.ts'
export { buildSnapshot, curateModelsDevCatalog, curateOpenRouterCatalog, parseSnapshot, SNAPSHOT_SCHEMA_VERSION } from './snapshot.ts'
export type {
  BuiltSnapshot,
  CuratedCatalog,
  ModelCapabilitySnapshot,
  ModelsDevSnapshotCatalog,
  ModelsDevSnapshotModel,
  ModelsDevSnapshotProvider,
  OpenRouterSnapshotCatalog,
  OpenRouterSnapshotModel,
  SnapshotInputs,
  SnapshotSourceMetadata,
} from './snapshot.ts'
export { createPublicCapabilitySource, resolvePublicCapability } from './resolve.ts'
export type {
  CachedCatalog,
  PublicCatalogCache,
  PublicCatalogClock,
  PublicCatalogFetch,
  PublicCatalogPolicy,
  PublicCatalogRefreshOutcome,
  PublicCatalogState,
  PublicCatalogStore,
  PublicCatalogStoreOptions,
  PublicMetadataRefreshMode,
  SelectedPublicCatalog,
} from './store.ts'
export type { PublicCatalogFetcherOptions } from './fetch.ts'
export type {
  ModelCapabilityDeclaration,
  ModelCapabilityInspectionView,
  ModelCapabilityProvenance,
  ModelCapabilityResolved,
  ModelCapabilitySuggestion,
  PublicCapabilityMatch,
  PublicCapabilityMatchLevel,
  PublicCapabilityResolution,
  PublicCatalog,
  PublicCatalogOrigin,
  PublicCatalogSource,
  PublicCatalogTier,
  ResolvedPublicCapability,
  UnresolvedPublicCapability,
} from './types.ts'
