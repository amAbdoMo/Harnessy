import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '../../../typert/registry/src/index.ts'
import { TypertGatewayService } from '../../gateway/src/index.ts'
import AccountsController from '../src/accounts.ts'
import type { AccountAutoSwitchEvent, AccountResetCreditId, AccountsState } from '../src/types.ts'
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

class UsageStreamAdapter extends LlmAdapter {
  constructor(private readonly outcome: 'success' | 'error' = 'success') { super() }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (this.outcome === 'error') throw new Error('fixture provider failure')
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function drainUsageStream(ctx: Context, provider = 'openai-codex'): Promise<void> {
  for await (const _chunk of ctx.llm.stream({ provider, model: 'fixture', messages: [] })) { /* drain provider */ }
}

describe('the Harnessy accounts Remote namespace', () => {
  it.each(['success', 'error', 'early-close'] as const)('refreshes Codex usage after %s without delaying stream settlement', async (outcome) => {
    const pending = Promise.withResolvers<Response>()
    const fetchUsage = vi.fn(() => pending.promise)
    const { ctx, controller } = await boot({ fetchUsage })
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['openai-codex', 'other'], new UsageStreamAdapter(outcome === 'error' ? 'error' : 'success'))
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () =>
      Promise.resolve(codexGrant('abdo@example.com', 'account-a')))
    await controller.describe()
    const changes: AccountsState[] = []
    ctx.on('accounts/changed', (state) => { changes.push(state) })
    try {
      await drainUsageStream(ctx, 'other')
      expect(fetchUsage).not.toHaveBeenCalled()
      if (outcome === 'early-close') {
        for await (const _chunk of ctx.llm.stream({ provider: 'openai-codex', model: 'fixture', messages: [] })) break
      } else {
        await drainUsageStream(ctx)
      }
      await vi.waitFor(() => { expect(fetchUsage).toHaveBeenCalledOnce() })
      expect(changes).toEqual([])
      pending.resolve(usageResponse(79))
      await vi.waitFor(() => { expect(changes.at(-1)?.accounts[0]?.usage?.windows[0]?.usedPercent).toBe(79) })
    } finally {
      pending.resolve(usageResponse(79))
    }
  })

