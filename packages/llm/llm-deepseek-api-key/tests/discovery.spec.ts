/** Model discovery requires the API-key route's own credential. */
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LlmRuntime, { LlmError } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as ApiKey from '../src/index.ts'

const contexts: Context[] = []
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected discovery network request'))
})
afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  }
})

async function boot(config: ApiKey.Options = {}, credentialSeed?: Record<string, string>): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  if (credentialSeed !== undefined) await ctx.plugin(MemoryCredentials, credentialSeed)
  await ctx.plugin(ApiKey, config)
  return ctx
}

it.each([undefined, ''])('hides models without an API key: %j', async (key) => {
  vi.stubEnv('DEEPSEEK_API_KEY', key)
  const ctx = await boot()
  expect(await ctx.llm.listModels('deepseek-official')).toEqual([])
  expect(ctx.llm.listConfigurableProviders()).toEqual([{
    provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek-api-key', settingsPath: [],
  }])
})

it('advertises the default models with an API key', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-api-key')
  const ctx = await boot()
  expect((await ctx.llm.listModels('deepseek-official')).map(model => model.id))
    .toEqual(['deepseek-flash', 'deepseek-v4-pro'])
})

it('retains the configured catalog with an API key', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-api-key')
  const ctx = await boot({ models: [{ id: 'configured-model', name: 'Configured model', inputModalities: ['text'] }] })
  expect(await ctx.llm.listModels('deepseek-official')).toEqual([{
    provider: 'deepseek-official', id: 'configured-model', name: 'Configured model', inputModalities: ['text'],
  }])
})

it.each(['invalid\nheader', 'invalid-\u{1F600}'])('reports malformed credentials during discovery: %j', async (key) => {
  vi.stubEnv('DEEPSEEK_API_KEY', key)
  const ctx = await boot()
  await expect(ctx.llm.listModels('deepseek-official')).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
})

it('reports malformed stored credentials during discovery', async () => {
  const ctx = await boot({}, {})
  await ctx.credentials.set(credentialRef('DEEPSEEK_API_KEY'), 'invalid\nheader')
  await expect(ctx.llm.listModels('deepseek-official')).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
})

it('re-resolves the configured reference after credential addition and removal', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-default-key')
  vi.stubEnv('DISCOVERY_ROUTE_KEY', 'ambient-route-key')
  const ctx = await boot({ apiKeyEnv: 'DISCOVERY_ROUTE_KEY', models: [{ id: 'route-model' }] }, {})
  await ctx.credentials.set(credentialRef('DEEPSEEK_API_KEY'), 'stored-default-key')
  const ref = credentialRef('DISCOVERY_ROUTE_KEY')
  expect(await ctx.llm.listModels('deepseek-official')).toEqual([])

  await ctx.credentials.set(ref, 'stored-route-key')
  expect((await ctx.llm.listModels('deepseek-official')).map(model => model.id)).toEqual(['route-model'])

  await ctx.credentials.unset(ref)
  expect(await ctx.llm.listModels('deepseek-official')).toEqual([])
})

it.each([
  new Error('credential lookup failed'),
  Object.assign(new Error('not an LlmError'), { code: 'MISSING_CREDENTIAL' }),
  new LlmError('credential lookup rejected', 'INVALID_CREDENTIAL'),
])('propagates credential resolver failures unchanged: %s', async (failure) => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-key-must-not-mask-failure')
  const ctx = await boot({}, {})
  vi.spyOn(ctx.credentials, 'resolve').mockRejectedValue(failure)
  await expect(ctx.llm.listModels('deepseek-official')).rejects.toBe(failure)
})

it('returns an empty catalog for a resolver MISSING_CREDENTIAL LlmError', async () => {
  const ctx = await boot({}, {})
  vi.spyOn(ctx.credentials, 'resolve').mockRejectedValue(new LlmError('credential unavailable', 'MISSING_CREDENTIAL'))
  expect(await ctx.llm.listModels('deepseek-official')).toEqual([])
})
