import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createPublicCatalogStore } from '@deepseek-ai/dsh-model-capabilities'
import type { CachedCatalog, SelectedPublicCatalog } from '@deepseek-ai/dsh-model-capabilities'
import { ModelCapabilitiesInspector } from '../src/remote.ts'
import { MODEL_CAPABILITY_STORE_SERVICE } from '../src/plugin.ts'

/** The reduced models.dev catalog the bundled tier is built from. */
const MODELS_DEV_ENTRIES = {
  cortecs: {
    id: 'cortecs',
    api: 'https://api.cortecs.ai/v1',
    models: {
      'gpt-5.6-sol': { id: 'gpt-5.6-sol', reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] },
      // One provider entry only, and none whose endpoint is configured: an
      // id-only claim, which no run may apply.
      'gpt-6-astra': { id: 'gpt-6-astra', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
    },
  },
}

/** One deployment: a provider-host route, a bare route, and a declared row. */
const ROUTES = {
  providers: {
    cortex: {
      displayName: 'Cortex',
      baseURL: 'https://api.cortecs.ai/v1',
      models: [{ id: 'gpt-5.6-sol', name: 'Sol' }],
    },
    commandcode: {
      displayName: 'Command Code',
      models: [
        { id: 'gpt-5.6-sol', reasoningEfforts: { low: 'low', max: 'max' } },
        { id: 'no-reasoning', reasoningEfforts: false },
      ],
    },
  },
}

/** The copy of the catalog the bundled tier serves. */
const BUNDLED = { source: 'models.dev' as const, origin: 'bundled' as const, entries: MODELS_DEV_ENTRIES }

/**
 * A store that answers from one tier and fetches nothing.
 *
 * Its policy is the deployment's: one policy drives both the store's selection
 * and the layer's reported state, exactly as the plugin wires them.
 * @param enabled - whether the public metadata layer answers at all.
 * @param cache - a cached entry to select, when the case wants the cache tier.
 * @returns the store.
 */
function store(enabled: boolean, cache?: CachedCatalog) {
  return createPublicCatalogStore({
    policy: () => ({ enabled, refresh: 'manual', cacheTtlMs: 1000 }),
    fetchCatalog: () => Promise.reject(new Error('no fetch may happen')),
    cache: { read: () => Promise.resolve(cache === undefined ? [] : [cache]), write: () => Promise.resolve() },
    bundled: [BUNDLED],
  })
}

/**
 * Mount the inspector over one deployment.
 * @param options - the routes, policy, and cache the mount should carry.
 * @returns the mounted service and the context owning it.
 */
async function mount(options: {
  routes?: unknown
  /** The policy section; `null` states that this deployment mounts none. */
  capability?: unknown
  cache?: CachedCatalog
} = {}): Promise<{ inspector: ModelCapabilitiesInspector; ctx: Context }> {
  const settings = options.capability === null
    ? undefined
    : options.capability ?? { publicMetadata: { enabled: true, refresh: 'manual', cacheTtl: '7d' } }
  const enabled = settings === undefined
    ? true
    : (settings as { publicMetadata: { enabled: boolean } }).publicMetadata.enabled
  const ctx = new Context()
  ctx.provide('settings', {
    get: (ns: string) => (ns === 'model-capabilities' ? settings : options.routes ?? ROUTES),
  })
  const storeHandle = store(enabled, options.cache)
  ctx.provide(MODEL_CAPABILITY_STORE_SERVICE, storeHandle)
  // The plugin reads the cache when it mounts, so a surface always reports the
  // selections of a store that has already started.
  await storeHandle.load()
  const inspector = new ModelCapabilitiesInspector(ctx)
  return { inspector, ctx }
}

/** The signal a Host-side call arrives with. */
const SIGNAL = new AbortController().signal

