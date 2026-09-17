import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  catalogFromResponse,
  createPublicCatalogStore,
  createPublicCapabilitySource,
  loadBundledPublicCatalogs,
  resolvePublicCapability,
} from '@deepseek-ai/dsh-model-capabilities'
import type {
  CachedCatalog,
  PublicCatalogRefreshOutcome,
  PublicCatalog,
  PublicCatalogCache,
  PublicCatalogPolicy,
  PublicCatalogSource,
} from '@deepseek-ai/dsh-model-capabilities'

/** The fixture directory, resolved from this spec so it works from any cwd. */
const FIXTURES = join(import.meta.dirname, 'fixtures')

/** Read one fixture as the parsed JSON it is. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown
}

/** The two captured databases as published documents, for a fake fetch to answer. */
const PUBLISHED: Readonly<Record<PublicCatalogSource, unknown>> = {
  'models.dev': fixture('models-dev.json'),
  openrouter: fixture('openrouter.json'),
}

/** One instant the fake clock starts at; every age below is relative to it. */
const NOW = Date.parse('2026-09-16T12:00:00.000Z')

/** One millisecond in a duration the tests state in days. */
const DAY_MS = 24 * 60 * 60 * 1000

/** A policy with everything on, overridable per test. */
function policy(overrides: Partial<PublicCatalogPolicy> = {}): PublicCatalogPolicy {
  return { enabled: true, refresh: 'auto', cacheTtlMs: 7 * DAY_MS, ...overrides }
}

/** One cached entry fetched `ageDays` before {@link NOW}. */
function cached(source: PublicCatalogSource, ageDays: number, catalog: unknown = PUBLISHED[source]): CachedCatalog {
  return { source, fetchedAt: new Date(NOW - ageDays * DAY_MS).toISOString(), catalog }
}

/** An in-memory cache, so no test touches the real file location. */
function memoryCache(initial: readonly CachedCatalog[] = []): PublicCatalogCache & { written: CachedCatalog[][] } {
  const written: CachedCatalog[][] = []
  let entries = initial
  return {
    written,
    read: () => Promise.resolve(entries),
    write: (next) => {
      written.push([...next])
      entries = next
      return Promise.resolve()
    },
  }
}

/** One fetcher answer: any published document, or a failure the fetch throws. */
type FetchAnswer = unknown

/**
 * A fetcher that records every request and answers per source.
 *
 * Answers pass through {@link catalogFromResponse}, so a fake fetch goes
 * through the same reduction a real response does: a test that hands over a
 * published document proves the whole path, and one that hands over a
 * malformed document proves it is refused whole.
 */
function fakeFetcher(answers: Partial<Record<PublicCatalogSource, FetchAnswer>> = {}) {
  const asked: PublicCatalogSource[] = []
  const fetchCatalog = (source: PublicCatalogSource): Promise<{ source: PublicCatalogSource; catalog: unknown }> => {
    asked.push(source)
    const answer: FetchAnswer = source in answers ? answers[source] : PUBLISHED[source]
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve({ source, catalog: catalogFromResponse(source, answer) })
  }
  return { asked, fetchCatalog }
}

/** A fixed clock, so TTL boundaries are exact rather than wall-clock dependent. */
function fixedClock(): { now(): number } {
  return { now: () => NOW }
}

/** Build one store over the fakes, with the real bundled snapshot as the floor. */
function store(options: {
  readonly policy?: PublicCatalogPolicy
  readonly cache?: PublicCatalogCache
  readonly fetcher?: ReturnType<typeof fakeFetcher>
  readonly clock?: { now(): number }
  readonly bundled?: readonly PublicCatalog[]
  readonly onFailure?: (source: PublicCatalogSource, reason: string) => void
}) {
  const fetcher = options.fetcher ?? fakeFetcher()
  return {
    fetcher,
    store: createPublicCatalogStore({
      policy: () => options.policy ?? policy(),
      fetchCatalog: source => fetcher.fetchCatalog(source),
      ...options.cache === undefined ? {} : { cache: options.cache },
      ...options.bundled === undefined ? {} : { bundled: options.bundled },
      clock: options.clock ?? fixedClock(),
      ...options.onFailure === undefined ? {} : { onFailure: options.onFailure },
    }),
  }
}

