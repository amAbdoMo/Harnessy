/**
 * The live/cached public catalog layer: which catalog each public database is
 * currently answered from, and the policy that decides when a refresh runs.
 *
 * This is the only place that owns network and cache state. It selects exactly
 * one catalog per database — the newest successfully fetched one, else the last
 * known-good cache, else the bundled snapshot — and hands the result to the
 * unchanged slice-1 resolver. Selection never merges two generations of one
 * database: a union would offer a level neither generation stated.
 *
 * @module @deepseek-ai/dsh-model-capabilities/store
 */

import { curateModelsDevCatalog, curateOpenRouterCatalog } from './snapshot.ts'
import { loadBundledPublicCatalogs } from './bundled.ts'
import type { PublicCatalog, PublicCatalogSource, PublicCatalogTier } from './types.ts'

/**
 * How this deployment refreshes public metadata.
 *
 * `auto` fetches whatever is missing or expired, `manual` never fetches on its
 * own and leaves that to an explicit command, and `never` refuses network
 * access outright. `manual` and `never` serve the same catalogs today; they
 * differ in whether a later command surface is allowed to fetch.
 */
export type PublicMetadataRefreshMode = 'auto' | 'manual' | 'never'

/** The databases this layer fetches, in the order a catalog stack lists them. */
export const PUBLIC_CATALOG_SOURCES: readonly PublicCatalogSource[] = ['openrouter', 'models.dev']

/** One database's catalog as a fetch or a cache states it. */
export interface CachedCatalog {
  /** Database this catalog came from. */
  readonly source: PublicCatalogSource
  /** When the fetch that produced it completed, in ISO 8601 UTC. */
  readonly fetchedAt: string
  /** The published document, reduced to the fields the resolver reads. */
  readonly catalog: unknown
}

/** Where the catalogs this layer serves come from, for diagnostics. */
export type PublicCatalogState = PublicCatalogTier

/** One database's selected catalog plus how it was selected. */
export interface SelectedPublicCatalog {
  /** The catalog to hand the resolver. */
  readonly catalog: PublicCatalog
  /** Which tier supplied it. */
  readonly state: PublicCatalogState
  /** When the fetch that produced it completed; absent for the bundled snapshot. */
  readonly fetchedAt?: string
}

/** One database's fetch outcome, so a caller can report per-source failures. */
export interface PublicCatalogRefreshOutcome {
  /** Database the refresh asked. */
  readonly source: PublicCatalogSource
  /** Whether this database's catalog was replaced. */
  readonly refreshed: boolean
  /** Why it was not replaced, when it was not. */
  readonly failure?: 'fetch-failed' | 'unusable-response' | 'persist-failed'
}

/** One source's fetch, as the store consumes it. */
export interface PublicCatalogFetch {
  /** Database being fetched. */
  readonly source: PublicCatalogSource
  /** The reduced catalog, or undefined when the response was not usable. */
  readonly catalog: unknown
}

/** The clock this layer reads, injectable so TTL boundaries stay testable. */
export interface PublicCatalogClock {
  /** Current time in milliseconds since the Unix epoch. */
  now(): number
}

/** The cache file this layer owns, as the store consumes it. */
export interface PublicCatalogCache {
  /** Read the last committed entries; an absent or unusable file yields none. */
  read(): Promise<readonly CachedCatalog[]>
  /** Commit one refresh's entries, replacing every database the pass covered. */
  write(entries: readonly CachedCatalog[]): Promise<void>
}

/** Everything one store needs to decide and serve. */
export interface PublicCatalogStoreOptions {
  /**
   * Read the active policy. Called per decision rather than captured, so a
   * settings change takes effect on the next lookup.
   */
  readonly policy: () => PublicCatalogPolicy
  /** Fetch one database; the fetcher owns transport, timeout, and validation. */
  readonly fetchCatalog: (source: PublicCatalogSource, signal: AbortSignal) => Promise<PublicCatalogFetch>
  /** The persistent cache, when this deployment has one. */
  readonly cache?: PublicCatalogCache
  /** Catalogs to serve before the bundled snapshot; defaults to the bundled ones. */
  readonly bundled?: readonly PublicCatalog[]
  /** Clock used for every TTL comparison; defaults to the system clock. */
  readonly clock?: PublicCatalogClock
  /** Report one database's failed attempt, for an operator-visible diagnostic. */
  readonly onFailure?: (source: PublicCatalogSource, reason: NonNullable<PublicCatalogRefreshOutcome['failure']>) => void
}

