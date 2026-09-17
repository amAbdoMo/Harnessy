import { describe, expect, it } from 'vitest'
import {
  buildSnapshot,
  curateModelsDevCatalog,
  curateOpenRouterCatalog,
  parseSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
} from '@deepseek-ai/dsh-model-capabilities'

/** One raw models.dev capture: the published field names the generator reads. */
const RAW_MODELS_DEV = {
  zeta: {
    id: 'zeta',
    name: 'Zeta',
    env: ['ZETA_API_KEY'],
    npm: '@ai-sdk/zeta',
    api: 'https://api.zeta.example/v1',
    doc: 'https://docs.zeta.example',
    models: {
      'z-sol': {
        id: 'z-sol',
        name: 'Z Sol',
        description: 'A model',
        family: 'z',
        attachment: true,
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 1000, output: 100 },
        cost: { input: 1, output: 2 },
      },
      'z-toggler': {
        id: 'z-toggler',
        reasoning_options: [{ type: 'toggle' }],
      },
    },
  },
  alpha: {
    id: 'alpha',
    api: 'https://api.alpha.example/v1',
    models: {
      'a-none-only': { id: 'a-none-only', reasoning_options: [{ type: 'effort', values: ['none'] }] },
      'a-mixed': {
        id: 'a-mixed',
        reasoning_options: [
          { type: 'budget_tokens' },
          { type: 'effort', values: ['none', 'low', 'turbo'] },
        ],
      },
      'a-empty': { id: 'a-empty', reasoning_options: [{ type: 'effort', values: [] }] },
    },
  },
}

/** One raw OpenRouter capture. */
const RAW_OPEN_ROUTER = {
  data: [
    { id: 'vendor/b', name: 'B', context_length: 1, pricing: { prompt: '0' }, reasoning: { supported_efforts: ['high', 'low'], default_effort: 'high' } },
    { id: 'vendor/a', reasoning: { supported_efforts: ['none', 'turbo'] } },
    { id: 'vendor/empty', reasoning: { supported_efforts: [] } },
    { id: 'vendor/no-default', reasoning: { supported_efforts: ['medium'], default_effort: '' } },
  ],
}

/** A timestamp the tests pin, so a build is reproducible. */
const GENERATED_AT = '2026-09-16T00:00:00.000Z'

/** The inputs one build consumes, with digests the tests state themselves. */
const INPUTS = {
  modelsDevInput: 'tests/fixtures/models-dev.json',
  modelsDevSource: RAW_MODELS_DEV,
  modelsDevDigest: 'a'.repeat(64),
  openRouterInput: 'tests/fixtures/openrouter.json',
  openRouterSource: RAW_OPEN_ROUTER,
  openRouterDigest: 'b'.repeat(64),
}

