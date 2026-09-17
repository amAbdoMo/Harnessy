/**
 * The public model capability discovery vocabulary: which public database a
 * claim came from, how a route was matched to it, where the metadata was
 * loaded from, and what the answer authorizes a consumer to do.
 *
 * The types are deliberately capability-tagged. Reasoning efforts are the only
 * capability populated today, and {@link ModelCapabilityProvenance.capability}
 * keeps a later vision, tools, modalities, structured-output, or context-limit
 * claim distinguishable from it without changing the resolution mechanism.
 *
 * @module @deepseek-ai/dsh-model-capabilities/types
 */

/** One public database this layer reads provider-aware capability claims from. */
export type PublicCatalogSource = 'models.dev' | 'openrouter'

/**
 * How one route was matched to a public catalog entry.
 *
 * `provider-host` is the preferred answer: the configured endpoint's normalized
 * host named exactly one models.dev provider entry, and the model id was
 * matched inside that entry alone. `provider-id` is the route id naming a
 * models.dev provider directly, which is what a route with no usable endpoint
 * has left. `openrouter-route` is an OpenRouter route answered from
 * OpenRouter's own catalog.
 */
export type PublicCapabilityMatchLevel =
  | 'provider-host'
  | 'provider-id'
  | 'openrouter-route'
  | 'model-id-only'
  | 'model-id-ambiguous'

/**
 * Where a catalog's metadata was loaded from, so a stale snapshot is answerable.
 *
 * `cache` is a durable catalog from an earlier successful fetch, which the live
 * layer selects ahead of the bundled snapshot however old it is: expiration
 * makes a catalog eligible for refresh, never invalid. A caller that needs to
 * know whether that cache is still within its TTL reads the selection's
 * `fetchedAt` against the configured TTL, so freshness is not duplicated here.
 */
export type PublicCatalogOrigin = 'fixture' | 'bundled' | 'live' | 'cache'

/**
 * The three tiers the live layer selects from, most authoritative first.
 *
 * A store selection can only ever be one of these: `fixture` states where a
 * test's catalog came from rather than a tier a deployment selects, so it is
 * absent here on purpose.
 */
export type PublicCatalogTier = 'live' | 'cache' | 'bundled'

/**
 * One loaded public catalog: the parsed database document, plus which database
 * it is and where the document came from.
 *
 * `entries` is the document exactly as it was parsed, not a normalized list, so
 * parsing and matching stay separate concerns and a store-backed catalog can
 * hand over its JSON without this layer knowing where it was read from.
 */
export interface PublicCatalog {
  /** Database this catalog was parsed from. */
  readonly source: PublicCatalogSource
  /** Whether this copy is a test fixture, the bundled snapshot, cached, or live-fetched data. */
  readonly origin: PublicCatalogOrigin
  /**
   * When the fetch that produced this copy completed, in ISO 8601 UTC.
   *
   * Present for `live` and `cache`, absent for `bundled` and `fixture`: the
   * bundled artifact states its generation time in its own metadata, and a
   * fixture has no fetch. It travels into provenance so a caller can answer how
   * old an answer is without asking the store.
   */
  readonly fetchedAt?: string
  /** The parsed database document: `models.dev/api.json`, or `/api/v1/models`. */
  readonly entries: unknown
}

/**
 * A claim that matched one exact provider entry, or a suggestion built from
 * model-id-only claims.
 *
 * `provider` is the matched provider entry, never a guess: an id-only
 * suggestion carries the providers that published the claim it was built from.
 * `levels` holds the normalized harness levels this claim offers, and `efforts`
 * the raw published tokens they came from, so a level the vocabulary dropped is
 * still visible to diagnostics.
 */
export interface PublicCapabilityMatch {
  /** Public database the claim came from. */
  readonly source: PublicCatalogSource
  /** How this claim was matched to the route. */
  readonly level: PublicCapabilityMatchLevel
  /** Provider entries that published this claim, in catalog order. */
  readonly providers: readonly string[]
  /** Normalized harness levels this claim offers, in dispatch order. */
  readonly levels: readonly string[]
  /** Raw tokens as published, for tokens normalization dropped. */
  readonly efforts: readonly string[]
  /** Published default effort, when the claim stated one the levels can take. */
  readonly defaultEffort?: string
}

/**
 * Where one resolved capability came from, for diagnostics and the Models UI.
 *
 * `authoritative` is the field a consumer branches on: a provider-aware claim
 * may be declared, and an id-only claim never may, because one gateway's claim
 * about a model id says nothing about another gateway serving the same id.
 */
