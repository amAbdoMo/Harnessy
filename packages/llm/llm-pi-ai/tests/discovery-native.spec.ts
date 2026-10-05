/** Fresh native listings, normal OAuth refresh, stale-account rejection, and real Loader composition. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import { recordKeyFor } from '../src/auth.ts'
import { discoverModels } from '../src/discovery.ts'
import { resolveBuiltinDiscoveryAuth } from '../src/discovery-auth.ts'
import { memoryAuth } from './auth-double.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function grant(accountId: string, expires = Date.now() + 3_600_000): OAuthCredential {
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }
  return { type: 'oauth', access: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`, refresh: 'test-refresh', expires, accountId }
}

const nativeListing = {
  models: [{
    slug: 'unreleased-codex-model', display_name: 'New Codex Model', context_window: 524288,
    input_modalities: ['text', 'image'], default_reasoning_level: 'high',
    supported_reasoning_levels: [{ effort: 'low', description: 'Low' }, { effort: 'high', description: 'High' }],
    visibility: 'list',
  }],
}

function authenticatedDiscovery(auth = memoryAuth({ 'openai-codex': grant('account-a') })) {
  return {
    auth,
    profile: () => ({
      headers: undefined,
      resolveApiKey: () => Promise.resolve(undefined),
      resolveAuth: (signal?: AbortSignal) => resolveBuiltinDiscoveryAuth('openai-codex', auth, signal),
    }),
  }
}

describe('native Codex discovery', () => {
  it.each([
    'https://chatgpt.com/backend-api',
    'https://chatgpt.com/backend-api/codex',
    'https://chatgpt.com/backend-api/codex/responses',
  ])('uses native OAuth headers and the upstream release client version at %s', async (baseURL) => {
    const { profile } = authenticatedDiscovery()
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(nativeListing)))
    vi.stubGlobal('fetch', fetcher)
    const models = await discoverModels({ provider: 'openai-codex', baseURL }, profile)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.160.0')
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${grant('account-a').access}`)
    expect(headers.get('chatgpt-account-id')).toBe('account-a')
    expect(headers.get('originator')).toBe('pi')
    expect(models).toEqual([{
      id: 'unreleased-codex-model', name: 'New Codex Model', contextWindow: 524288,
      inputModalities: ['text', 'image'], reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
    }])
  })

  it('refreshes through pi-ai before listing and guards the refreshed credential', async () => {
    const { auth, profile } = authenticatedDiscovery(memoryAuth({ 'openai-codex': grant('account-a', 0) }))
    const requests: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      requests.push(url)
      if (url === 'https://auth.openai.com/oauth/token') {
        if (typeof init?.body !== 'string' && !(init?.body instanceof URLSearchParams)) {
          throw new Error('expected URL-encoded OAuth refresh body')
        }
        const body = new URLSearchParams(init.body)
        expect(body.get('grant_type')).toBe('refresh_token')
        expect(body.get('refresh_token')).toBe('test-refresh')
        return new Response(JSON.stringify({ access_token: grant('refreshed-account').access, refresh_token: 'rotated', expires_in: 3600 }))
      }
      expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('refreshed-account')
      return new Response(JSON.stringify(nativeListing))
    })
    await expect(discoverModels({ provider: 'openai-codex' }, profile)).resolves.toHaveLength(1)
    expect(requests).toEqual(['https://auth.openai.com/oauth/token', 'https://chatgpt.com/backend-api/codex/models?client_version=0.160.0'])
    expect(auth.stored.get('openai-codex')).toMatchObject({ refresh: 'rotated', accountId: 'refreshed-account' })
  })

  it('rejects a switch during auth resolution instead of adopting the new account identity', async () => {
    const auth = memoryAuth({ 'openai-codex': grant('account-a') })
    const read = auth.credentials.read.bind(auth.credentials)
    let first = true
    auth.credentials.read = async (id, options) => {
      const used = await read(id, options)
      if (first) {
        first = false
        auth.stored.set(id, grant('account-b'))
      }
      return used
    }
    const { profile } = authenticatedDiscovery(auth)
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(discoverModels({ provider: 'openai-codex' }, profile)).rejects.toMatchObject({ code: 'DISCOVERY_STALE' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['switch', 'logout'])('rejects a response from the previous account after %s', async (action) => {
    const { auth, profile } = authenticatedDiscovery()
    vi.stubGlobal('fetch', async () => {
      if (action === 'logout') auth.stored.delete('openai-codex')
      else auth.stored.set('openai-codex', grant('account-b'))
      return new Response(JSON.stringify(nativeListing))
    })
    await expect(discoverModels({ provider: 'openai-codex' }, profile)).rejects.toMatchObject({ code: 'DISCOVERY_STALE' })
  })

  it('uses an explicit draft endpoint and key without touching stored native auth', async () => {
    const { profile } = authenticatedDiscovery()
    const stored = profile()
    const resolver = vi.fn(stored.resolveAuth)
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"data":[{"id":"draft-only"}]}'))
    vi.stubGlobal('fetch', fetcher)
    await expect(discoverModels({
      provider: 'openai-codex', api: 'openai-completions', baseURL: 'https://draft.example/v1', apiKey: 'draft-key',
    }, () => ({ ...stored, resolveAuth: resolver }))).resolves.toEqual([{ id: 'draft-only', name: 'draft-only' }])
    expect(resolver).not.toHaveBeenCalled()
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://draft.example/v1/models')
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer draft-key')
  })

  it.each([401, 500])('reports %s without falling back to installed Codex models', async (status) => {
    const { profile } = authenticatedDiscovery()
    vi.stubGlobal('fetch', async () => new Response('{}', { status }))
    await expect(discoverModels({ provider: 'openai-codex' }, profile)).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })

  it('reports refresh failure instead of falling back to installed models', async () => {
    const { profile } = authenticatedDiscovery(memoryAuth({ 'openai-codex': grant('account-a', 0) }))
    const fetcher = vi.fn(async () => new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(discoverModels({ provider: 'openai-codex' }, profile)).rejects.toMatchObject({ code: 'oauth' })
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

describe('complete bounded Anthropic discovery', () => {
  it('follows has_more using last_id and preserves all page membership', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      const second = new URL(url).searchParams.has('after_id')
      return new Response(JSON.stringify({ data: [{ id: second ? 'second' : 'first' }], has_more: !second, last_id: 'first' }))
    })
    await expect(discoverModels({ api: 'anthropic-messages', baseURL: 'https://anthropic.example/v1' }))
      .resolves.toEqual([{ id: 'first', name: 'first' }, { id: 'second', name: 'second' }])
    expect(urls).toEqual(['https://anthropic.example/v1/models?limit=1000', 'https://anthropic.example/v1/models?limit=1000&after_id=first'])
  })

  it.each(['missing', 'repeated', 'too-many-pages'])('refuses an incomplete listing with %s cursor', async (kind) => {
    let page = 0
    const fetcher = vi.fn(async () => {
      page++
      return new Response(JSON.stringify({ data: [{ id: `model-${page}` }], has_more: true,
        ...kind === 'missing' ? {} : { last_id: kind === 'repeated' ? 'same' : `cursor-${page}` },
      }))
    })
    vi.stubGlobal('fetch', fetcher)
    await expect(discoverModels({ api: 'anthropic-messages', baseURL: 'https://anthropic.example' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_TRUNCATED' })
    expect(fetcher).toHaveBeenCalledTimes(kind === 'missing' ? 1 : kind === 'repeated' ? 2 : 10)
  })

  it('applies the byte ceiling across pages, including multibyte text', async () => {
    let page = 0
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [{ id: `model-${++page}`, pad: 'é'.repeat(1_048_576) }], has_more: true, last_id: `cursor-${page}` })))
    await expect(discoverModels({ api: 'anthropic-messages', baseURL: 'https://anthropic.example' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(page).toBe(2)
  })
})

/** Boot source modules through test-only cordis.yml and the actual profile/Loader composition. */
async function composition(): Promise<{ ctx: Context; patchPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-discovery-composition-'))
  const credentialPath = join(root, '.credentials.yaml')
  await writeFile(credentialPath, 'version: 1\nrefs: {}\n', { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm', "  name: 'test-llm-service'", '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'", '  config:', `    path: ${JSON.stringify(credentialPath)}`,
    '    debounceMs: 10', '- id: llm-pi-ai', "  name: '@deepseek-ai/dsh-llm-pi-ai'", '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime], ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import: (specifier) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  return { ctx, patchPath: await profileComposition(ctx, root, configPath) }
}

describe('real Loader discovery composition', () => {
  it('discovers keyless Codex from a stored login without configuring routes or saving candidates', async () => {
    const { ctx, patchPath } = await composition()
    await ctx.credentials.modifyRecord(recordKeyFor('openai-codex'), () => Promise.resolve({ kind: 'grant', payload: grant('loader-account') }))
    const before = await readFile(patchPath, 'utf8')
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      urls.push(url)
      expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('loader-account')
      return new Response(JSON.stringify(nativeListing))
    })
    expect(ctx.llm.listProviders()).toEqual([])
    expect(await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai-codex' })).toMatchInlineSnapshot(`
      [
        {
          "contextWindow": 524288,
          "defaultReasoningEffort": "high",
          "id": "unreleased-codex-model",
          "inputModalities": [
            "text",
            "image",
          ],
          "name": "New Codex Model",
          "reasoningEfforts": [
            "low",
            "high",
          ],
        },
      ]
    `)
    expect(urls).toEqual(['https://chatgpt.com/backend-api/codex/models?client_version=0.160.0'])
    expect(ctx.llm.listProviders()).toEqual([])
    expect(await readFile(patchPath, 'utf8')).toBe(before)
  })

  it('rejects a stale account result through the real credential service', async () => {
    const { ctx } = await composition()
    const key = recordKeyFor('openai-codex')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: grant('loader-account') }))
    vi.stubGlobal('fetch', async () => {
      await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: grant('new-account') }))
      return new Response(JSON.stringify(nativeListing))
    })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai-codex' })).rejects.toMatchObject({ code: 'DISCOVERY_STALE' })
  })
})
