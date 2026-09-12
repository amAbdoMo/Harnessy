import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import AccountsController from '../src/accounts.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'

const PiAiSettings = z.object({ providers: z.dict(z.object({})).default({}) })

async function boot(internals: ConstructorParameters<typeof AccountsController>[1] = {}) {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(MemorySettings)
  ctx.settings.register('llm-pi-ai', PiAiSettings)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(AccountsController, internals)
  return { ctx, controller: ctx.accountsController }
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function codexGrant(email: string, accountId: string) {
  return {
    kind: 'grant' as const,
    payload: {
      type: 'oauth',
      access: jwt({
        'https://api.openai.com/profile': { email, name: 'Abdo Mohamed' },
        'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' },
      }),
      refresh: `refresh-${accountId}`,
      expires: Date.now() + 3_600_000,
      accountId,
    },
  }
}

describe('the Harnessy accounts Remote namespace', () => {
  it('owns the account-management methods and reports unavailable composition safely', async () => {
    const empty = new Context()
    await empty.plugin(AccountsController)
    expect(await empty.accountsController.describe()).toMatchObject({ writable: false, accounts: [] })
    const { controller } = await boot()
    expect(remoteMethods(controller).map(method => method.method)).toEqual([
      'describe', 'addOAuth', 'addApiKey', 'activate', 'rename', 'deleteAccount', 'refreshUsage',
    ])
  })

  it('imports the existing Codex identity without exposing its OAuth material', async () => {
    const { ctx, controller } = await boot()
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () =>
      Promise.resolve(codexGrant('abdo@example.com', 'account-a')))
    const state = await controller.describe()
    expect(state.accounts).toEqual([expect.objectContaining({
      provider: 'openai-codex', name: 'Abdo Mohamed', detail: 'abdo@example.com · PLUS', active: true,
    })])
    expect(JSON.stringify(state)).not.toContain('refresh-account-a')
    expect(JSON.stringify(state)).not.toContain('signature')
  })

  it('adds, renames, switches, and removes API-key accounts while syncing the active route', async () => {
    const { ctx, controller } = await boot()
    const first = await controller.addApiKey('zai', 'Work GLM', 'glm-secret-one')
    const firstAccount = first.accounts.find(account => account.provider === 'zai')
    expect(firstAccount).toMatchObject({ name: 'Work GLM', active: true })
    const second = await controller.addApiKey('zai', 'Spare GLM', 'glm-secret-two')
    const spare = second.accounts.find(account => account.name === 'Spare GLM')
    expect(spare?.active).toBe(false)
    const switched = await controller.activate('zai', spare!.id)
    expect(switched.accounts.find(account => account.id === spare!.id)?.active).toBe(true)
    expect(await ctx.credentials.readRecord(credentialKey('llm-pi-ai', 'zai')))
      .toEqual({ kind: 'api-key', key: 'glm-secret-two' })
    const renamed = await controller.rename('zai', spare!.id, 'Personal GLM')
    expect(renamed.accounts.find(account => account.id === spare!.id)?.name).toBe('Personal GLM')
    const removed = await controller.deleteAccount('zai', spare!.id)
    expect(removed.accounts).toHaveLength(1)
    expect(removed.accounts[0]?.active).toBe(true)
    expect(ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai')?.value)
      .toEqual({ providers: { zai: {} } })
  })

  it('adds a browser OAuth account and preserves a previously active identity', async () => {
    const openUrl = vi.fn(async () => {})
    const { ctx, controller } = await boot({ openUrl })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const first = codexGrant('first@example.com', 'account-first')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(first))
    await controller.describe()
    ctx.authorization.registerFlow({
      key,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Browser login' }],
      async run(session) {
        session.notify({ message: 'Open browser', url: 'https://auth.openai.com/login' })
        await ctx.credentials.modifyRecord(key, () => Promise.resolve(codexGrant('second@example.com', 'account-second')))
      },
    })
    await expect(controller.addOAuth('openai-codex', new AbortController().signal))
      .resolves.toEqual({ status: 'authorized' })
    expect(openUrl).toHaveBeenCalledOnce()
    expect((await controller.describe()).accounts).toHaveLength(2)
    expect(await ctx.credentials.readRecord(key)).toEqual(first)
  })

  it('restores the active identity when a browser OAuth flow fails after writing', async () => {
    const { ctx, controller } = await boot({ openUrl: async () => {} })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const first = codexGrant('first@example.com', 'account-first')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(first))
    await controller.describe()
    ctx.authorization.registerFlow({
      key,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Browser login' }],
      async run() {
        await ctx.credentials.modifyRecord(key, () =>
          Promise.resolve(codexGrant('failed@example.com', 'account-failed')))
        throw new Error('provider rejected the sign-in')
      },
    })
    await expect(controller.addOAuth('openai-codex', new AbortController().signal))
      .rejects.toThrow('provider rejected the sign-in')
    expect(await ctx.credentials.readRecord(key)).toEqual(first)
  })

  it('refreshes Codex usage into browser-safe windows', async () => {
    let requestedAccountId: string | null = null
    const fetchUsage = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestedAccountId = new Headers(init?.headers).get('chatgpt-account-id')
      return new Response(JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 40,
            limit_window_seconds: 18_000,
            reset_after_seconds: 900,
          },
          secondary_window: {
            used_percent: 12,
            limit_window_seconds: 604_800,
            reset_at: 2_000_000_000,
          },
        },
      }), { status: 200 })
    }) as typeof fetch
    const now = 1_900_000_000_000
    const { ctx, controller } = await boot({ fetchUsage, now: () => now })
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () =>
      Promise.resolve({ ...codexGrant('abdo@example.com', 'account-a'), payload: {
        ...codexGrant('abdo@example.com', 'account-a').payload,
        expires: now + 3_600_000,
      } }))
    const state = await controller.refreshUsage(new AbortController().signal)
    expect(state.accounts[0]?.usage?.windows).toEqual([
      expect.objectContaining({ label: '5h', usedPercent: 40, resetsAtMs: now + 900_000 }),
      expect.objectContaining({ label: '7d', usedPercent: 12, resetsAtMs: 2_000_000_000_000 }),
    ])
    expect(fetchUsage).toHaveBeenCalledOnce()
    expect(requestedAccountId).toBe('account-a')
  })
})
