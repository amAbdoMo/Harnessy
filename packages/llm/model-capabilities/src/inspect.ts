/**
 * What a standalone command can ask the public metadata layer, without owning a
 * second matcher: which capability one route-qualified model resolves to, which
 * tier answered, and — for a deployment's whole configuration — which rows a
 * sync would write and which it must leave alone.
 *
 * Every answer here comes from the slice-1 resolver and the slice-3 store. This
 * module composes them into a report; it never re-implements matching, level
 * normalization, or precedence.
 *
 * @module @deepseek-ai/dsh-model-capabilities/inspect
 */

import { resolvePublicCapability } from './resolve.ts'
import type { SelectedPublicCatalog } from './store.ts'
import type {
  ModelCapabilityDeclaration,
  ModelCapabilityInspectionView,
  ModelCapabilityResolved,
  ModelCapabilitySuggestion,
  PublicCatalog,
  PublicCatalogTier,
} from './types.ts'

// The inspection vocabulary is declared in the wire module and re-exported here,
// so a consumer of this module reads one import for what one model resolves to.
export type {
  ModelCapabilityDeclaration,
  ModelCapabilityInspectionView,
  ModelCapabilityResolved,
  ModelCapabilitySuggestion,
}

/** One configured route and one model id it serves. */
export interface ModelCapabilityTarget {
  /** Configured route the model is reached through. */
  readonly route: string
  /** Exact model id within that route. */
  readonly model: string
}

/** How the route itself identifies, which is what provider-aware matching reads. */
export interface ModelCapabilityRouteIdentity {
  /** Configured endpoint, when the route states one. */
  readonly baseURL?: string
}

/**
 * Why one public tier did or did not answer.
 *
 * `no-catalog` is a tier this deployment has nothing in; `not-matched` is a tier
 * that holds a catalog but whose entries do not name this route; `answered` is
 * the tier that produced the resolution.
 */
export type ModelCapabilityTierState = 'answered' | 'not-matched' | 'no-catalog'

/** One public tier's contribution to one model's answer. */
export interface ModelCapabilityTier {
  /** Tier this reports. */
  readonly tier: PublicCatalogTier
  /** What this tier did for this model. */
  readonly state: ModelCapabilityTierState
  /** Provider entry that answered, for a provider-aware match. */
  readonly provider?: string
  /** How the route was matched, when it was. */
  readonly match?: string
  /** Levels the tier offers for this model. */
  readonly levels?: readonly string[]
  /** When the fetch that produced this tier's catalog completed. */
  readonly fetchedAt?: string
}

/** The whole resolution chain for one route-qualified model. */
export interface ModelCapabilityExplanation {
  /** Route the model was explained through. */
  readonly route: string
  /** Model id that was explained. */
  readonly model: string
  /** Route declaration, as configuration states it. */
  readonly declared: ModelCapabilityDeclaration
  /** The declarable capability, when a provider-aware match produced one. */
  readonly resolved?: ModelCapabilityResolved
  /** One entry per public tier, most authoritative first. */
  readonly tiers: readonly ModelCapabilityTier[]
  /** Id-only claims, reported but never declared. */
  readonly suggestions: readonly ModelCapabilitySuggestion[]
}

/** One configured model row, as the settings document states it. */
export interface ConfiguredModelRow {
  /** Exact model id. */
  readonly id: string
  /** The row's own fields, for declaration reading and writing. */
  readonly profile: Record<string, unknown>
}

/** One configured route and the models it serves. */
export interface ConfiguredRoute {
  /** Route key. */
  readonly route: string
  /** The route's own fields, which a write restates with its models list. */
  readonly profile: Record<string, unknown>
  /** Models the route lists. */
  readonly models: readonly ConfiguredModelRow[]
}

/**
 * Read the configured routes out of a resolved settings namespace.
 *
 * The rows come from the settings seam's resolved value, so a route supplied by
 * the composition entry and one supplied by the user's document are both read.
 * Anything that is not the documented shape states nothing.
 * @param section - the resolved `llm-pi-ai` section.
 * @returns the configured routes, in document order.
 */
export function readConfiguredRoutes(section: unknown): readonly ConfiguredRoute[] {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return []
  const providers = (section as Record<string, unknown>).providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return []
  const routes: ConfiguredRoute[] = []
  for (const [route, value] of Object.entries(providers)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const profile = value as Record<string, unknown>
    const listed = Array.isArray(profile.models) ? profile.models : []
    const models = listed.flatMap((entry): ConfiguredModelRow[] => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
      const id = (entry as Record<string, unknown>).id
      return typeof id === 'string' && id.length > 0 ? [{ id, profile: entry as Record<string, unknown> }] : []
    })
    routes.push({ route, profile, models })
  }
  return routes
}

/**
 * Inspect every configured model against the mounted store.
 *
 * This is the one join of configured rows and resolved capabilities, so the
 * command surface and the Models page report the same answer for one deployment.
 * @param routes - the configured routes.
 * @param store - the mounted catalog store.
 * @returns one inspection per configured model, in configuration order.
 */