/** The signal every refresh call receives; the store never creates one. */
const SIGNAL = new AbortController().signal

describe('selection tiers', () => {
  it('serves the bundled snapshot before anything is loaded or fetched', () => {
    const { store: catalogStore } = store({})
    expect(catalogStore.catalogs().map(catalog => catalog.source)).toEqual(['openrouter', 'models.dev'])
    expect(catalogStore.selections().map(selection => selection.state)).toEqual(['bundled', 'bundled'])
  })

  it('ranks a fresh cache over the bundled snapshot', async () => {
    const cache = memoryCache([cached('models.dev', 1)])
    const { store: catalogStore } = store({ cache })
    await catalogStore.load()
    const selections = catalogStore.selections()
    expect(selections.map(selection => [selection.catalog.source, selection.state]))
      .toEqual([['openrouter', 'bundled'], ['models.dev', 'cache']])
    expect(selections[1]?.fetchedAt).toBe(new Date(NOW - DAY_MS).toISOString())
    expect(selections[1]?.catalog.origin).toBe('cache')
  })

  it('ranks a stale cache over the bundled snapshot, because expiration is not invalidity', async () => {
    const cache = memoryCache([cached('models.dev', 30)])
    const { store: catalogStore } = store({ cache })
    await catalogStore.load()
    expect(catalogStore.selections()[1]).toMatchObject({ state: 'cache', fetchedAt: cached('models.dev', 30).fetchedAt })
  })

  it('ranks a successful fetch over a stale cache', async () => {
    const cache = memoryCache([cached('models.dev', 30)])
    const { store: catalogStore } = store({ cache })
    await catalogStore.load()
    await catalogStore.refresh(SIGNAL)
    const selection = catalogStore.selections()[1]
    expect(selection?.state).toBe('live')
    expect(selection?.catalog.origin).toBe('live')
    expect(selection?.fetchedAt).toBe(new Date(NOW).toISOString())
  })

  it('discards a structurally invalid cache entry and keeps the bundled floor', async () => {
    const cache = memoryCache([
      { source: 'models.dev', fetchedAt: 'not-a-time', catalog: PUBLISHED['models.dev'] },
      { source: 'models.dev', fetchedAt: new Date(NOW).toISOString(), catalog: {} },
      { source: 'openrouter', fetchedAt: new Date(NOW).toISOString(), catalog: { data: 'not-a-list' } },
      // Entries that are not entries at all, which a hand-edited or truncated
      // cache file can state.
      null as unknown as CachedCatalog,
      'scalar' as unknown as CachedCatalog,
      [] as unknown as CachedCatalog,
      { source: 'models.dev' } as unknown as CachedCatalog,
      { source: 'models.dev', fetchedAt: new Date(NOW).toISOString(), catalog: null } as unknown as CachedCatalog,
      { source: 'openrouter', fetchedAt: new Date(NOW).toISOString(), catalog: 'scalar' } as unknown as CachedCatalog,
      { source: 'somewhere-else', fetchedAt: new Date(NOW).toISOString(), catalog: PUBLISHED['models.dev'] } as unknown as CachedCatalog,
    ])
    const { store: catalogStore } = store({ cache })
    await catalogStore.load()
    expect(catalogStore.selections().map(selection => selection.state)).toEqual(['bundled', 'bundled'])
  })

  it('serves only the databases the floor carries when a cache states none', async () => {
    const { store: catalogStore } = store({ cache: memoryCache(), bundled: [] })
    await catalogStore.load()
    expect(catalogStore.catalogs()).toEqual([])
  })
})

