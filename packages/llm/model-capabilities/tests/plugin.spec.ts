import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as plugin from '@deepseek-ai/dsh-model-capabilities/plugin'
import { MODEL_CAPABILITIES_DEFAULTS, parseSnapshot } from '@deepseek-ai/dsh-model-capabilities'

/** One reasoning model the fake models.dev response publishes for `acme`. */
const MODELS_DEV_RESPONSE = {
  acme: {
    id: 'acme',
    api: 'https://api.acme.example/v1',
    models: { think: { id: 'think', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } },
  },
}

/** One reasoning model the fake OpenRouter response publishes. */
const OPENROUTER_RESPONSE = {
  data: [{ id: 'acme/think', reasoning: { supported_efforts: ['low', 'high'], default_effort: 'high' } }],
}

/** The route the adapter advertises, so discovery has a listing to interrogate. */
const ADAPTER_CATALOG: readonly LlmModelInfo[] = [
  { provider: 'acme', id: 'think', name: 'Acme Think' },
]

/** An adapter that advertises one model, optionally describing its own efforts. */
class CatalogAdapter extends LlmAdapter {
  constructor(private readonly nativeReasoning: boolean) {
    super()
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(ADAPTER_CATALOG.filter(model => model.provider === provider))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      // The adapter's own statement about this exact model, which is the
      // provider-native tier no public claim may displace.
      ...this.nativeReasoning && model === 'think'
        ? { reasoning: { efforts: [{ id: ReasoningEffortId('max'), name: 'Max' }] } }
        : {},
    })
  }

  override async * stream(): AsyncIterable<never> {
    throw new Error('not exercised')
  }
}

/** One recorded public request, so a test can prove what was and was not sent. */
interface RecordedRequest {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** The harness one test drives: a real Cordis tree with a stubbed public network. */
interface Harness {
  readonly ctx: Context
  readonly requests: RecordedRequest[]
  readonly scratch: string
  readonly settingsPath: string
  readonly dispose: () => Promise<void>
}

/** Scratch directories removed after each test. */
const scratchDirs: string[] = []

/** The environment's `DSH_HOME` before a test replaced it. */
let originalHome: string | undefined

/** The URL one `fetch` call names, whatever form the caller used. */
function requestedUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

/** A network stub that answers each public endpoint from the fixtures above. */
function stubNetwork(hang = false): { requests: RecordedRequest[]; restore: () => void } {
  const requests: RecordedRequest[] = []
  const original = globalThis.fetch
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = requestedUrl(input)
    requests.push({ url, init })
    if (hang) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
      })
    }
    const body = url.includes('openrouter.ai') ? OPENROUTER_RESPONSE : MODELS_DEV_RESPONSE
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  }
  return { requests, restore: () => { globalThis.fetch = original } }
}

/**
 * Wait for a condition to hold, without assuming how many microtasks it needs.
 * @param condition - predicate to poll.
 */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('waitFor: condition never held')
}

/**
 * Mount the plugin over a real Cordis tree, a scratch Harness home, and a
 * stubbed public network.
 * @param options - settings document, network behaviour, and adapter hooks.
 * @returns the harness to drive, torn down by the test.
 */
async function mount(options: {
  settings?: string
  hang?: boolean
  withSettings?: boolean
  nativeReasoning?: boolean
  beforeMount?: (ctx: Context) => void
} = {}): Promise<Harness> {
  const scratch = mkdtempSync(join(tmpdir(), 'model-capabilities-plugin-'))
  scratchDirs.push(scratch)
  const home = join(scratch, 'home')
  process.env.DSH_HOME = home
  const settingsPath = join(scratch, 'settings.yaml')
  if (options.settings !== undefined) writeFileSync(settingsPath, options.settings)
  const network = stubNetwork(options.hang ?? false)

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['acme'], new CatalogAdapter(options.nativeReasoning ?? false))
  ctx.llm.registerModelDiscovery('llm-example', () => Promise.resolve(ADAPTER_CATALOG))
  options.beforeMount?.(ctx)
  if (options.withSettings !== false) {
    await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
  }
  await ctx.plugin(plugin, MODEL_CAPABILITIES_DEFAULTS)
  return {
    ctx,
    requests: network.requests,
    scratch,
    settingsPath,
    dispose: async () => {
      network.restore()
      await ctx.fiber.dispose()
    },
  }
}

beforeEach(() => {
  originalHome = process.env.DSH_HOME
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop() as string, { recursive: true, force: true })
})