export function inspectConfiguredModels(
  routes: readonly ConfiguredRoute[],
  store: { selections(): readonly SelectedPublicCatalog[] },
): readonly ModelCapabilityInspection[] {
  const selections = store.selections()
  return routes.flatMap(route => route.models.map(model => inspectModelCapability(
    selections,
    { route: route.route, model: model.id },
    route.profile,
    model.profile,
  )))
}

/**
 * Project one inspection onto the fields a surface renders.
 *
 * The row's own declaration is deliberately absent: a surface edits it in a
 * draft and renders what the draft says, so shipping the Host's copy would only
 * offer a value that is stale between an edit and its commit. The route's
 * settings fields and the sync decision stay on the Host for the same reason —
 * a surface reads what applies to a model, not what a write would do to it.
 * @param inspection - the inspected model.
 * @param enabled - whether the public metadata layer answers under the policy.
 * @returns the projection a Client reads.
 */
function inspectionView(inspection: ModelCapabilityInspection, enabled: boolean): ModelCapabilityInspectionView {
  return {
    route: inspection.route,
    model: inspection.model,
    enabled,
    ...inspection.chain.resolved === undefined ? {} : { resolved: inspection.chain.resolved },
    suggestions: inspection.chain.suggestions,
  }
}

/**
 * Read every configured model's capability provenance for a Client surface.
 * @param routes - the configured routes.
 * @param store - the mounted catalog store.
 * @param enabled - whether the public metadata layer answers under the policy.
 * @returns one projection per configured model, in configuration order.
 */
export function capabilityInspectionViews(
  routes: readonly ConfiguredRoute[],
  store: { selections(): readonly SelectedPublicCatalog[] },
  enabled: boolean,
): readonly ModelCapabilityInspectionView[] {
  return inspectConfiguredModels(routes, store).map(inspection => inspectionView(inspection, enabled))
}

/**
 * The explicit level set a configured row declares, if it declares one.
 *
 * A row may state `false` (this model does not reason) or a mapping of levels to
 * their wire spellings. Anything else is not a declaration this layer acts on.
 * @param profile - the configured row's fields.
 * @returns the declared levels, and whether the row refused reasoning outright.
 */
export function readDeclaration(profile: unknown): ModelCapabilityDeclaration {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    return { declaresNoReasoning: false }
  }
  const stated = (profile as Record<string, unknown>).reasoningEfforts
  if (stated === false) return { declaresNoReasoning: true }
  if (typeof stated !== 'object' || stated === null || Array.isArray(stated)) {
    return { declaresNoReasoning: false }
  }
  const efforts = Object.keys(stated)
  return { declaresNoReasoning: false, ...efforts.length === 0 ? {} : { efforts } }
}

/**
 * The profile fields one row needs to declare a level set.
 *
 * The spelling is what the profile schema validates and what the Models UI
 * writes: a level maps to its own wire value, except `off`, which is the
 * parameter's absence and therefore a valueless key.
 * @param levels - normalized levels a provider-aware match offers.
 * @param defaultEffort - published default, when it names one of the levels.
 * @returns the row fields to write, or nothing when there is no level to declare.
 */
export function declaredCapabilityFields(
  levels: readonly string[],
  defaultEffort: string | undefined,
): Record<string, unknown> {
  if (levels.length === 0) return {}
  return {
    reasoningEfforts: Object.fromEntries(levels.map(level => [level, level === 'off' ? null : level])),
    ...defaultEffort === undefined || !levels.includes(defaultEffort)
      ? {}
      : { defaultReasoningEffort: defaultEffort },
  }
}

/**
 * Report one tier's contribution, given which tier actually answered.
 *
 * `not-matched` means this tier had a catalog to consult and it did not answer:
 * either an earlier tier already did, or none of its entries names this route.
 * @param tier - the tier to report.
 * @param selection - that tier's selected catalog, when this deployment has one.
 * @param resolved - the resolved capability, when one exists.
 * @returns the tier's contribution.
 */
function tierReport(
  tier: 'live' | 'cache' | 'bundled',
  selection: SelectedPublicCatalog | undefined,
  resolved: ModelCapabilityResolved | undefined,
): ModelCapabilityTier {
  if (selection === undefined) return { tier, state: 'no-catalog' }
  const fetchedAt = selection.fetchedAt === undefined ? {} : { fetchedAt: selection.fetchedAt }
  if (resolved?.origin !== tier) return { tier, state: 'not-matched', ...fetchedAt }
  return {
    tier,
    state: 'answered',
    provider: resolved.provider,
    match: resolved.match,
    levels: resolved.levels,
    ...fetchedAt,
  }
}
/**
 * Explain one route-qualified model: what the resolver answers, and what each
 * public tier contributed to that answer.
 *
 * The route is part of the question because a model id does not identify a
 * gateway: the same id may resolve differently, or not at all, through another
 * route. An empty selection list is a layer that answered from nothing, which is
 * what a disabled layer reports.
 * @param selections - the store's selected catalogs, most authoritative first.
 * @param target - the route and model to explain.
 * @param identity - the route's configured endpoint, when it states one.
 * @returns the explanation chain for that model.
 */
