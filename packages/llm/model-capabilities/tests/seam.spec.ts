import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmModelCapability, LlmModelCapabilityLookup, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { createPublicCapabilitySource } from '@deepseek-ai/dsh-model-capabilities'
import type { PublicCatalog } from '@deepseek-ai/dsh-model-capabilities'

/** The fixture directory, resolved from this spec so it works from any cwd. */
const FIXTURES = join(import.meta.dirname, 'fixtures')

/** The two captured databases, most authoritative first, as a composition would load them. */
const CATALOGS: readonly PublicCatalog[] = [
  {
    source: 'openrouter',
    origin: 'fixture',
    entries: JSON.parse(readFileSync(join(FIXTURES, 'openrouter.json'), 'utf8')),
  },
  {
    source: 'models.dev',
    origin: 'fixture',
    entries: JSON.parse(readFileSync(join(FIXTURES, 'models-dev.json'), 'utf8')),
  },
]

/** One route's adapter-owned catalog: the models the endpoint itself describes. */
const ADAPTER_CATALOG: readonly LlmModelInfo[] = [
  // An id only OpenRouter lists, so its answer can come from nothing else.
  { provider: 'local-integration', id: '~deepseek/deepseek-pro-latest', name: 'DeepSeek Pro Latest' },
  // An id only models.dev lists, and only as a foreign provider's claim.
  { provider: 'local-integration', id: 'gpt-5.4', name: 'GPT-5.4' },
]

/** An adapter whose listing is {@link ADAPTER_CATALOG}. */
class CatalogAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(ADAPTER_CATALOG.filter(model => model.provider === provider))
  }

  override async * stream(): AsyncIterable<never> {
    throw new Error('not exercised')
  }
}

/** A lookup standing in for a local integration's own per-model answer. */
function fixedSource(answers: Readonly<Record<string, readonly string[]>>): LlmModelCapabilityLookup {
  return (modelId) => {
    const efforts = answers[modelId]
    return efforts === undefined ? undefined : { reasoningEfforts: efforts }
  }
}

/**
 * Mount the LLM runtime, its one adapter, its discovery listing, and the given capability sources.
 * @param sources - sources to register, in registration order, as `[name, lookup]` pairs.
 * @returns the context and the disposal thunk.
 */
async function harness(
  sources: readonly (readonly [string, LlmModelCapabilityLookup])[] = [],
): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['local-integration'], new CatalogAdapter())
  ctx.llm.registerModelDiscovery('llm-example', () => Promise.resolve(ADAPTER_CATALOG))
  for (const [name, lookup] of sources) {
    await ctx.plugin({
      name: `capability-source-${name}`,
      inject: ['llm'],
      apply: (inner: Context) => {
        inner.llm.registerModelCapabilitySource(name, lookup)
      },
    })
  }
  return { ctx, dispose: async () => { await ctx.fiber.dispose() } }
}

/** The public source under test, as a composition would register it. */
const PUBLIC = createPublicCapabilitySource(CATALOGS)

/** An endpoint that is not OpenRouter, so OpenRouter's catalog may not answer. */
const FOREIGN = { provider: 'local-integration', baseURL: 'https://api.openai.com/v1' }

/** The adapter's own name for each id, carried into every discovered model. */
const NAMES: Readonly<Record<string, string>> = {
  '~deepseek/deepseek-pro-latest': 'DeepSeek Pro Latest',
  'gpt-5.4': 'GPT-5.4',
}

/**
 * One discovered model as the seam publishes it.
 * @param id - the model id.
 * @param declared - the reasoning fields the answering source stated, if any.
 * @returns the discovered model.
 */
function discovered(id: string, declared: LlmModelCapability = { reasoningEfforts: [] }) {
  return {
    id,
    name: NAMES[id] as string,
    ...declared.reasoningEfforts.length === 0 ? {} : { reasoningEfforts: declared.reasoningEfforts },
    ...declared.defaultReasoningEffort === undefined
      ? {}
      : { defaultReasoningEffort: declared.defaultReasoningEffort },
  }
}

describe('the public source on the LLM capability seam', () => {
  it('resolves an undeclared model through its provider-aware match', async () => {
    const { ctx, dispose } = await harness([['public-metadata', PUBLIC]])
    try {
      // The route is OpenRouter, so OpenRouter's own catalog answers the id it
      // lists and says nothing about the one it does not.
      expect(await ctx.llm.discoverModels('llm-example', {
        provider: 'some-gateway',
        baseURL: 'https://openrouter.ai/api/v1',
      })).toEqual([
        discovered('~deepseek/deepseek-pro-latest', {
          reasoningEfforts: ['low', 'high', 'max'],
          defaultReasoningEffort: 'high',
        }),
        discovered('gpt-5.4'),
      ])
    } finally {
      await dispose()
    }
  })

  it('matches models.dev by the route endpoint, so an undeclared model gets the gateway’s own levels', async () => {
    const { ctx, dispose } = await harness([['public-metadata', PUBLIC]])
    try {
      // The endpoint names OpenAI, whose models.dev entry is the only one that
      // may answer for `gpt-5.4`. The OpenRouter-only id finds nothing here.
      expect(await ctx.llm.discoverModels('llm-example', FOREIGN)).toEqual([
        discovered('~deepseek/deepseek-pro-latest'),
        discovered('gpt-5.4', { reasoningEfforts: ['low', 'medium', 'high'] }),
      ])
    } finally {
      await dispose()
    }
  })

  it('declares nothing for an id-only suggestion', async () => {
    const { ctx, dispose } = await harness([['public-metadata', PUBLIC]])
    try {
      // No loaded catalog identifies this route's gateway, so neither id may
      // adopt a claim that belongs to some other gateway.
      expect(await ctx.llm.discoverModels('llm-example', { provider: 'unlisted' }))
        .toEqual([discovered('~deepseek/deepseek-pro-latest'), discovered('gpt-5.4')])
    } finally {
      await dispose()
    }
  })

  it('never overrides a declaration an earlier-registered integration already made', async () => {
    const { ctx, dispose } = await harness([
      ['public-metadata', PUBLIC],
      ['local-integration', fixedSource({
        '~deepseek/deepseek-pro-latest': ['low', 'high', 'max'],
        'gpt-5.4': ['high'],
      })],
    ])
    try {
      // Both sources describe these ids; the first registration answers alone,
      // and the public claim never displaces it.
      expect(await ctx.llm.discoverModels('llm-example', FOREIGN)).toEqual([
        discovered('~deepseek/deepseek-pro-latest', { reasoningEfforts: ['low', 'high', 'max'] }),
        discovered('gpt-5.4', { reasoningEfforts: ['low', 'medium', 'high'] }),
      ])
    } finally {
      await dispose()
    }
  })

  it('answers only for the model no higher-priority source describes', async () => {
    const { ctx, dispose } = await harness([
      ['local-integration', fixedSource({ 'gpt-5.4': ['high'] })],
      ['public-metadata', PUBLIC],
    ])
    try {
      // The local integration answers first, so `gpt-5.4` keeps its set; the
      // OpenRouter-only id is left to the public source.
      expect(await ctx.llm.discoverModels('llm-example', {
        provider: 'local-integration',
        baseURL: 'https://openrouter.ai/api/v1',
      })).toEqual([
        discovered('~deepseek/deepseek-pro-latest', {
          reasoningEfforts: ['low', 'high', 'max'],
          defaultReasoningEffort: 'high',
        }),
        discovered('gpt-5.4', { reasoningEfforts: ['high'] }),
      ])
    } finally {
      await dispose()
    }
  })
})