describe('the disabled layer', () => {
  it('answers no catalog at all, so no public claim reaches a consumer', () => {
    const { store: catalogStore } = store({ policy: policy({ enabled: false }) })
    expect(catalogStore.catalogs()).toEqual([])
    expect(catalogStore.selections()).toEqual([])
  })

  it('never constructs a request, however often a refresh is attempted', async () => {
    const fetcher = fakeFetcher()
    const cache = memoryCache([cached('models.dev', 30)])
    const { store: catalogStore } = store({ policy: policy({ enabled: false }), fetcher, cache })
    await catalogStore.load()
    await expect(catalogStore.refresh(SIGNAL)).resolves.toEqual([])
    expect(fetcher.asked).toEqual([])
    expect(cache.written).toEqual([])
  })
})

describe('refresh modes', () => {
  it.each(['manual', 'never'] as const)('%s performs no automatic fetch', async (refresh) => {
    const fetcher = fakeFetcher()
    const cache = memoryCache([cached('models.dev', 30)])
    const { store: catalogStore } = store({ policy: policy({ refresh }), fetcher, cache })
    await catalogStore.load()
    await expect(catalogStore.refresh(SIGNAL)).resolves.toEqual([])
    expect(fetcher.asked).toEqual([])
    // The expired cache still serves, which is what keeps both modes usable.
    expect(catalogStore.selections()[1]?.state).toBe('cache')
  })

  it('auto fetches nothing while every cache entry is inside its TTL', async () => {
    const fetcher = fakeFetcher()
    const cache = memoryCache([cached('models.dev', 1), cached('openrouter', 1)])
    const { store: catalogStore } = store({ fetcher, cache })
    await catalogStore.load()
    await expect(catalogStore.refresh(SIGNAL)).resolves.toEqual([])
    expect(fetcher.asked).toEqual([])
  })

  it('auto fetches every database when the cache is missing', async () => {
    const fetcher = fakeFetcher()
    const { store: catalogStore } = store({ fetcher, cache: memoryCache() })
    await catalogStore.load()
    const outcomes = await catalogStore.refresh(SIGNAL)
    expect(outcomes.length).toBeGreaterThan(0)
    expect(fetcher.asked).toEqual(['openrouter', 'models.dev'])
    expect(outcomes).toEqual([
      { source: 'openrouter', refreshed: true },
      { source: 'models.dev', refreshed: true },
    ])
  })

  it('auto fetches only the database whose cache has expired', async () => {
    const fetcher = fakeFetcher()
    const cache = memoryCache([cached('models.dev', 8), cached('openrouter', 1)])
    const { store: catalogStore } = store({ fetcher, cache })
    await catalogStore.load()
    await catalogStore.refresh(SIGNAL)
    expect(fetcher.asked).toEqual(['models.dev'])
  })
})

describe('the TTL boundary', () => {
  it('treats an entry exactly at the TTL as stale and one just inside it as fresh', async () => {
    const atBoundary = fakeFetcher()
    const boundaryCache = memoryCache([cached('models.dev', 7), cached('openrouter', 7)])
    const boundary = store({ fetcher: atBoundary, cache: boundaryCache }).store
    await boundary.load()
    await boundary.refresh(SIGNAL)
    expect(atBoundary.asked).toEqual(['openrouter', 'models.dev'])

    const inside = fakeFetcher()
    const insideCache = memoryCache([cached('models.dev', 7 - 1 / DAY_MS), cached('openrouter', 7 - 1 / DAY_MS)])
    const fresh = store({ fetcher: inside, cache: insideCache }).store
    await fresh.load()
    await fresh.refresh(SIGNAL)
    expect(inside.asked).toEqual([])
  })

  it('reads the TTL from the policy at each decision, so a change takes effect immediately', async () => {
    let current = policy({ cacheTtlMs: 7 * DAY_MS })
    const fetcher = fakeFetcher()
    const cache = memoryCache([cached('models.dev', 1), cached('openrouter', 1)])
    const catalogStore = createPublicCatalogStore({
      policy: () => current,
      fetchCatalog: source => fetcher.fetchCatalog(source),
      cache,
      clock: fixedClock(),
    })
    await catalogStore.load()
    await catalogStore.refresh(SIGNAL)
    expect(fetcher.asked).toEqual([])
    current = policy({ cacheTtlMs: 1 })
    await catalogStore.refresh(SIGNAL)
    expect(fetcher.asked).toEqual(['openrouter', 'models.dev'])
  })
})

