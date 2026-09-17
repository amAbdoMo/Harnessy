import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePublicCapability } from '@deepseek-ai/dsh-model-capabilities'
import type { PublicCatalog } from '@deepseek-ai/dsh-model-capabilities'

/** The fixture directory, resolved from this spec so it works from any cwd. */
const FIXTURES = join(import.meta.dirname, 'fixtures')

/**
 * Read one captured database as the parsed document a catalog carries.
 * @param name - fixture file name.
 * @returns the parsed JSON document.
 */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown
}

/** The two public databases, most authoritative first, as a composition would load them. */
const CATALOGS: readonly PublicCatalog[] = [
  { source: 'openrouter', origin: 'fixture', entries: fixture('openrouter.json') },
  { source: 'models.dev', origin: 'fixture', entries: fixture('models-dev.json') },
]

/** One configured route, as a discovery draft states it. */
interface Route {
  readonly provider?: string
  readonly baseURL?: string
}

/**
 * Resolve one model against the captured catalogs.
 * @param modelId - the model id the route serves.
 * @param route - the configured route.
 * @returns the resolution.
 */
function resolve(modelId: string, route: Route) {
  return resolvePublicCapability(CATALOGS, modelId, route)
}

describe('models.dev provider-aware matching', () => {
  it('matches the route endpoint host, then the model id inside that provider entry', () => {
    expect(resolve('gpt-5.4', { provider: 'openai', baseURL: 'https://api.openai.com/v1' }))
      .toEqual({
        kind: 'resolved',
        capability: 'reasoning-efforts',
        levels: ['low', 'medium', 'high'],
        provenance: {
          capability: 'reasoning-efforts',
          source: 'models.dev',
          match: 'provider-host',
          provider: 'openai',
          modelId: 'gpt-5.4',
          route: 'openai',
          authoritative: true,
          origin: 'fixture',
        },
      })
  })

  it('answers for the gateway the endpoint names even when the route id names another', () => {
    // The endpoint decides: `api.anthropic.com` is Anthropic's entry, so the
    // Sonnet claim is Anthropic's, not the route id's `openai`.
    const resolution = resolve('claude-sonnet-4-6', {
      provider: 'openai',
      baseURL: 'https://api.anthropic.com/v1',
    })
    expect(resolution.kind === 'resolved' ? resolution.levels : undefined)
      .toEqual(['low', 'medium', 'high', 'max'])
    expect(resolution.kind === 'resolved' ? resolution.provenance.provider : undefined).toBe('anthropic')
  })

  it('keeps a claim that publishes an unknown token beside the levels it publishes', () => {
    expect(resolve('unusable-values', {
      provider: 'scalar-model',
      baseURL: 'https://scalar-model.example/v1',
    })).toMatchObject({ kind: 'resolved', levels: ['high'] })
  })
})

