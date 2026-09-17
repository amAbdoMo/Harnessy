import { describe, expect, it } from 'vitest'
import {
  bundledSnapshotMetadata,
  loadBundledPublicCatalogs,
  resolvePublicCapability,
  SNAPSHOT_SCHEMA_VERSION,
} from '@deepseek-ai/dsh-model-capabilities'

/** The providers the real capture publishes `gpt-5.6-sol` through, in catalog order. */
const SOL_PROVIDERS = [
  '302ai',
  'agentrouter',
  'ai-router',
  'aihubmix',
  'azure',
  'azure-cognitive-services',
  'cortecs',
  'github-copilot',
  'llmgateway',
  'openai',
  'opencode',
  'pioneer',
  'requesty',
  'sap-ai-core',
  'vivgrid',
  'xpersona',
]

/** Resolve one model against the bundled catalogs alone. */
function bundled(modelId: string, route: { provider?: string; baseURL?: string }) {
  return resolvePublicCapability(loadBundledPublicCatalogs(), modelId, route)
}

describe('the bundled snapshot', () => {
  it('states its schema version, generation time, and both sources', () => {
    expect(bundledSnapshotMetadata.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION)
    // An ISO 8601 UTC instant, so a reader can answer how old the capture is.
    expect(bundledSnapshotMetadata.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    for (const source of ['models.dev', 'openrouter'] as const) {
      const metadata = bundledSnapshotMetadata.sources[source]
      expect(metadata.input).toMatch(/^packages\/llm\/model-capabilities\/tests\/fixtures\/upstream\/.+\.json$/)
      expect(metadata.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(metadata.entryCount).toBeGreaterThan(0)
    }
  })

  it('carries both catalogs with the entry counts its metadata states', () => {
    const catalogs = loadBundledPublicCatalogs()
    expect(catalogs.map(catalog => catalog.source)).toEqual(['openrouter', 'models.dev'])
    expect(catalogs.map(catalog => catalog.origin)).toEqual(['bundled', 'bundled'])
    const modelsDev = catalogs[1]?.entries
    const openRouter = catalogs[0]?.entries
    expect(Object.keys(modelsDev as Record<string, unknown>).length)
      .toBe(bundledSnapshotMetadata.sources['models.dev'].entryCount)
    expect(Object.keys(openRouter as Record<string, unknown>)).toEqual(['data'])
    const data = (openRouter as { data: readonly unknown[] }).data
    expect(data.length).toBe(bundledSnapshotMetadata.sources.openrouter.entryCount)
  })

  it('is frozen through its catalogs, so no consumer can edit what a lookup reads', () => {
    expect(Object.isFrozen(bundledSnapshotMetadata)).toBe(true)
    expect(Object.isFrozen(bundledSnapshotMetadata.catalogs)).toBe(true)
    expect(Object.isFrozen(bundledSnapshotMetadata.catalogs.modelsDev)).toBe(true)
    expect(Object.isFrozen(bundledSnapshotMetadata.catalogs.modelsDev.openai)).toBe(true)
    expect(Object.isFrozen(bundledSnapshotMetadata.catalogs.openRouter.data)).toBe(true)
  })

  it('marks every catalog it hands out as bundled', () => {
    for (const catalog of loadBundledPublicCatalogs()) {
      expect(catalog.origin).toBe('bundled')
    }
  })
})

describe('resolving against the bundled snapshot', () => {
  it('matches a models.dev provider by the route endpoint host', () => {
    // `pioneer` publishes its endpoint and a narrower set than the gateways that
    // republish the same id, so the host is what decides the answer.
    expect(bundled('gpt-5.6-sol', { provider: 'unrelated-route', baseURL: 'https://api.pioneer.ai/v1' }))
      .toEqual({
        kind: 'resolved',
        capability: 'reasoning-efforts',
        levels: ['low', 'medium', 'high', 'xhigh'],
        provenance: {
          capability: 'reasoning-efforts',
          source: 'models.dev',
          match: 'provider-host',
          provider: 'pioneer',
          modelId: 'gpt-5.6-sol',
          route: 'unrelated-route',
          authoritative: true,
          origin: 'bundled',
        },
      })
  })

  it('matches a models.dev provider by the route id when the route states no endpoint', () => {
    const resolution = bundled('gpt-5.6-sol', { provider: 'cortecs' })
    expect(resolution.kind).toBe('resolved')
    expect(resolution.kind === 'resolved' ? resolution.levels : undefined)
      .toEqual(['low', 'medium', 'high'])
    expect(resolution.kind === 'resolved' ? resolution.provenance : undefined).toMatchObject({
      source: 'models.dev',
      match: 'provider-id',
      provider: 'cortecs',
      authoritative: true,
      origin: 'bundled',
    })
  })

  it('matches an OpenRouter route from OpenRouter’s own catalog', () => {
    const resolution = bundled('openai/gpt-5.6-sol', {
      provider: 'some-gateway',
      baseURL: 'https://openrouter.ai/api/v1',
    })
    expect(resolution).toEqual({
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
        route: 'some-gateway',
        authoritative: true,
        origin: 'bundled',
      },
    })
  })

  it('never declares an OpenRouter claim for a route that is not OpenRouter', () => {
    // The bundled catalog holds the claim; only the route's own identity may
    // read it, so a foreign gateway gets a suggestion at most.
    expect(bundled('openai/gpt-5.6-sol', {
      provider: 'unrelated-route',
      baseURL: 'https://api.pioneer.ai/v1',
    }).kind).toBe('unresolved')
  })
})

describe('the bundled snapshot cannot weaken the slice-1 safety rule', () => {
  it('keeps the real gpt-5.6-sol ambiguity as suggestions, choosing no provider', () => {
    // The capture publishes this id through sixteen gateways with five distinct
    // level sets. Being in the bundled database makes none of them authoritative.
    const resolution = bundled('gpt-5.6-sol', { provider: 'unlisted', baseURL: 'https://unlisted.example/v1' })
    const suggestions = resolution.kind === 'unresolved' ? resolution.suggestions : []
    expect(suggestions.map(match => match.providers[0])).toEqual(SOL_PROVIDERS)
    expect(suggestions.every(match => match.level === 'model-id-ambiguous')).toBe(true)
    expect(new Set(suggestions.map(match => match.levels.join('/')))).toEqual(new Set([
      'off/low/medium/high/xhigh/max',
      'off/low/medium/high/max',
      'low/medium/high',
      'low/medium/high/xhigh',
      'low/medium/high/xhigh/max',
    ]))
  })

  it('keeps a unique id-only claim a suggestion when the route is unknown', () => {
    // Exactly one gateway publishes these, which is the whole difference from
    // the ambiguous set above — and still not a declaration.
    const resolution = bundled('abliterated-model-large-v2', { provider: 'unlisted' })
    const suggestions = resolution.kind === 'unresolved' ? resolution.suggestions : []
    expect(suggestions.map(match => [match.providers[0], match.level, match.levels])).toEqual([
      ['abliteration-ai', 'model-id-only', ['low', 'high', 'max']],
    ])
  })

  it('normalizes a bundled claim exactly as a fixture claim, unknown tokens included', () => {
    // `ling-3.0-flash` publishes `none` alone, so the bundled claim declares
    // nothing for it, which is the same answer slice 1 gives a fixture.
    expect(bundled('ling-3.0-flash', { provider: 'llmgateway' }))
      .toEqual({ kind: 'unresolved', suggestions: [] })
  })

  it('leaves a model no bundled catalog states unresolved', () => {
    expect(bundled('never-heard-of-it', { provider: 'openai' }))
      .toEqual({ kind: 'unresolved', suggestions: [] })
  })
})
