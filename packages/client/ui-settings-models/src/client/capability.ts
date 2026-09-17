/**
 * What one configured model row's reasoning provenance is, derived from the
 * Host's own answer.
 *
 * The Host resolves and matches; this module only chooses which of the states a
 * row renders as. Keeping that choice here rather than in the component is what
 * lets every state — a declaration, a provider-aware public claim, an id-only
 * claim, an ambiguity, a disabled layer — be asserted without rendering.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-models/capability
 */

import type { ModelCapabilityInspectionView, ModelCapabilitySuggestion } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * The key one configured model's provenance is held under.
 *
 * A model id alone is not unique across routes, and the same id may resolve
 * differently through two gateways, so the route is part of the identity.
 * @param route - configured route id.
 * @param model - model id within that route.
 * @returns the lookup key.
 */
export function capabilityKey(route: string, model: string): string {
  return `${route}\u0000${model}`
}

/**
 * The lookup a card renders with when it has no configured rows to explain.
 *
 * A card that is adding a route, or editing one for the first time, has no
 * configured model for the Host to have resolved, so it shows no provenance
 * rather than an absence of one.
 */
export const NO_CAPABILITIES: ReadonlyMap<string, ModelCapabilityInspectionView> = new Map()

/**
 * One route's rows, keyed by model id.
 *
 * The editor already knows which route it is editing, so the projection drops
 * the route dimension rather than making every row carry it.
 * @param capabilities - the page's provenance by {@link capabilityKey}.
 * @param route - route whose rows are wanted.
 * @returns the route's inspections, keyed by model id.
 */
export function routeCapabilities(
  capabilities: ReadonlyMap<string, ModelCapabilityInspectionView> | undefined,
  route: string,
): ReadonlyMap<string, ModelCapabilityInspectionView> {
  const prefix = `${route}\u0000`
  return new Map(
    [...capabilities ?? []]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => [key.slice(prefix.length), entry]),
  )
}

/** How one row's provenance renders, once the row's own declaration is known. */
export type CapabilityProvenanceState =
  /** Nothing to say: the row declares nothing and no public claim names it. */
  | { readonly kind: 'none' }
  /** The layer is off, so no public claim applies to any row. */
  | { readonly kind: 'disabled' }
  /** The row's own declaration is the active source. */
  | {
    readonly kind: 'declared'
    /** Levels a public claim states that the declaration does not apply. */
    readonly notApplied?: readonly string[]
  }
  /** A provider-aware public match supplies the levels the runtime offers. */
  | {
    readonly kind: 'public'
    readonly levels: readonly string[]
    readonly source: string
    readonly provider: string
    readonly match: string
    readonly origin: string
    readonly fetchedAt?: string
  }
  /** Id-only claims name the model, and none of them is applied. */
  | { readonly kind: 'id-only'; readonly claims: readonly ModelCapabilitySuggestion[] }

/**
 * Whether two level sets differ as sets.
 * @param left - one level list.
 * @param right - the other level list.
 * @returns whether either names a level the other does not.
 */
function differs(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left)
  const b = new Set(right)
  return a.size !== b.size || [...a].some(level => !b.has(level))
}

/**
 * Decide how one row renders its provenance.
 *
 * The row's own declaration is read from the draft the user is editing, not
 * from the Host's copy, so a change made and not yet applied is reflected
 * immediately; the Host's answer supplies only what the catalogs state.
 * @param inspection - the Host's answer for this route and model, when it made one.
 * @param declared - the row's declaration as the draft states it.
 * @returns the state to render.
 */
export function capabilityProvenance(
  inspection: ModelCapabilityInspectionView | undefined,
  declared: { readonly efforts?: readonly string[]; readonly declaresNoReasoning: boolean },
): CapabilityProvenanceState {
  if (declared.declaresNoReasoning || declared.efforts !== undefined) {
    // The declaration is the active source, so nothing public is applied. A
    // public claim that states something else is reported and no more: the
    // layer never reconciles the two.
    const levels = inspection?.resolved?.levels
    const stated = declared.efforts ?? []
    return {
      kind: 'declared',
      ...levels === undefined || !differs(levels, stated) ? {} : { notApplied: levels },
    }
  }
  /* v8 ignore next -- a route whose rows the Host does not report renders no provenance. */
  if (inspection === undefined) return { kind: 'none' }
  if (!inspection.enabled) return { kind: 'disabled' }
  if (inspection.resolved !== undefined) {
    return {
      kind: 'public',
      levels: inspection.resolved.levels,
      source: inspection.resolved.source,
      provider: inspection.resolved.provider,
      match: inspection.resolved.match,
      origin: inspection.resolved.origin,
      ...inspection.resolved.fetchedAt === undefined ? {} : { fetchedAt: inspection.resolved.fetchedAt },
    }
  }
  if (inspection.suggestions.length > 0) return { kind: 'id-only', claims: inspection.suggestions }
  // Nothing claims this id: the undeclared row is the whole answer, and a
  // database that has no record of a model is not something to warn about.
  return { kind: 'none' }
}