describe('endpoint host normalization', () => {
  const expected = {
    kind: 'resolved',
    capability: 'reasoning-efforts',
    levels: ['low', 'high'],
  }

  it('folds case, drops the default port, and ignores a trailing slash and path', () => {
    // The fixture states `HTTPS://API.ACME-GATEWAY.EXAMPLE:443/v1/`, so every
    // spelling below is the same gateway.
    for (const baseURL of [
      'https://api.acme-gateway.example/v1',
      'api.acme-gateway.example',
      'https://API.ACME-GATEWAY.EXAMPLE:443/v1/',
      'https://www.api.acme-gateway.example/v1',
    ]) {
      expect(resolve('acme-think', { provider: 'acme', baseURL }), baseURL).toMatchObject(expected)
    }
  })

  it('keeps a non-default port, which distinguishes one gateway from another', () => {
    const local = 'http://127.0.0.1:8080/v1'
    expect(resolve('local-think', { provider: 'local-farm', baseURL: local }))
      .toMatchObject({ kind: 'resolved', levels: ['low', 'medium'] })
    // Another port is another endpoint, so neither the host nor the route id
    // may stand in for the one the provider entry publishes.
    const elsewhere = 'http://127.0.0.1:9090/v1'
    expect(resolve('local-think', { provider: 'local-farm', baseURL: elsewhere }))
      .toEqual({
        kind: 'unresolved',
        suggestions: [{
          source: 'models.dev',
          level: 'model-id-only',
          providers: ['local-farm'],
          levels: ['low', 'medium'],
          efforts: ['low', 'medium'],
        }],
      })
  })

  it('accepts an endpoint that states no scheme and one that states only a host', () => {
    expect(resolve('aifarm-think', { provider: 'unseen', baseURL: 'aifarm.example' }))
      .toMatchObject({ kind: 'resolved', levels: ['minimal', 'high'] })
    expect(resolve('slash-think', { provider: 'unseen', baseURL: 'gateway.example' }))
      .toMatchObject({ kind: 'resolved', levels: ['medium'] })
  })

  it('compares nothing for an endpoint that cannot be parsed', () => {
    // `://` leaves no scheme for the parser to read, so the route has no host,
    // and the route id `unseen` names no provider entry either. Only the
    // id-only claim `gpt-5.4` carries survives, as a suggestion.
    expect(resolve('gpt-5.4', { provider: 'unseen', baseURL: '://broken' })).toEqual({
      kind: 'unresolved',
      suggestions: [{
        source: 'models.dev',
        level: 'model-id-only',
        providers: ['openai'],
        levels: ['low', 'medium', 'high'],
        efforts: ['low', 'medium', 'high'],
      }],
    })
  })
})

describe('models.dev provider-id matching', () => {
  it('matches the route id when the route states no endpoint', () => {
    expect(resolve('mystery-think', { provider: 'Mystery Cloud' })).toMatchObject({
      kind: 'resolved',
      levels: ['low', 'max'],
      provenance: { source: 'models.dev', match: 'provider-id', provider: 'mystery-cloud', route: 'Mystery Cloud' },
    })
  })

  it('reads a provider id the database itself leaves empty as the key it is filed under', () => {
    expect(resolve('unidentified-think', { provider: '', baseURL: 'https://unidentified.example/v1' }))
      .toMatchObject({
        kind: 'resolved',
        levels: ['low'],
        provenance: { source: 'models.dev', match: 'provider-host', provider: 'unidentified', route: '' },
      })
  })

  it('records a route that names no id at all as the empty route', () => {
    // A draft being added has an endpoint and no route id yet.
    expect(resolve('unidentified-think', { baseURL: 'https://unidentified.example/v1' }))
      .toMatchObject({ kind: 'resolved', provenance: { route: '', match: 'provider-host' } })
  })

  it('matches the route id when the endpoint cannot be read as one', () => {
    expect(resolve('mystery-think', { provider: 'mystery-cloud', baseURL: '://broken' }))
      .toMatchObject({ kind: 'resolved', provenance: { match: 'provider-id', provider: 'mystery-cloud' } })
  })

  it('does not fall back to the route id when the endpoint names a host', () => {
    // The route points somewhere unlisted, so this layer cannot show that the
    // endpoint is the provider the id spells: the id-only claim is a
    // suggestion, never `mystery-cloud`'s answer.
    expect(resolve('mystery-think', { provider: 'mystery-cloud', baseURL: 'https://unlisted.example/v1' }))
      .toEqual({
        kind: 'unresolved',
        suggestions: [{
          source: 'models.dev',
          level: 'model-id-only',
          providers: ['mystery-cloud'],
          levels: ['low', 'max'],
          efforts: ['low', 'max'],
        }],
      })
  })

  it('matches nothing when the route states neither an endpoint nor an id', () => {
    expect(resolve('mystery-think', { provider: '', baseURL: '' })).toEqual({
      kind: 'unresolved',
      suggestions: [{
        source: 'models.dev',
        level: 'model-id-only',
        providers: ['mystery-cloud'],
        levels: ['low', 'max'],
        efforts: ['low', 'max'],
      }],
    })
  })

  it('resolves nothing through models.dev when no models.dev catalog is loaded', () => {
    // Only OpenRouter is loaded here, so a route it does not own has no
    // provider-aware answer to find.
    const openRouterOnly = CATALOGS.filter(catalog => catalog.source === 'openrouter')
    expect(resolvePublicCapability(openRouterOnly, 'mystery-think', { provider: 'mystery-cloud' }))
      .toEqual({ kind: 'unresolved', suggestions: [] })
  })

  it('requires the model to belong to the matched provider entry', () => {
    // `openai` publishes no Luna; `opencode` does. A route id naming the wrong
    // provider is a suggestion at most, never that provider's answer.
    expect(resolve('gpt-5.6-luna', { provider: 'openai' }).kind).toBe('unresolved')
  })
})

