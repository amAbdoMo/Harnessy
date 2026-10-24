/** Both authentication routes retain customized catalogs and isolate live discovery by credential. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import * as Account from '../src/index.ts'
import * as ApiKey from '../../llm-deepseek-api-key/src/index.ts'
import { resolveAccountOptions } from '../src/config.ts'

const LISTING_URL = 'https://api.deepseek.com/models'
const contexts: Context[] = []
afterEach(async () => {
  try { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs() }
})

const routes = [
  { plugin: Account, provider: 'deepseek-account', header: 'x-dsh-auth-token' },
  { plugin: ApiKey, provider: 'deepseek-official', header: 'x-api-key' },
] as const

async function host() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  let token: string | undefined = 'credential-a'
  const rejectToken = vi.fn<(token: string) => Promise<void>>(() => Promise.resolve())
  ctx.provide('deepseekAccount', {
    resolveToken: (_url: string): Promise<string | undefined> => Promise.resolve(token),
    rejectToken: (value: string): Promise<void> => rejectToken(value),
  } as DeepSeekAccount)
  const credential = (value: string | undefined) => {
    token = value
    vi.stubEnv('DEEPSEEK_API_KEY', value)
  }
  credential(token)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return { ctx, credential, rejectToken }
}

function answer(header: string, response?: () => Response) {
  const requests: Request[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init)
    if (request.url !== LISTING_URL || request.method !== 'GET') return Promise.reject(new Error('unexpected request'))
    requests.push(request)
    const credential = request.headers.get(header)
    if (credential === null) throw new Error('missing fixture credential header')
    return Promise.resolve(response?.() ?? new Response(JSON.stringify({ data: [{
      id: 'listed-' + credential, name: 'Model for ' + credential, context_window: 42,
      client_requirements: { 'deepseek-harness': { min_version: '0.0.1' } },
      input_modalities: ['text'], api_capabilities: { anthropic_messages: {} },
    }] })))
  })
  return requests
}

it.each(routes)('refreshes $provider discovery on credential switch and clears it on sign-out', async ({ plugin, provider, header }) => {
  const { ctx, credential, rejectToken } = await host()
  const requests = answer(header)
  await ctx.plugin(plugin, {})
  expect((await ctx.llm.listModels(provider)).map(model => model.id)).toEqual(['listed-credential-a'])
  expect(await ctx.llm.resolveModelInfo(provider, 'listed-credential-a')).toMatchObject({ context: { contextWindow: 42 } })
  expect(requests).toHaveLength(1)
  expect(requests[0]!.headers.get(header)).toBe('credential-a')
  expect(requests[0]!.redirect).toBe('error')
  credential('credential-b')
  expect((await ctx.llm.listModels(provider)).map(model => model.id)).toEqual(['listed-credential-b'])
  expect(requests).toHaveLength(2)
  expect(requests[1]!.headers.get(header)).toBe('credential-b')
  credential(undefined)
  expect(await ctx.llm.listModels(provider)).toEqual([])
  expect(requests).toHaveLength(2)
  expect(rejectToken).not.toHaveBeenCalled()
})

it.each(routes)('keeps $provider saved models and custom endpoints independent of live discovery', async ({ plugin, provider, header }) => {
  const { ctx } = await host()
  const requests = answer(header)
  const live = await liveConfig(ctx, plugin, { models: [{ id: 'saved', name: 'My model', contextWindow: 7 }] })
  expect((await ctx.llm.listModels(provider)).map(model => [model.id, model.name])).toEqual([['saved', 'My model']])
  expect(requests).toHaveLength(0)
  await live.replace({ baseURL: 'https://gateway.custom.example/anthropic' })
  expect((await ctx.llm.listModels(provider)).map(model => model.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  expect(requests).toHaveLength(0)
  await live.replace({})
  expect((await ctx.llm.listModels(provider)).map(model => model.id)).toEqual(['listed-credential-a'])
  expect(requests).toHaveLength(1)
})

it.each(routes)('honors actual client-version requirements on $provider before model requests', async ({ plugin, provider, header }) => {
  const { ctx, rejectToken } = await host()
  const requests = answer(header, () => new Response(JSON.stringify({ data: [{
    id: 'requires-newer', client_requirements: { 'deepseek-harness': { min_version: '99.0.0' } },
    api_capabilities: { anthropic_messages: {} },
  }] })))
  await ctx.plugin(plugin, {})
  expect(await ctx.llm.listModels(provider)).toEqual([])
  await expect(ctx.llm.prepareCall({ provider, model: 'requires-newer' })).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' })
  expect(requests).toHaveLength(1)
  expect(rejectToken).not.toHaveBeenCalled()
})

it('keeps an account credential after a listing rejects it and retains the fallback catalog', async () => {
  const { ctx, rejectToken } = await host()
  const requests = answer('x-dsh-auth-token', () => new Response('catalog unavailable', { status: 401 }))
  await ctx.plugin(Account, {})
  expect((await ctx.llm.listModels('deepseek-account')).map(model => model.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  expect(requests).toHaveLength(1)
  expect(rejectToken).not.toHaveBeenCalled()
})

it.each([0, -1, Infinity, NaN])('rejects invalid account listing timeout %s', (modelsTimeoutMs) => {
  expect(() => resolveAccountOptions({ modelsTimeoutMs })).toThrow('modelsTimeoutMs')
})

it.each(routes)('preserves $provider reasoning-only and hidden-metadata catalog edits', async ({ plugin, provider, header }) => {
  const { ctx } = await host()
  const requests = answer(header)
  const models = resolveAdapterOptions({}).models.map(model => ({
    ...model, reasoningEfforts: { high: 'custom-high' }, ownerMetadata: { keep: true },
  }))
  const live = await liveConfig(ctx, plugin, { models })
  expect((await ctx.llm.listModels(provider)).map(model => model.id)).toEqual(models.map(model => model.id))
  expect(requests).toHaveLength(0)
  await live.replace({})
  expect((await ctx.llm.listModels(provider)).map(model => model.id)).toEqual(['listed-credential-a'])
  expect(requests).toHaveLength(1)
})
