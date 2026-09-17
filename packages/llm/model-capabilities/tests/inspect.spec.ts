import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createPublicCatalogStore, explainModelCapability, inspectModelCapability } from '@deepseek-ai/dsh-model-capabilities'
import { readDeclaration } from '../src/inspect.ts'
import type { PublicCatalog, SelectedPublicCatalog } from '@deepseek-ai/dsh-model-capabilities'

/** The reduced models.dev catalog, before a tier stamps its own origin on it. */
const MODELS_DEV_ENTRIES = {
  cortecs: {
    id: 'cortecs',
    api: 'https://api.cortecs.ai/v1',
    models: { 'gpt-5.6-sol': { id: 'gpt-5.6-sol', reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] } },
  },
}

/** The reduced OpenRouter catalog, before a tier stamps its own origin on it. */
const OPENROUTER_ENTRIES = {
  data: [{ id: 'stealth/union-alpha', reasoning: { supported_efforts: ['low', 'high'], default_effort: 'high' } }],
}

/**
 * One selection at one tier.
 *
 * The tier stamps both the origin and the fetch time on the catalog, because
 * that is where the resolver reads provenance from; the selection restates them
 * for the report.
 * @param source - the database to select.
 * @param state - the tier holding it.
 * @param fetchedAt - when the fetch that produced it completed.
 * @returns the selection.
 */
function selected(
  source: 'models.dev' | 'openrouter',
  state: SelectedPublicCatalog['state'],
  fetchedAt?: string,
): SelectedPublicCatalog {
  const entries = source === 'models.dev' ? MODELS_DEV_ENTRIES : OPENROUTER_ENTRIES
  const catalog: PublicCatalog = { source, origin: state, entries, ...fetchedAt === undefined ? {} : { fetchedAt } }
  return { state, catalog, ...fetchedAt === undefined ? {} : { fetchedAt } }
}

describe('reading a declaration', () => {
  it('reads an explicit level set in its stated order', () => {
    expect(readDeclaration({ reasoningEfforts: { low: 'low', high: 'high', max: 'max' } }))
      .toEqual({ declaresNoReasoning: false, efforts: ['low', 'high', 'max'] })
  })

  it('distinguishes a row that refuses reasoning from one that inherits', () => {
    expect(readDeclaration({ reasoningEfforts: false })).toEqual({ declaresNoReasoning: true })
    expect(readDeclaration({})).toEqual({ declaresNoReasoning: false })
    expect(readDeclaration(undefined)).toEqual({ declaresNoReasoning: false })
    // Values that are not a level mapping state no declaration this layer reads.
    expect(readDeclaration({ reasoningEfforts: {} })).toEqual({ declaresNoReasoning: false })
    expect(readDeclaration({ reasoningEfforts: 'low' })).toEqual({ declaresNoReasoning: false })
    expect(readDeclaration({ reasoningEfforts: ['low'] })).toEqual({ declaresNoReasoning: false })
    expect(readDeclaration('scalar')).toEqual({ declaresNoReasoning: false })
    expect(readDeclaration([])).toEqual({ declaresNoReasoning: false })
  })
})