describe('openrouter matching', () => {
  it('answers from its own catalog when the route endpoint is OpenRouter', () => {
    expect(resolve('openai/gpt-5.6-sol', { provider: 'some-route', baseURL: 'https://openrouter.ai/api/v1' }))
      .toEqual({
        kind: 'resolved',
        capability: 'reasoning-efforts',
        levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium',
        provenance: {
          capability: 'reasoning-efforts',
          source: 'openrouter',
          match: 'openrouter-route',
          provider: 'openrouter',
          modelId: 'openai/gpt-5.6-sol',
          route: 'some-route',
          authoritative: true,
          origin: 'fixture',
        },
      })
  })

  it('recognizes a subdomain endpoint and an OpenRouter route id', () => {
    expect(resolve('openai/gpt-5.6-sol', { provider: 'unseen', baseURL: 'https://gateway.openrouter.ai/v1' }))
      .toMatchObject({ kind: 'resolved', provenance: { match: 'openrouter-route' } })
    expect(resolve('openai/gpt-5.6-sol', { provider: 'OpenRouter' }))
      .toMatchObject({ kind: 'resolved', provenance: { match: 'openrouter-route' } })
  })

  it('never applies its metadata to another gateway serving the same model id', () => {
    // `openai/gpt-5.6-sol` is OpenRouter's own id. No models.dev entry claims
    // it, and OpenRouter's route identity is not this route's, so the claim is
    // a suggestion attributed to OpenRouter and never a capability here.
    expect(resolve('openai/gpt-5.6-sol', { provider: 'acme', baseURL: 'https://api.acme-gateway.example/v1' }))
      .toEqual({
        kind: 'unresolved',
        suggestions: [{
          source: 'openrouter',
          level: 'model-id-only',
          providers: ['openrouter'],
          levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
          efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
          defaultEffort: 'medium',
        }],
      })
  })

  it('drops a published default that names no level the claim offers', () => {
    const resolution = resolve('openai/gpt-5.4', { provider: 'openrouter', baseURL: 'https://openrouter.ai/api/v1' })
    // The fixture publishes `default_effort: "turbo"` beside `low` and `high`;
    // a default naming no offered level names nothing dispatch could send.
    expect(resolution.kind).toBe('resolved')
    expect(resolution.kind === 'resolved' ? resolution.levels : undefined).toEqual(['low', 'high'])
    expect(resolution.kind === 'resolved' ? resolution.defaultEffort : undefined).toBeUndefined()
    expect(resolution.kind === 'resolved' ? resolution.provenance : undefined)
      .toMatchObject({ source: 'openrouter', match: 'openrouter-route' })
  })

  it('matches only a route whose identity is OpenRouter, not a model id it happens to list', () => {
    // The models.dev fixture has no `openai/gpt-5.4` entry, so a non-OpenRouter
    // route finds nothing at all rather than OpenRouter's claim.
    expect(resolve('openai/gpt-5.4', { provider: 'openai', baseURL: 'https://api.openai.com/v1' }).kind)
      .toBe('unresolved')
  })
})

describe('the same model id through different providers', () => {
  it('answers each gateway with its own effort set', () => {
    const forOpenai = resolve('gpt-5.6-sol', { provider: 'openai', baseURL: 'https://api.openai.com/v1' })
    const forPioneer = resolve('gpt-5.6-sol', { provider: 'pioneer', baseURL: 'https://api.pioneer.ai/v1' })
    expect(forOpenai.kind === 'resolved' ? forOpenai.levels : undefined)
      .toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(forPioneer.kind === 'resolved' ? forPioneer.levels : undefined)
      .toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(forOpenai.kind === 'resolved' ? forOpenai.levels : undefined)
      .not.toEqual(forPioneer.kind === 'resolved' ? forPioneer.levels : undefined)
  })
})