describe('source isolation', () => {
  it('updates only the database whose fetch succeeded', async () => {
    const cache = memoryCache([cached('models.dev', 30), cached('openrouter', 30)])
    const fetcher = fakeFetcher({ openrouter: new Error('offline') })
    const { store: catalogStore } = store({ cache, fetcher })
    await catalogStore.load()
    const outcomes = await catalogStore.refresh(SIGNAL)
    expect(outcomes).toEqual([
      { source: 'openrouter', refreshed: false, failure: 'fetch-failed' },
      { source: 'models.dev', refreshed: true },
    ])
    expect(catalogStore.selections().map(selection => [selection.catalog.source, selection.state]))
      .toEqual([['openrouter', 'cache'], ['models.dev', 'live']])
    // The committed cache keeps OpenRouter's previous entry untouched.
    expect(cache.written[0]?.map(entry => entry.source)).toEqual(['models.dev', 'openrouter'])
  })

  it('keeps the stale cache when a fetch fails, so no control disappears', async () => {
    const cache = memoryCache([cached('models.dev', 30), cached('openrouter', 30)])
    const failures: string[] = []
    const { store: catalogStore } = store({
      cache,
      fetcher: fakeFetcher({ 'models.dev': new Error('timeout') }),
      onFailure: (source, reason) => failures.push(`${source}:${reason}`),
    })
    await catalogStore.load()
    await catalogStore.refresh(SIGNAL)
    expect(failures).toEqual(['models.dev:fetch-failed'])
    expect(catalogStore.selections()[1]).toMatchObject({ state: 'cache' })
    // Only OpenRouter's entry is rewritten; models.dev keeps its previous one.
    const committed = cache.written[0] ?? []
    expect(committed.map(entry => entry.source).sort()).toEqual(['models.dev', 'openrouter'])
    expect(committed.find(entry => entry.source === 'models.dev')?.fetchedAt).toBe(cached('models.dev', 30).fetchedAt)
    expect(committed.find(entry => entry.source === 'openrouter')?.fetchedAt).toBe(new Date(NOW).toISOString())
  })

  it('keeps the stale cache when a response reduces to no catalog', async () => {
    const cache = memoryCache([cached('models.dev', 30), cached('openrouter', 30)])
    const failures: string[] = []
    const { store: catalogStore } = store({
      cache,
      fetcher: fakeFetcher({ 'models.dev': { unrelated: true } }),
      onFailure: (source, reason) => failures.push(`${source}:${reason}`),
    })
    await catalogStore.load()
    await catalogStore.refresh(SIGNAL)
    expect(failures).toEqual(['models.dev:unusable-response'])
    expect(catalogStore.selections()[1]).toMatchObject({ state: 'cache' })
    expect((cache.written[0] ?? []).find(entry => entry.source === 'models.dev')?.fetchedAt)
      .toBe(cached('models.dev', 30).fetchedAt)
  })

  it('lets a failing database finish while the other still commits', async () => {
    const cache = memoryCache([cached('models.dev', 30), cached('openrouter', 30)])
    const { store: catalogStore } = store({ cache, fetcher: fakeFetcher({ 'models.dev': undefined }) })
    await catalogStore.load()
    const outcomes = await catalogStore.refresh(SIGNAL)
    expect(outcomes.map((outcome: PublicCatalogRefreshOutcome) => [outcome.source, outcome.refreshed]))
      .toEqual([['openrouter', true], ['models.dev', false]])
    expect(catalogStore.selections().map(selection => selection.state)).toEqual(['live', 'cache'])
  })
})