describe('the Models page capability read', () => {
  it('reports one entry per configured model, in configuration order', async () => {
    const { inspector, ctx } = await mount()
    const views = await inspector.remoteExportInspect(SIGNAL)
    expect(views.map(view => [view.route, view.model])).toEqual([
      ['cortex', 'gpt-5.6-sol'],
      ['commandcode', 'gpt-5.6-sol'],
      ['commandcode', 'no-reasoning'],
    ])
    await ctx.fiber.dispose()
  })

  it('answers a provider-host route from the provider entry that matched', async () => {
    const { inspector, ctx } = await mount()
    const [cortex] = await inspector.remoteExportInspect(SIGNAL)
    expect(cortex?.resolved).toEqual({
      levels: ['low', 'medium', 'high'],
      source: 'models.dev',
      provider: 'cortecs',
      match: 'provider-host',
      origin: 'bundled',
    })
    expect(cortex?.suggestions).toEqual([])
    expect(cortex?.enabled).toBe(true)
    await ctx.fiber.dispose()
  })

  it('carries the fetch time a cached answer came from', async () => {
    const { inspector, ctx } = await mount({
      cache: { source: 'models.dev', fetchedAt: '2026-09-16T12:00:00.000Z', catalog: MODELS_DEV_ENTRIES },
    })
    const [cortex] = await inspector.remoteExportInspect(SIGNAL)
    expect(cortex?.resolved).toMatchObject({
      origin: 'cache',
      fetchedAt: '2026-09-16T12:00:00.000Z',
    })
    await ctx.fiber.dispose()
  })

  it('reports an id-only claim as a suggestion and never as a capability', async () => {
    const { inspector, ctx } = await mount({
      routes: { providers: { 'openai-codex': { models: [{ id: 'gpt-6-astra' }] } } },
    })
    const [view] = await inspector.remoteExportInspect(SIGNAL)
    expect(view?.resolved).toBeUndefined()
    expect(view?.suggestions).toEqual([{ source: 'models.dev', provider: 'cortecs', levels: ['low', 'high'] }])
    await ctx.fiber.dispose()
  })

  it('reports a model no loaded catalog states as having no claim at all', async () => {
    const { inspector, ctx } = await mount({
      routes: { providers: { 'openai-codex': { models: [{ id: 'gpt-9-nothing' }] } } },
    })
    const [view] = await inspector.remoteExportInspect(SIGNAL)
    expect(view?.resolved).toBeUndefined()
    expect(view?.suggestions).toEqual([])
    await ctx.fiber.dispose()
  })

  it('reports a disabled layer as disabled rather than as an absence of claims', async () => {
    const { inspector, ctx } = await mount({
      capability: { publicMetadata: { enabled: false, refresh: 'auto', cacheTtl: '7d' } },
    })
    const views = await inspector.remoteExportInspect(SIGNAL)
    expect(views.every(view => !view.enabled)).toBe(true)
    // A disabled layer answers no catalog, so nothing resolves for any row.
    expect(views.every(view => view.resolved === undefined)).toBe(true)
    await ctx.fiber.dispose()
  })

  it('treats an absent policy section as the layer default rather than as disabled', async () => {
    const { inspector, ctx } = await mount({ capability: null, routes: ROUTES })
    const views = await inspector.remoteExportInspect(SIGNAL)
    // No settings section is mounted, so the layer serves its configured
    // default rather than reporting itself disabled.
    expect(views.every(view => view.enabled)).toBe(true)
    await ctx.fiber.dispose()
  })

  it('reports no entry for a deployment that configures no model', async () => {
    const { inspector, ctx } = await mount({ routes: { providers: {} } })
    await expect(inspector.remoteExportInspect(SIGNAL)).resolves.toEqual([])
    await ctx.fiber.dispose()
  })

  it('refuses an aborted call instead of answering late', async () => {
    const { inspector, ctx } = await mount()
    const controller = new AbortController()
    controller.abort()
    await expect(inspector.remoteExportInspect(controller.signal)).rejects.toThrow('aborted')
    await ctx.fiber.dispose()
  })

  it('projects only the fields a surface renders', async () => {
    const { inspector, ctx } = await mount()
    const [view] = await inspector.remoteExportInspect(SIGNAL)
    // The route's own settings fields and the sync decision stay on the Host:
    // a surface reads what applies to a model, not what a write would do.
    expect(Object.keys(view ?? {}).sort()).toEqual(['enabled', 'model', 'resolved', 'route', 'suggestions'])
    await ctx.fiber.dispose()
  })

  it('holds no state: two reads answer the same deployment identically', async () => {
    const { inspector, ctx } = await mount()
    const first = await inspector.remoteExportInspect(SIGNAL)
    const second = await inspector.remoteExportInspect(SIGNAL)
    expect(second).toEqual(first)
    await ctx.fiber.dispose()
  })
})

describe('the capability read against a live selection', () => {
  it('answers from whatever tier the store selected, not from a tier of its own', async () => {
    // The same deployment answered twice: a cached catalog resolves from the
    // cache, and the bundled floor resolves from the snapshot. The read has no
    // selection logic of its own to disagree with either.
    const cached = await mount({
      cache: { source: 'models.dev', fetchedAt: '2026-09-16T12:00:00.000Z', catalog: MODELS_DEV_ENTRIES },
    })
    const [fromCache] = await cached.inspector.remoteExportInspect(SIGNAL)
    await cached.ctx.fiber.dispose()

    const bundled = await mount()
    const [fromBundled] = await bundled.inspector.remoteExportInspect(SIGNAL)
    await bundled.ctx.fiber.dispose()

    expect(fromCache?.resolved?.origin).toBe('cache')
    expect(fromBundled?.resolved?.origin).toBe('bundled')
    expect(fromCache?.resolved?.levels).toEqual(fromBundled?.resolved?.levels)
  })

  it('reports the selections the mounted store holds, without reading the cache itself', async () => {
    const { inspector, ctx } = await mount()
    const selections: readonly SelectedPublicCatalog[] = ctx.get(MODEL_CAPABILITY_STORE_SERVICE)?.selections() ?? []
    // With no cache entry the store answers from its bundled floor, so the
    // layer reports a resolved capability without any fetch having happened.
    expect(selections.map(selection => selection.state)).toEqual(['bundled'])
    expect((await inspector.remoteExportInspect(SIGNAL))[0]?.enabled).toBe(true)
    await ctx.fiber.dispose()
  })
})