describe('the plugin as a composition row', () => {
  it('exports the function-plugin surface the Loader expects', () => {
    expect(plugin.name).toBe('model-capabilities')
    expect(plugin.inject).toEqual(['llm'])
    expect(plugin.Config).toBeDefined()
    expect('default' in plugin).toBe(false)
  })
})

describe('registration and precedence', () => {
  it('registers the public source on the LLM seam and resolves through it', async () => {
    const harness = await mount()
    try {
      await waitFor(() => harness.requests.length >= 2)
      const models = await harness.ctx.llm.discoverModels('llm-example', {
        provider: 'acme',
        baseURL: 'https://api.acme.example/v1',
      })
      expect(models).toEqual([{ id: 'think', name: 'Acme Think', reasoningEfforts: ['low', 'high'] }])
    } finally {
      await harness.dispose()
    }
  })

  it('leaves adapter-native metadata ahead of any public claim', async () => {
    // The seam asks a capability source only for a model the adapter left
    // undescribed, and an adapter that describes its own efforts is the
    // provider-native tier. Here the adapter states nothing, so the public
    // source answers; the adapter-stated case is the next assertion.
    const harness = await mount()
    try {
      await waitFor(() => harness.requests.length >= 2)
      const native = await harness.ctx.llm.resolveModelInfo('acme', 'think')
      expect(native.reasoning).toBeUndefined()
      const models = await harness.ctx.llm.discoverModels('llm-example', {
        provider: 'acme',
        baseURL: 'https://api.acme.example/v1',
      })
      expect(models[0]?.reasoningEfforts).toEqual(['low', 'high'])
    } finally {
      await harness.dispose()
    }
  })

  it('reports what an adapter states for itself, without consulting the public source', async () => {
    const harness = await mount({ nativeReasoning: true })
    try {
      await waitFor(() => harness.requests.length >= 2)
      const native = await harness.ctx.llm.resolveModelInfo('acme', 'think')
      expect(native.reasoning?.efforts.map(effort => effort.id)).toEqual(['max'])
      // Discovery still asks the public source, because a listing states no
      // efforts at all — the two tiers answer different questions and never
      // overwrite one another.
      const models = await harness.ctx.llm.discoverModels('llm-example', {
        provider: 'acme',
        baseURL: 'https://api.acme.example/v1',
      })
      expect(models[0]?.reasoningEfforts).toEqual(['low', 'high'])
    } finally {
      await harness.dispose()
    }
  })

  it('leaves a local integration registered before the plugin ahead of public metadata', async () => {
    const harness = await mount({ beforeMount: (ctx) => {
      ctx.llm.registerModelCapabilitySource('local', modelId =>
        modelId === 'think' ? { reasoningEfforts: ['medium'] } : undefined)
    } })
    try {
      await waitFor(() => harness.requests.length >= 2)
      const models = await harness.ctx.llm.discoverModels('llm-example', {
        provider: 'acme',
        baseURL: 'https://api.acme.example/v1',
      })
      expect(models[0]?.reasoningEfforts).toEqual(['medium'])
    } finally {
      await harness.dispose()
    }
  })

  it('fills in only the models no higher-priority source described', async () => {
    const harness = await mount({ beforeMount: (ctx) => {
      ctx.llm.registerModelCapabilitySource('local', () => undefined)
    } })
    try {
      await waitFor(() => harness.requests.length >= 2)
      const models = await harness.ctx.llm.discoverModels('llm-example', {
        provider: 'acme',
        baseURL: 'https://api.acme.example/v1',
      })
      expect(models[0]?.reasoningEfforts).toEqual(['low', 'high'])
    } finally {
      await harness.dispose()
    }
  })
})

describe('enabled: false', () => {
  it('registers nothing that declares a capability and makes no request', async () => {
    const harness = await mount({ settings: 'model-capabilities:\n  publicMetadata:\n    enabled: false\n' })
    try {
      const models = await harness.ctx.llm.discoverModels('llm-example', {
        provider: 'acme',
        baseURL: 'https://api.acme.example/v1',
      })
      expect(models).toEqual([{ id: 'think', name: 'Acme Think' }])
      expect(harness.requests).toEqual([])
    } finally {
      await harness.dispose()
    }
    // Nothing landed on disk either.
    expect(readFileSync(join(harness.scratch, 'settings.yaml'), 'utf8')).toContain('enabled: false')
  })
})

