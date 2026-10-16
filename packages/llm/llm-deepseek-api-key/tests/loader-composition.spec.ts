/** Source Loader composition keeps keyless settings available without inference requests. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as ApiKey from '../src/index.ts'

it('discovers live credentials through cordis.yml while retaining the entry settings and disposing registrations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-deepseek-discovery-'))
  const ctx = new Context()
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected discovery network request'))
  try {
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: llm',
      '  name: cordis:test-llm',
      '- id: credentials',
      '  name: cordis:test-credentials',
      '- id: llm-deepseek',
      '  name: cordis:test-api-key',
      '  config:',
      '    apiKeyEnv: DISCOVERY_ROUTE_KEY',
      '    models:',
      '      - id: configured-model',
      '        name: Configured model',
      '        inputModalities: [text]',
      '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    // Builtin aliases load the real source plugins without Node package resolution.
    Object.assign(ctx.loader.builtins, {
      include: Include,
      'test-llm': LlmRuntime,
      'test-credentials': MemoryCredentials,
      'test-api-key': ApiKey,
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    const llm = ctx.llm
    const settings = [{ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] }]
    expect(llm.listConfigurableProviders()).toEqual(settings)
    expect(await llm.listModels('deepseek-official')).toEqual([])

    const ref = credentialRef('DISCOVERY_ROUTE_KEY')
    await ctx.credentials.set(ref, 'fixture-route-key')
    expect(await llm.listModels('deepseek-official')).toEqual([{
      provider: 'deepseek-official', id: 'configured-model', name: 'Configured model', inputModalities: ['text'],
    }])
    await ctx.credentials.unset(ref)
    expect(await llm.listModels('deepseek-official')).toEqual([])
    expect(llm.listConfigurableProviders()).toEqual(settings)

    await ctx.fiber.dispose()
    expect(llm.listProviders()).toEqual([])
    expect(llm.listConfigurableProviders()).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    try {
      await ctx.fiber.dispose()
    } finally {
      fetch.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  }
})
