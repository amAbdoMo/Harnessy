import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createPublicCatalogStore } from '@deepseek-ai/dsh-model-capabilities'
import type { ConfiguredRoute, ConfiguredModelRow } from '@deepseek-ai/dsh-model-capabilities'
import { evaluateCommand, parseTarget, readCliPolicy, writableSection } from '../src/cli.ts'
import { readConfiguredRoutes } from '../src/inspect.ts'
import { registerTestStore } from './cli-test-support.ts'

describe('route-qualified identity', () => {
  it('splits the route from the model', () => {
    expect(parseTarget('openai-codex/gpt-5.6-sol')).toEqual({ route: 'openai-codex', model: 'gpt-5.6-sol' })
    // The model id keeps its own separators; only the first one delimits.
    expect(parseTarget('openrouter-live/stealth/union-alpha')).toEqual({
      route: 'openrouter-live',
      model: 'stealth/union-alpha',
    })
  })

  it('refuses an argument that is not route-qualified', () => {
    expect(parseTarget('gpt-5.6-sol')).toBeUndefined()
    expect(parseTarget('/gpt-5.6-sol')).toBeUndefined()
    expect(parseTarget('openai-codex/')).toBeUndefined()
    expect(parseTarget('')).toBeUndefined()
  })
})

describe('the effective policy', () => {
  it('reads the defaults the plugin states', () => {
    expect(readCliPolicy({
      publicMetadata: { enabled: true, refresh: 'auto', cacheTtl: '7d' },
    })).toEqual({ enabled: true, refresh: 'auto', cacheTtlMs: 604_800_000 })
  })

  it('refuses a section it cannot act on', () => {
    expect(readCliPolicy(undefined)).toBeUndefined()
    expect(readCliPolicy('scalar')).toBeUndefined()
    expect(readCliPolicy({})).toBeUndefined()
    expect(readCliPolicy({ publicMetadata: undefined })).toBeUndefined()
    expect(readCliPolicy({ publicMetadata: { refresh: 'auto', cacheTtl: '7d' } })).toBeUndefined()
    expect(readCliPolicy({ publicMetadata: { enabled: true, refresh: 'sometimes', cacheTtl: '7d' } })).toBeUndefined()
    expect(readCliPolicy({ publicMetadata: { enabled: true, refresh: 'auto' } })).toBeUndefined()
    // A hand-edited duration the grammar cannot read is no policy at all.
    expect(readCliPolicy({ publicMetadata: { enabled: true, refresh: 'auto', cacheTtl: 'weekly' } })).toBeUndefined()
  })
})