describe('cache persistence', () => {
  it('commits one write covering every database it knows', async () => {
    const cache = memoryCache([cached('openrouter', 30)])
    const { store: catalogStore } = store({ cache })
    await catalogStore.load()
    await catalogStore.refresh(SIGNAL)
    expect(cache.written).toHaveLength(1)
    expect(cache.written[0]?.map(entry => [entry.source, entry.fetchedAt])).toEqual([
      ['openrouter', new Date(NOW).toISOString()],
      ['models.dev', new Date(NOW).toISOString()],
    ])
  })

  it('keeps serving the live catalogs when the cache cannot be written', async () => {
    const failures: string[] = []
    const cache: PublicCatalogCache = {
      read: () => Promise.resolve([]),
      write: () => Promise.reject(new Error('EACCES')),
    }
    const { store: catalogStore } = store({ cache, onFailure: (source, reason) => failures.push(`${source}:${reason}`) })
    await catalogStore.load()
    const outcomes = await catalogStore.refresh(SIGNAL)
    expect(outcomes).toEqual([
      { source: 'openrouter', refreshed: true, failure: 'persist-failed' },
      { source: 'models.dev', refreshed: true, failure: 'persist-failed' },
    ])
    expect(failures).toEqual(['openrouter:persist-failed', 'models.dev:persist-failed'])
    // Durability was lost, discovery was not.
    expect(catalogStore.selections().map(selection => selection.state)).toEqual(['live', 'live'])
  })

  it('reports only the databases a failed write covered', async () => {
    const cache: PublicCatalogCache = {
      read: () => Promise.resolve([]),
      write: () => Promise.reject(new Error('EACCES')),
    }
    const failures: string[] = []
    const { store: catalogStore } = store({
      cache,
      fetcher: fakeFetcher({ 'models.dev': new Error('offline') }),
      onFailure: (source, reason) => failures.push(`${source}:${reason}`),
    })
    await catalogStore.load()
    const outcomes = await catalogStore.refresh(SIGNAL)
    expect(outcomes).toEqual([
      { source: 'openrouter', refreshed: true, failure: 'persist-failed' },
      { source: 'models.dev', refreshed: false, failure: 'fetch-failed' },
    ])
    expect(failures).toEqual(['models.dev:fetch-failed', 'openrouter:persist-failed'])
  })

  it('treats an unreadable cache as an empty one', async () => {
    const cache: PublicCatalogCache = {
      read: () => Promise.reject(new Error('EACCES')),
      write: () => Promise.resolve(),
    }
    const { store: catalogStore } = store({ cache })
    await catalogStore.load()
    expect(catalogStore.selections().map(selection => selection.state)).toEqual(['bundled', 'bundled'])
  })

  it('does not write anything when no cache is configured', async () => {
    const { store: catalogStore } = store({})
    await catalogStore.load()
    const outcomes = await catalogStore.refresh(SIGNAL)
    expect(outcomes.every((outcome: PublicCatalogRefreshOutcome) => outcome.refreshed)).toBe(true)
    expect(catalogStore.selections().map(selection => selection.state)).toEqual(['live', 'live'])
  })
})

