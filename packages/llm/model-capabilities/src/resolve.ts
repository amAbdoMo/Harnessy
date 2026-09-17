/**
 * The public-source resolution layer: provider-aware matching, and the
 * model-id-only claims that are reported but never declared.
 *
 * Both public databases are indexed once and every lookup is synchronous
 * against the loaded catalog, so discovery acquires no network dependency.
 * Matching order is the precedence the Agent Note fixes — OpenRouter's own
 * catalog for an OpenRouter route, then models.dev by the route's endpoint
 * host, then by the route id — and a model-id-only claim never becomes an
 * authoritative answer, because one gateway's claim about a model id says
 * nothing about another gateway serving the same id.
 *
 * @module @deepseek-ai/dsh-model-capabilities/resolve
 */

import type { LlmModelCapability, LlmModelCapabilityLookup, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import { normalizeDefaultEffort, normalizeEfforts } from './efforts.ts'
import { normalizeProviderId, normalizeRouteHost, openRouterRouteProvider, routeHostKey } from './routes.ts'
import type {
  ModelCapabilityProvenance,
  PublicCapabilityMatch,
  PublicCapabilityResolution,
  PublicCatalog,
  PublicCatalogSource,
  ResolvedPublicCapability,
} from './types.ts'

/** One model entry that states something this layer can resolve. */
interface CatalogEntry {
  /** Provider entry the model belongs to, as the database ids it. */
  readonly provider: string
  /** Model id the entry is keyed by. */
  readonly modelId: string
  /** Published effort list, exactly as the entry states it. */
  readonly efforts: readonly string[]
  /** Published default effort, when the entry states one. */
  readonly defaultEffort?: string
}

/** One catalog entry whose published list normalizes to a usable level set. */
interface CatalogClaim {
  /** Database the claim was published by. */
  readonly source: PublicCatalogSource
  /** Provider entry the claim belongs to. */
  readonly provider: string
  /** Normalized harness levels the claim offers; never empty. */
  readonly levels: readonly string[]
  /** Published tokens those levels came from, so a dropped one stays attributable. */
  readonly efforts: readonly string[]
  /** Published tokens that named no level this build can dispatch. */
  readonly dropped: readonly string[]
  /** Published default effort, when it is one of {@link levels}. */
  readonly defaultEffort?: string
}

/** One loaded catalog, indexed for every lookup this layer performs. */
interface CatalogIndex {
  /** Model id to the claims every provider publishes for it. */
  readonly byModelId: ReadonlyMap<string, readonly CatalogClaim[]>
  /** Normalized endpoint host to the models.dev provider ids stating it. */
  readonly byHost: ReadonlyMap<string, readonly string[]>
  /** Comparable provider id to the models.dev provider id it names. */
  readonly byId: ReadonlyMap<string, string>
}

/** Whether one parsed JSON value is a non-null object rather than an array or scalar. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the `reasoning_options` entry models.dev publishes an effort list in.
 * @param model - one model entry as parsed from the database.
 * @returns the published effort tokens, or undefined when the entry states none.
 */
function modelsDevEfforts(model: Record<string, unknown>): readonly string[] | undefined {
  const options = model.reasoning_options
  if (!Array.isArray(options)) return undefined
  for (const option of options) {
    if (!isRecord(option) || option.type !== 'effort') continue
    const values: unknown = option.values
    if (Array.isArray(values)) return values.filter(value => typeof value === 'string')
  }
  return undefined
}

/**
 * Read every model entry a models.dev database publishes.
 *
 * A provider entry that is not an object, a models map that is not an object,
 * and a model entry that is not an object are each skipped: one malformed entry
 * must not take the whole database out of service.
 * @param database - the parsed `models.dev/api.json` document.
 * @returns one entry per published model, in document order.
 */
function readModelsDevEntries(database: unknown): CatalogEntry[] {
  if (!isRecord(database)) return []
  const entries: CatalogEntry[] = []
  for (const [provider, value] of Object.entries(database)) {
    if (!isRecord(value) || !isRecord(value.models)) continue
    for (const [modelId, model] of Object.entries(value.models)) {
      if (!isRecord(model)) continue
      entries.push({
        provider,
        modelId,
        // An absent options list and one naming another kind of control both
        // state no effort list at all.
        efforts: modelsDevEfforts(model) ?? [],
      })
    }
  }
  return entries
}

/**
 * Read every model entry an OpenRouter database publishes.
 *
 * An entry without an exact id cannot be looked up at all, and one whose
 * reasoning metadata is not the published form states no effort list; both are
 * skipped rather than repaired into a claim.
 * @param database - the parsed `/api/v1/models` document.
 * @returns one entry per published model, in document order.
 */
function readOpenRouterEntries(database: unknown): CatalogEntry[] {
  if (!isRecord(database) || !Array.isArray(database.data)) return []
  const entries: CatalogEntry[] = []
  for (const model of database.data) {
    if (!isRecord(model) || typeof model.id !== 'string' || model.id.length === 0) continue
    const reasoning = model.reasoning
    if (!isRecord(reasoning)) continue
    const published = reasoning.supported_efforts
    if (!Array.isArray(published)) continue
    const stated = reasoning.default_effort
    entries.push({
      provider: 'openrouter',
      modelId: model.id,
      efforts: published.filter(value => typeof value === 'string'),
      ...typeof stated === 'string' && stated.length > 0 ? { defaultEffort: stated } : {},
    })
  }
  return entries
}

/**
 * Read one catalog's published model entries.
 * @param catalog - the catalog to read.
 * @returns one entry per published model, in document order.
 */
function readEntries(catalog: PublicCatalog): CatalogEntry[] {
  return catalog.source === 'openrouter'
    ? readOpenRouterEntries(catalog.entries)
    : readModelsDevEntries(catalog.entries)
}

/**
 * Build the claim one published entry states.
 * @param entry - one published model entry.
 * @param source - the database it was published by.
 * @returns the claim, or undefined when the entry offers no dispatchable level.
 */
function claimOf(entry: CatalogEntry, source: PublicCatalogSource): CatalogClaim | undefined {
  const { levels, dropped } = normalizeEfforts(entry.efforts)
  if (levels.length === 0) return undefined
  const defaultEffort = normalizeDefaultEffort(entry.defaultEffort, levels)
  return {
    source,
    provider: entry.provider,
    levels,
    efforts: [...entry.efforts],
    dropped,
    ...defaultEffort === undefined ? {} : { defaultEffort },
  }
}

/** A models.dev provider entry's self-stated id and published API URL. */
interface ModelsDevProvider {
  /** Provider id the entry states, falling back to the key it is filed under. */
  readonly id: string
  /** Published API URL, when the entry states one. */
  readonly api?: string
}

/**
 * Read one models.dev provider entry's identity and endpoint.
 * @param filedAs - the provider key the entry is filed under.
 * @param entry - the provider entry as parsed from the database.
 * @returns the identity and endpoint; the key alone when the entry states neither.
 */
function modelsDevProvider(filedAs: string, entry: Record<string, unknown>): ModelsDevProvider {
  const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : filedAs
  return typeof entry.api === 'string' && entry.api.length > 0 ? { id, api: entry.api } : { id }
}

/**
 * Index the loaded catalogs once, so every later lookup is synchronous.
 *
 * Only models.dev providers enter the host and provider-id indexes: OpenRouter
 * is a single catalog reached through its own route identity, so its entries
 * contribute model-id-only claims and nothing provider-aware. A provider entry
 * that is not an object states nothing and is skipped, because one malformed
 * entry must not take the database out of service.
 * @param catalogs - the loaded catalogs, in precedence order.
 * @returns the index over every claim the catalogs state.
 */
function indexCatalogs(catalogs: readonly PublicCatalog[]): CatalogIndex {
  const byModelId = new Map<string, CatalogClaim[]>()
  const byHost = new Map<string, string[]>()
  const byId = new Map<string, string>()
  for (const catalog of catalogs) {
    const database = catalog.entries
    if (catalog.source === 'models.dev' && isRecord(database)) {
      for (const [filedAs, entry] of Object.entries(database)) {
        if (!isRecord(entry)) continue
        const provider = modelsDevProvider(filedAs, entry)
        byId.set(normalizeProviderId(provider.id), provider.id)
        const endpoint = normalizeRouteHost(provider.api)
        if (endpoint === undefined) continue
        const host = routeHostKey(endpoint)
        byHost.set(host, [...byHost.get(host) ?? [], provider.id])
      }
    }
    for (const entry of readEntries(catalog)) {
      const claim = claimOf(entry, catalog.source)
      if (claim === undefined) continue
      byModelId.set(entry.modelId, [...byModelId.get(entry.modelId) ?? [], claim])
    }
  }
  return { byModelId, byHost, byId }
}

/**
 * Report one claim as a public match.
 * @param claim - the claim to report.
 * @param level - how the claim was matched.
 * @returns the match a diagnostics surface renders.
 */
function matchOf(claim: CatalogClaim, level: PublicCapabilityMatch['level']): PublicCapabilityMatch {
  return {
    source: claim.source,
    level,
    providers: [claim.provider],
    levels: claim.levels,
    efforts: [...claim.efforts],
    ...claim.defaultEffort === undefined ? {} : { defaultEffort: claim.defaultEffort },
  }
}

/**
 * The provenance of one authoritative match.
 * @param match - the matched claim.
 * @param request - the interrogated route.
 * @param modelId - the resolved model id.
 * @param catalog - the loaded catalog that answered.
 * @returns the provenance a consumer records beside the capability.
 */
function provenanceOf(
  match: PublicCapabilityMatch,
  request: LlmModelDiscoveryRequest,
  modelId: string,
  catalog: PublicCatalog,
): ModelCapabilityProvenance {
  return {
    capability: 'reasoning-efforts',
    source: match.source,
    match: match.level,
    provider: match.providers[0] as string,
    modelId,
    route: request.provider ?? '',
    authoritative: true,
    origin: catalog.origin,
    ...catalog.fetchedAt === undefined ? {} : { fetchedAt: catalog.fetchedAt },
  }
}

/**
 * Build one authoritative resolution from a matched claim.
 * @param match - the matched claim.
 * @param request - the interrogated route.
 * @param modelId - the resolved model id.
 * @param catalog - the loaded catalog that answered.
 * @returns the resolved capability, provenance included.
 */
function resolvedFrom(
  match: PublicCapabilityMatch,
  request: LlmModelDiscoveryRequest,
  modelId: string,
  catalog: PublicCatalog,
): ResolvedPublicCapability {
  return {
    kind: 'resolved',
    capability: 'reasoning-efforts',
    levels: match.levels,
    ...match.defaultEffort === undefined ? {} : { defaultEffort: match.defaultEffort },
    provenance: provenanceOf(match, request, modelId, catalog),
  }
}

/**
 * Match one model against models.dev, by the route's endpoint first and its id second.
 *
 * An endpoint that names a host is the route's identity, so the route id is
 * only consulted when the route has no usable endpoint: otherwise a route whose
 * id happens to spell a provider name would adopt that provider's claim while
 * pointing somewhere else entirely.
 * @param modelId - the model id the route serves.
 * @param request - the route being interrogated.
 * @param index - the loaded catalogs, indexed.
 * @returns the matched claim and how it matched, or undefined when none did.
 */
function providerAwareMatch(
  modelId: string,
  request: LlmModelDiscoveryRequest,
  index: CatalogIndex,
): PublicCapabilityMatch | undefined {
  const routeEnd = normalizeRouteHost(request.baseURL)
  const routeHost = routeEnd === undefined ? undefined : routeHostKey(routeEnd)
  if (routeHost !== undefined) {
    for (const provider of index.byHost.get(routeHost) ?? []) {
      const claim = index.byModelId.get(modelId)?.find(candidate => candidate.provider === provider)
      if (claim !== undefined) return matchOf(claim, 'provider-host')
    }
    return undefined
  }
  const named = index.byId.get(normalizeProviderId(request.provider ?? ''))
  const claim = named === undefined
    ? undefined
    : index.byModelId.get(modelId)?.find(candidate => candidate.provider === named)
  return claim === undefined ? undefined : matchOf(claim, 'provider-id')
}

/**
 * Find the loaded catalog one database contributes, if it was loaded at all.
 * @param catalogs - the loaded catalogs.
 * @param source - the database to find.
 * @returns the catalog, or undefined when that database is not loaded.
 */
function catalogOf(catalogs: readonly PublicCatalog[], source: PublicCatalogSource): PublicCatalog | undefined {
  return catalogs.find(catalog => catalog.source === source)
}

/**
 * Resolve one model's public reasoning-effort metadata.
 *
 * The answer is provider-aware when the route's own identity names a provider
 * entry, and a suggestion otherwise. A lower-priority source never overrides a
 * higher one, so the caller passes `catalogs` in precedence order and applies
 * the first resolution whose `kind` is `resolved`.
 * @param catalogs - the loaded catalogs, most authoritative first.
 * @param modelId - model id the route serves.
 * @param request - the route being interrogated.
 * @returns a declarable capability, or the id-only claims that were not one.
 */
export function resolvePublicCapability(
  catalogs: readonly PublicCatalog[],
  modelId: string,
  request: LlmModelDiscoveryRequest,
): PublicCapabilityResolution {
  const index = indexCatalogs(catalogs)
  if (modelId.length === 0) return { kind: 'unresolved', suggestions: [] }

  const openRouter = catalogOf(catalogs, 'openrouter')
  const openRouterClaim = openRouterRouteProvider(request) === undefined || openRouter === undefined
    ? undefined
    : index.byModelId.get(modelId)?.find(claim => claim.source === 'openrouter')
  if (openRouter !== undefined && openRouterClaim !== undefined) {
    return resolvedFrom(matchOf(openRouterClaim, 'openrouter-route'), request, modelId, openRouter)
  }

  const modelsDev = catalogOf(catalogs, 'models.dev')
  const matched = modelsDev === undefined ? undefined : providerAwareMatch(modelId, request, index)
  if (matched !== undefined && modelsDev !== undefined) {
    return resolvedFrom(matched, request, modelId, modelsDev)
  }

  // Model-id-only claims, reported with every competitor so an ambiguity stays
  // explainable: one distinct level set is a suggestion, several are a
  // disagreement no consumer may resolve for the user.
  const offered = index.byModelId.get(modelId) ?? []
  const distinct = new Set(offered.map(claim => claim.levels.join('\u0000')))
  return {
    kind: 'unresolved',
    suggestions: offered.map(claim => matchOf(claim, distinct.size > 1 ? 'model-id-ambiguous' : 'model-id-only')),
  }
}

/**
 * Build the capability source one composition registers on the LLM service.
 *
 * The returned lookup answers only when a provider-aware match exists, so an
 * id-only suggestion never becomes a declaration. The seam consults a source
 * only for a model the adapter left undescribed, which is what keeps an
 * adapter-native statement and a local integration's answer in front of this
 * one.
 * @param catalogs - the loaded catalogs, most authoritative first, or a thunk
 *   read per lookup so a background refresh can replace them in place.
 * @returns the lookup to register on the LLM service.
 */
export function createPublicCapabilitySource(
  catalogs: readonly PublicCatalog[] | (() => readonly PublicCatalog[]),
): LlmModelCapabilityLookup {
  const loaded = typeof catalogs === 'function' ? catalogs : (): readonly PublicCatalog[] => catalogs
  return (modelId, request) => {
    const resolution = resolvePublicCapability(loaded(), modelId, request)
    if (resolution.kind !== 'resolved') return undefined
    const capability: LlmModelCapability = {
      reasoningEfforts: resolution.levels,
      ...resolution.defaultEffort === undefined ? {} : { defaultReasoningEffort: resolution.defaultEffort },
    }
    return capability
  }
}