describe('explaining one route-qualified model', () => {
  it('answers a models.dev provider-host route from the tier that holds it', () => {
    const explanation = explainModelCapability(
      [selected('models.dev', 'bundled')],
      { route: 'cortex', model: 'gpt-5.6-sol' },
      { baseURL: 'https://api.cortecs.ai/v1' },
    )
    expect(explanation.resolved).toMatchObject({
      levels: ['low', 'medium', 'high'],
      source: 'models.dev',
      provider: 'cortecs',
      match: 'provider-host',
      origin: 'bundled',
    })
    expect(explanation.tiers.map(tier => [tier.tier, tier.state])).toEqual([
      ['live', 'no-catalog'],
      ['cache', 'no-catalog'],
      ['bundled', 'answered'],
    ])
    expect(explanation.suggestions).toEqual([])
  })

  it('answers a models.dev provider-id route, carrying the fetch time of the tier that answered', () => {
    const explanation = explainModelCapability(
      [selected('models.dev', 'cache', '2026-09-16T12:00:00.000Z')],
      { route: 'cortecs', model: 'gpt-5.6-sol' },
    )
    expect(explanation.resolved).toMatchObject({
      levels: ['low', 'medium', 'high'],
      match: 'provider-id',
      origin: 'cache',
      fetchedAt: '2026-09-16T12:00:00.000Z',
    })
    expect(explanation.tiers[1]).toMatchObject({ tier: 'cache', state: 'answered', fetchedAt: '2026-09-16T12:00:00.000Z' })
  })

  it('answers an OpenRouter route from the OpenRouter catalog only', () => {
    const onOpenRouter = explainModelCapability(
      [selected('openrouter', 'live', '2026-09-16T12:00:00.000Z')],
      { route: 'openrouter-live', model: 'stealth/union-alpha' },
      { baseURL: 'https://openrouter.ai/api/v1' },
    )
    expect(onOpenRouter.resolved).toMatchObject({
      levels: ['low', 'high'],
      defaultEffort: 'high',
      source: 'openrouter',
      match: 'openrouter-route',
      origin: 'live',
    })
    // The same model through a gateway that is not OpenRouter is not answered
    // by OpenRouter's catalog: the id is reported as a claim and nothing more.
    const elsewhere = explainModelCapability(
      [selected('openrouter', 'live')],
      { route: 'other-gateway', model: 'stealth/union-alpha' },
      { baseURL: 'https://api.other.example/v1' },
    )
    expect(elsewhere.resolved).toBeUndefined()
    expect(elsewhere.suggestions).toEqual([{ source: 'openrouter', provider: 'openrouter', levels: ['low', 'high'] }])
  })

  it('reports a live tier that answered ahead of the cache and bundled tiers', () => {
    const explanation = explainModelCapability(
      [
        selected('models.dev', 'live', '2026-09-16T12:00:00.000Z'),
        selected('models.dev', 'cache', '2026-09-01T12:00:00.000Z'),
        selected('models.dev', 'bundled'),
      ],
      { route: 'cortex', model: 'gpt-5.6-sol' },
      { baseURL: 'https://api.cortecs.ai/v1' },
    )
    expect(explanation.resolved).toMatchObject({ origin: 'live', fetchedAt: '2026-09-16T12:00:00.000Z' })
    expect(explanation.tiers.map(tier => [tier.tier, tier.state])).toEqual([
      ['live', 'answered'],
      ['cache', 'not-matched'],
      ['bundled', 'not-matched'],
    ])
  })

  it('reports a tier that holds a catalog but does not name the route', () => {
    const explanation = explainModelCapability(
      [selected('openrouter', 'cache', '2026-09-16T12:00:00.000Z')],
      { route: 'cortex', model: 'gpt-5.6-sol' },
    )
    expect(explanation.resolved).toBeUndefined()
    expect(explanation.tiers[1]).toEqual({ tier: 'cache', state: 'not-matched', fetchedAt: '2026-09-16T12:00:00.000Z' })
  })

  it('reports an id-only claim as a suggestion and never as a capability', () => {
    const explanation = explainModelCapability(
      [selected('models.dev', 'bundled')],
      { route: 'openai-codex', model: 'gpt-5.6-sol' },
    )
    expect(explanation.resolved).toBeUndefined()
    expect(explanation.suggestions).toEqual([{ source: 'models.dev', provider: 'cortecs', levels: ['low', 'medium', 'high'] }])
    expect(explanation.tiers[2]).toEqual({ tier: 'bundled', state: 'not-matched' })
  })

  it('answers nothing when the layer holds no catalog', () => {
    const explanation = explainModelCapability([], { route: 'cortex', model: 'gpt-5.6-sol' })
    expect(explanation.resolved).toBeUndefined()
    expect(explanation.tiers.every(tier => tier.state === 'no-catalog')).toBe(true)
  })
})

describe('inspecting a configured model', () => {
  it('writes a provider-aware match onto a row that declares nothing', () => {
    const inspection = inspectModelCapability(
      [selected('models.dev', 'bundled')],
      { route: 'cortex', model: 'gpt-5.6-sol' },
      { baseURL: 'https://api.cortecs.ai/v1' },
      { id: 'gpt-5.6-sol', name: 'Sol' },
    )
    expect(inspection.decision).toBe('write')
    expect(inspection.write).toEqual({ levels: ['low', 'medium', 'high'] })
  })

  it('keeps an existing declaration, whatever the public catalogs state', () => {
    const declared = inspectModelCapability(
      [selected('models.dev', 'bundled')],
      { route: 'cortex', model: 'gpt-5.6-sol' },
      { baseURL: 'https://api.cortecs.ai/v1' },
      { reasoningEfforts: { low: 'low' } },
    )
    expect(declared.decision).toBe('declared')
    expect(declared.write).toBeUndefined()

    const refused = inspectModelCapability(
      [selected('models.dev', 'bundled')],
      { route: 'cortex', model: 'gpt-5.6-sol' },
      { baseURL: 'https://api.cortecs.ai/v1' },
      { reasoningEfforts: false },
    )
    expect(refused.decision).toBe('declared')
  })

  it('never writes a model-id-only claim', () => {
    const inspection = inspectModelCapability(
      [selected('models.dev', 'bundled')],
      { route: 'openai-codex', model: 'gpt-5.6-sol' },
      {},
      { id: 'gpt-5.6-sol' },
    )
    expect(inspection.decision).toBe('suggestion')
    expect(inspection.write).toBeUndefined()
  })

  it('reports a model no catalog states as unresolved', () => {
    const inspection = inspectModelCapability(
      [selected('models.dev', 'bundled')],
      { route: 'openai-codex', model: 'gpt-6-astra' },
      {},
      { id: 'gpt-6-astra' },
    )
    expect(inspection.decision).toBe('unresolved')
  })
})

describe('the store the commands read', () => {
  it('is the same operation the capability source answers from', async () => {
    const ctx = new Context()
    const store = createPublicCatalogStore({
      policy: () => ({ enabled: true, refresh: 'manual', cacheTtlMs: 1000 }),
      fetchCatalog: () => Promise.resolve({ source: 'models.dev', catalog: undefined }),
      cache: { read: () => Promise.resolve([]), write: () => Promise.resolve() },
    })
    ctx.provide('modelCapabilities', store)
    await store.load()
    const selections = ctx.get('modelCapabilities')?.selections() ?? []
    // The layer is enabled with no cache, so the bundled snapshot is the answer
    // the store hands both the seam and a diagnostics command.
    expect(selections.length).toBeGreaterThan(0)
    expect(selections.every(selection => selection.state === 'bundled')).toBe(true)
    await ctx.fiber.dispose()
  })
})