describe('live and cached catalogs through the slice-1 resolver', () => {
  /** Resolve one model against whatever the store currently selects. */
  const resolve = (
    catalogStore: { catalogs(): readonly PublicCatalog[] },
    modelId: string,
    route: { provider?: string; baseURL?: string },
  ) => resolvePublicCapability(catalogStore.catalogs(), modelId, route)

  it('answers a models.dev provider host authoritatively from a live catalog', async () => {
    const { store: catalogStore } = store({ cache: memoryCache() })
    await catalogStore.load()
    await catalogStore.refresh(SIGNAL)
    const resolution = resolve(catalogStore, 'gpt-5.4', { provider: 'openai', baseURL: 'https://api.openai.com/v1' })
    expect(resolution.kind).toBe('resolved')
    expect(resolution.kind === 'resolved' ? resolution.levels : undefined).toEqual(['low', 'medium', 'high'])
    expect(resolution.kind === 'resolved' ? resolution.provenance : undefined)
      .toMatchObject({ match: 'provider-host', origin: 'live', fetchedAt: new Date(NOW).toISOString() })
  })

  it('answers a models.dev provider host authoritatively from a cached catalog', async () => {
    const cache = memoryCache([cached('models.dev', 30)])
    const { store: catalogStore } = store({ cache, fetcher: fakeFetcher({ 'models.dev': undefined }) })
    await catalogStore.load()
    await catalogStore.refresh(SIGNAL)
    const resolution = resolve(catalogStore, 'gpt-5.4', { provider: 'openai', baseURL: 'https://api.openai.com/v1' })
    expect(resolution.kind === 'resolved' ? resolution.provenance : undefined)
      .toMatchObject({ origin: 'cache', fetchedAt: cached('models.dev', 30).fetchedAt })
  })

  it('answers an OpenRouter route only when the route is OpenRouter', async () => {
    const { store: catalogStore } = store({ cache: memoryCache() })
    await catalogStore.load()
    await catalogStore.refresh(SIGNAL)
    const own = resolve(catalogStore, 'openai/gpt-5.6-sol', { provider: 'x', baseURL: 'https://openrouter.ai/api/v1' })
    expect(own).toMatchObject({ kind: 'resolved', provenance: { match: 'openrouter-route' } })
    const foreign = resolve(catalogStore, 'openai/gpt-5.6-sol', { provider: 'x', baseURL: 'https://api.pioneer.ai/v1' })
    expect(foreign.kind).toBe('unresolved')
  })

  it('keeps an id-only claim a suggestion from a live catalog', async () => {
    const { store: catalogStore } = store({ cache: memoryCache() })
    await catalogStore.load()
    await catalogStore.refresh(SIGNAL)
    const resolution = resolve(catalogStore, 'gpt-5.6-sol', { provider: 'unlisted' })
    expect(resolution.kind).toBe('unresolved')
    const suggestions = resolution.kind === 'unresolved' ? resolution.suggestions : []
    expect(suggestions.length).toBeGreaterThan(1)
    expect(suggestions.every(match => match.level === 'model-id-ambiguous')).toBe(true)
    expect(createPublicCapabilitySource(catalogStore.catalogs())('gpt-5.6-sol', { provider: 'unlisted' }))
      .toBeUndefined()
  })

  it('keeps an id-only claim a suggestion from a cached catalog', async () => {
    const cache = memoryCache([cached('models.dev', 30)])
    const { store: catalogStore } = store({ cache, fetcher: fakeFetcher({ 'models.dev': undefined }) })
    await catalogStore.load()
    await catalogStore.refresh(SIGNAL)
    const resolution = resolve(catalogStore, 'gpt-5.6-sol', { provider: 'unlisted' })
    expect(resolution.kind).toBe('unresolved')
    expect(createPublicCapabilitySource(catalogStore.catalogs())('gpt-5.6-sol', { provider: 'unlisted' }))
      .toBeUndefined()
  })

  it('leaves a disabled layer with nothing to resolve', () => {
    const { store: catalogStore } = store({ policy: policy({ enabled: false }) })
    expect(resolve(catalogStore, 'gpt-5.4', { provider: 'openai' })).toEqual({ kind: 'unresolved', suggestions: [] })
  })

  it('never merges two generations of one database', async () => {
    // The cached catalog claims a model the live one does not; after a
    // successful refresh the cached claim is gone rather than unioned in.
    const older = { openai: { id: 'openai', models: { 'stale-only': { id: 'stale-only', reasoning_options: [{ type: 'effort', values: ['low'] }] } } } }
    const cache = memoryCache([cached('models.dev', 30, older)])
    const { store: catalogStore } = store({ cache })
    await catalogStore.load()
    expect(resolve(catalogStore, 'stale-only', { provider: 'openai' }).kind).toBe('resolved')
    await catalogStore.refresh(SIGNAL)
    expect(resolve(catalogStore, 'stale-only', { provider: 'openai' })).toEqual({ kind: 'unresolved', suggestions: [] })
  })
})