describe('curating a models.dev capture', () => {
  it('keeps the provider identity, its endpoint, and its effort claims', () => {
    const { catalog, skipped } = curateModelsDevCatalog(RAW_MODELS_DEV)
    expect(Object.keys(catalog)).toEqual(['alpha', 'zeta'])
    expect(catalog.zeta).toEqual({
      id: 'zeta',
      api: 'https://api.zeta.example/v1',
      models: {
        'z-sol': { id: 'z-sol', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
      },
    })
    // `z-toggler` states no effort control, so it is skipped rather than
    // recorded as offering nothing.
    expect(skipped).toBe(1)
  })

  it('orders providers and models ascending, whatever order the capture stated', () => {
    const catalog = curateModelsDevCatalog({
      mike: { id: 'mike', models: { zebra: { reasoning_options: [{ type: 'effort', values: ['low'] }] }, alpha: { reasoning_options: [{ type: 'effort', values: ['low'] }] } } },
      alpha: { id: 'alpha', models: { only: { reasoning_options: [{ type: 'effort', values: ['low'] }] } } },
    })
    expect(Object.keys(catalog.catalog)).toEqual(['alpha', 'mike'])
    expect(Object.keys(catalog.catalog.mike?.models ?? {})).toEqual(['alpha', 'zebra'])
  })

  it('excludes every upstream field this layer does not resolve', () => {
    const encoded = JSON.stringify(curateModelsDevCatalog(RAW_MODELS_DEV).catalog)
    for (const field of ['env', 'npm', 'doc', 'family', 'attachment', 'tool_call', 'modalities', 'limit', 'cost', 'description']) {
      expect(encoded).not.toContain(`"${field}"`)
    }
    // What it does keep: the identity, the endpoint, and the claim.
    expect(encoded).toContain('"api"')
    expect(encoded).toContain('"reasoning_options"')
  })

  it('preserves raw published tokens, the unknown ones included', () => {
    // `turbo` is not a level this build dispatches, and the snapshot still
    // carries it so provenance can explain what was dropped.
    expect(curateModelsDevCatalog(RAW_MODELS_DEV).catalog.alpha?.models['a-mixed']?.reasoning_options)
      .toEqual([{ type: 'effort', values: ['none', 'low', 'turbo'] }])
  })

  it('keeps a claim whose tokens are all unusable as the empty list it published', () => {
    const catalog = curateModelsDevCatalog(RAW_MODELS_DEV).catalog
    expect(catalog.alpha?.models['a-empty']?.reasoning_options).toEqual([{ type: 'effort', values: [] }])
    expect(catalog.alpha?.models['a-none-only']?.reasoning_options).toEqual([{ type: 'effort', values: ['none'] }])
  })

  it('falls back to the key a provider is filed under when it states no id', () => {
    const catalog = curateModelsDevCatalog({
      filed: { models: { m: { reasoning_options: [{ type: 'effort', values: ['low'] }] } } },
      'empty-id': { id: '', models: { m: { reasoning_options: [{ type: 'effort', values: ['low'] }] } } },
    }).catalog
    expect(Object.keys(catalog)).toEqual(['empty-id', 'filed'])
    expect(catalog.filed?.id).toBe('filed')
    expect(catalog['empty-id']?.id).toBe('empty-id')
  })

  it('isolates malformed rows instead of failing the database', () => {
    const catalog = curateModelsDevCatalog({
      'not-an-object': 'scalar',
      'no-models': { id: 'no-models' },
      'models-not-a-map': { id: 'models-not-a-map', models: 'scalar' },
      'all-models-malformed': { id: 'all-models-malformed', models: { one: 42, two: null, three: { reason: true } } },
      'no-api': { id: 'no-api', models: { ok: { reasoning_options: [{ type: 'effort', values: ['low'] }] } } },
    })
    expect(Object.keys(catalog.catalog)).toEqual(['no-api'])
    expect(catalog.catalog['no-api']?.api).toBeUndefined()
    // Four provider entries and three model entries stated nothing usable.
    expect(catalog.skipped).toBe(7)
  })

  it('skips an effort control whose values are not a list at all', () => {
    const catalog = curateModelsDevCatalog({
      raw: { models: { m: { reasoning_options: [{ type: 'effort' }] } } },
    })
    expect(catalog.catalog).toEqual({})
    expect(catalog.skipped).toBe(2)
  })

  it('reads a document that is not an object as an empty catalog', () => {
    for (const value of [undefined, null, 42, 'text', ['zeta']]) {
      expect(curateModelsDevCatalog(value)).toEqual({ catalog: {}, skipped: 0 })
    }
  })

  it('reads the curated input form as the same catalog', () => {
    // The committed input keeps the tokens alone, so re-curating a fresh
    // capture and generating from the committed input are the same derivation.
    expect(curateModelsDevCatalog({
      providers: { zeta: { api: 'https://api.zeta.example/v1', models: { 'z-sol': ['low', 'high'] } } },
    }).catalog).toEqual({ zeta: curateModelsDevCatalog(RAW_MODELS_DEV).catalog.zeta })
  })
})

describe('curating an OpenRouter capture', () => {
  it('keeps the model id, its effort list, and its default', () => {
    const { catalog, skipped } = curateOpenRouterCatalog(RAW_OPEN_ROUTER)
    expect(catalog.data).toEqual([
      { id: 'vendor/a', reasoning: { supported_efforts: ['none', 'turbo'] } },
      { id: 'vendor/b', reasoning: { supported_efforts: ['high', 'low'], default_effort: 'high' } },
      { id: 'vendor/empty', reasoning: { supported_efforts: [] } },
      { id: 'vendor/no-default', reasoning: { supported_efforts: ['medium'] } },
    ])
    expect(skipped).toBe(0)
  })

  it('orders models by id, whatever order the capture listed them', () => {
    expect(curateOpenRouterCatalog(RAW_OPEN_ROUTER).catalog.data.map(model => model.id))
      .toEqual(['vendor/a', 'vendor/b', 'vendor/empty', 'vendor/no-default'])
  })

  it('excludes every upstream field this layer does not resolve', () => {
    const encoded = JSON.stringify(curateOpenRouterCatalog(RAW_OPEN_ROUTER).catalog)
    for (const field of ['name', 'context_length', 'pricing', 'architecture', 'top_provider']) {
      expect(encoded).not.toContain(`"${field}"`)
    }
    expect(encoded).toContain('"supported_efforts"')
  })

  it('preserves raw published tokens, the unknown ones included', () => {
    const mixed = curateOpenRouterCatalog(RAW_OPEN_ROUTER).catalog.data
    expect(mixed.find(model => model.id === 'vendor/a')?.reasoning.supported_efforts)
      .toEqual(['none', 'turbo'])
  })

  it('omits a default that names no token at all', () => {
    const stated = curateOpenRouterCatalog(RAW_OPEN_ROUTER).catalog.data
    expect(stated.find(model => model.id === 'vendor/no-default')?.reasoning).toEqual({ supported_efforts: ['medium'] })
  })

  it('isolates malformed rows instead of failing the catalog', () => {
    const catalog = curateOpenRouterCatalog({
      data: [
        'scalar',
        'reasoning-not-an-object',
        { name: 'no id', reasoning: { supported_efforts: ['low'] } },
        { id: '', reasoning: { supported_efforts: ['low'] } },
        { id: 'no-reasoning' },
        { id: 'reasoning-not-an-object', reasoning: 'scalar' },
        { id: 'no-list', reasoning: { supported_efforts: 'low' } },
        { id: 'kept', reasoning: { supported_efforts: [42, '', 'low'] } },
        { id: 'kept-two', reasoning: { supported_efforts: ['low'] } },
      ],
    })
    expect(catalog.catalog.data).toEqual([
      { id: 'kept', reasoning: { supported_efforts: ['low'] } },
      { id: 'kept-two', reasoning: { supported_efforts: ['low'] } },
    ])
    // Four entries stated no usable id or were not objects; three stated no
    // usable support list. Each is skipped and counted, none fails the catalog.
    expect(catalog.skipped).toBe(7)
  })

  it('reads a document that is not an object as an empty catalog', () => {
    for (const value of [undefined, null, 42, ['kept'], { data: 'scalar' }]) {
      expect(curateOpenRouterCatalog(value)).toEqual({ catalog: { data: [] }, skipped: 0 })
    }
  })

  it('reads the curated input form as the same catalog', () => {
    const curated = { data: { 'vendor/a': { supported_efforts: ['none', 'turbo'] } } }
    expect(curateOpenRouterCatalog(curated).catalog.data)
      .toEqual([{ id: 'vendor/a', reasoning: { supported_efforts: ['none', 'turbo'] } }])
  })

  it('treats an entry that carries neither form of the metadata as stating nothing', () => {
    // In the raw list shape an entry is a model object, so metadata must sit
    // under `reasoning`; an object without it is not a curated entry.
    expect(curateOpenRouterCatalog({ data: [{ id: 'carries-nothing-else' }] }))
      .toEqual({ catalog: { data: [] }, skipped: 1 })
  })
})

describe('assembling the bundled document', () => {
  it('records the schema version, the timestamp, and both capture identities', () => {
    const built = buildSnapshot(INPUTS, GENERATED_AT)
    expect(built.snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION)
    expect(built.snapshot.generatedAt).toBe(GENERATED_AT)
    expect(built.snapshot.sources).toEqual({
      'models.dev': { input: INPUTS.modelsDevInput, digest: INPUTS.modelsDevDigest, entryCount: 2 },
      openrouter: { input: INPUTS.openRouterInput, digest: INPUTS.openRouterDigest, entryCount: 4 },
    })
    expect(built.providerCount).toBe(2)
    expect(built.modelCount).toBe(4)
    expect(built.skipped).toBe(1)
  })

  it('carries the catalogs in the document form the resolver reads', () => {
    const { catalogs } = buildSnapshot(INPUTS, GENERATED_AT).snapshot
    // models.dev: provider id -> entry, under the database's own key.
    expect(catalogs.modelsDev.alpha?.models['a-mixed']?.reasoning_options)
      .toEqual([{ type: 'effort', values: ['none', 'low', 'turbo'] }])
    // OpenRouter: a `data` list, each entry carrying its own id.
    expect(catalogs.openRouter.data[1]).toEqual({
      id: 'vendor/b',
      reasoning: { supported_efforts: ['high', 'low'], default_effort: 'high' },
    })
  })

  it('produces identical bytes for identical captures, whatever order they stated', () => {
    const first = buildSnapshot(INPUTS, GENERATED_AT).snapshot
    const reordered = buildSnapshot({
      ...INPUTS,
      modelsDevSource: Object.fromEntries(Object.entries(RAW_MODELS_DEV).reverse()),
      openRouterSource: { data: [...RAW_OPEN_ROUTER.data].reverse() },
    }, GENERATED_AT).snapshot
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(first))
  })

  it('produces the same bytes for the raw and the curated capture of one database', () => {
    const fromRaw = buildSnapshot(INPUTS, GENERATED_AT).snapshot.catalogs.modelsDev
    const fromCurated = buildSnapshot({
      ...INPUTS,
      modelsDevSource: {
        providers: {
          alpha: {
            api: 'https://api.alpha.example/v1',
            models: {
              'a-none-only': ['none'],
              'a-mixed': ['none', 'low', 'turbo'],
              'a-empty': [],
            },
          },
          zeta: { api: 'https://api.zeta.example/v1', models: { 'z-sol': ['low', 'high'] } },
        },
      },
    }, GENERATED_AT).snapshot.catalogs.modelsDev
    expect(fromCurated).toEqual(fromRaw)
  })
})

