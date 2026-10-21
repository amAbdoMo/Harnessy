import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { requestFetch } from '../src/request-fetch.ts'
import { memoryAuth } from './auth-double.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('provider HTTP failures', () => {
  it('retains a socket code in the SDK terminal failure without exposing the nested message', async () => {
    const cause = Object.assign(new Error('private endpoint and credential detail'), { code: 'UND_ERR_SOCKET' })
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed', { cause }) })
    const access = `header.${Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-membership' },
    })).toString('base64url')}.signature`
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ 'openai-codex': { transport: 'sse' } }),
      resolveApiKey: async () => access,
      auth: memoryAuth({ 'openai-codex': { type: 'oauth', access, refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 } }),
    })
    const [model] = getBuiltinModels('openai-codex')
    if (model === undefined) throw new Error('installed Codex catalog is empty')
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'openai-codex', model: model.id, messages: [] })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: {
      kind: 'error', failure: { code: 'TRANSPORT', message: 'fetch failed (UND_ERR_SOCKET)' },
    } })
    expect(JSON.stringify(chunks)).not.toContain('private endpoint')
  })

  it('retains distinct connection codes from an aggregate fetch cause', async () => {
    const cause = new AggregateError([
      Object.assign(new Error('private IPv6 address'), { code: 'ENETUNREACH' }),
      Object.assign(new Error('private IPv4 address'), { code: 'ETIMEDOUT' }),
    ])
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed', { cause }) })
    await expect(requestFetch('https://provider.invalid')).rejects.toMatchObject({
      message: 'fetch failed (ENETUNREACH, ETIMEDOUT)',
    })
  })

  it.each([
    new TypeError('fetch failed'),
    new TypeError('fetch failed', { cause: Object.assign(new Error('secret'), { code: 'private-secret' }) }),
    new DOMException('cancelled', 'AbortError'),
  ])('preserves an error without a recognized fetch cause', async (error) => {
    vi.stubGlobal('fetch', async () => { throw error })
    await expect(requestFetch('https://provider.invalid')).rejects.toBe(error)
  })
})