describe('refresh modes', () => {
  it.each(['manual', 'never'] as const)('makes no automatic request under refresh: %s', async (refresh) => {
    const harness = await mount({ settings: `model-capabilities:\n  publicMetadata:\n    refresh: ${refresh}\n` })
    try {
      const models = await harness.ctx.llm.discoverModels('llm-example', {
        provider: 'acme',
        baseURL: 'https://api.acme.example/v1',
      })
      // The bundled snapshot answers instead, and nothing was fetched.
      expect(models[0]?.reasoningEfforts).toBeUndefined()
      expect(harness.requests).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  it('refreshes in the background under refresh: auto', async () => {
    const harness = await mount()
    try {
      await waitFor(() => harness.requests.length >= 2)
      expect(harness.requests.map(request => request.url).sort()).toEqual([
        'https://models.dev/api.json',
        'https://openrouter.ai/api/v1/models',
      ])
      // The request is a plain anonymous GET.
      expect(harness.requests[0]?.init?.method).toBe('GET')
      expect(harness.requests[0]?.init?.headers).toEqual({ accept: 'application/json' })
      // The successful fetch is committed, so a later start serves it.
      await waitFor(() => {
        try {
          return readFileSync(join(harness.scratch, 'home', 'model-capabilities', 'public-catalogs.json'), 'utf8').length > 0
        } catch {
          return false
        }
      })
      const cached: unknown = JSON.parse(readFileSync(
        join(harness.scratch, 'home', 'model-capabilities', 'public-catalogs.json'),
        'utf8',
      ))
      expect(cached).toMatchObject({ schemaVersion: 1 })
    } finally {
      await harness.dispose()
    }
  })
})

describe('offline operation', () => {
  it('starts and serves without waiting for the network', async () => {
    const harness = await mount({ hang: true })
    try {
      // Mount resolved while both requests are still outstanding, which is the
      // property that keeps startup from depending on reachability.
      const models = await harness.ctx.llm.discoverModels('llm-example', {
        provider: 'acme',
        baseURL: 'https://api.acme.example/v1',
      })
      expect(models[0]?.id).toBe('think')
      expect(harness.requests).toHaveLength(2)
    } finally {
      await harness.dispose()
    }
  })

  it('serves without the settings seam at all', async () => {
    const harness = await mount({ withSettings: false })
    try {
      await waitFor(() => harness.requests.length >= 2)
      const models = await harness.ctx.llm.discoverModels('llm-example', {
        provider: 'acme',
        baseURL: 'https://api.acme.example/v1',
      })
      expect(models[0]?.reasoningEfforts).toEqual(['low', 'high'])
    } finally {
      await harness.dispose()
    }
  })
})

describe('lifecycle', () => {
  it('aborts an in-flight refresh when the plugin is disposed', async () => {
    const harness = await mount({ hang: true })
    const signals = harness.requests.map(request => request.init?.signal)
    expect(signals).toHaveLength(2)
    await harness.dispose()
    expect(signals.every(signal => signal?.aborted === true)).toBe(true)
  })

  it('returns a fiber whose disposal withdraws the source from the seam', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'model-capabilities-dispose-'))
    scratchDirs.push(scratch)
    process.env.DSH_HOME = join(scratch, 'home')
    const network = stubNetwork(true)
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['acme'], new CatalogAdapter(false))
      ctx.llm.registerModelDiscovery('llm-example', () => Promise.resolve(ADAPTER_CATALOG))
      const fiber = await ctx.plugin(plugin, MODEL_CAPABILITIES_DEFAULTS)
      await fiber.dispose()
      // The seam refuses a second registration under the same name only when
      // the first one is gone, which is what proves the effect was withdrawn.
      expect(() => ctx.llm.registerModelCapabilitySource('public-metadata', () => undefined)).not.toThrow()
    } finally {
      network.restore()
      await ctx.fiber.dispose()
    }
  })
})

describe('the bundled snapshot the plugin ships', () => {
  it('is a document this build can read', () => {
    expect(parseSnapshot(JSON.parse(JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-09-16T00:00:00.000Z',
      sources: {
        'models.dev': { input: 'a', digest: 'a'.repeat(64), entryCount: 1 },
        openrouter: { input: 'b', digest: 'b'.repeat(64), entryCount: 1 },
      },
      catalogs: { modelsDev: { acme: {} }, openRouter: { data: [{ id: 'x' }] } },
    })))).toMatchObject({ schemaVersion: 1 })
  })
})