export interface ModelCapabilityProvenance {
  /** Capability this provenance describes; the discriminator later capabilities reuse. */
  readonly capability: 'reasoning-efforts'
  /** Public database the claim came from. */
  readonly source: PublicCatalogSource
  /** How the route was matched to that database. */
  readonly match: PublicCapabilityMatchLevel
  /** Matched provider entry, for a provider-aware match. */
  readonly provider?: string
  /** Model id the claim was resolved for. */
  readonly modelId: string
  /** Route the claim was resolved against. */
  readonly route: string
  /** Whether the claim may be declared, or is a suggestion that never may be. */
  readonly authoritative: boolean
  /** Whether the metadata was a fixture, the bundled snapshot, cached, or live-fetched. */
  readonly origin: PublicCatalogOrigin
  /**
   * When the fetch that produced this claim's catalog completed, in ISO 8601
   * UTC; absent for the bundled snapshot and for fixtures.
   */
  readonly fetchedAt?: string
}

/** A capability the resolution layer authorizes a consumer to declare. */
export interface ResolvedPublicCapability {
  /** Discriminant: this resolution produced a declarable capability. */
  readonly kind: 'resolved'
  /** Capability name; the same discriminator {@link ModelCapabilityProvenance} carries. */
  readonly capability: 'reasoning-efforts'
  /** Normalized harness levels the matched provider entry offers, in dispatch order. */
  readonly levels: readonly string[]
  /** Published default effort, when it is one of {@link levels}. */
  readonly defaultEffort?: string
  /** Where this capability came from. */
  readonly provenance: ModelCapabilityProvenance
}

/**
 * A model-id-only claim, reported but never declared.
 *
 * It carries {@link PublicCapabilityResolution.kind} `unresolved` because a
 * suggestion is not an answer a consumer may apply; `suggestions` is what a
 * diagnostics surface renders, and an ambiguous one lists every competing
 * claim rather than one chosen arbitrarily.
 */
export interface UnresolvedPublicCapability {
  /** Discriminant: this resolution produced no declarable capability. */
  readonly kind: 'unresolved'
  /**
   * Model-id-only claims over the same model id. One entry is a unique id-only
   * suggestion, several are the providers that disagree about it, and none
   * means nothing in the loaded catalogs claims this id at all.
   */
  readonly suggestions: readonly PublicCapabilityMatch[]
}

/** What resolving one route and model id against the loaded catalogs produced. */
export type PublicCapabilityResolution = ResolvedPublicCapability | UnresolvedPublicCapability

/*
 * The inspection vocabulary below is what a surface reads: the declaration a
 * configuration row states, the provider-aware match that applies, and the
 * id-only claims that never do. It is declared in this module because these are
 * wire types — the Models page reads them over the `modelCapabilities` Remote
 * namespace — and a Remote boundary type must be reachable from a public
 * non-root type subpath.
 */

/**
 * One route's declaration for one model, as configuration states it.
 *
 * `efforts` is present when the row declares a level set, and absent when the
 * row inherits. `declaresNoReasoning` is a row that answered the question with
 * `false`, which is a declaration and never something a public claim may fill.
 */
export interface ModelCapabilityDeclaration {
  /** Levels the row declares, in dispatch order; absent when the row inherits. */
  readonly efforts?: readonly string[]
  /** Whether the row declares that this model does not reason at all. */
  readonly declaresNoReasoning: boolean
}

/** A model id claimed by one provider entry, for an id-only report. */
export interface ModelCapabilitySuggestion {
  /** Database that claims the id. */
  readonly source: PublicCatalogSource
  /** Provider entry that published the claim. */
  readonly provider: string
  /** Levels that claim offers, in dispatch order. */
  readonly levels: readonly string[]
}

/** The declarable capability one provider-aware match produced. */
export interface ModelCapabilityResolved {
  /** Normalized levels the matched provider entry offers, in dispatch order. */
  readonly levels: readonly string[]
  /** Published default effort, when it names one of the levels. */
  readonly defaultEffort?: string
  /** Database that answered. */
  readonly source: PublicCatalogSource
  /** Provider entry that matched. */
  readonly provider: string
  /** How the route matched it. */
  readonly match: string
  /** Tier that supplied the answering catalog. */
  readonly origin: PublicCatalogTier
  /** When that catalog's fetch completed, for a live or cached answer. */
  readonly fetchedAt?: string
}

/**
 * One configured model's capability provenance, as a Client reads it.
 *
 * `enabled` reports whether the public metadata layer answers at all under the
 * active policy, so a surface can say the layer is off rather than showing an
 * absence of public claims that a disabled layer would also produce. The row's
 * own declaration is deliberately not here: a surface edits it in a draft, so
 * the Host's copy would be stale between an edit and its commit.
 */
export interface ModelCapabilityInspectionView {
  /** Route the model is configured under. */
  readonly route: string
  /** Model id configured under that route. */
  readonly model: string
  /** Whether the public metadata layer answers at all under the active policy. */
  readonly enabled: boolean
  /** The provider-aware match that applies, when one resolved. */
  readonly resolved?: ModelCapabilityResolved
  /** Id-only claims, reported but never applied. */
  readonly suggestions: readonly ModelCapabilitySuggestion[]
}
