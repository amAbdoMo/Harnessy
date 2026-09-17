import { describe, expect, it } from 'vitest'
import * as api from '@deepseek-ai/dsh-model-capabilities'
import { createPublicCapabilitySource } from '@deepseek-ai/dsh-model-capabilities'
import type { PublicCatalog } from '@deepseek-ai/dsh-model-capabilities'

/** A minimal catalog whose one provider states one effort list. */
const CATALOG: PublicCatalog = {
  source: 'models.dev',
  origin: 'bundled',
  entries: {
    acme: {
      id: 'acme',
      api: 'https://api.acme.example/v1',
      models: {
        'acme-think': {
          id: 'acme-think',
          reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }],
        },
      },
    },
  },
}

describe('the package public API', () => {
  it('exports the resolution layer and its normalization vocabulary', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CACHE_SCHEMA_VERSION',
      'CAPABILITY_SOURCE_NAME',
      'MAX_CACHE_TTL_MS',
      'MAX_CATALOG_RESPONSE_BYTES',
      'MODEL_CAPABILITIES_DEFAULTS',
      'MODEL_CAPABILITIES_NAMESPACE',
      'MODEL_CAPABILITY_STORE_SERVICE',
      'ModelCapabilitiesConfigSchema',
      'PUBLIC_CATALOG_CACHE_PATH',
      'PUBLIC_CATALOG_ENDPOINTS',
      'PUBLIC_CATALOG_SOURCES',
      'SNAPSHOT_SCHEMA_VERSION',
      'assertServiceableConfig',
      'buildSnapshot',
      'bundledSnapshotMetadata',
      'capabilityInspectionViews',
      'catalogFromResponse',
      'createPublicCapabilitySource',
      'createPublicCatalogCache',
      'createPublicCatalogStore',
      'curateModelsDevCatalog',
      'curateOpenRouterCatalog',
      'declaredCapabilityFields',
      'explainModelCapability',
      'fetchPublicCatalog',
      'inspectConfiguredModels',
      'inspectModelCapability',
      'loadBundledPublicCatalogs',
      'normalizeDefaultEffort',
      'normalizeEfforts',
      'normalizeProviderId',
      'normalizeRouteHost',
      'openRouterRouteProvider',
      'parseCacheTtl',
      'parseSnapshot',
      'readConfiguredRoutes',
      'resolvePolicy',
      'resolvePublicCapability',
      'routeHostKey',
    ])
  })

  it('states the level vocabulary a sync writes in the profile schema spelling', () => {
    expect(api.declaredCapabilityFields(['low', 'off', 'high'], 'off'))
      .toEqual({ reasoningEfforts: { low: 'low', off: null, high: 'high' }, defaultReasoningEffort: 'off' })
    // A default a source invented is not one of the levels, so it is dropped
    // rather than written beside a set it does not name.
    expect(api.declaredCapabilityFields(['low'], 'max')).toEqual({ reasoningEfforts: { low: 'low' } })
    // No level at all is no declaration, which is what keeps an empty claim out.
    expect(api.declaredCapabilityFields([], undefined)).toEqual({})
  })

  it('builds a capability with the default only when it names a stated level', () => {
    const source = createPublicCapabilitySource([CATALOG])
    expect(source('acme-think', { provider: 'acme', baseURL: 'https://api.acme.example/v1' }))
      .toEqual({ reasoningEfforts: ['off', 'low', 'high'] })
    expect(source('acme-think', { provider: 'unseen' })).toBeUndefined()
  })

  it('carries the catalog origin into provenance', () => {
    const resolution = api.resolvePublicCapability([CATALOG], 'acme-think', { provider: 'acme' })
    expect(resolution).toMatchObject({
      kind: 'resolved',
      provenance: { origin: 'bundled', authoritative: true, route: 'acme', modelId: 'acme-think' },
    })
  })

  it('carries a published default into the capability it builds', () => {
    const catalog: PublicCatalog = {
      source: 'openrouter',
      origin: 'live',
      entries: {
        data: [{
          id: 'openai/gpt-5.6-sol',
          reasoning: { supported_efforts: ['none', 'high'], default_effort: 'none' },
        }],
      },
    }
    expect(createPublicCapabilitySource([catalog])('openai/gpt-5.6-sol', { provider: 'openrouter' }))
      .toEqual({ reasoningEfforts: ['off', 'high'], defaultReasoningEffort: 'off' })
  })

  it('resolves nothing when no catalog is loaded at all', () => {
    expect(createPublicCapabilitySource([])('acme-think', { provider: 'acme' })).toBeUndefined()
    expect(api.resolvePublicCapability([], 'acme-think', { provider: 'acme' }))
      .toEqual({ kind: 'unresolved', suggestions: [] })
  })
})