describe('the catalog stack the resolver receives', () => {
  it('lists OpenRouter before models.dev, matching the slice-1 precedence', async () => {
    const { store: catalogStore } = store({ cache: memoryCache() })
    await catalogStore.load()
    await catalogStore.refresh(SIGNAL)
    expect(catalogStore.catalogs().map(catalog => catalog.source)).toEqual(['openrouter', 'models.dev'])
  })

  it('hands the resolver the same shape the bundled snapshot does', () => {
    const bundled = loadBundledPublicCatalogs()
    expect(bundled.map(catalog => catalog.source)).toEqual(['openrouter', 'models.dev'])
    expect(bundled.every(catalog => catalog.origin === 'bundled')).toBe(true)
  })
})

describe('refresh reporting', () => {
  it('reports nothing when nothing needed a fetch', async () => {
    const { store: catalogStore } = store({ cache: memoryCache([cached('models.dev', 1), cached('openrouter', 1)]) })
    await catalogStore.load()
    expect(await catalogStore.refresh(SIGNAL)).toEqual([])
  })

  it('reports nothing when a second pass finds every database already live', async () => {
    const { store: catalogStore } = store({ cache: memoryCache() })
    await catalogStore.load()
    expect((await catalogStore.refresh(SIGNAL)).length).toBeGreaterThan(0)
    expect(await catalogStore.refresh(SIGNAL)).toEqual([])
  })
})

describe('cancellation', () => {
  it('forwards the caller signal to every fetcher', async () => {
    const seen: AbortSignal[] = []
    const catalogStore = createPublicCatalogStore({
      policy: () => policy(),
      fetchCatalog: (source, signal) => {
        seen.push(signal)
        return Promise.resolve({ source, catalog: PUBLISHED[source] })
      },
      cache: memoryCache(),
      clock: fixedClock(),
    })
    await catalogStore.load()
    const controller = new AbortController()
    await catalogStore.refresh(controller.signal)
    expect(seen).toHaveLength(2)
    expect(seen.every(signal => signal === controller.signal)).toBe(true)
  })

  it('treats an aborted fetch as a source failure that keeps the previous catalog', async () => {
    const cache = memoryCache([cached('models.dev', 30)])
    const catalogStore = createPublicCatalogStore({
      policy: () => policy(),
      fetchCatalog: (source, signal) => signal.aborted
        ? Promise.reject(new Error('aborted'))
        : Promise.resolve({ source, catalog: PUBLISHED[source] }),
      cache,
      clock: fixedClock(),
    })
    await catalogStore.load()
    const controller = new AbortController()
    controller.abort()
    const outcomes = await catalogStore.refresh(controller.signal)
    expect(outcomes.every((outcome: PublicCatalogRefreshOutcome) => outcome.failure === 'fetch-failed')).toBe(true)
    expect(catalogStore.selections()[1]?.state).toBe('cache')
  })
})

describe('failure reporting', () => {
  it('reports each failing database exactly once', async () => {
    const report = vi.fn()
    const { store: catalogStore } = store({
      cache: memoryCache(),
      fetcher: fakeFetcher({ 'models.dev': new Error('offline'), openrouter: undefined }),
      onFailure: report,
    })
    await catalogStore.load()
    await catalogStore.refresh(SIGNAL)
    expect(report.mock.calls).toEqual([
      ['openrouter', 'unusable-response'],
      ['models.dev', 'fetch-failed'],
    ])
  })
})