/** The policy fields that decide whether and how a refresh runs. */
export interface PublicCatalogPolicy {
  /** Whether the public metadata layer runs at all. */
  readonly enabled: boolean
  /** When this deployment fetches. */
  readonly refresh: PublicMetadataRefreshMode
  /** How long a fetched catalog stays fresh, in milliseconds. */
  readonly cacheTtlMs: number
}

/** The store handle one composition keeps for the lifetime of its fiber. */
export interface PublicCatalogStore {
  /**
   * Snapshot the catalogs to resolve against, most authoritative first.
   * Call {@link PublicCatalogStore.load} or {@link PublicCatalogStore.refresh}
   * first when the persistent cache should be part of the answer.
   * @returns one selected catalog per public database that has one.
   */
  catalogs(): readonly PublicCatalog[]
  /**
   * Report which tier currently supplies each database.
   * @returns one selection per public database that has one, in source order.
   */
  selections(): readonly SelectedPublicCatalog[]
  /**
   * Read the persistent cache once, so every later answer includes it. A cache
   * that is absent, unreadable, or structurally unusable reads as empty, which
   * leaves the bundled snapshot serving.
   * @returns when the cache has been read.
   */
  load(): Promise<void>
  /**
   * Fetch whatever this policy makes eligible, committing a successful fetch to
   * the cache in one write.
   * @param signal - caller cancellation, honoured by the fetchers.
   * @returns what the pass did, per database.
   */
  refresh(signal: AbortSignal): Promise<readonly PublicCatalogRefreshOutcome[]>
}

/** The system clock, used when a caller supplies none. */
const SYSTEM_CLOCK: PublicCatalogClock = { now: () => Date.now() }

/**
 * Whether one parsed entry loaded from the cache is structurally usable.
 *
 * Only structure is judged here. Age is not validity: an expired entry is
 * eligible for refresh, and stays the best available answer until a refresh
 * actually replaces it.
 * @param entry - one candidate entry.
 * @param source - the database it claims to be.
 * @returns whether it states a parseable fetch time and a non-empty catalog.
 */
function isCachedCatalog(entry: unknown, source: PublicCatalogSource): entry is CachedCatalog {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
  const candidate = entry as Record<string, unknown>
  if (candidate.source !== source) return false
  if (typeof candidate.fetchedAt !== 'string' || Number.isNaN(Date.parse(candidate.fetchedAt))) return false
  return !isEmptyCatalog(source, candidate.catalog)
}

/**
 * Whether one catalog document states no entry at all.
 *
 * A models.dev catalog is its provider map; an OpenRouter catalog is its `data`
 * list. An empty one is refused rather than served, because a refresh that
 * produced nothing is a failed refresh, not a deployment with no public
 * metadata — and replacing a known-good cache with it would remove controls.
 * @param source - the database the catalog belongs to.
 * @param catalog - the candidate catalog document.
 * @returns whether it carries no entry in that database's own shape.
 */
function isEmptyCatalog(source: PublicCatalogSource, catalog: unknown): boolean {
  if (typeof catalog !== 'object' || catalog === null || Array.isArray(catalog)) return true
  const entries = catalog as Record<string, unknown>
  if (source === 'openrouter') {
    const data = entries.data
    return !Array.isArray(data) || data.length === 0
  }
  return Object.keys(entries).length === 0
}

/**
 * Reduce one fetched document to the fields the resolver reads, and refuse it
 * whole when that reduction states nothing.
 *
 * The curation is the snapshot generator's own, so a live fetch and the bundled
 * artifact are the same reduction of the same published form. A malformed
 * response therefore cannot reach the cache as a partial catalog.
 * @param source - the database the document was fetched from.
 * @param document - the parsed response body.
 * @returns the reduced catalog, or undefined when the response stated nothing usable.
 */