export function explainModelCapability(
  selections: readonly SelectedPublicCatalog[],
  target: ModelCapabilityTarget,
  identity: ModelCapabilityRouteIdentity = {},
): ModelCapabilityExplanation {
  const catalogs: readonly PublicCatalog[] = selections.map(selection => selection.catalog)
  const resolution = resolvePublicCapability(catalogs, target.model, {
    provider: target.route,
    ...identity.baseURL === undefined ? {} : { baseURL: identity.baseURL },
  })
  const resolved: ModelCapabilityResolved | undefined = resolution.kind === 'resolved'
    ? {
      levels: resolution.levels,
      ...resolution.defaultEffort === undefined ? {} : { defaultEffort: resolution.defaultEffort },
      source: resolution.provenance.source,
      provider: resolution.provenance.provider as string,
      match: resolution.provenance.match,
      origin: resolution.provenance.origin as SelectedPublicCatalog['state'],
      ...resolution.provenance.fetchedAt === undefined ? {} : { fetchedAt: resolution.provenance.fetchedAt },
    }
    : undefined
  const suggestions: readonly ModelCapabilitySuggestion[] = resolution.kind === 'resolved'
    ? []
    : resolution.suggestions.map(match => ({
      source: match.source,
      provider: match.providers[0] as string,
      levels: match.levels,
    }))
  const tierOf = (tier: 'live' | 'cache' | 'bundled'): SelectedPublicCatalog | undefined =>
    selections.find(selection => selection.state === tier)
  return {
    route: target.route,
    model: target.model,
    declared: { declaresNoReasoning: false },
    ...resolved === undefined ? {} : { resolved },
    tiers: [
      tierReport('live', tierOf('live'), resolved),
      tierReport('cache', tierOf('cache'), resolved),
      tierReport('bundled', tierOf('bundled'), resolved),
    ],
    suggestions,
  }
}

/** What one configured row's sync decision is. */
export type ModelCapabilitySyncDecision =
  /** A provider-aware match exists and the row declares nothing: write it. */
  | 'write'
  /** The row already declares a level set, or refused reasoning: never overwrite. */
  | 'declared'
  /** Only model-id-only claims exist: reported, never written. */
  | 'suggestion'
  /** Nothing in the loaded catalogs states this id. */
  | 'unresolved'

/** One configured model's inspection, with the action a sync would take. */
export interface ModelCapabilityInspection {
  /** Route the model is configured under. */
  readonly route: string
  /** Model id configured under that route. */
  readonly model: string
  /**
   * The configured route's own fields, as the settings document states them.
   *
   * A write restates this row into the route's `models` list, because the
   * settings seam merges a patch over the user's section and replaces arrays
   * wholesale — the list a write sends must therefore be the complete one.
   */
  readonly routeProfile: Record<string, unknown>
  /** The row's current declaration. */
  readonly declared: ModelCapabilityDeclaration
  /** The resolution chain for this model. */
  readonly chain: ModelCapabilityExplanation
  /** What a sync would do with this row. */
  readonly decision: ModelCapabilitySyncDecision
  /** Levels a `write` would declare, when the decision is `write`. */
  readonly write?: {
    /** Normalized levels the matched provider entry offers. */
    readonly levels: readonly string[]
    /** Published default effort, when it names one of the levels. */
    readonly defaultEffort?: string
  }
}

/**
 * Inspect one configured model and decide what a sync would do with it.
 *
 * The decision is the safety rule in one place: a declaration always wins, a
 * model-id-only claim is never written, and only a provider-aware match on a row
 * that declares nothing produces a write.
 * @param selections - the store's selected catalogs, most authoritative first.
 * @param target - the route and model to inspect.
 * @param routeProfile - the configured route's own fields.
 * @param modelProfile - the configured row's fields, as the settings document states them.
 * @returns the inspection, including the decision.
 */
export function inspectModelCapability(
  selections: readonly SelectedPublicCatalog[],
  target: ModelCapabilityTarget,
  routeProfile: Record<string, unknown>,
  modelProfile: unknown,
): ModelCapabilityInspection {
  const declared = readDeclaration(modelProfile)
  const identity: ModelCapabilityRouteIdentity = typeof routeProfile.baseURL === 'string'
    ? { baseURL: routeProfile.baseURL }
    : {}
  const chain: ModelCapabilityExplanation = {
    ...explainModelCapability(selections, target, identity),
    declared,
  }
  const base = { route: target.route, model: target.model, routeProfile, declared, chain }
  // A row that declares a level set — or refuses reasoning outright — has
  // answered this question, so nothing public may speak for it.
  if (declared.declaresNoReasoning || declared.efforts !== undefined) {
    return { ...base, decision: 'declared' }
  }
  if (chain.resolved === undefined) {
    return { ...base, decision: chain.suggestions.length === 0 ? 'unresolved' : 'suggestion' }
  }
  return {
    ...base,
    decision: 'write',
    write: {
      levels: chain.resolved.levels,
      ...chain.resolved.defaultEffort === undefined ? {} : { defaultEffort: chain.resolved.defaultEffort },
    },
  }
}