describe('the configured routes', () => {
  it('reads every route and the models it lists', () => {
    const routes = readConfiguredRoutes({
      providers: {
        cortex: {
          baseURL: 'https://api.cortecs.ai/v1',
          models: [{ id: 'gpt-5.6-sol', name: 'Sol' }, { id: 'gpt-5.6-terra' }],
        },
        'openai-codex': { models: [{ id: 'gpt-6-astra' }] },
      },
    })
    expect(routes.map((route: ConfiguredRoute) => route.route)).toEqual(['cortex', 'openai-codex'])
    expect(routes[0]?.models.map((model: ConfiguredModelRow) => model.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra'])
    expect(routes[0]?.profile.baseURL).toBe('https://api.cortecs.ai/v1')
  })

  it('states nothing for a document that is not the documented shape', () => {
    expect(readConfiguredRoutes(undefined)).toEqual([])
    expect(readConfiguredRoutes([])).toEqual([])
    expect(readConfiguredRoutes({})).toEqual([])
    expect(readConfiguredRoutes({ providers: 'scalar' })).toEqual([])
    expect(readConfiguredRoutes({ providers: { cortex: 'scalar' } })).toEqual([])
    expect(readConfiguredRoutes({ providers: { cortex: {} } })).toEqual([
      { route: 'cortex', profile: {}, models: [] },
    ])
    expect(readConfiguredRoutes({ providers: { cortex: { models: ['scalar', { id: '' }, { name: 'x' }] } } }))
      .toEqual([{ route: 'cortex', profile: { models: ['scalar', { id: '' }, { name: 'x' }] }, models: [] }])
  })
})

describe('the writable section', () => {
  it('restates the whole models list with only the writable rows changed', () => {
    const routes = readConfiguredRoutes({
      providers: {
        cortex: {
          baseURL: 'https://api.cortecs.ai/v1',
          models: [{ id: 'gpt-5.6-sol', name: 'Sol', contextWindow: 272_000 }, { id: 'other', name: 'Other' }],
        },
        untouched: { models: [{ id: 'kept' }] },
      },
    })
    const section = writableSection(routes, [{
      route: 'cortex',
      model: 'gpt-5.6-sol',
      routeProfile: routes[0]?.profile ?? {},
      declared: { declaresNoReasoning: false },
      chain: { route: 'cortex', model: 'gpt-5.6-sol', declared: { declaresNoReasoning: false }, tiers: [], suggestions: [] },
      decision: 'write',
      write: { levels: ['low', 'off'], defaultEffort: 'low' },
    }])
    expect(section).toEqual({
      providers: {
        cortex: {
          baseURL: 'https://api.cortecs.ai/v1',
          models: [
            {
              id: 'gpt-5.6-sol',
              name: 'Sol',
              contextWindow: 272_000,
              reasoningEfforts: { low: 'low', off: null },
              defaultReasoningEffort: 'low',
            },
            { id: 'other', name: 'Other' },
          ],
        },
      },
    })
  })

  it('states nothing when no row is writable', () => {
    expect(writableSection([], [])).toEqual({})
  })
})

describe('the command', () => {
  /**
   * One command invocation with both streams captured.
   * @param options - the flags to run with.
   * @param settings - what the settings service resolves, keyed by namespace.
   * @param store - the catalog store to publish, or undefined for none.
   * @returns the exit code, stdout, stderr, and the store's refresh calls.
   */
  async function run(
    options: { modelsSync?: string; modelsExplain?: string; modelsRefresh?: boolean },
    settings: Readonly<Record<string, unknown>> = {},
    store?: ReturnType<typeof createPublicCatalogStore>,
  ): Promise<{ code: number; out: string; err: string; refreshes: number }> {
    const ctx = new Context()
    const refreshes = { count: 0 }
    const catalog = store ?? createPublicCatalogStore({
      policy: () => ({ enabled: true, refresh: 'manual', cacheTtlMs: 1000 }),
      fetchCatalog: (source, signal) => {
        refreshes.count += 1
        return Promise.reject(new Error(`no fetch may happen: ${source} ${String(signal.aborted)}`))
      },
      cache: { read: () => Promise.resolve([]), write: () => Promise.resolve() },
    })
    ctx.provide('settings', {
      get: (ns: string) => settings[ns],
      update: () => Promise.resolve(),
    })
    registerTestStore(ctx, catalog)
    let out = ''
    let err = ''
    const code = await evaluateCommand(ctx, options, (text) => { out += text }, (text) => { err += text })
    await ctx.fiber.dispose()
    return { code, out, err, refreshes: refreshes.count }
  }

  it('reports a disabled layer instead of silently bypassing the policy', async () => {
    const { code, out, refreshes } = await run({ modelsSync: 'check' }, {
      'model-capabilities': { publicMetadata: { enabled: false, refresh: 'auto', cacheTtl: '7d' } },
      'llm-pi-ai': { providers: { cortex: { models: [{ id: 'gpt-5.6-sol' }] } } },
    })
    expect(code).toBe(0)
    expect(out).toContain('public metadata is disabled')
    expect(out).not.toContain('gpt-5.6-sol')
    expect(refreshes).toBe(0)
  })

  it('refuses an explicit refresh under "never" and fetches nothing', async () => {
    const { code, out, err, refreshes } = await run({ modelsSync: 'check', modelsRefresh: true }, {
      'model-capabilities': { publicMetadata: { enabled: true, refresh: 'never', cacheTtl: '7d' } },
      'llm-pi-ai': { providers: {} },
    })
    expect(code).toBe(1)
    expect(err).toContain('refresh is "never"')
    expect(out).toBe('')
    expect(refreshes).toBe(0)
  })

  it('permits an explicit refresh under "manual" and reports what it fetched', async () => {
    const ctx = new Context()
    let refreshes = 0
    // `manual` is why nothing fetched automatically at mount; the explicit
    // request is the one path that reaches the fetcher.
    const store = createPublicCatalogStore({
      policy: () => ({ enabled: true, refresh: 'auto', cacheTtlMs: 1000 }),
      fetchCatalog: (source) => {
        refreshes += 1
        return Promise.resolve({ source, catalog: undefined })
      },
      cache: { read: () => Promise.resolve([]), write: () => Promise.resolve() },
    })
    ctx.provide('settings', {
      get: (ns: string) => (ns === 'model-capabilities'
        ? { publicMetadata: { enabled: true, refresh: 'manual', cacheTtl: '7d' } }
        : { providers: {} }),
    })
    registerTestStore(ctx, store)
    let out = ''
    const err = { text: '' }
    const code = await evaluateCommand(ctx, { modelsSync: 'check', modelsRefresh: true }, (text) => { out += text }, (text) => { err.text += text })
    await ctx.fiber.dispose()
    expect(code).toBe(0)
    expect(err.text).toBe('')
    // One request per public database is what "the user asked to refresh" means.
    expect(refreshes).toBe(2)
    expect(out).toContain('no models are configured')
  })

  it('does not fetch when the invocation did not ask for a refresh', async () => {
    const ctx = new Context()
    let refreshes = 0
    const store = createPublicCatalogStore({
      policy: () => ({ enabled: true, refresh: 'auto', cacheTtlMs: 1000 }),
      fetchCatalog: (source) => {
        refreshes += 1
        return Promise.resolve({ source, catalog: undefined })
      },
      cache: { read: () => Promise.resolve([]), write: () => Promise.resolve() },
    })
    ctx.provide('settings', {
      get: (ns: string) => (ns === 'model-capabilities'
        ? { publicMetadata: { enabled: true, refresh: 'manual', cacheTtl: '7d' } }
        : { providers: {} }),
    })
    registerTestStore(ctx, store)
    const code = await evaluateCommand(ctx, { modelsSync: 'check' }, () => {}, () => {})
    await ctx.fiber.dispose()
    expect(code).toBe(0)
    expect(refreshes).toBe(0)
  })

  it('fails a malformed --models-explain argument as a usage error', async () => {
    const { code, err } = await run({ modelsExplain: 'gpt-5.6-sol' }, {
      'model-capabilities': { publicMetadata: { enabled: true, refresh: 'auto', cacheTtl: '7d' } },
    })
    expect(code).toBe(1)
    expect(err).toContain('needs a <route>/<model> argument')
  })

  it('fails a malformed --models-sync mode as a usage error', async () => {
    const { code, err } = await run({ modelsSync: 'sometimes' }, {
      'model-capabilities': { publicMetadata: { enabled: true, refresh: 'auto', cacheTtl: '7d' } },
    })
    expect(code).toBe(1)
    expect(err).toContain('needs "check" or "write"')
  })

  it('does nothing when no flag asked for anything', async () => {
    const { code, out, err } = await run({}, {
      'model-capabilities': { publicMetadata: { enabled: true, refresh: 'auto', cacheTtl: '7d' } },
    })
    expect(code).toBe(0)
    expect(out).toBe('')
    expect(err).toBe('')
  })

  it('reports an unreadable policy as disabled rather than guessing', async () => {
    const { code, out } = await run({ modelsSync: 'check' }, {})
    expect(code).toBe(0)
    expect(out).toContain('public metadata is disabled')
  })
})