export function catalogFromResponse(source: PublicCatalogSource, document: unknown): unknown {
  if (source === 'openrouter') {
    const { catalog } = curateOpenRouterCatalog(document)
    return catalog.data.length === 0 ? undefined : catalog
  }
  const { catalog } = curateModelsDevCatalog(document)
  return Object.keys(catalog).length === 0 ? undefined : catalog
}

/**
 * Create the layer that selects and refreshes the public catalogs.
 *
 * The store performs no I/O of its own: it reads the cache through the supplied
 * {@link PublicCatalogCache} and fetches through the supplied fetcher, so a test
 * drives every branch with fakes and no socket is ever opened.
 * @param options - the policy source, fetcher, cache, and bundled floor.
 * @returns the store handle.
 */
export function createPublicCatalogStore(options: PublicCatalogStoreOptions): PublicCatalogStore {
  const clock = options.clock ?? SYSTEM_CLOCK
  const bundled = options.bundled ?? loadBundledPublicCatalogs()
  /** Last successfully fetched catalogs, replacing nothing until a fetch succeeds. */
  const fetched = new Map<PublicCatalogSource, CachedCatalog>()
  /** Last cache contents, read once; entries are replaced only by a successful fetch. */
  let cached: readonly CachedCatalog[] | undefined
  let reading: Promise<void> | undefined

  /**
   * Whether the store may read the cache at all under the active policy.
   * @returns whether the public metadata layer is enabled.
   */
  function active(): boolean {
    return options.policy().enabled
  }

  /**
   * Load the cache once, so a lookup after startup is synchronous.
   * @returns the in-flight or settled read.
   */
  function ensureCacheLoaded(): Promise<void> {
    if (cached !== undefined || options.cache === undefined) return reading ?? Promise.resolve()
    reading ??= options.cache.read().then((entries) => {
      cached = entries
    }, () => {
      // An unreadable cache is an absent cache: the bundled snapshot is the
      // floor, so a cache failure never removes a control.
      cached = []
    })
    return reading
  }  /**
   * The cached entry for one database, when it is structurally usable.
   * @param source - the database to select.
   * @returns the entry, or undefined when the cache states none.
   */
  function cachedFor(source: PublicCatalogSource): CachedCatalog | undefined {
    return cached?.find(entry => isCachedCatalog(entry, source))
  }

  /**
   * The bundled catalog for one database.
   * @param source - the database to select.
   * @returns the catalog, or undefined when the floor does not carry it.
   */
  function bundledFor(source: PublicCatalogSource): PublicCatalog | undefined {
    return bundled.find(catalog => catalog.source === source)
  }

  /**
   * Select one database's best available catalog.
   *
   * The tiers are ordered, never merged: a fresh fetch wins, then the last
   * known-good cache whatever its age, then the bundled floor.
   * @param source - the database to select.
   * @returns the selection, or undefined when no tier states a catalog.
   */
  function select(source: PublicCatalogSource): SelectedPublicCatalog | undefined {
    const live = fetched.get(source)
    if (live !== undefined) {
      return {
        catalog: { source, origin: 'live', fetchedAt: live.fetchedAt, entries: live.catalog },
        state: 'live',
        fetchedAt: live.fetchedAt,
      }
    }
    const fromCache = cachedFor(source)
    if (fromCache !== undefined) {
      return {
        catalog: { source, origin: 'cache', fetchedAt: fromCache.fetchedAt, entries: fromCache.catalog },
        state: 'cache',
        fetchedAt: fromCache.fetchedAt,
      }
    }
    const fromBundle = bundledFor(source)
    return fromBundle === undefined ? undefined : { catalog: fromBundle, state: 'bundled' }
  }

  /**
   * Whether one database is missing or expired under the active policy.
   * @param source - the database to judge.
   * @returns whether `refresh: auto` should fetch it now.
   */
  function needsRefresh(source: PublicCatalogSource): boolean {
    if (fetched.has(source)) return false
    const entry = cachedFor(source)
    if (entry === undefined) return true
    // Age is measured from the fetch, and the boundary belongs to staleness:
    // an entry exactly at the TTL is eligible for refresh. An expired entry is
    // never discarded — it keeps serving until a fetch replaces it.
    return clock.now() - Date.parse(entry.fetchedAt) >= options.policy().cacheTtlMs
  }

  /**
   * Report one database's failed attempt.
   * @param source - the database that failed.
   * @param reason - why its catalog was not replaced.
   */
  function fail(source: PublicCatalogSource, reason: NonNullable<PublicCatalogRefreshOutcome['failure']>): void {
    options.onFailure?.(source, reason)
  }

  /**
   * Select every database's best available catalog, in source order.
   * @returns the selections, empty while the layer is disabled.
   */
  function selected(): readonly SelectedPublicCatalog[] {
    if (!active()) return []
    return PUBLIC_CATALOG_SOURCES.flatMap((source) => {
      const selection = select(source)
      return selection === undefined ? [] : [selection]
    })
  }

  return {
    catalogs(): readonly PublicCatalog[] {
      return selected().map(selection => selection.catalog)
    },

    selections: selected,

    load: ensureCacheLoaded,

    async refresh(signal: AbortSignal): Promise<readonly PublicCatalogRefreshOutcome[]> {
      if (!active()) return []
      // `manual` leaves every fetch to an explicit command; `never` refuses
      // them outright. Neither is an automatic refresh, so nothing runs here.
      if (options.policy().refresh !== 'auto') return []
      await ensureCacheLoaded()
      const pending = PUBLIC_CATALOG_SOURCES.filter(needsRefresh)
      if (pending.length === 0) return []

      // One database failing never blocks another: each fetch settles on its
      // own, and the whole pass still commits what succeeded.
      const settled = await Promise.all(pending.map(async (source): Promise<PublicCatalogRefreshOutcome> => {
        let result: PublicCatalogFetch
        try {
          result = await options.fetchCatalog(source, signal)
        } catch (_sourceUnreachable) {
          // A transport failure keeps the previous catalog: the cache and the
          // bundled floor still answer, so no control disappears.
          fail(source, 'fetch-failed')
          return { source, refreshed: false, failure: 'fetch-failed' }
        }
        if (result.catalog === undefined) {
          fail(source, 'unusable-response')
          return { source, refreshed: false, failure: 'unusable-response' }
        }
        fetched.set(source, { source, fetchedAt: new Date(clock.now()).toISOString(), catalog: result.catalog })
        return { source, refreshed: true }
      }))

      const succeeded = settled.filter(outcome => outcome.refreshed)
      // Nothing succeeded, or this deployment keeps no cache: the live catalogs
      // are already in memory, which is the whole answer.
      if (succeeded.length === 0 || options.cache === undefined) return settled

      // Commit in one write, so a crash leaves either the whole previous cache
      // or the whole next one. A cache read can repeat a database, so the map
      // keeps the last entry for each, and a fetch that just succeeded is
      // always newer than the entry it replaces.
      //
      // `cached` is settled here because `ensureCacheLoaded` above awaited it,
      // and `fetched` holds an entry for every source in `succeeded` — putting
      // each one there is what put it in `succeeded`.
      const known = new Map<PublicCatalogSource, CachedCatalog>()
      for (const entry of cached as readonly CachedCatalog[]) known.set(entry.source, entry)
      for (const outcome of succeeded) {
        const entry = fetched.get(outcome.source) as CachedCatalog
        known.set(entry.source, entry)
      }
      try {
        await options.cache.write([...known.values()])
        cached = [...known.values()]
        return settled
      } catch (_unwritableCache) {
        // The catalogs are already live in memory; only durability is lost, so
        // discovery keeps serving while the failure is reported per database.
        for (const outcome of succeeded) fail(outcome.source, 'persist-failed')
        return settled.map(outcome => outcome.refreshed
          ? { source: outcome.source, refreshed: true, failure: 'persist-failed' }
          : outcome)
      }
    },
  }
}