describe('validating a bundled document', () => {
  /** One valid document the malformation cases start from. */
  const valid = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(buildSnapshot(INPUTS, GENERATED_AT).snapshot)) as Record<string, unknown>

  /** The document field each published database's catalog lives under. */
  const CATALOG_FIELD = { 'models.dev': 'modelsDev', openrouter: 'openRouter' } as const

  /**
   * One valid document with a source's catalog removed.
   * @param source - the database whose catalog to drop.
   * @returns the malformed document.
   */
  const withoutCatalog = (source: 'models.dev' | 'openrouter'): Record<string, unknown> => {
    const document = valid()
    const { [CATALOG_FIELD[source]]: _dropped, ...catalogs } = document.catalogs as Record<string, unknown>
    return { ...document, catalogs }
  }

  /**
   * One valid document with a source's capture identity removed.
   * @param source - the database whose identity to drop.
   * @returns the malformed document.
   */
  const withoutSource = (source: 'models.dev' | 'openrouter'): Record<string, unknown> => {
    const document = valid()
    const { [source]: _dropped, ...sources } = document.sources as Record<string, unknown>
    return { ...document, sources }
  }

  it('accepts a document this package built', () => {
    expect(parseSnapshot(valid())).toEqual(buildSnapshot(INPUTS, GENERATED_AT).snapshot)
  })

  it('refuses a document whose schema version is not this build’s', () => {
    expect(() => parseSnapshot({ ...valid(), schemaVersion: SNAPSHOT_SCHEMA_VERSION + 1 }))
      .toThrow(/schema version 2 is not 1/u)
    expect(() => parseSnapshot({ ...valid(), schemaVersion: '1' })).toThrow(/schema version "1" is not 1/u)
    expect(() => parseSnapshot(undefined)).toThrow(/schema version null/u)
    expect(() => parseSnapshot('scalar')).toThrow(/schema version null/u)
  })

  it('refuses a document that states no generation time', () => {
    expect(() => parseSnapshot({ ...valid(), generatedAt: undefined })).toThrow(/no generatedAt timestamp/u)
    expect(() => parseSnapshot({ ...valid(), generatedAt: '' })).toThrow(/no generatedAt timestamp/u)
  })

  it('refuses a document missing either catalog or either capture identity', () => {
    for (const source of ['models.dev', 'openrouter'] as const) {
      expect(() => parseSnapshot(withoutSource(source))).toThrow(new RegExp(`no usable "${source}"`, 'u'))
      expect(() => parseSnapshot(withoutCatalog(source))).toThrow(new RegExp(`no usable "${source}"`, 'u'))
    }
    expect(() => parseSnapshot({ ...valid(), sources: 'scalar' })).toThrow(/no usable "models.dev"/u)
    expect(() => parseSnapshot({ ...valid(), catalogs: undefined })).toThrow(/no usable "models.dev"/u)
  })

  it('refuses a capture identity that could not be compared', () => {
    for (const broken of [{ input: '' }, { digest: '' }, { entryCount: 'many' }]) {
      const malformed = valid()
      malformed.sources = {
        ...malformed.sources as Record<string, unknown>,
        'models.dev': { ...(malformed.sources as Record<string, Record<string, unknown>>)['models.dev'], ...broken },
      }
      expect(() => parseSnapshot(malformed)).toThrow(/no usable "models.dev"/u)
    }
  })

  it('refuses a catalog that states no entry at all', () => {
    const emptyModelsDev = valid()
    ;(emptyModelsDev.catalogs as Record<string, unknown>).modelsDev = {}
    expect(() => parseSnapshot(emptyModelsDev)).toThrow(/no usable "models.dev"/u)

    const emptyOpenRouter = valid()
    ;(emptyOpenRouter.catalogs as Record<string, unknown>).openRouter = { data: [] }
    expect(() => parseSnapshot(emptyOpenRouter)).toThrow(/no usable "openrouter"/u)

    const scalars = valid()
    ;(scalars.catalogs as Record<string, unknown>).openRouter = 'scalar'
    expect(() => parseSnapshot(scalars)).toThrow(/no usable "openrouter"/u)
  })
})
