import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
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

function codexGrant(email: string, accountId: string, options: {
  readonly userId?: string
  readonly plan?: string
} = {}) {
  return {
    kind: 'grant' as const,
    payload: {
      type: 'oauth',
      access: jwt({
        'https://api.openai.com/profile': { email, name: 'Abdo Mohamed' },
        'https://api.openai.com/auth': {
          chatgpt_account_id: accountId,
          chatgpt_user_id: options.userId ?? email,
          chatgpt_plan_type: options.plan ?? 'plus',
        },
      }),
      refresh: `refresh-${accountId}`,
      expires: Date.now() + 3_600_000,
      accountId,
    },
  }
}

function usageResponse(primaryUsedPercent: number, secondaryUsedPercent = primaryUsedPercent): Response {
  return new Response(JSON.stringify({
    rate_limit: {
      primary_window: { used_percent: primaryUsedPercent, limit_window_seconds: 18_000, reset_after_seconds: 900 },
      secondary_window: {
        used_percent: secondaryUsedPercent, limit_window_seconds: 604_800, reset_after_seconds: 86_400,
      },
    },
  }), { status: 200 })
}

describe('the Harnessy accounts Remote namespace', () => {
  it('owns the account-management methods and reports unavailable composition safely', async () => {
    const empty = new Context()
    await empty.plugin(AccountsController)
    expect(await empty.accountsController.describe()).toMatchObject({ writable: false, accounts: [] })
    const { controller } = await boot()
    expect(remoteMethods(controller).map(method => method.method)).toEqual([
      'describe', 'addOAuth', 'addApiKey', 'activate', 'setAutoSwitch', 'rename', 'deleteAccount', 'refreshUsage',
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

  it('migrates workspace-only legacy Codex ids without losing the active account', async () => {
    const { ctx, controller } = await boot()
    const credential = codexGrant('abdo@example.com', 'shared-workspace', { userId: 'user-abdo' })
    await ctx.credentials.modifyRecord(credentialKey('account-manager', 'accounts'), () => Promise.resolve({
      kind: 'grant',
      payload: {
        version: 1,
        providers: {
          'openai-codex': {
            activeAccountId: 'legacy-workspace-id',
            accounts: {
              'legacy-workspace-id': {
                id: 'legacy-workspace-id',
                provider: 'openai-codex',
                authMode: 'oauth',
                credential,
                name: 'Custom account name',
                createdAt: 1,
              },
            },
          },
        },
      },
    }))

    const state = await controller.describe()
    expect(state.accounts).toEqual([expect.objectContaining({
      active: true,
      name: 'Custom account name',
    })])
    expect(state.accounts[0]?.ownerId).toMatch(/^owner_/u)
    expect(state.accounts[0]?.id).not.toBe('legacy-workspace-id')
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

  it('keeps two user seats in the same ChatGPT workspace as separate accounts', async () => {
    const { ctx, controller } = await boot({ openUrl: async () => {} })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    await ctx.credentials.modifyRecord(key, () =>
      Promise.resolve(codexGrant('first@example.com', 'shared-workspace', { userId: 'user-first', plan: 'business' })))
    await controller.describe()
    ctx.authorization.registerFlow({
      key,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Browser login' }],
      async run() {
        await ctx.credentials.modifyRecord(key, () =>
          Promise.resolve(codexGrant('second@example.com', 'shared-workspace', {
            userId: 'user-second', plan: 'business',
          })))
      },
    })

    await controller.addOAuth('openai-codex', new AbortController().signal)
    const state = await controller.describe()
    expect(state.providers.find(provider => provider.id === 'openai-codex')?.accountCount).toBe(2)
    expect(state.accounts.map(account => account.id)).toHaveLength(2)
    expect(new Set(state.accounts.map(account => account.id)).size).toBe(2)
    expect(new Set(state.accounts.map(account => account.ownerId)).size).toBe(2)
  })

  it('groups one user\'s Personal and Workspace memberships for the usage switch', async () => {
    const { ctx, controller } = await boot({ openUrl: async () => {} })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    await ctx.credentials.modifyRecord(key, () =>
      Promise.resolve(codexGrant('abdo@example.com', 'personal-context', { userId: 'user-abdo' })))
    await controller.describe()
    ctx.authorization.registerFlow({
      key,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Browser login' }],
      async run() {
        await ctx.credentials.modifyRecord(key, () =>
          Promise.resolve(codexGrant('abdo@example.com', 'workspace-context', {
            userId: 'user-abdo', plan: 'business',
          })))
      },
    })

    await controller.addOAuth('openai-codex', new AbortController().signal)
    const state = await controller.describe()
    expect(state.providers.find(provider => provider.id === 'openai-codex')?.accountCount).toBe(1)
    expect(state.accounts).toHaveLength(2)
    expect(new Set(state.accounts.map(account => account.ownerId)).size).toBe(1)
    expect(state.accounts.map(account => account.usageScope).sort()).toEqual(['personal', 'workspace'])
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

  it('serializes overlapping Host usage refreshes', async () => {
    let releaseFirst!: () => void
    const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve })
    let requests = 0
    const fetchUsage = vi.fn(async () => {
      requests += 1
      if (requests === 1) await firstResponse
      return usageResponse(20)
    }) as typeof fetch
    const { ctx, controller } = await boot({ fetchUsage })
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () =>
      Promise.resolve(codexGrant('abdo@example.com', 'account-a')))

    const first = controller.refreshUsage(new AbortController().signal)
    await vi.waitFor(() => { expect(requests).toBe(1) })
    const second = controller.refreshUsage(new AbortController().signal)
    await Promise.resolve()
    expect(requests).toBe(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(requests).toBe(2)
  })

  it('automatically switches to another seat in the same Workspace with capacity', async () => {
    let request = 0
    const fetchUsage = vi.fn(async () => request++ === 0 ? usageResponse(100, 40) : usageResponse(20)) as typeof fetch
    const { ctx, controller } = await boot({ fetchUsage, openUrl: async () => {} })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const first = codexGrant('first@example.com', 'shared-workspace', {
      userId: 'user-first', plan: 'business',
    })
    const second = codexGrant('second@example.com', 'shared-workspace', {
      userId: 'user-second', plan: 'business',
    })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(first))
    await controller.describe()
    await controller.setAutoSwitch('openai-codex', true)
    ctx.authorization.registerFlow({
      key,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Browser login' }],
      async run() { await ctx.credentials.modifyRecord(key, () => Promise.resolve(second)) },
    })
    await controller.addOAuth('openai-codex', new AbortController().signal)

    const preference = await controller.describe()
    expect(preference.providers.find(provider => provider.id === 'openai-codex')?.autoSwitchOnLimit).toBe(true)
    const switches: unknown[] = []
    ctx.on('accounts/auto-switched', (event) => { switches.push(event) })
    const state = await controller.refreshUsage(new AbortController().signal)
    expect(state.accounts.find(account => account.detail?.startsWith('second@example.com'))?.active).toBe(true)
    expect(await ctx.credentials.readRecord(key)).toEqual(second)
    expect(switches).toEqual([expect.objectContaining({
      provider: 'openai-codex',
      limit: '5h',
      from: { name: 'Abdo Mohamed', usageScope: 'workspace' },
      to: { name: 'Abdo Mohamed', usageScope: 'workspace' },
    })])
  })

  it('refreshes and switches an exhausted Codex account before returning the next model request', async () => {
    let request = 0
    const fetchUsage = vi.fn(async () => request++ === 0 ? usageResponse(100, 40) : usageResponse(20)) as typeof fetch
    const { ctx, controller } = await boot({ fetchUsage, openUrl: async () => {} })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const first = codexGrant('first@example.com', 'shared-workspace', {
      userId: 'user-first', plan: 'business',
    })
    const second = codexGrant('second@example.com', 'shared-workspace', {
      userId: 'user-second', plan: 'business',
    })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(first))
    await controller.describe()
    await controller.setAutoSwitch('openai-codex', true)
    ctx.authorization.registerFlow({
      key,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Browser login' }],
      async run() { await ctx.credentials.modifyRecord(key, () => Promise.resolve(second)) },
    })
    await controller.addOAuth('openai-codex', new AbortController().signal)

    const config = { provider: 'openai-codex', model: 'gpt-5' }
    const agent = {} as Agent
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request',
      { turn: 1, step: 0, signal: new AbortController().signal },
      () => Promise.resolve(config),
    )).resolves.toBe(config)

    expect(await ctx.credentials.readRecord(key)).toEqual(second)
  })

  it('switches a Codex account at the pre-request safety threshold', async () => {
    let request = 0
    const fetchUsage = vi.fn(async () => request++ === 0 ? usageResponse(95, 40) : usageResponse(20)) as typeof fetch
    const { ctx, controller } = await boot({ fetchUsage, openUrl: async () => {} })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const first = codexGrant('first@example.com', 'shared-workspace', {
      userId: 'user-first', plan: 'business',
    })
    const second = codexGrant('second@example.com', 'shared-workspace', {
      userId: 'user-second', plan: 'business',
    })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(first))
    await controller.describe()
    await controller.setAutoSwitch('openai-codex', true)
    ctx.authorization.registerFlow({
      key,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Browser login' }],
      async run() { await ctx.credentials.modifyRecord(key, () => Promise.resolve(second)) },
    })
    await controller.addOAuth('openai-codex', new AbortController().signal)

    const config = { provider: 'openai-codex', model: 'gpt-5' }
    const agent = {} as Agent
    await agentEvents(ctx, agent).waterfall(
      'agent/request',
      { turn: 1, step: 0, signal: new AbortController().signal },
      () => Promise.resolve(config),
    )

    expect(await ctx.credentials.readRecord(key)).toEqual(second)
  })

  it('switches and retries after a Codex quota failure reaches the request boundary', async () => {
    let request = 0
    const fetchUsage = vi.fn(async () => request++ === 0 ? usageResponse(100, 40) : usageResponse(20)) as typeof fetch
    const { ctx, controller } = await boot({ fetchUsage, openUrl: async () => {} })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const first = codexGrant('first@example.com', 'shared-workspace', {
      userId: 'user-first', plan: 'business',
    })
    const second = codexGrant('second@example.com', 'shared-workspace', {
      userId: 'user-second', plan: 'business',
    })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(first))
    await controller.describe()
    await controller.setAutoSwitch('openai-codex', true)
    ctx.authorization.registerFlow({
      key,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Browser login' }],
      async run() { await ctx.credentials.modifyRecord(key, () => Promise.resolve(second)) },
    })
    await controller.addOAuth('openai-codex', new AbortController().signal)

    const action = await agentEvents(ctx, {} as Agent).waterfall(
      'agent/request-error',
      {
        turn: 1,
        step: 1,
        provider: 'openai-codex',
        failure: { code: 'QUOTA', message: 'usage limit reached' },
        retryPolicy: undefined,
        signal: new AbortController().signal,
      },
      () => Promise.resolve(undefined),
    )

    expect(action).toEqual({ kind: 'retry' })
    expect(await ctx.credentials.readRecord(key)).toEqual(second)
  })

  it('uses the same owner\'s Workspace membership when their Personal limit is exhausted', async () => {
    const fetchUsage = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const accountId = new Headers(init?.headers).get('chatgpt-account-id')
      return accountId === 'personal-context' ? usageResponse(20, 100) : usageResponse(15)
    }) as typeof fetch
    const { ctx, controller } = await boot({ fetchUsage, openUrl: async () => {} })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const personal = codexGrant('abdo@example.com', 'personal-context', { userId: 'user-abdo' })
    const workspace = codexGrant('abdo@example.com', 'workspace-context', {
      userId: 'user-abdo', plan: 'business',
    })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(personal))
    await controller.describe()
    ctx.authorization.registerFlow({
      key,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Browser login' }],
      async run() { await ctx.credentials.modifyRecord(key, () => Promise.resolve(workspace)) },
    })
    await controller.addOAuth('openai-codex', new AbortController().signal)
    await controller.setAutoSwitch('openai-codex', true)

    const state = await controller.refreshUsage(new AbortController().signal)
    expect(state.accounts.find(account => account.usageScope === 'workspace')?.active).toBe(true)
    expect(await ctx.credentials.readRecord(key)).toEqual(workspace)
  })

  it('does not automatically cross between unrelated Workspaces', async () => {
    const fetchUsage = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const accountId = new Headers(init?.headers).get('chatgpt-account-id')
      return accountId === 'workspace-one' ? usageResponse(100, 30) : usageResponse(10)
    }) as typeof fetch
    const { ctx, controller } = await boot({ fetchUsage, openUrl: async () => {} })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const first = codexGrant('first@example.com', 'workspace-one', {
      userId: 'user-first', plan: 'business',
    })
    const unrelated = codexGrant('second@example.com', 'workspace-two', {
      userId: 'user-second', plan: 'business',
    })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(first))
    await controller.describe()
    ctx.authorization.registerFlow({
      key,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Browser login' }],
      async run() { await ctx.credentials.modifyRecord(key, () => Promise.resolve(unrelated)) },
    })
    await controller.addOAuth('openai-codex', new AbortController().signal)
    await controller.setAutoSwitch('openai-codex', true)

    const state = await controller.refreshUsage(new AbortController().signal)
    expect(state.accounts.find(account => account.detail?.startsWith('first@example.com'))?.active).toBe(true)
    expect(await ctx.credentials.readRecord(key)).toEqual(first)
  })
})