describe('model-id-only matches are suggestions', () => {
  it('reports a unique id-only claim as a suggestion, never a capability', () => {
    // `gpt-5.4` is OpenAI's claim alone, and the route is not OpenAI.
    const resolution = resolve('gpt-5.4', { provider: 'unseen', baseURL: 'https://unlisted.example/v1' })
    expect(resolution).toEqual({
      kind: 'unresolved',
      suggestions: [{
        source: 'models.dev',
        level: 'model-id-only',
        providers: ['openai'],
        levels: ['low', 'medium', 'high'],
        efforts: ['low', 'medium', 'high'],
      }],
    })
  })

  it('reports an ambiguous id-only claim with every competing provider, choosing none', () => {
    const resolution = resolve('gpt-5.6-luna', { provider: 'unseen', baseURL: 'https://unlisted.example/v1' })
    const suggestions = resolution.kind === 'unresolved' ? resolution.suggestions : []
    expect(suggestions.map(match => [match.providers[0], match.level, match.levels])).toEqual([
      ['opencode', 'model-id-ambiguous', ['off', 'low', 'medium', 'high', 'xhigh', 'max']],
      ['routing-run', 'model-id-ambiguous', ['low', 'medium', 'high']],
    ])
  })

  it('reports every id-only claim when providers disagree about the same model id', () => {
    const resolution = resolve('gpt-5.6-sol', { provider: 'unseen', baseURL: 'https://unlisted.example/v1' })
    const suggestions = resolution.kind === 'unresolved' ? resolution.suggestions : []
    // Five entries claim this id: three state the same levels, one states a
    // narrower set, one states a set with a different ceiling, and one states
    // no levels at all. Every one of them is a suggestion, in catalog order.
    const byProvider = suggestions.map(match => [match.providers[0], match.level, match.levels])
    expect(byProvider).toHaveLength(5)
    expect(byProvider.every(([, level]) => level === 'model-id-ambiguous')).toBe(true)
    expect(byProvider.map(([provider]) => provider))
      .toEqual(['openai', 'agentrouter', 'pioneer', 'opencode', 'requesty'])
    expect(suggestions.map(match => match.levels)).toEqual([
      ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      ['low', 'medium', 'high', 'xhigh'],
      ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      ['off', 'low', 'medium', 'high', 'max'],
    ])
  })

  it('leaves a model no catalog claims unresolved', () => {
    expect(resolve('stealth/union-alpha', { provider: 'unseen', baseURL: 'https://unlisted.example/v1' }))
      .toEqual({ kind: 'unresolved', suggestions: [] })
    expect(resolve('never-heard-of-it', {})).toEqual({ kind: 'unresolved', suggestions: [] })
    // `gpt-5.6-sol` is claimed, so it is unresolved WITH suggestions — the
    // distinction from the two above, which nothing claims at all.
    const claimed = resolve('gpt-5.6-sol', { provider: 'unseen' })
    expect(claimed.kind).toBe('unresolved')
    expect(claimed.kind === 'unresolved' ? claimed.suggestions.length : 0).toBe(5)
  })

  it('resolves no model id at all when the id is empty', () => {
    expect(resolve('', { provider: 'openai', baseURL: 'https://api.openai.com/v1' }))
      .toEqual({ kind: 'unresolved', suggestions: [] })
  })
})

