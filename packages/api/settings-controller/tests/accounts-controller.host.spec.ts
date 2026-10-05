import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import AccountsController from '../src/accounts.ts'
import type { AccountAutoSwitchEvent } from '../src/types.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { MemorySettings } from './memory-settings.ts'
import { credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai/src/auth.ts'

const { oauthRefresh } = vi.hoisted(() => ({ oauthRefresh: vi.fn() }))
vi.mock('@earendil-works/pi-ai/providers/openai-codex', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-ai/providers/openai-codex')>()
  return { ...original, openaiCodexProvider: () => {
    const provider = original.openaiCodexProvider()
    if (provider.auth.oauth !== undefined) provider.auth.oauth.refresh = oauthRefresh
    return provider
  } }
})

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  oauthRefresh.mockReset()
})

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

async function seedOAuth(ctx: Context, credential: ReturnType<typeof codexGrant>): Promise<void> {
  const fixture = context()
  await fixture.plugin(MemoryCredentials)
  await fixture.plugin(AccountsController)
  await fixture.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () => Promise.resolve(credential))
  await fixture.accountsController.describe()
  const key = credentialKey('account-manager', 'accounts')
  const seed = await fixture.credentials.readRecord(key)
  if (seed?.kind !== 'grant') throw new Error('fixture did not import its grant')
  type FixtureVault = {
    version: 1
    providers: Record<string, {
      accounts: Record<string, object>
      activeAccountId?: string
      autoSwitchOnLimit?: boolean
    }>
  }
  const imported = seed.payload as FixtureVault
  await ctx.credentials.modifyRecord(key, (record) => {
    const vault = record?.kind === 'grant' ? record.payload as FixtureVault : { version: 1 as const, providers: {} }
    const provider = vault.providers['openai-codex'] ?? imported.providers['openai-codex']!
    return Promise.resolve({ kind: 'grant', payload: {
      ...vault,
      providers: { ...vault.providers, 'openai-codex': {
        ...provider, accounts: { ...provider.accounts, ...imported.providers['openai-codex']!.accounts },
      } },
    } })
  })
}