  it('coalesces stream completions into one follow-up and aborts background usage on disposal', async () => {
    const first = Promise.withResolvers<Response>()
    const fetchUsage = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('fixture usage aborted')) }, { once: true })
      }))
    const { ctx, controller } = await boot({ fetchUsage })
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['openai-codex'], new UsageStreamAdapter())
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () =>
      Promise.resolve(codexGrant('abdo@example.com', 'account-a')))
    await controller.describe()
    try {
      await drainUsageStream(ctx)
      await vi.waitFor(() => { expect(fetchUsage).toHaveBeenCalledOnce() })
      await Promise.all([drainUsageStream(ctx), drainUsageStream(ctx), drainUsageStream(ctx)])
      expect(fetchUsage).toHaveBeenCalledOnce()
      first.resolve(usageResponse(20))
      await vi.waitFor(() => { expect(fetchUsage).toHaveBeenCalledTimes(2) })
      const signal = fetchUsage.mock.calls[1]?.[1]?.signal
      await ctx.fiber.dispose()
      expect(signal?.aborted).toBe(true)
      expect(fetchUsage).toHaveBeenCalledTimes(2)
    } finally {
      first.resolve(usageResponse(20))
    }
  })

  it('contains failed snapshot observers after a committed selection and still notifies other observers', async () => {
    const { ctx, controller } = await boot()
    await controller.addApiKey('zai', 'First', 'fixture-one')
    const second = (await controller.addApiKey('zai', 'Second', 'fixture-two')).accounts.find(account => !account.active)!
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.on('accounts/changed', () => { throw new Error('fixture synchronous observer failure') })
    // oxlint-disable-next-line typescript/no-misused-promises -- Async emit rejection is deliberately tested.
    ctx.on('accounts/changed', async () => { throw new Error('fixture asynchronous observer failure') })
    const observed = vi.fn()
    ctx.on('accounts/changed', observed)
    const state = await controller.activate('zai', second.id)
    expect(state.accounts.find(account => account.active)?.id).toBe(second.id)
    expect(await ctx.credentials.readRecord(credentialKey('llm-pi-ai', 'zai'))).toEqual({ kind: 'api-key', key: 'fixture-two' })
    expect(observed).toHaveBeenCalledWith(state)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledOnce() })
  })

  it('owns the account-management methods and reports unavailable composition safely', async () => {
    const empty = context()
    await empty.plugin(AccountsController)
    expect(await empty.accountsController.describe()).toMatchObject({ writable: false, accounts: [] })
    const { controller } = await boot()
    expect(remoteMethods(controller).map(method => method.method)).toEqual([
      'describe', 'addOAuth', 'addApiKey', 'activate', 'setAutoSwitch', 'listResetCredits', 'consumeResetCredit', 'setManualBillingDate', 'rename', 'deleteAccount',
      'refreshUsage',
    ])
  })

  it('imports the existing Codex identity without exposing its OAuth material', async () => {
    const { ctx, controller } = await boot()
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () =>
      Promise.resolve(codexGrant('abdo@example.com', 'account-a')))
    const changes: AccountsState[] = []
    ctx.on('accounts/changed', (state) => { changes.push(state) })
    const state = await controller.describe()
    expect(state.accounts).toEqual([expect.objectContaining({
      provider: 'openai-codex', name: 'Abdo Mohamed', detail: 'abdo@example.com · PLUS', active: true,
    })])
    expect(changes).toEqual([state])
    expect(JSON.stringify(changes)).not.toContain('refresh-account-a')
    expect(JSON.stringify(changes)).not.toContain('signature')
    await controller.describe()
    expect(changes).toHaveLength(1)
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

  it('lists individual credits with expiry without redeeming or persisting them', async () => {
    const fetchUsage = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ credits: [
      { id: ' first ', reset_type: 'codex_rate_limits', status: 'available', expires_at: '2030-10-23T00:00:00Z', title: 'Full reset' },
      { id: 'second', reset_type: 'codex_rate_limits', status: 'available', expires_at: null },
      { id: 'redeemed', reset_type: 'codex_rate_limits', status: 'redeemed', expires_at: null },
    ], available_count: 2 }), { status: 200 }))
    const { ctx, controller } = await boot({ fetchUsage })
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () =>
      Promise.resolve(codexGrant('abdo@example.com', 'account-a')))
    const account = (await controller.describe()).accounts[0]!
    const reads = vi.spyOn(ctx.credentials, 'readRecord')
    const list = await controller.listResetCredits(account.id, new AbortController().signal)
    expect(reads.mock.calls.filter(([key]) => key === credentialKey('llm-pi-ai', 'openai-codex'))).toHaveLength(1)
    expect(list.credits).toEqual([
      { id: ' first ', resetType: 'codex_rate_limits', status: 'available', expiresAtMs: Date.parse('2030-10-23T00:00:00Z'), title: 'Full reset' },
      { id: 'second', resetType: 'codex_rate_limits', status: 'available' },
      { id: 'redeemed', resetType: 'codex_rate_limits', status: 'redeemed' },
    ])
    expect(fetchUsage).toHaveBeenCalledOnce()
    const [url, init] = fetchUsage.mock.calls[0]!
    expect(url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits')
    expect(init?.method).toBe('GET')
    expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('account-a')
    expect((await controller.describe()).accounts[0]?.usage).toBeUndefined()
  })

  it.each([
    { credits: [{ id: 42, reset_type: 'codex_rate_limits', status: 'available' }] },
    { credits: [{ id: '   ', reset_type: 'codex_rate_limits', status: 'available' }] },
    { credits: [{ id: 'a'.repeat(257), reset_type: 'codex_rate_limits', status: 'available' }] },
    { credits: [{ id: 'a', reset_type: 'codex_rate_limits', status: 'available', expires_at: 'invalid' }] },
    { credits: [{ id: 'a', reset_type: 'codex_rate_limits', status: 'available' }, { id: 'a', reset_type: 'codex_rate_limits', status: 'available' }] },
    { available_count: 2 },
  ])('rejects unreadable reset details instead of manufacturing selectable rows (%j)', async (payload) => {
    const { ctx, controller } = await boot({ fetchUsage: async () => new Response(JSON.stringify(payload)) })
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () =>
      Promise.resolve(codexGrant('abdo@example.com', 'account-a')))
    const account = (await controller.describe()).accounts[0]!
    await expect(controller.listResetCredits(account.id, new AbortController().signal)).rejects.toThrow('unreadable')
  })

  it('consumes the selected membership credit and refreshes only that membership among many saved accounts', async () => {
    const requests: Array<{ readonly input: string; readonly init?: RequestInit }> = []
    let redeemed = false
    const fetchUsage = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requests.push({ input: requestUrl, ...init === undefined ? {} : { init } })
      if (init?.method === 'POST') {
        redeemed = true
        return new Response(JSON.stringify({ code: 'reset', windows_reset: 2 }), { status: 200 })
      }
      if (!redeemed) return usageResponse(60)
      return new Response(JSON.stringify({
        rate_limit_reset_credits: { available_count: 0 },
        rate_limit: {
          primary_window: { used_percent: 0, limit_window_seconds: 18_000, reset_after_seconds: 18_000 },
          secondary_window: { used_percent: 0, limit_window_seconds: 604_800, reset_after_seconds: 604_800 },
        },
      }), { status: 200 })
    }) as typeof fetch
    const { ctx, controller } = await boot({ fetchUsage })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const personal = codexGrant('abdo@example.com', 'account-a')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(personal))
    await controller.describe()
    await seedOAuth(ctx, codexGrant('abdo@example.com', 'workspace-a', { plan: 'business' }))
    for (let index = 0; index < 12; index++) {
      await seedOAuth(ctx, codexGrant(`other-${String(index)}@example.com`, `unrelated-${String(index)}`))
    }
    const before = await controller.refreshUsage(new AbortController().signal)
    const selected = before.accounts.find(account => account.usageScope === 'workspace')
    if (selected === undefined) throw new Error('workspace membership was not saved')
    requests.length = 0
    const changes: AccountsState[] = []
    ctx.on('accounts/changed', (state) => { changes.push(state) })

    const result = await controller.consumeResetCredit(
      selected.id, ' credit-second ' as AccountResetCreditId, 'reset-attempt-1', new AbortController().signal,
    )

    expect(result.outcome).toBe('reset')
    expect(result.state.accounts).toHaveLength(14)
    expect(result.state.accounts.find(account => account.id === selected.id)?.usage?.resetCredits).toEqual({ availableCount: 0 })
    expect(result.state.accounts.filter(account => account.id !== selected.id))
      .toEqual(before.accounts.filter(account => account.id !== selected.id))
    expect(await controller.describe()).toEqual(result.state)
    expect(changes).toEqual([result.state])
    expect(await ctx.credentials.readRecord(key)).toEqual(personal)
    expect(requests).toHaveLength(2)
    expect(requests[1]?.input).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(new Headers(requests[1]?.init?.headers).get('chatgpt-account-id')).toBe('workspace-a')
    expect(requests[0]?.input).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume')
    expect(requests[0]?.init?.method).toBe('POST')
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ redeem_request_id: 'reset-attempt-1', credit_id: ' credit-second ' }))
    expect(new Headers(requests[0]?.init?.headers).get('chatgpt-account-id')).toBe('workspace-a')
  })

  it('keeps a full usage refresh queued behind the selected post-reset refresh', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const memberships: Array<string | null> = []
    const fetchUsage: typeof fetch = async (_input, init) => {
      if (init?.method === 'POST') return Response.json({ code: 'reset' })
      memberships.push(new Headers(init?.headers).get('chatgpt-account-id'))
      if (memberships.length === 1) {
        entered.resolve(undefined)
        await release.promise
      }
      return usageResponse(20)
    }
    const { ctx, controller } = await boot({ fetchUsage })
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () =>
      Promise.resolve(codexGrant('owner@example.com', 'personal')))
    await controller.describe()
    await seedOAuth(ctx, codexGrant('owner@example.com', 'workspace', { plan: 'business' }))
    const selected = (await controller.describe()).accounts.find(account => account.usageScope === 'workspace')
    if (selected === undefined) throw new Error('workspace membership was not saved')
    const resetting = controller.consumeResetCredit(selected.id, 'selected' as AccountResetCreditId, 'attempt', new AbortController().signal)
    let full: ReturnType<AccountsController['refreshUsage']> | undefined
    try {
      await bounded(entered.promise)
      full = controller.refreshUsage(new AbortController().signal)
      await setImmediate()
      expect(memberships).toEqual(['workspace'])
      release.resolve(undefined)
      const reset = await bounded(resetting)
      expect(reset.state.accounts.find(account => account.active)?.usage).toBeUndefined()
      const state = await bounded(full)
      expect(state.accounts.every(account => account.usage?.windows[0]?.usedPercent === 20)).toBe(true)
      expect(memberships).toEqual(['workspace', 'personal', 'workspace'])
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([resetting, ...full === undefined ? [] : [full]])
    }
  })

  it.each(['cancel', 'delete', 'rotate'] as const)(
    'does not commit stale post-reset usage after %s during the selected request', async (action) => {
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const fetchUsage: typeof fetch = async (_input, init) => {
        if (init?.method === 'POST') return Response.json({ code: 'reset' })
        entered.resolve(undefined)
        await release.promise
        return usageResponse(90)
      }
      const { ctx, controller } = await boot({ fetchUsage })
      const key = credentialKey('llm-pi-ai', 'openai-codex')
      const grant = codexGrant('owner@example.com', 'personal', { userId: 'owner' })
      await ctx.credentials.modifyRecord(key, () => Promise.resolve(grant))
      const [account] = (await controller.describe()).accounts
      if (account === undefined) throw new Error('selected membership was not saved')
      const changes: AccountsState[] = []
      ctx.on('accounts/changed', (state) => { changes.push(state) })
      const signal = new AbortController()
      const resetting = controller.consumeResetCredit(account.id, 'selected' as AccountResetCreditId, 'attempt', signal.signal)
      const rotated = { ...grant.payload, refresh: 'rotated-during-reset', expires: Date.now() + 3_600_000 }
      try {
        await bounded(entered.promise)
        const cancelled = action === 'cancel'
          ? expect(resetting).rejects.toMatchObject({ code: 'gateway/cancelled' }) : undefined
        if (action === 'cancel') signal.abort()
        else if (action === 'delete') await controller.deleteAccount('openai-codex', account.id)
        else await credentialStoreFrom(ctx).modify('openai-codex', () => Promise.resolve(rotated))
        release.resolve(undefined)
        if (cancelled !== undefined) await bounded(cancelled)
        else {
          const result = await bounded(resetting)
          expect(result.outcome).toBe('reset')
          expect(result.state).toEqual(await controller.describe())
        }
        const state = await controller.describe()
        expect(state.accounts).toHaveLength(action === 'delete' ? 0 : 1)
        expect(state.accounts[0]?.usage).toBeUndefined()
        expect(changes.every(state => state.accounts.every(account => account.usage === undefined))).toBe(true)
        expect(await ctx.credentials.readRecord(key)).toEqual(action === 'delete' ? undefined
          : action === 'rotate' ? { kind: 'grant', payload: rotated } : grant)
      } finally {
        release.resolve(undefined)
        await Promise.allSettled([resetting])
      }
    },
  )

  it.each(['wait', 'cancel', 'delete', 'rotate'] as const)(
    'serializes selected post-reset usage behind a full refresh and rechecks %s before fetching', async (action) => {
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const redeemed = Promise.withResolvers<undefined>()
      const authorizations: Array<string | null> = []
      const fetchUsage: typeof fetch = async (_input, init) => {
        if (init?.method === 'POST') {
          redeemed.resolve(undefined)
          return Response.json({ code: 'reset' })
        }
        authorizations.push(new Headers(init?.headers).get('authorization'))
        if (authorizations.length === 1) {
          entered.resolve(undefined)
          await release.promise
          return usageResponse(40)
        }
        return usageResponse(20)
      }
      const { ctx, controller } = await boot({ fetchUsage })
      const key = credentialKey('llm-pi-ai', 'openai-codex')
      const grant = codexGrant('owner@example.com', 'personal', { userId: 'owner' })
      await ctx.credentials.modifyRecord(key, () => Promise.resolve(grant))
      const [account] = (await controller.describe()).accounts
      if (account === undefined) throw new Error('selected membership was not saved')
      const first = controller.refreshUsage(new AbortController().signal)
      const signal = new AbortController()
      let resetting: ReturnType<AccountsController['consumeResetCredit']> | undefined
      const rotated = { ...grant.payload, access: `${grant.payload.access}.rotated`, refresh: 'rotated-before-reset-read' }
      try {
        await bounded(entered.promise)
        resetting = controller.consumeResetCredit(account.id, 'selected' as AccountResetCreditId, 'attempt', signal.signal)
        await bounded(redeemed.promise)
        await setImmediate()
        expect(authorizations).toHaveLength(1)
        const cancelled = action === 'cancel'
          ? expect(resetting).rejects.toMatchObject({ code: 'gateway/cancelled' }) : undefined
        if (action === 'cancel') signal.abort()
        else if (action === 'delete') await controller.deleteAccount('openai-codex', account.id)
        else if (action === 'rotate') await credentialStoreFrom(ctx).modify('openai-codex', () => Promise.resolve(rotated))
        release.resolve(undefined)
        await bounded(first)
        if (cancelled !== undefined) await bounded(cancelled)
        else {
          const result = await bounded(resetting)
          expect(result.state).toEqual(await controller.describe())
          expect(result.state.accounts[0]?.usage?.windows[0]?.usedPercent).toBe(action === 'delete' ? undefined : 20)
        }
        expect(authorizations).toEqual(action === 'wait' ? [`Bearer ${grant.payload.access}`, `Bearer ${grant.payload.access}`]
          : action === 'rotate' ? [`Bearer ${grant.payload.access}`, `Bearer ${rotated.access}`] : [`Bearer ${grant.payload.access}`])
        expect(await ctx.credentials.readRecord(key)).toEqual(action === 'delete' ? undefined
          : action === 'rotate' ? { kind: 'grant', payload: rotated } : grant)
        // A cancelled queued refresh must still release its place for the next caller.
        const next = await bounded(controller.refreshUsage(new AbortController().signal))
        expect(next.accounts[0]?.usage?.windows[0]?.usedPercent).toBe(action === 'delete' ? undefined : 20)
      } finally {
        release.resolve(undefined)
        await Promise.allSettled([first, ...resetting === undefined ? [] : [resetting]])
      }
    },
  )

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

    const result = await controller.consumeResetCredit(account.id, 'credit-second' as AccountResetCreditId, `attempt-${code}`, new AbortController().signal)

    expect(result.outcome).toBe(outcome)
  })

  it('pushes active-account usage before a slower inactive account finishes', async () => {
    const inactive = Promise.withResolvers<undefined>()
    const fetchUsage: typeof fetch = async (_input, init) => {
      const account = new Headers(init?.headers).get('chatgpt-account-id')
      if (account === 'account-first') await inactive.promise
      return usageResponse(account === 'account-second' ? 40 : 20)
    }
    const { ctx, controller } = await boot({ fetchUsage })
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () =>
      Promise.resolve(codexGrant('first@example.com', 'account-first')))
    await controller.describe()
    await seedOAuth(ctx, codexGrant('second@example.com', 'account-second'))
    const spare = (await controller.describe()).accounts.find(account => account.detail?.startsWith('second@'))!
    await controller.activate('openai-codex', spare.id)
    const changes: AccountsState[] = []
    ctx.on('accounts/changed', (state) => { changes.push(state) })
    let complete = false
    const refresh = controller.refreshUsage(new AbortController().signal).then((state) => {
      complete = true
      return state
    })
    try {
      await vi.waitFor(() => {
        expect(changes.at(-1)?.accounts.find(account => account.active)?.usage?.windows[0]?.usedPercent).toBe(40)
      })
      expect(complete).toBe(false)
      expect(changes.at(-1)?.accounts.find(account => !account.active)?.usage).toBeUndefined()
      inactive.resolve(undefined)
      const state = await refresh
      expect(changes.at(-1)).toEqual(state)
      expect(state.accounts.find(account => !account.active)?.usage?.windows[0]?.usedPercent).toBe(20)
    } finally {
      inactive.resolve(undefined)
      await refresh
    }
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
    const changes = vi.fn()
    ctx.on('accounts/changed', changes)
    await expect(controller.activate('zai', second.id)).rejects.toThrow(`fixture ${failure} failure`)
    expect(await ctx.credentials.readRecord(canonicalKey)).toEqual({ kind: 'api-key', key: 'fixture-one' })
    expect(await ctx.credentials.readRecord(vaultKey)).toEqual(beforeVault)
    expect(changes).not.toHaveBeenCalled()
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
      reset = controller.consumeResetCredit(account.id, 'credit-second' as AccountResetCreditId, 'fixture-reset', new AbortController().signal)
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

describe('manual account billing dates on the Host', () => {
  const vaultKey = credentialKey('account-manager', 'accounts')

  it('stores independent dates for one owner’s memberships and key providers without exposing credentials', async () => {
    const { ctx, controller } = await boot()
    const canonical = credentialKey('llm-pi-ai', 'openai-codex')
    const grant = codexGrant('owner@example.com', 'personal', { userId: 'owner' })
    await ctx.credentials.modifyRecord(canonical, () => Promise.resolve(grant))
    await controller.describe()
    await seedOAuth(ctx, codexGrant('owner@example.com', 'workspace', { userId: 'owner', plan: 'business' }))
    const memberships = (await controller.describe()).accounts
    const personal = memberships.find(account => account.usageScope === 'personal')
    const workspace = memberships.find(account => account.usageScope === 'workspace')
    if (personal === undefined || workspace === undefined) throw new Error('billing memberships were not saved')
    const [keyAccount] = (await controller.addApiKey('zai', 'Key account', 'billing-key-secret')).accounts
      .filter(account => account.provider === 'zai')
    if (keyAccount === undefined) throw new Error('key account was not saved')
    const routeBefore = ctx.settings.describe()
    const changes: AccountsState[] = []
    ctx.on('accounts/changed', (state) => { changes.push(state) })

    await controller.setManualBillingDate('openai-codex', personal.id, '2028-02-29')
    await controller.setManualBillingDate('openai-codex', workspace.id, '2030-04-30')
    const saved = await controller.setManualBillingDate('zai', keyAccount.id, '2031-01-31')
    expect(personal.ownerId).toBe(workspace.ownerId)
    expect(saved.accounts.find(account => account.id === personal.id)?.manualBillingDate).toBe('2028-02-29')
    expect(saved.accounts.find(account => account.id === workspace.id)?.manualBillingDate).toBe('2030-04-30')
    expect(saved.accounts.find(account => account.id === keyAccount.id)?.manualBillingDate).toBe('2031-01-31')
    expect(await ctx.credentials.readRecord(vaultKey)).toMatchObject({ kind: 'grant', payload: { providers: {
      'openai-codex': { accounts: {
        [personal.id]: { manualBillingDate: '2028-02-29' }, [workspace.id]: { manualBillingDate: '2030-04-30' },
      } },
      zai: { accounts: { [keyAccount.id]: { manualBillingDate: '2031-01-31' } } },
    } } })
    const beforeRejected = await ctx.credentials.readRecord(vaultKey)
    const changeCount = changes.length
    await expect(controller.setManualBillingDate('zai', personal.id, '2032-01-01'))
      .rejects.toMatchObject({ code: 'accounts/not-found' })
    await expect(controller.setManualBillingDate('openai-codex', 'missing-membership', '2032-01-01'))
      .rejects.toMatchObject({ code: 'accounts/not-found' })
    expect(await ctx.credentials.readRecord(vaultKey)).toEqual(beforeRejected)
    expect(changes).toHaveLength(changeCount)

    const cleared = await controller.setManualBillingDate('openai-codex', personal.id, null)
    expect(cleared.accounts.find(account => account.id === personal.id)).not.toHaveProperty('manualBillingDate')
    expect(cleared.accounts.find(account => account.id === workspace.id)?.manualBillingDate).toBe('2030-04-30')
    expect(await ctx.credentials.readRecord(vaultKey))
      .not.toHaveProperty(`payload.providers.openai-codex.accounts.${personal.id}.manualBillingDate`)
    expect(await controller.describe()).toEqual(cleared)
    expect(changes.at(-1)).toEqual(cleared)
    const visible = JSON.stringify([saved, cleared, changes])
    expect(visible).not.toContain('billing-key-secret')
    expect(visible).not.toContain(grant.payload.access)
    expect(visible).not.toContain(grant.payload.refresh)
    expect(await ctx.credentials.readRecord(canonical)).toEqual(grant)
    expect(ctx.settings.describe()).toEqual(routeBefore)
  })

  it.each(['0001-01-01', '0004-02-29', '0099-12-31', '2000-02-29', '2400-02-29', '9999-12-31'])(
    'round-trips the exact Gregorian date %s', async (date) => {
      const { ctx, controller } = await boot()
      const [account] = (await controller.addApiKey('zai', 'Calendar', 'calendar-secret')).accounts
      if (account === undefined) throw new Error('calendar account was not saved')
      const state = await controller.setManualBillingDate('zai', account.id, date)
      expect(state.accounts[0]?.manualBillingDate).toBe(date)
      expect((await controller.describe()).accounts[0]?.manualBillingDate).toBe(date)
      expect(await ctx.credentials.readRecord(vaultKey))
        .toHaveProperty(`payload.providers.zai.accounts.${account.id}.manualBillingDate`, date)
    },
  )

  it.each([
    '', '2028-2-29', '2028-02-9', ' 2028-02-29', '2028-02-29 ', '2028-02-29\n',
    '2028-02-29T00:00:00Z', '0000-01-01', '10000-01-01', '-001-01-01',
    '2028-00-01', '2028-13-01', '2028-01-00', '2028-01-32', '2028-04-31',
    '2027-02-29', '1900-02-29', '2100-02-29', '2028-02-30',
  ])('rejects the non-calendar date %j without a write or notification', async (date) => {
    const { ctx, controller } = await boot()
    const [account] = (await controller.addApiKey('zai', 'Calendar', 'calendar-secret')).accounts
    if (account === undefined) throw new Error('calendar account was not saved')
    await controller.setManualBillingDate('zai', account.id, '2028-02-29')
    const before = await ctx.credentials.readRecord(vaultKey)
    const changes: AccountsState[] = []
    ctx.on('accounts/changed', (state) => { changes.push(state) })
    await expect(controller.setManualBillingDate('zai', account.id, date)).rejects.toMatchObject({ code: 'accounts/rejected' })
    expect(await ctx.credentials.readRecord(vaultKey)).toEqual(before)
    expect(changes).toEqual([])
  })

  it('accepts and clears named wire dates but rejects malformed JSON date values without changing the vault', async () => {
    const { ctx, controller } = await boot()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService)
    const [account] = (await controller.addApiKey('zai', 'Wire', 'wire-secret')).accounts
    if (account === undefined) throw new Error('wire account was not saved')
    const invoke = (date: unknown) => ctx.typertGateway.invoke({
      namespace: 'accounts', method: 'setManualBillingDate', args: { provider: 'zai', accountId: account.id, date },
    })
    const saved = await invoke('2000-02-29')
    expect(saved).toHaveProperty('accounts.0.manualBillingDate', '2000-02-29')
    const before = await ctx.credentials.readRecord(vaultKey)
    const changes: AccountsState[] = []
    ctx.on('accounts/changed', (state) => { changes.push(state) })
    for (const date of [false, 20280229, {}, [], '1900-02-29', '2028-02-29T00:00:00Z']) {
      await expect(invoke(date)).rejects.toMatchObject({ code: 'accounts/rejected' })
    }
    expect(await ctx.credentials.readRecord(vaultKey)).toEqual(before)
    expect(changes).toEqual([])
    expect(await invoke(null)).not.toHaveProperty('accounts.0.manualBillingDate')
    expect(await ctx.credentials.readRecord(vaultKey))
      .not.toHaveProperty(`payload.providers.zai.accounts.${account.id}.manualBillingDate`)
  })

  it.each([
    null, false, 20280229, {}, [], '', '0000-01-01', '10000-01-01', '1900-02-29',
    '2028-04-31', '2028-02-29\n', '2028-02-29T00:00:00Z',
  ])(
    'fails closed for a provider containing the invalid durable billing value %j', async (manualBillingDate) => {
      const { ctx, controller } = await boot()
      const account = (id: string, provider: 'zai' | 'opencode') => ({
        id, provider, authMode: 'api-key', name: id, credential: { kind: 'api-key', key: `secret-${id}` }, createdAt: 1,
      })
      const record = { kind: 'grant' as const, payload: { version: 1, providers: {
        zai: { activeAccountId: 'bad', accounts: {
          bad: { ...account('bad', 'zai'), manualBillingDate }, valid: account('valid', 'zai'),
        } },
        opencode: { activeAccountId: 'old', accounts: { old: account('old', 'opencode') } },
      } } }
      await ctx.credentials.modifyRecord(vaultKey, () => Promise.resolve(record))
      const changes: AccountsState[] = []
      ctx.on('accounts/changed', (state) => { changes.push(state) })
      await expect(controller.describe()).rejects.toMatchObject({ code: 'accounts/rejected' })
      await expect(controller.setManualBillingDate('zai', 'valid', '2028-02-29'))
        .rejects.toMatchObject({ code: 'accounts/rejected' })
      expect(await ctx.credentials.readRecord(vaultKey)).toEqual(record)
      expect(changes).toEqual([])
    },
  )

  it.each(['account-field', 'provider-field', 'earlier-sibling'])(
    'rejects a corrupt reminder before discarding a malformed %s', async (corruption) => {
      const { ctx, controller } = await boot()
      const account = { id: 'bad', provider: 'zai', authMode: 'api-key',
        credential: { kind: 'api-key', key: 'corrupt-secret' }, name: 'Bad', createdAt: 1,
        manualBillingDate: '1900-02-29', ...(corruption === 'account-field' ? { usageError: 123 } : {}),
      }
      const record = { kind: 'grant' as const, payload: { version: 1, providers: {
        zai: { ...(corruption === 'provider-field' ? { activeAccountId: false } : {}), accounts: {
          ...(corruption === 'earlier-sibling' ? { malformed: null } : {}), bad: account,
        } },
      } } }
      await ctx.credentials.modifyRecord(vaultKey, () => Promise.resolve(record))
      const changes: AccountsState[] = []
      ctx.on('accounts/changed', (state) => { changes.push(state) })
      await expect(controller.describe()).rejects.toMatchObject({ code: 'accounts/rejected' })
      expect(await ctx.credentials.readRecord(vaultKey)).toEqual(record)
      expect(changes).toEqual([])
    },
  )

  it.each(['kimi-coding', 'anthropic'] as const)(
    'keeps a same-subject %s token rotation but clears the reminder for a different canonical subject', async (provider) => {
      const { ctx, controller } = await boot()
      const key = credentialKey('llm-pi-ai', provider)
      const grant = (subject: string, refresh: string) => ({ kind: 'grant' as const, payload: {
        access: jwt({ sub: subject, email: `${subject}@example.com` }), refresh, expires: Date.now() + 3_600_000,
      } })
      await ctx.credentials.modifyRecord(key, () => Promise.resolve(grant('first', 'initial-token')))
      const [account] = (await controller.describe()).accounts
      if (account === undefined) throw new Error('OAuth membership was not saved')
      await controller.setManualBillingDate(provider, account.id, '2028-02-29')
      await ctx.credentials.modifyRecord(key, () => Promise.resolve(grant('first', 'rotated-token')))
      expect((await controller.describe()).accounts.find(member => member.id === account.id)?.manualBillingDate).toBe('2028-02-29')
      await ctx.credentials.modifyRecord(key, () => Promise.resolve(grant('second', 'different-owner-token')))
      expect((await controller.describe()).accounts.find(member => member.id === account.id)).not.toHaveProperty('manualBillingDate')
      expect(await ctx.credentials.readRecord(vaultKey)).not.toHaveProperty(`payload.providers.${provider}.accounts.${account.id}.manualBillingDate`)
    },
  )

  it('loads old durable accounts with no billing field alongside a valid dated record', async () => {
    const { ctx, controller } = await boot()
    await ctx.credentials.modifyRecord(vaultKey, () => Promise.resolve({ kind: 'grant', payload: {
      version: 1, providers: { zai: { activeAccountId: 'old', accounts: {
        old: { id: 'old', provider: 'zai', authMode: 'api-key', credential: { kind: 'api-key', key: 'old-secret' }, name: 'Old', createdAt: 1 },
        dated: { id: 'dated', provider: 'zai', authMode: 'api-key', credential: { kind: 'api-key', key: 'dated-secret' },
          name: 'Dated', createdAt: 2, manualBillingDate: '0001-01-01' },
      } } },
    } }))
    const state = await controller.describe()
    expect(state.accounts).toHaveLength(2)
    expect(state.accounts.find(account => account.id === 'old')).not.toHaveProperty('manualBillingDate')
    expect(state.accounts.find(account => account.id === 'dated')?.manualBillingDate).toBe('0001-01-01')
    const saved = await controller.setManualBillingDate('zai', 'old', '9999-12-31')
    expect(saved.accounts.find(account => account.id === 'old')?.manualBillingDate).toBe('9999-12-31')
  })

  it.each(['2028-02-29', null])('publishes and returns billing value %j only after storage commits', async (date) => {
    const { ctx, controller } = await boot()
    const [account] = (await controller.addApiKey('zai', 'Commit', 'commit-secret')).accounts
    if (account === undefined) throw new Error('commit account was not saved')
    await controller.setManualBillingDate('zai', account.id, '2030-01-01')
    const before = await ctx.credentials.readRecord(vaultKey)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const modify = ctx.credentials.modifyRecord.bind(ctx.credentials)
    vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
      if (key === vaultKey) { entered.resolve(undefined); await release.promise }
      return modify(key, mutate)
    })
    const changes: AccountsState[] = []
    const eventRecords: Array<ReturnType<typeof ctx.credentials.readRecord>> = []
    ctx.on('accounts/changed', (state) => {
      eventRecords.push(ctx.credentials.readRecord(vaultKey))
      changes.push(state)
    })
    let returned = false
    const pending = controller.setManualBillingDate('zai', account.id, date).then((state) => { returned = true; return state })
    try {
      await bounded(entered.promise)
      expect(returned).toBe(false)
      expect(changes).toEqual([])
      expect(await ctx.credentials.readRecord(vaultKey)).toEqual(before)
      release.resolve(undefined)
      const state = await bounded(pending)
      expect(changes).toEqual([state])
      const durable = await ctx.credentials.readRecord(vaultKey)
      expect(await Promise.all(eventRecords)).toEqual([durable])
      if (date === null) {
        expect(state.accounts[0]).not.toHaveProperty('manualBillingDate')
        expect(durable).not.toHaveProperty(`payload.providers.zai.accounts.${account.id}.manualBillingDate`)
      } else {
        expect(state.accounts[0]?.manualBillingDate).toBe(date)
        expect(durable).toHaveProperty(`payload.providers.zai.accounts.${account.id}.manualBillingDate`, date)
      }
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([pending])
    }
  })

  it.each(['2028-02-29', null])('keeps the previous date and emits nothing when storing %j fails', async (date) => {
    const { ctx, controller } = await boot()
    const [account] = (await controller.addApiKey('zai', 'Failure', 'failure-secret')).accounts
    if (account === undefined) throw new Error('failure account was not saved')
    await controller.setManualBillingDate('zai', account.id, '2030-01-01')
    const before = await ctx.credentials.readRecord(vaultKey)
    const modify = ctx.credentials.modifyRecord.bind(ctx.credentials)
    const fault = vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
      if (key === vaultKey) {
        await mutate(await ctx.credentials.readRecord(key))
        throw new Error('fixture billing write failed')
      }
      return modify(key, mutate)
    })
    const changes: AccountsState[] = []
    ctx.on('accounts/changed', (state) => { changes.push(state) })
    await expect(controller.setManualBillingDate('zai', account.id, date)).rejects.toThrow('fixture billing write failed')
    expect(await ctx.credentials.readRecord(vaultKey)).toEqual(before)
    expect(changes).toEqual([])
    fault.mockRestore()
    expect((await controller.describe()).accounts[0]?.manualBillingDate).toBe('2030-01-01')
  })

  it.each([
    { outcome: 'success', date: '2032-02-29' }, { outcome: 'error', date: '2032-02-29' },
    { outcome: 'success', date: null }, { outcome: 'error', date: null },
  ])('retains a concurrent billing edit during $outcome usage refresh (date $date)', async ({ outcome, date }) => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const { ctx, controller } = await boot({ fetchUsage: async () => {
      entered.resolve(undefined)
      await release.promise
      if (outcome === 'error') throw new Error('fixture billing usage failed')
      return usageResponse(20)
    } })
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () =>
      Promise.resolve(codexGrant('owner@example.com', 'personal', { userId: 'owner' })))
    await controller.describe()
    await seedOAuth(ctx, codexGrant('owner@example.com', 'workspace', { userId: 'owner', plan: 'business' }))
    const accounts = (await controller.describe()).accounts
    const personal = accounts.find(account => account.usageScope === 'personal')
    const workspace = accounts.find(account => account.usageScope === 'workspace')
    if (personal === undefined || workspace === undefined) throw new Error('usage memberships were not saved')
    await controller.setManualBillingDate('openai-codex', personal.id, '2030-01-01')
    await controller.setManualBillingDate('openai-codex', workspace.id, '2031-01-01')
    const refresh = controller.refreshUsage(new AbortController().signal)
    const changes: AccountsState[] = []
    ctx.on('accounts/changed', (state) => { changes.push(state) })
    try {
      await bounded(entered.promise)
      const edited = await bounded(controller.setManualBillingDate('openai-codex', personal.id, date))
      expect(edited.accounts.find(account => account.id === personal.id)?.manualBillingDate).toBe(date ?? undefined)
      changes.length = 0
      release.resolve(undefined)
      const state = await bounded(refresh)
      expect(state.accounts.find(account => account.id === personal.id)?.manualBillingDate).toBe(date ?? undefined)
      expect(state.accounts.find(account => account.id === workspace.id)?.manualBillingDate).toBe('2031-01-01')
      expect(changes.length).toBeGreaterThan(0)
      expect(changes.every(state => state.accounts.find(account => account.id === personal.id)?.manualBillingDate
        === (date ?? undefined))).toBe(true)
      expect(state.accounts.every(account => outcome === 'error'
        ? account.usageError === 'Usage is temporarily unavailable.' : account.usage?.windows[0]?.usedPercent === 20)).toBe(true)
      expect(await controller.describe()).toEqual(state)
      const durable = await ctx.credentials.readRecord(vaultKey)
      if (date === null) expect(durable).not.toHaveProperty(`payload.providers.openai-codex.accounts.${personal.id}.manualBillingDate`)
      else expect(durable).toHaveProperty(`payload.providers.openai-codex.accounts.${personal.id}.manualBillingDate`, date)
      expect(durable).toHaveProperty(`payload.providers.openai-codex.accounts.${workspace.id}.manualBillingDate`, '2031-01-01')
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([refresh])
    }
  })

  it('retains dates through shared token refresh without copying one membership’s date to another', async () => {
    const now = Date.now()
    const personal = codexGrant('owner@example.com', 'personal', { userId: 'owner' })
    personal.payload.expires = now - 1
    const workspace = codexGrant('owner@example.com', 'workspace', { userId: 'owner', plan: 'business' })
    workspace.payload.refresh = personal.payload.refresh
    const rotated = { ...personal.payload, refresh: 'billing-rotated-token', expires: now + 3_600_000 }
    oauthRefresh.mockResolvedValueOnce(rotated)
    const { ctx, controller } = await boot({ now: () => now, fetchUsage: async () => usageResponse(20) })
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () => Promise.resolve(personal))
    const [active] = (await controller.describe()).accounts
    if (active === undefined) throw new Error('refresh account was not saved')
    await seedOAuth(ctx, workspace)
    const other = (await controller.describe()).accounts.find(account => account.usageScope === 'workspace')
    if (other === undefined) throw new Error('refresh workspace was not saved')
    await controller.setManualBillingDate('openai-codex', active.id, '2028-02-29')
    await controller.setManualBillingDate('openai-codex', other.id, '2030-04-30')
    const state = await controller.refreshUsage(new AbortController().signal)
    expect(state.accounts.find(account => account.id === active.id)?.manualBillingDate).toBe('2028-02-29')
    expect(state.accounts.find(account => account.id === other.id)?.manualBillingDate).toBe('2030-04-30')
    expect(await ctx.credentials.readRecord(vaultKey)).toMatchObject({ kind: 'grant', payload: { providers: {
      'openai-codex': { accounts: {
        [active.id]: { manualBillingDate: '2028-02-29', credential: { payload: rotated } },
        [other.id]: { manualBillingDate: '2030-04-30', credential: { payload: { refresh: rotated.refresh } } },
      } },
    } } })
    expect(await ctx.credentials.readRecord(credentialKey('llm-pi-ai', 'openai-codex'))).toEqual({ kind: 'grant', payload: rotated })
  })

  it('preserves dates on rename, canonical import and same-membership re-login without transferring them to new memberships', async () => {
    const { ctx, controller } = await boot({ openUrl: async () => {} })
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const personal = codexGrant('owner@example.com', 'personal', { userId: 'owner' })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(personal))
    const [account] = (await controller.describe()).accounts
    if (account === undefined) throw new Error('re-login account was not saved')
    await seedOAuth(ctx, codexGrant('owner@example.com', 'workspace', { userId: 'owner', plan: 'business' }))
    const workspace = (await controller.describe()).accounts.find(account => account.usageScope === 'workspace')
    if (workspace === undefined) throw new Error('re-login workspace was not saved')
    await controller.setManualBillingDate('openai-codex', account.id, '2028-02-29')
    await controller.setManualBillingDate('openai-codex', workspace.id, '2030-04-30')
    await controller.rename('openai-codex', account.id, 'My membership')
    const rotated = { ...personal.payload, refresh: 'billing-sdk-rotation', expires: Date.now() + 3_600_000 }
    await credentialStoreFrom(ctx).modify('openai-codex', () => Promise.resolve(rotated))
    const imported = await controller.describe()
    expect(imported.accounts.find(member => member.id === account.id)).toMatchObject({ name: 'My membership', manualBillingDate: '2028-02-29' })
    expect(imported.accounts.find(member => member.id === workspace.id)?.manualBillingDate).toBe('2030-04-30')
    let login = { ...personal, payload: { ...personal.payload, refresh: 'billing-re-login' } }
    ctx.authorization.registerFlow({
      key, label: 'Codex', methods: [{ id: 'oauth', label: 'Sign in' }], supportsDestination: true,
      async run(session) { await session.commit(login) },
    })
    await controller.addOAuth('openai-codex', new AbortController().signal)
    const relogged = await controller.describe()
    expect(relogged.accounts).toHaveLength(2)
    expect(relogged.accounts.find(member => member.id === account.id)?.manualBillingDate).toBe('2028-02-29')
    expect(relogged.accounts.find(member => member.id === workspace.id)?.manualBillingDate).toBe('2030-04-30')
    expect(await ctx.credentials.readRecord(vaultKey))
      .toHaveProperty(`payload.providers.openai-codex.accounts.${account.id}.credential.payload.refresh`, 'billing-re-login')
    login = codexGrant('owner@example.com', 'different-workspace', { userId: 'owner', plan: 'business' })
    await controller.addOAuth('openai-codex', new AbortController().signal)
    const added = await controller.describe()
    const newMember = added.accounts.find(member => member.id !== account.id && member.id !== workspace.id)
    if (newMember === undefined) throw new Error('different membership was not saved')
    expect(newMember.ownerId).toBe(account.ownerId)
    expect(newMember).not.toHaveProperty('manualBillingDate')
    expect(added.accounts.find(member => member.id === account.id)?.manualBillingDate).toBe('2028-02-29')
    expect(added.accounts.find(member => member.id === workspace.id)?.manualBillingDate).toBe('2030-04-30')
    login = codexGrant('stranger@example.com', 'workspace', { userId: 'stranger', plan: 'business' })
    await controller.addOAuth('openai-codex', new AbortController().signal)
    const separateOwner = (await controller.describe()).accounts.find(member => member.detail?.startsWith('stranger@example.com'))
    if (separateOwner === undefined) throw new Error('different owner was not saved')
    expect(separateOwner.ownerId).not.toBe(account.ownerId)
    expect(separateOwner).not.toHaveProperty('manualBillingDate')
    await controller.deleteAccount('openai-codex', workspace.id)
    login = codexGrant('owner@example.com', 'workspace', { userId: 'owner', plan: 'business' })
    await controller.addOAuth('openai-codex', new AbortController().signal)
    const readded = (await controller.describe()).accounts.find(member => member.id === workspace.id)
    if (readded === undefined) throw new Error('deleted membership was not re-added')
    expect(readded).not.toHaveProperty('manualBillingDate')
  })

  it('retains billing dates while normalizing legacy membership ids', async () => {
    const { ctx, controller } = await boot()
    await ctx.credentials.modifyRecord(vaultKey, () => Promise.resolve({ kind: 'grant', payload: {
      version: 1, providers: { 'openai-codex': { activeAccountId: 'legacy-personal', accounts: {
        'legacy-personal': { id: 'legacy-personal', provider: 'openai-codex', authMode: 'oauth',
          credential: codexGrant('owner@example.com', 'personal', { userId: 'owner' }), name: 'Personal', createdAt: 1, manualBillingDate: '2028-02-29' },
        'legacy-workspace': { id: 'legacy-workspace', provider: 'openai-codex', authMode: 'oauth',
          credential: codexGrant('owner@example.com', 'workspace', { userId: 'owner', plan: 'business' }), name: 'Work', createdAt: 2 },
      } } },
    } }))
    const state = await controller.describe()
    const personal = state.accounts.find(account => account.active)
    const workspace = state.accounts.find(account => !account.active)
    if (personal === undefined || workspace === undefined) throw new Error('normalized memberships were not saved')
    expect(personal.id).not.toBe('legacy-personal')
    expect(workspace.id).not.toBe('legacy-workspace')
    expect(personal.manualBillingDate).toBe('2028-02-29')
    expect(workspace).not.toHaveProperty('manualBillingDate')
    expect(personal.ownerId).toBe(workspace.ownerId)
    expect(await ctx.credentials.readRecord(vaultKey)).toMatchObject({ kind: 'grant', payload: { providers: {
      'openai-codex': { activeAccountId: personal.id, accounts: { [personal.id]: { manualBillingDate: '2028-02-29' } } },
    } } })
  })
})