describe('malformed catalog entries', () => {
  it('isolates one unusable provider entry from the rest of the database', () => {
    // `malformed-provider` is null, `scalar-provider` is a string, and
    // `null-models` states no models map; each is skipped while every other
    // provider still answers.
    expect(resolve('mystery-think', { provider: 'mystery-cloud' }).kind).toBe('resolved')
    expect(resolve('gpt-5.4', { provider: 'openai', baseURL: 'https://api.openai.com/v1' }).kind).toBe('resolved')
    expect(resolve('not-a-model-entry', { provider: 'malformed-provider' })).toEqual({
      kind: 'unresolved',
      suggestions: [],
    })
  })

  it('ignores a malformed model entry safely', () => {
    // A scalar entry, an options list that is not a list, an effort option
    // whose values are not a list, and a values list of unusable members each
    // state nothing instead of failing the lookup.
    for (const modelId of ['broken-model', 'broken-options', 'broken-values']) {
      expect(resolve(modelId, { provider: 'scalar-model', baseURL: 'https://scalar-model.example/v1' }))
        .toEqual({ kind: 'unresolved', suggestions: [] })
    }
  })

  it('ignores a malformed OpenRouter entry safely', () => {
    for (const modelId of ['not-a-model-entry', 'no id at all', '']) {
      expect(resolve(modelId, { provider: 'openrouter', baseURL: 'https://openrouter.ai/api/v1' }).kind)
        .toBe('unresolved')
    }
  })

  it('ignores an OpenRouter entry whose reasoning metadata is not the published form', () => {
    const openRouter = { provider: 'openrouter', baseURL: 'https://openrouter.ai/api/v1' }
    // A reasoning field that is not an object, and a supported-efforts list of
    // members that are not tokens, each state no version this layer can read.
    expect(resolve('openai/gpt-6-astra', openRouter)).toEqual({ kind: 'unresolved', suggestions: [] })
    expect(resolve('openai/gpt-6-vega', openRouter)).toEqual({ kind: 'unresolved', suggestions: [] })
    // A reasoning object with no effort list at all states none either.
    expect(resolve('openai/gpt-6-nova', openRouter)).toEqual({ kind: 'unresolved', suggestions: [] })
    // An empty-string default names no effort, so the claim states levels and
    // no default rather than a default the harness would have to guess at.
    const terra = resolve('openai/gpt-5.6-terra', openRouter)
    expect(terra.kind).toBe('resolved')
    expect(terra.kind === 'resolved' ? terra.levels : undefined).toEqual(['low', 'high'])
    expect(terra.kind === 'resolved' ? terra.defaultEffort : undefined).toBeUndefined()
    expect(terra.kind === 'resolved' ? terra.provenance : undefined)
      .toMatchObject({ source: 'openrouter', match: 'openrouter-route' })
  })

  it('reads nothing from a document that is not the database it claims to be', () => {
    const notADatabase: readonly PublicCatalog[] = [
      { source: 'models.dev', origin: 'fixture', entries: ['openai'] },
      { source: 'openrouter', origin: 'fixture', entries: { data: 'not-a-list' } },
    ]
    expect(resolvePublicCapability(notADatabase, 'gpt-5.4', { provider: 'openai' }))
      .toEqual({ kind: 'unresolved', suggestions: [] })
    expect(resolvePublicCapability(
      [{ source: 'models.dev', origin: 'fixture', entries: null }],
      'gpt-5.4',
      { provider: 'openai' },
    )).toEqual({ kind: 'unresolved', suggestions: [] })
  })
})

describe('unknown and unusable effort tokens', () => {
  it('drops a token this build cannot dispatch without failing the claim', () => {
    // The published list is `[42, null, "", "high", "turbo"]`: the unusable
    // members and the unknown token state nothing, and `high` still answers.
    const resolution = resolve('unusable-values', {
      provider: 'scalar-model',
      baseURL: 'https://scalar-model.example/v1',
    })
    expect(resolution.kind).toBe('resolved')
    expect(resolution.kind === 'resolved' ? resolution.levels : undefined).toEqual(['high'])
    expect(resolution.kind === 'resolved' ? resolution.provenance : undefined)
      .toMatchObject({ match: 'provider-host', provider: 'scalar-model' })
  })

  it('treats a claim offering only `none` as no capability at all', () => {
    // `ling-3.0-flash` publishes `none` alone. `none` is the harness's `off`,
    // and not thinking is the parameter's absence rather than a level a
    // selector can offer, so the claim declares nothing.
    expect(resolve('ling-3.0-flash', { provider: 'opencode', baseURL: 'https://opencode.ai/zen/v1' }))
      .toEqual({ kind: 'unresolved', suggestions: [] })
  })
})