async function boot(
  internals: ConstructorParameters<typeof AccountsController>[1] = {},
  beforeAccounts?: (ctx: Context) => void,
) {
  const ctx = context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(AuthorizationService)
  beforeAccounts?.(ctx)
  await ctx.plugin(AccountsController, internals)
  return { ctx, controller: ctx.accountsController }
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() =>{  reject(new Error('fixture interleaving did not settle')) }, 2000)
  })
  try { return await Promise.race([operation, timeout]) }
  finally { clearTimeout(timer) }
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
      type: 'oauth' as const,
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
    const empty = context()
    await empty.plugin(AccountsController)
    expect(await empty.accountsController.describe()).toMatchObject({ writable: false, accounts: [] })
    const { controller } = await boot()
    expect(remoteMethods(controller).map(method => method.method)).toEqual([
      'describe', 'addOAuth', 'addApiKey', 'activate', 'setAutoSwitch', 'consumeResetCredit', 'rename', 'deleteAccount',
      'refreshUsage',
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

  it('restores the model route for an active account when the Host starts', async () => {
    const ctx = context()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(MemorySettings)
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () =>
      Promise.resolve(codexGrant('abdo@example.com', 'account-a')))
    await ctx.plugin(AccountsController)

    await vi.waitFor(() => {
      expect(ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai')?.value)
        .toEqual({ providers: { 'openai-codex': {} } })
    })
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

  it('refuses unstaged OAuth adding before a flow can overwrite the active request credential', async () => {
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
      .rejects.toMatchObject({ code: 'UNSUPPORTED_DESTINATION' })
    expect(openUrl).not.toHaveBeenCalled()
    expect((await controller.describe()).accounts).toHaveLength(1)
    expect(await ctx.credentials.readRecord(key)).toEqual(first)
  })

  it('adds a staged OAuth identity while manual selection remains usable and authoritative', async () => {
    const { ctx, controller } = await boot({ openUrl: async () => {} })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const personal = codexGrant('first@example.com', 'personal')
    const work = codexGrant('first@example.com', 'work', { plan: 'business' })
    const extra = codexGrant('second@example.com', 'shared-work', { plan: 'business' })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(personal))
    await controller.describe()
    await seedOAuth(ctx, work)
    const target = (await controller.describe()).accounts.find(account => account.usageScope === 'workspace')!
    let release!: () => void
    let entered!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    ctx.authorization.registerFlow({
      key, label: 'Codex', methods: [{ id: 'oauth', label: 'Sign in' }], supportsDestination: true,
      async run(session) {
        entered()
        await pending
        await session.commit(extra)
      },
    })
    const adding = controller.addOAuth('openai-codex', new AbortController().signal)
    let switching: ReturnType<AccountsController['activate']> | undefined
    try {
      await Promise.race([started, adding.then(() => { throw new Error('login settled before the staged flow ran') })])
      switching = controller.activate('openai-codex', target.id)
      let selected = false
      void switching.then(() => { selected = true }, () => {})
      await vi.waitFor(() =>{  expect(selected).toBe(true) })
      await switching
      expect(await ctx.credentials.readRecord(key)).toEqual(work)
      release()
      await expect(adding).resolves.toEqual({ status: 'authorized' })
      expect(await ctx.credentials.readRecord(key)).toEqual(work)
      const state = await controller.describe()
      expect(state.accounts).toHaveLength(3)
      expect(state.accounts.find(account => account.id === target.id)?.active).toBe(true)
      expect(state.accounts.find(account => account.detail?.includes('second@example.com'))?.active).toBe(false)
      expect((await ctx.credentials.listRecords()).some(record => record.key.startsWith('account-manager/login-'))).toBe(false)
    } finally {
      release()
      await Promise.allSettled([adding, ...switching === undefined ? [] : [switching]])
    }
  })

  it('keeps two user seats in the same ChatGPT workspace as separate accounts', async () => {
    const { ctx, controller } = await boot({ openUrl: async () => {} })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    await ctx.credentials.modifyRecord(key, () =>
      Promise.resolve(codexGrant('first@example.com', 'shared-workspace', { userId: 'user-first', plan: 'business' })))
    await controller.describe()
    await seedOAuth(ctx, codexGrant('second@example.com', 'shared-workspace', {
      userId: 'user-second', plan: 'business',
    }))
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
    await seedOAuth(ctx, codexGrant('abdo@example.com', 'workspace-context', {
      userId: 'user-abdo', plan: 'business',
    }))
    const state = await controller.describe()
    expect(state.providers.find(provider => provider.id === 'openai-codex')?.accountCount).toBe(1)
    expect(state.accounts).toHaveLength(2)
    expect(new Set(state.accounts.map(account => account.ownerId)).size).toBe(1)
    expect(state.accounts.map(account => account.usageScope).sort()).toEqual(['personal', 'workspace'])
  })

  it('removes a first-login credential when its browser OAuth flow fails after writing', async () => {
    const { ctx, controller } = await boot({ openUrl: async () => {} })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    ctx.authorization.registerFlow({
      key,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Browser login' }],
      supportsDestination: true,
      async run(session) {
        await session.commit(codexGrant('failed@example.com', 'account-failed'))
        throw new Error('provider rejected the sign-in')
      },
    })
    await expect(controller.addOAuth('openai-codex', new AbortController().signal))
      .rejects.toThrow('provider rejected the sign-in')
    expect(await ctx.credentials.readRecord(key)).toBeUndefined()
  })

  it('refreshes Codex usage into browser-safe windows', async () => {
    let requestedAccountId: string | null = null
    const fetchUsage = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestedAccountId = new Headers(init?.headers).get('chatgpt-account-id')
      return new Response(JSON.stringify({
        rate_limit_reset_credits: { available_count: 1 },
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
    expect(state.accounts[0]?.usage).toEqual({
      windows: [
        expect.objectContaining({ label: '5h', usedPercent: 40, resetsAtMs: now + 900_000 }),
        expect.objectContaining({ label: '7d', usedPercent: 12, resetsAtMs: 2_000_000_000_000 }),
      ],
      resetCredits: { availableCount: 1 },
    })
    expect(fetchUsage).toHaveBeenCalledOnce()
    expect(requestedAccountId).toBe('account-a')
  })

  it('consumes a provider reset credit idempotently and refreshes usage', async () => {
    const requests: Array<{ readonly input: string; readonly init?: RequestInit }> = []
    const fetchUsage = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requests.push({ input: requestUrl, ...init === undefined ? {} : { init } })
      if (requests.length === 1) return new Response(JSON.stringify({ code: 'reset', windows_reset: 2 }), { status: 200 })
      return new Response(JSON.stringify({
        rate_limit_reset_credits: { available_count: 0 },
        rate_limit: {
          primary_window: { used_percent: 0, limit_window_seconds: 18_000, reset_after_seconds: 18_000 },
          secondary_window: { used_percent: 0, limit_window_seconds: 604_800, reset_after_seconds: 604_800 },
        },
      }), { status: 200 })
    }) as typeof fetch
    const { ctx, controller } = await boot({ fetchUsage })
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () =>
      Promise.resolve(codexGrant('abdo@example.com', 'account-a')))
    const account = (await controller.describe()).accounts[0]!

    const result = await controller.consumeResetCredit(account.id, 'reset-attempt-1', new AbortController().signal)

    expect(result.outcome).toBe('reset')
    expect(result.state.accounts[0]?.usage?.resetCredits).toEqual({ availableCount: 0 })
    expect(requests[0]?.input).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume')
    expect(requests[0]?.init?.method).toBe('POST')
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ redeem_request_id: 'reset-attempt-1' }))
    expect(new Headers(requests[0]?.init?.headers).get('chatgpt-account-id')).toBe('account-a')
  })

  it.each([
    ['nothing_to_reset', 'nothing-to-reset'],
    ['no_credit', 'no-credit'],
    ['already_redeemed', 'already-redeemed'],
  ] as const)('decodes the provider reset-credit outcome %s', async (code, outcome) => {
    let request = 0
    const fetchUsage = vi.fn(async () => request++ === 0
      ? new Response(JSON.stringify({ code, windows_reset: 0 }), { status: 200 })
      : usageResponse(20)) as typeof fetch
    const { ctx, controller } = await boot({ fetchUsage })
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () =>
      Promise.resolve(codexGrant('abdo@example.com', 'account-a')))
    const account = (await controller.describe()).accounts[0]!

    const result = await controller.consumeResetCredit(account.id, `attempt-${code}`, new AbortController().signal)

    expect(result.outcome).toBe(outcome)
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
    await Promise.resolve(undefined)
    expect(requests).toBe(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(requests).toBe(2)
  })

  it('keeps a manual switch that lands while a usage refresh is in flight', async () => {
    let releaseFirst!: () => void
    const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve })
    let requests = 0
    const fetchUsage = vi.fn(async () => {
      requests += 1
      if (requests === 1) await firstResponse
      return usageResponse(20)
    }) as typeof fetch
    const { ctx, controller } = await boot({ fetchUsage })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const first = codexGrant('first@example.com', 'account-first')
    const second = codexGrant('second@example.com', 'account-second')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(first))
    await controller.describe()
    await seedOAuth(ctx, second)
    const spare = (await controller.describe()).accounts
      .find(account => account.detail?.startsWith('second@example.com'))
    expect(spare).toBeDefined()

    const refresh = controller.refreshUsage(new AbortController().signal)
    await vi.waitFor(() => { expect(requests).toBe(1) })
    await controller.activate('openai-codex', spare!.id)
    releaseFirst()
    const state = await refresh

    expect(state.accounts).toHaveLength(2)
    expect(state.accounts.find(account => account.active)?.id).toBe(spare!.id)
    expect(state.accounts.every(account => account.usage !== undefined)).toBe(true)
    expect(await ctx.credentials.readRecord(key)).toEqual(second)
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
    await seedOAuth(ctx, second)

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
    await seedOAuth(ctx, second)

    const config = { provider: 'openai-codex', model: 'gpt-5' }
    const agent = {} as Agent
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request',
      { turn: 1, step: 0, signal: new AbortController().signal },
      () => Promise.resolve(config),
    )).resolves.toBe(config)

    expect(await ctx.credentials.readRecord(key)).toEqual(second)
  })

  it('switches a Codex account when rounded usage reaches the displayed safety threshold', async () => {
    let request = 0
    const fetchUsage = vi.fn(async () => request++ === 0 ? usageResponse(94.6, 40) : usageResponse(20)) as typeof fetch
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
    await seedOAuth(ctx, second)

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
    const fetchUsage = vi.fn(async () => request++ === 0 ? usageResponse(60, 40) : usageResponse(20)) as typeof fetch
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
    await seedOAuth(ctx, second)
    const switches: AccountAutoSwitchEvent[] = []
    ctx.on('accounts/auto-switched', (event) => { switches.push(event) })

    const agent = {} as Agent
    const payload = {
      turn: 1,
      step: 1,
      provider: 'openai-codex',
      failure: { code: 'QUOTA' as const, message: 'usage limit reached' },
      retryPolicy: undefined,
      signal: new AbortController().signal,
    }
    const action = await agentEvents(ctx, agent).waterfall(
      'agent/request-error',
      payload,
      () => Promise.resolve(undefined),
    )
    const secondAction = await agentEvents(ctx, agent).waterfall(
      'agent/request-error',
      payload,
      () => Promise.resolve({ kind: 'retry' as const }),
    )

    expect(action).toEqual({ kind: 'retry' })
    expect(secondAction).toEqual({ kind: 'retry' })
    expect(await ctx.credentials.readRecord(key)).toEqual(second)
    expect(switches).toEqual([expect.objectContaining({ reason: 'quota' })])
  })

  it('never recovers quota by retrying the failed account even when its usage looks reset', async () => {
    let request = 0
    const fetchUsage = vi.fn(async () => request++ === 0 ? usageResponse(10, 20) : usageResponse(100)) as typeof fetch
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
    await seedOAuth(ctx, second)
    const firstAccount = (await controller.describe()).accounts
      .find(account => account.detail?.startsWith('first@example.com'))
    expect(firstAccount).toBeDefined()
    await controller.activate('openai-codex', firstAccount!.id)

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

    expect(action).toBeUndefined()
    expect(await ctx.credentials.readRecord(key)).toEqual(first)
  })

  it('delegates quota failures to remaining retry listeners when every account is exhausted', async () => {
    const fetchUsage = vi.fn(async () => usageResponse(100, 100)) as typeof fetch
    const genericRetry = vi.fn()
    const { ctx, controller } = await boot({ fetchUsage, openUrl: async () => {} }, (context) => {
      context.on('agent/request-error', async (_payload, next) => {
        await next()
        genericRetry()
        return { kind: 'retry' }
      })
    })
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
    await seedOAuth(ctx, second)
    const finalRecovery = vi.fn(async () => ({ kind: 'retry' as const }))

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
      finalRecovery,
    )

    expect(action).toEqual({ kind: 'retry' })
    expect(genericRetry).toHaveBeenCalledOnce()
    expect(finalRecovery).toHaveBeenCalledOnce()
  })

  it('returns to an earlier Personal account when it regains the most capacity', async () => {
    let request = 0
    const fetchUsage = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const accountId = new Headers(init?.headers).get('chatgpt-account-id')
      const round = Math.floor(request++ / 2)
      if (round === 0) return accountId === 'personal-first' ? usageResponse(95) : usageResponse(20)
      return accountId === 'personal-first' ? usageResponse(10) : usageResponse(100)
    }) as typeof fetch
    const { ctx, controller } = await boot({ fetchUsage, openUrl: async () => {} })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const first = codexGrant('first@example.com', 'personal-first', { userId: 'user-first' })
    const second = codexGrant('second@example.com', 'personal-second', { userId: 'user-second' })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(first))
    await controller.describe()
    await seedOAuth(ctx, second)
    const firstAccount = (await controller.describe()).accounts
      .find(account => account.detail?.startsWith('first@example.com'))
    expect(firstAccount).toBeDefined()
    await controller.activate('openai-codex', firstAccount!.id)
    await controller.setAutoSwitch('openai-codex', true)

    const switched = await controller.refreshUsage(new AbortController().signal)
    expect(switched.accounts.find(account => account.detail?.startsWith('second@example.com'))?.active).toBe(true)
    const returned = await controller.refreshUsage(new AbortController().signal)
    expect(returned.accounts.find(account => account.detail?.startsWith('first@example.com'))?.active).toBe(true)
    expect(await ctx.credentials.readRecord(key)).toEqual(first)
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
    await seedOAuth(ctx, workspace)
    await controller.setAutoSwitch('openai-codex', true)

    const state = await controller.refreshUsage(new AbortController().signal)
    expect(state.accounts.find(account => account.usageScope === 'workspace')?.active).toBe(true)
    expect(await ctx.credentials.readRecord(key)).toEqual(workspace)
  })

  it('authorizes a first OAuth account and publishes only redacted account output', async () => {
    const openUrl = vi.fn(async () => {})
    const { ctx, controller } = await boot({ openUrl })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const grant = codexGrant('first@example.com', 'personal-first')
    ctx.authorization.registerFlow({
      key, label: 'Codex', methods: [{ id: 'oauth', label: 'Browser login' }], supportsDestination: true,
      async run(session) {
        session.notify({ message: 'Open browser', url: 'https://auth.openai.com/login' })
        await session.commit(grant)
      },
    })
    await expect(controller.addOAuth('openai-codex', new AbortController().signal)).resolves.toEqual({ status: 'authorized' })
    expect(openUrl).toHaveBeenCalledOnce()
    expect((await controller.describe()).accounts.map(({ name, detail, active, usageScope }) => ({ name, detail, active, usageScope })))
      .toMatchInlineSnapshot(`
        [
          {
            "active": true,
            "detail": "first@example.com · PLUS",
            "name": "Abdo Mohamed",
            "usageScope": "personal",
          },
        ]
      `)
    expect(await ctx.credentials.readRecord(key)).toEqual(grant)
  })

  it('preserves configured provider route options during activation and active-account removal', async () => {
    const { ctx, controller } = await boot()
    const first = (await controller.addApiKey('zai', 'First', 'fixture-one')).accounts[0]!
    const second = (await controller.addApiKey('zai', 'Second', 'fixture-two')).accounts.find(account => account.id !== first.id)!
    const route = { baseUrl: 'https://example.invalid/api', models: ['glm-test'], options: { temperature: 0.2 } }
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'zai'], value: route }])
    await controller.activate('zai', second.id)
    await controller.deleteAccount('zai', second.id)
    expect(ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai')?.value).toEqual({ providers: { zai: route } })
    expect(await ctx.credentials.readRecord(credentialKey('llm-pi-ai', 'zai'))).toEqual({ kind: 'api-key', key: 'fixture-one' })
  })

  it.each(['canonical', 'vault', 'route'] as const)('rolls back the selection when the %s write fails', async (failure) => {
    const { ctx, controller } = await boot()
    const first = (await controller.addApiKey('zai', 'First', 'fixture-one')).accounts[0]!
    const second = (await controller.addApiKey('zai', 'Second', 'fixture-two')).accounts.find(account => account.id !== first.id)!
    const vaultKey = credentialKey('account-manager', 'accounts')
    const canonicalKey = credentialKey('llm-pi-ai', 'zai')
    const beforeVault = await ctx.credentials.readRecord(vaultKey)
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', 'zai'] }])
    const original = ctx.credentials.modifyRecord.bind(ctx.credentials)
    let failed = false
    vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
      if (!failed && key === (failure === 'canonical' ? canonicalKey : failure === 'vault' ? vaultKey : undefined)) {
        failed = true
        throw new Error(`fixture ${failure} failure`)
      }
      return original(key, mutate)
    })
    if (failure === 'route') vi.spyOn(ctx.settings, 'mutate').mockRejectedValueOnce(new Error('fixture route failure'))
    await expect(controller.activate('zai', second.id)).rejects.toThrow(`fixture ${failure} failure`)
    expect(await ctx.credentials.readRecord(canonicalKey)).toEqual({ kind: 'api-key', key: 'fixture-one' })
    expect(await ctx.credentials.readRecord(vaultKey)).toEqual(beforeVault)
    expect(ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai')?.value).toEqual({ providers: {} })
  })

  it.each(['manual', 'delete-replacement', 'delete-active', 'disable', 'disable-enable'] as const)(
    'revalidates threshold switching after %s during a usage request', async (action) => {
      let release!: () => void
      let entered!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      const started = new Promise<void>((resolve) => { entered = resolve })
      let requests = 0
      const fetchUsage: typeof fetch = async (_input, init) => {
        if (requests++ === 0) { entered(); await held }
        return usageResponse(new Headers(init?.headers).get('chatgpt-account-id') === 'workspace-b' ? 20 : 100)
      }
      const { ctx, controller } = await boot({ fetchUsage })
      const key = credentialKey('llm-pi-ai', 'openai-codex')
      const first = codexGrant('owner@example.com', 'personal-a', { userId: 'owner' })
      const second = codexGrant('owner@example.com', 'workspace-b', { userId: 'owner', plan: 'business' })
      await ctx.credentials.modifyRecord(key, () => Promise.resolve(first))
      await controller.describe()
      await seedOAuth(ctx, second)
      await controller.setAutoSwitch('openai-codex', true)
      const accounts = (await controller.describe()).accounts
      const active = accounts.find(account => account.active)!
      const spare = accounts.find(account => !account.active)!
      const switches = vi.fn()
      ctx.on('accounts/auto-switched', switches)
      const pending = controller.refreshUsage(new AbortController().signal)
      await started
      try {
        if (action === 'manual') await controller.activate('openai-codex', active.id)
        else if (action === 'delete-replacement') await controller.deleteAccount('openai-codex', spare.id)
        else if (action === 'delete-active') await controller.deleteAccount('openai-codex', active.id)
        else {
          await controller.setAutoSwitch('openai-codex', false)
          if (action === 'disable-enable') await controller.setAutoSwitch('openai-codex', true)
        }
      } finally { release() }
      const state = await pending
      expect(state.accounts.find(account => account.active)?.id).toBe(action === 'delete-active' ? spare.id : active.id)
      expect(await ctx.credentials.readRecord(key)).toEqual(action === 'delete-active' ? second : first)
      expect(state.accounts).toHaveLength(action.startsWith('delete') ? 1 : 2)
      expect(switches).not.toHaveBeenCalled()
    },
  )

  it('imports a late canonical refresh into its matching person and membership, not the active account', async () => {
    const { ctx, controller } = await boot()
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const personal = codexGrant('owner@example.com', 'personal', { userId: 'owner' })
    const workspace = codexGrant('owner@example.com', 'workspace', { userId: 'owner', plan: 'business' })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(personal))
    await controller.describe()
    await seedOAuth(ctx, workspace)
    const before = (await controller.describe()).accounts
    const active = before.find(account => account.active)!
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(workspace))
    const after = (await controller.describe()).accounts
    expect(after).toEqual(before)
    const vault = await ctx.credentials.readRecord(credentialKey('account-manager', 'accounts'))
    expect(JSON.stringify(vault)).toContain(personal.payload.access)
    expect(after.find(account => account.active)?.id).toBe(active.id)
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(codexGrant('stranger@example.com', 'workspace', { userId: 'stranger' })))
    expect((await controller.describe()).accounts).toEqual(before)
  })

  it('persists a rotated OAuth grant before a later usage request fails, including shared refresh-token aliases', async () => {
    const now = Date.now()
    const personal = codexGrant('owner@example.com', 'personal', { userId: 'owner' })
    personal.payload.expires = now - 1
    const workspace = codexGrant('owner@example.com', 'workspace', { userId: 'owner', plan: 'business' })
    workspace.payload.refresh = personal.payload.refresh
    const rotated = { ...personal.payload, refresh: 'fixture-rotated-token', expires: now + 3_600_000 }
    oauthRefresh.mockResolvedValueOnce(rotated)
    const { ctx, controller } = await boot({ now: () => now, fetchUsage: async () => { throw new Error('fixture usage failure') } })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(personal))
    await controller.describe()
    await seedOAuth(ctx, workspace)
    const state = await controller.refreshUsage(new AbortController().signal)
    expect(oauthRefresh).toHaveBeenCalledOnce()
    expect(await ctx.credentials.readRecord(key)).toEqual({ kind: 'grant', payload: rotated })
    expect(JSON.stringify(await ctx.credentials.readRecord(credentialKey('account-manager', 'accounts'))))
      .not.toContain(personal.payload.refresh)
    expect(state.accounts.map(account => account.usageError)).toEqual(['Usage is temporarily unavailable.', 'Usage is temporarily unavailable.'])
  })

  it('rejects a refreshed Codex grant belonging to a different owner without persisting it', async () => {
    const original = codexGrant('owner@example.com', 'personal', { userId: 'owner' })
    original.payload.expires = Date.now() - 1
    const stranger = codexGrant('stranger@example.com', 'workspace', { userId: 'stranger', plan: 'business' })
    oauthRefresh.mockResolvedValueOnce(stranger.payload)
    const fetchUsage = vi.fn(async () => usageResponse(10))
    const { ctx, controller } = await boot({ fetchUsage })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(original))
    const state = await controller.refreshUsage(new AbortController().signal)
    expect(oauthRefresh).toHaveBeenCalledOnce()
    expect(fetchUsage).not.toHaveBeenCalled()
    expect(await ctx.credentials.readRecord(key)).toEqual(original)
    expect(state.accounts[0]?.usageError).toBe('Usage is temporarily unavailable.')
    expect(JSON.stringify(await ctx.credentials.readRecord(credentialKey('account-manager', 'accounts'))))
      .not.toContain('stranger')
  })

  it('waits for SDK refresh before selecting a stale saved grant and imports its shared token rotation', async () => {
    const { ctx, controller } = await boot()
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const personal = codexGrant('owner@example.com', 'personal', { userId: 'owner' })
    const workspace = codexGrant('owner@example.com', 'workspace', { userId: 'owner', plan: 'business' })
    const stranger = codexGrant('stranger@example.com', 'workspace', { userId: 'stranger', plan: 'business' })
    workspace.payload.refresh = stranger.payload.refresh = personal.payload.refresh
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(personal))
    const active = (await controller.describe()).accounts[0]!
    await seedOAuth(ctx, workspace)
    await seedOAuth(ctx, stranger)
    await controller.rename('openai-codex', active.id, 'My identity')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const rotated = { ...personal.payload, refresh: 'sdk-rotated-refresh', expires: Date.now() + 3_600_000 }
    const sdk = credentialStoreFrom(ctx).modify('openai-codex', async () => {
      entered.resolve(undefined)
      await release.promise
      return rotated
    })
    let selection: Promise<unknown> | undefined
    try {
      await bounded(entered.promise)
      let selected = false
      selection = controller.activate('openai-codex', active.id).then((state) => { selected = true; return state })
      await setImmediate()
      expect(selected).toBe(false)
      release.resolve(undefined)
      await bounded(Promise.all([sdk, selection]))
      expect(await ctx.credentials.readRecord(key)).toEqual({ kind: 'grant', payload: rotated })
      const state = await controller.describe()
      expect(state.accounts.find(account => account.active)?.name).toBe('My identity')
      const member = state.accounts.find(account => account.detail?.startsWith('owner@example.com') && account.usageScope === 'workspace')!
      const other = state.accounts.find(account => account.detail?.startsWith('stranger@example.com'))!
      const vault = await ctx.credentials.readRecord(credentialKey('account-manager', 'accounts'))
      expect(vault).toMatchObject({ kind: 'grant', payload: { providers: { 'openai-codex': { accounts: {
        [active.id]: { credential: { payload: rotated } },
        [member.id]: { credential: { payload: { ...workspace.payload, refresh: rotated.refresh } } },
        [other.id]: { credential: stranger },
      } } } } })
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([sdk, ...selection === undefined ? [] : [selection]])
    }
  })

  it('rechecks canonical credentials when SDK refresh lands after the initial vault import', async () => {
    const personal = codexGrant('owner@example.com', 'personal', { userId: 'owner' })
    personal.payload.expires = Date.now() - 1
    const rotated = { ...personal.payload, refresh: 'sdk-between-imports', expires: Date.now() + 3_600_000 }
    const requests: string[] = []
    const { ctx, controller } = await boot({ fetchUsage: async (_input, init) => {
      requests.push(new Headers(init?.headers).get('authorization') ?? '')
      return usageResponse(10)
    } })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(personal))
    await controller.describe()
    let sdk: Promise<unknown> | undefined
    const dispose = ctx.on('credentials/record-updated', (recordKey) => {
      if (recordKey === credentialKey('account-manager', 'accounts') && sdk === undefined) {
        sdk = credentialStoreFrom(ctx).modify('openai-codex', () => Promise.resolve(rotated))
      }
    })
    const usage = controller.refreshUsage(new AbortController().signal)
    try {
      await bounded(usage)
      expect(sdk).toBeDefined()
      await bounded(sdk!)
      expect(oauthRefresh).not.toHaveBeenCalled()
      expect(requests).toEqual([`Bearer ${rotated.access}`])
      expect(await ctx.credentials.readRecord(key)).toEqual({ kind: 'grant', payload: rotated })
      expect(JSON.stringify(await ctx.credentials.readRecord(credentialKey('account-manager', 'accounts'))))
        .toContain('sdk-between-imports')
    } finally {
      dispose()
      await Promise.allSettled([usage, ...sdk === undefined ? [] : [sdk]])
    }
  })

  it('merges SDK rotation before committing metadata from an earlier usage request', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const { ctx, controller } = await boot({ fetchUsage: async () => {
      entered.resolve(undefined)
      await release.promise
      return usageResponse(10)
    } })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const grant = codexGrant('owner@example.com', 'personal', { userId: 'owner' })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(grant))
    await controller.describe()
    const usage = controller.refreshUsage(new AbortController().signal)
    let sdk: Promise<unknown> | undefined
    const rotated = { ...grant.payload, refresh: 'sdk-during-usage', expires: Date.now() + 3_600_000 }
    try {
      await bounded(entered.promise)
      sdk = credentialStoreFrom(ctx).modify('openai-codex', () => Promise.resolve(rotated))
      await bounded(sdk)
      release.resolve(undefined)
      await bounded(usage)
      expect(await ctx.credentials.readRecord(key)).toEqual({ kind: 'grant', payload: rotated })
      expect(JSON.stringify(await ctx.credentials.readRecord(credentialKey('account-manager', 'accounts'))))
        .toContain('sdk-during-usage')
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([usage, ...sdk === undefined ? [] : [sdk]])
    }
  })

  it('excludes SDK and reset-credit access during controller refresh and persists before failed usage', async () => {
    const now = Date.now()
    const personal = codexGrant('owner@example.com', 'personal', { userId: 'owner' })
    personal.payload.expires = now - 1
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const rotated = { ...personal.payload, refresh: 'controller-rotated-refresh', expires: now + 3_600_000 }
    oauthRefresh.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      return rotated
    })
    const { ctx, controller } = await boot({ now: () => now, fetchUsage: async (_input, init) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ code: 'reset' }), { status: 200 })
      throw new Error('fixture usage failure')
    } })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(personal))
    const account = (await controller.describe()).accounts[0]!
    const usage = controller.refreshUsage(new AbortController().signal)
    let sdk: Promise<unknown> | undefined
    let reset: Promise<unknown> | undefined
    let sdkObserved: unknown
    try {
      await bounded(entered.promise)
      sdk = credentialStoreFrom(ctx).modify('openai-codex', async (current) => {
        sdkObserved = current
        return undefined
      })
      reset = controller.consumeResetCredit(account.id, 'fixture-reset', new AbortController().signal)
      await setImmediate()
      expect(sdkObserved).toBeUndefined()
      release.resolve(undefined)
      await bounded(Promise.all([usage, sdk, reset]))
      expect(sdkObserved).toEqual(rotated)
      expect(oauthRefresh).toHaveBeenCalledOnce()
      expect(await ctx.credentials.readRecord(key)).toEqual({ kind: 'grant', payload: rotated })
      expect((await controller.describe()).accounts[0]?.usageError).toBe('Usage is temporarily unavailable.')
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([usage, ...sdk === undefined ? [] : [sdk], ...reset === undefined ? [] : [reset]])
    }
  })

  it('rolls back a failed selection before SDK refresh can rotate its provisional canonical grant', async () => {
    const { ctx, controller } = await boot()
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const first = codexGrant('first@example.com', 'personal-first', { userId: 'first' })
    const second = codexGrant('second@example.com', 'personal-second', { userId: 'second' })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(first))
    const active = (await controller.describe()).accounts[0]!
    await seedOAuth(ctx, second)
    const spare = (await controller.describe()).accounts.find(account => account.id !== active.id)!
    const vaultKey = credentialKey('account-manager', 'accounts')
    const before = await ctx.credentials.readRecord(vaultKey)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const modify = ctx.credentials.modifyRecord.bind(ctx.credentials)
    let fail = true
    vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation(async (recordKey, mutate) => {
      if (recordKey === vaultKey && fail) {
        fail = false
        entered.resolve(undefined)
        await release.promise
        throw new Error('fixture vault failure')
      }
      return modify(recordKey, mutate)
    })
    const selection = controller.activate('openai-codex', spare.id)
    const failure = expect(selection).rejects.toThrow('fixture vault failure')
    let sdk: Promise<unknown> | undefined
    let sdkObserved: unknown
    const rotated = { ...first.payload, refresh: 'sdk-after-rollback', expires: Date.now() + 3_600_000 }
    try {
      await bounded(entered.promise)
      expect(await ctx.credentials.readRecord(key)).toEqual(second)
      sdk = credentialStoreFrom(ctx).modify('openai-codex', async (current) => {
        sdkObserved = current
        return rotated
      })
      await setImmediate()
      expect(sdkObserved).toBeUndefined()
      release.resolve(undefined)
      await bounded(Promise.all([failure, sdk]))
      expect(sdkObserved).toEqual(first.payload)
      expect(await ctx.credentials.readRecord(vaultKey)).toEqual(before)
      expect(await ctx.credentials.readRecord(key)).toEqual({ kind: 'grant', payload: rotated })
      expect((await controller.describe()).accounts.find(account => account.active)?.id).toBe(active.id)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([selection, failure, ...sdk === undefined ? [] : [sdk]])
    }
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
    await seedOAuth(ctx, unrelated)
    await controller.setAutoSwitch('openai-codex', true)

    const state = await controller.refreshUsage(new AbortController().signal)
    expect(state.accounts.find(account => account.detail?.startsWith('first@example.com'))?.active).toBe(true)
    expect(await ctx.credentials.readRecord(key)).toEqual(first)
  })
})
