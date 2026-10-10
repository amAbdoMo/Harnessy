/** Account selection across live turns in the real profile, Loader, and agent loop. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import AccountsController from '../src/accounts.ts'
import type { AccountAutoSwitchEvent, AccountsState } from '../src/types.ts'
import TypertRegistry from '../../../typert/registry/src/index.ts'
import { TypertGatewayService } from '../../gateway/src/index.ts'

const NOW = 1_800_000_000_000
const KEY = credentialKey('llm-pi-ai', 'zai')
const CODEX = credentialKey('llm-pi-ai', 'openai-codex')
const VAULT = credentialKey('account-manager', 'accounts')
let root: string | undefined
let context: Context | undefined
let wire: ProviderWire | undefined

/** External HTTP only: the shipping pi-ai serializers and stream parsers stay mounted. */
class ProviderWire {
  readonly arrived = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()
  readonly requests: {
    url: string
    authorization: string | null
    membership: string | null
    routeHeader: string | null
    body: string
  }[] = []
  readonly usageRequests: string[] = []
  readonly resetRequests: { method: string; membership: string; authorization: string | null; body: string }[] = []
  readonly usage = new Map<string, number>([['personal', 10], ['workspace', 20]])
  failFirstCodexQuota = false
  billingUsage: {
    readonly entered: ReturnType<typeof Promise.withResolvers<undefined>>
    readonly release: ReturnType<typeof Promise.withResolvers<undefined>>
    readonly fail: boolean
  } | undefined

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (request.method === 'GET' && url.origin + url.pathname === 'https://chatgpt.com/backend-api/codex/models') {
      return Response.json({ models: getBuiltinModels('openai-codex').map(model => ({ slug: model.id })) })
    }
    if (request.method !== 'POST' || ![
      'https://accounts.invalid/v1/chat/completions',
      'https://chatgpt.com/backend-api/codex/responses',
    ].includes(request.url)) throw new Error(`unexpected external request: ${request.method} ${request.url}`)
    const ordinal = this.requests.length
    this.requests.push({
      url: request.url,
      authorization: request.headers.get('authorization'),
      membership: request.headers.get('chatgpt-account-id'),
      routeHeader: request.headers.get('x-fixture-route'),
      // Codex may zstd-compress its wire body; its durable messages are checked separately.
      body: url.hostname === 'accounts.invalid' ? await request.text() : '',
    })
    if (ordinal === 0) {
      this.arrived.resolve(undefined)
      await Promise.race([this.release.promise, new Promise<never>((_resolve, reject) => {
        const abort = (): void => { reject(new Error('fixture request aborted', { cause: request.signal.reason })) }
        if (request.signal.aborted) { abort(); return }
        request.signal.addEventListener('abort', abort, { once: true })
        void this.release.promise.then(() => { request.signal.removeEventListener('abort', abort) })
      })])
    }
    if (this.failFirstCodexQuota && ordinal === 0 && url.hostname === 'chatgpt.com') {
      this.usage.set('personal', 100)
      return Response.json({ error: { message: 'You have hit your ChatGPT usage limit.', type: 'usage_limit_reached' } }, { status: 429 })
    }
    return sse(url.hostname === 'accounts.invalid'
      ? completionsEvents(ordinal === 0 ? 'first answer' : 'second answer')
      : codexEvents(ordinal === 0 ? 'first answer' : 'second answer'))
  }

  readonly fetchUsage: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const membership = request.headers.get('chatgpt-account-id')
    if (membership === null || !this.usage.has(membership)) throw new Error('unexpected usage membership')
    if (request.method === 'GET' && request.url === 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits') {
      this.resetRequests.push({ method: request.method, membership, authorization: request.headers.get('authorization'), body: '' })
      return Response.json({ credits: [{ id: 'selected-credit', reset_type: 'codex_rate_limits', status: 'available', expires_at: null }] })
    }
    if (request.method === 'POST' && request.url === 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume') {
      this.resetRequests.push({ method: request.method, membership, authorization: request.headers.get('authorization'), body: await request.text() })
      this.usage.set(membership, 0)
      return Response.json({ code: 'reset', windows_reset: 2 })
    }
    if (request.method !== 'GET' || request.url !== 'https://chatgpt.com/backend-api/wham/usage') {
      throw new Error(`unexpected usage request: ${request.method} ${request.url}`)
    }
    this.usageRequests.push(membership)
    if (this.billingUsage !== undefined) {
      this.billingUsage.entered.resolve(undefined)
      await this.billingUsage.release.promise
      if (this.billingUsage.fail) throw new Error('fixture billing usage failed')
    }
    return Response.json({ rate_limit: {
      primary_window: { used_percent: this.usage.get(membership), limit_window_seconds: 18_000, reset_after_seconds: 900 },
      secondary_window: { used_percent: 5, limit_window_seconds: 604_800, reset_after_seconds: 86_400 },
    } })
  }
}

function sse(events: readonly unknown[]): Response {
  return new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function completionsEvents(text: string): unknown[] {
  return [
    { choices: [{ delta: { role: 'assistant', content: text }, index: 0, finish_reason: null }] },
    { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    '[DONE]',
  ]
}

function codexEvents(text: string): unknown[] {
  const item = { type: 'message', id: 'msg_fixture', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] }
  return [
    { type: 'response.created', response: { id: 'resp_fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
  ]
}

/** Inject the external usage endpoint without replacing AccountsController behavior. */
class FixtureAccounts extends AccountsController {
  constructor(ctx: Context) {
    if (wire === undefined) throw new Error('HTTP fixture is not installed')
    super(ctx, { fetchUsage: wire.fetchUsage, now: () => NOW })
  }
}

afterEach(async () => {
  wire?.release.resolve(undefined)
  wire?.billingUsage?.release.resolve(undefined)
  try {
    await context?.fiber.dispose()
    context = undefined
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  } finally {
    wire = undefined
    vi.unstubAllGlobals()
  }
})

async function loadComposition(existingHome?: string): Promise<{ ctx: Context; patchPath: string; http: ProviderWire }> {
  const home = existingHome ?? await mkdtemp(join(tmpdir(), 'dsh-accounts-loader-'))
  root = home
  const http = new ProviderWire()
  wire = http
  vi.stubGlobal('fetch', http.fetch)
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-authorization', AuthorizationService],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['test-accounts', FixtureAccounts],
  ])
  const rows = [...modules.keys()].map(name => ({
    id: name === 'test-accounts' ? 'accounts' : name.replace('@deepseek-ai/dsh-', ''),
    name,
    ...name === '@deepseek-ai/dsh-credentials-local' ? { config: { path: join(home, '.credentials.yaml'), watch: false } } : {},
  }))
  // JSON is valid YAML; the Include/profile loader parses these real entry rows.
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(rows))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: async (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  const patchPath = await profileComposition(ctx, root, configPath)
  await ctx.settings.whenInitialImportSettles()
  const unloaded = [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled).map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  return { ctx, patchPath, http }
}

function routeValue(ctx: Context): unknown {
  const descriptor = ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai')
  if (descriptor === undefined) throw new Error('llm-pi-ai settings did not load')
  return structuredClone(descriptor.value)
}

function followup(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

async function awaitRequest(agent: Agent, http: ProviderWire): Promise<void> {
  await Promise.race([
    http.arrived.promise,
    agent.whenIdle().then(() => { throw new Error(`turn ended before HTTP: ${JSON.stringify(agent.session.snapshotEvents())}`) }),
  ])
}

function transcript(agent: Agent): unknown {
  return agent.session.deriveMessages().map(message => ({
    role: message.role,
    text: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
  }))
}

function codexGrant(membership: 'personal' | 'workspace') {
  const claims = {
    'https://api.openai.com/profile': { email: 'fixture@example.invalid', name: 'Fixture owner' },
    'https://api.openai.com/auth': {
      chatgpt_account_id: membership, chatgpt_user_id: 'fixture-owner',
      chatgpt_plan_type: membership === 'workspace' ? 'team' : 'plus',
    },
  }
  return { kind: 'grant', payload: {
    type: 'oauth', access: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`,
    refresh: 'fixture-refresh-never-used', expires: 4_000_000_000_000, accountId: membership,
  } } satisfies CredentialRecord
}

async function seedCodex(ctx: Context, active: 'personal' | 'workspace'): Promise<void> {
  const accounts = Object.fromEntries((['personal', 'workspace'] as const).map(id => [id, {
    id, provider: 'openai-codex', authMode: 'oauth', credential: codexGrant(id), name: id, createdAt: NOW,
  }]))
  await ctx.credentials.modifyRecord(VAULT, () => Promise.resolve({ kind: 'grant', payload: {
    version: 1, providers: { 'openai-codex': { activeAccountId: active, autoSwitchOnLimit: true, accounts } },
  } }))
  await ctx.credentials.modifyRecord(CODEX, () => Promise.resolve(codexGrant(active)))
}

describe('accounts across real Loader turns', () => {
  // Source imports plus real profile/HMR startup use the same cold-cache budget as other Loader suites.
  it('activates a key account during an in-flight turn without replacing its agent, session, or custom route', { timeout: 60_000 }, async () => {
    const { ctx, patchPath, http } = await loadComposition()
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'zai'], value: {
      api: 'openai-completions', baseURL: 'https://accounts.invalid/v1',
      headers: { 'x-fixture-route': 'preserve' }, reasoning: 'off', transport: 'sse',
      models: [{ id: 'fixture-model', contextWindow: 8192, maxTokens: 1024 }],
    } }])
    await ctx.accountsController.addApiKey('zai', 'first key', 'fixture-key-first')
    const state = await ctx.accountsController.addApiKey('zai', 'second key', 'fixture-key-second')
    const next = state.accounts.find(account => account.name === 'second key')
    if (next === undefined) throw new Error('second account was not saved')
    const configBefore = routeValue(ctx)
    const patchBefore = await readFile(patchPath, 'utf8')
    const agent = await ctx.agentLoop.create(SessionId('manual-selection'), { provider: 'zai', model: 'fixture-model' })
    const session = agent.session
    followup(agent, 'first question')
    await awaitRequest(agent, http)
    const eventsBefore = session.snapshotEvents()
    try {
      await ctx.accountsController.activate('zai', next.id)
      expect(await ctx.credentials.readRecord(KEY)).toEqual({ kind: 'api-key', key: 'fixture-key-second' })
      expect(ctx.agents.get(agent.id)).toBe(agent)
      expect(agent.session).toBe(session)
      expect(session.snapshotEvents()).toEqual(eventsBefore)
      expect(routeValue(ctx)).toEqual(configBefore)
      expect(await readFile(patchPath, 'utf8')).toBe(patchBefore)
    } finally {
      http.release.resolve(undefined)
    }
    await agent.whenIdle()
    const firstTurn = session.snapshotEvents()
    followup(agent, 'second question')
    await agent.whenIdle()
    expect(session.snapshotEvents().slice(0, firstTurn.length)).toEqual(firstTurn)
    expect(http.requests.map(request => request.authorization)).toEqual(['Bearer fixture-key-first', 'Bearer fixture-key-second'])
    expect(http.requests.map(request => request.routeHeader)).toEqual(['preserve', 'preserve'])
    expect(http.requests.map(request => request.url)).toEqual([
      'https://accounts.invalid/v1/chat/completions', 'https://accounts.invalid/v1/chat/completions',
    ])
    const nextRequest: unknown = JSON.parse(http.requests[1]!.body)
    expect(nextRequest).toHaveProperty('model', 'fixture-model')
    expect(nextRequest).toHaveProperty('messages', expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'first question' }),
      expect.objectContaining({ role: 'assistant', content: 'first answer' }),
      expect.objectContaining({ role: 'user', content: 'second question' }),
    ]))
    expect(transcript(agent)).toMatchInlineSnapshot(`
      [
        {
          "role": "system",
          "text": "You are an AI agent powered by DeepSeek Harness.",
        },
        {
          "role": "user",
          "text": "first question",
        },
        {
          "role": "assistant",
          "text": "first answer",
        },
        {
          "role": "user",
          "text": "second question",
        },
        {
          "role": "assistant",
          "text": "second answer",
        },
      ]
    `)
    expect(ctx.agents.get(agent.id)).toBe(agent)
    expect(agent.session).toBe(session)
  })

  it('lists and consumes a selected reset through the Loader without refreshing or promoting another membership', { timeout: 60_000 }, async () => {
    const { ctx, patchPath, http } = await loadComposition()
    await seedCodex(ctx, 'personal')
    await ctx.accountsController.setAutoSwitch('openai-codex', false)
    http.usage.set('personal', 100)
    const before = await ctx.accountsController.refreshUsage(new AbortController().signal)
    await ctx.accountsController.setAutoSwitch('openai-codex', true)
    const selected = before.accounts.find(account => account.usageScope === 'workspace')
    if (selected === undefined) throw new Error('workspace membership was not saved')
    const configBefore = routeValue(ctx)
    const patchBefore = await readFile(patchPath, 'utf8')
    const changes: AccountsState[] = []
    const switches: AccountAutoSwitchEvent[] = []
    ctx.on('accounts/changed', (state) => { changes.push(state) })
    ctx.on('accounts/auto-switched', (event) => { switches.push(event) })
    http.usageRequests.length = 0
    const list = await ctx.accountsController.listResetCredits(selected.id, new AbortController().signal)
    const [credit] = list.credits
    if (credit === undefined) throw new Error('reset credit was not listed')
    expect(http.usageRequests).toEqual([])
    expect(changes).toEqual([])
    const result = await ctx.accountsController.consumeResetCredit(selected.id, credit.id, 'selected-attempt', new AbortController().signal)
    expect(result.outcome).toBe('reset')
    expect(http.resetRequests).toEqual([
      { method: 'GET', membership: 'workspace', authorization: `Bearer ${codexGrant('workspace').payload.access}`, body: '' },
      { method: 'POST', membership: 'workspace', authorization: `Bearer ${codexGrant('workspace').payload.access}`,
        body: JSON.stringify({ redeem_request_id: 'selected-attempt', credit_id: 'selected-credit' }) },
    ])
    expect(http.usageRequests).toEqual(['workspace'])
    expect(result.state.accounts.map(account => ({ scope: account.usageScope, active: account.active,
      usedPercent: account.usage?.windows[0]?.usedPercent }))).toEqual([
      { scope: 'personal', active: true, usedPercent: 100 },
      { scope: 'workspace', active: false, usedPercent: 0 },
    ])
    expect(changes).toEqual([result.state])
    expect(await ctx.accountsController.describe()).toEqual(result.state)
    expect(await ctx.credentials.readRecord(VAULT)).toMatchObject({ kind: 'grant', payload: { providers: {
      'openai-codex': { accounts: { [selected.id]: { usage: { windows: [
        expect.objectContaining({ usedPercent: 0 }), expect.objectContaining({ usedPercent: 5 }),
      ] } } } },
    } } })
    expect(await ctx.credentials.readRecord(CODEX)).toEqual(codexGrant('personal'))
    expect(switches).toEqual([])
    expect(routeValue(ctx)).toEqual(configBefore)
    expect(await readFile(patchPath, 'utf8')).toBe(patchBefore)
    expect(JSON.stringify(result)).not.toContain('fixture-refresh-never-used')
    expect(JSON.stringify(result)).not.toContain('signature')
  })

  it('pushes fresh usage after a real Codex request with automatic switching disabled', { timeout: 60_000 }, async () => {
    const { ctx, http } = await loadComposition()
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'openai-codex'], value: {
      transport: 'sse', reasoning: 'off',
    } }])
    await seedCodex(ctx, 'personal')
    await ctx.accountsController.setAutoSwitch('openai-codex', false)
    const changes: AccountsState[] = []
    ctx.on('accounts/changed', (state) => { changes.push(state) })
    const [model] = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai-codex' })
    if (model === undefined) throw new Error('installed Codex catalog is empty')
    const agent = await ctx.agentLoop.create(SessionId('codex-live-usage'), { provider: 'openai-codex', model: model.id })
    followup(agent, 'first question')
    await awaitRequest(agent, http)
    expect(http.usageRequests).toEqual([])
    http.usage.set('personal', 79)
    http.release.resolve(undefined)
    await agent.whenIdle()
    await vi.waitFor(() => {
      expect(changes.at(-1)?.accounts.find(account => account.active)?.usage?.windows[0]?.usedPercent).toBe(79)
    })
    expect(await ctx.credentials.readRecord(CODEX)).toEqual(codexGrant('personal'))
    expect(transcript(agent)).toEqual([
      { role: 'system', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
    ])
  })

  it('recovers a real Codex quota failure without racing post-stream usage against promotion', { timeout: 60_000 }, async () => {
    const { ctx, http } = await loadComposition()
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'openai-codex'], value: {
      transport: 'sse', reasoning: 'off',
    } }])
    await seedCodex(ctx, 'personal')
    http.failFirstCodexQuota = true
    const switches: AccountAutoSwitchEvent[] = []
    ctx.on('accounts/auto-switched', (event) => { switches.push(event) })
    const [model] = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai-codex' })
    if (model === undefined) throw new Error('installed Codex catalog is empty')
    const agent = await ctx.agentLoop.create(SessionId('codex-quota-recovery'), { provider: 'openai-codex', model: model.id })
    followup(agent, 'first question')
    await awaitRequest(agent, http)
    http.release.resolve(undefined)
    await agent.whenIdle()
    expect(http.requests.map(request => request.membership)).toEqual(['personal', 'workspace'])
    expect(switches.map(event => event.reason)).toEqual(['quota'])
    expect(transcript(agent)).toEqual([
      { role: 'system', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'second answer' },
    ])
  })

  it.each(['personal', 'workspace'] as const)('automatically fails over from %s while a Codex request is in flight', { timeout: 60_000 }, async (active) => {
    const { ctx, patchPath, http } = await loadComposition()
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'openai-codex'], value: {
      transport: 'sse', reasoning: 'off', headers: { 'x-fixture-route': 'codex-preserve' },
    } }])
    await seedCodex(ctx, active)
    const replacement = active === 'personal' ? 'workspace' : 'personal'
    const switches: AccountAutoSwitchEvent[] = []
    ctx.on('accounts/auto-switched', (event) => { switches.push(event) })
    const configBefore = routeValue(ctx)
    const patchBefore = await readFile(patchPath, 'utf8')
    const [model] = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai-codex' })
    if (model === undefined) throw new Error('installed Codex catalog is empty')
    const agent = await ctx.agentLoop.create(SessionId(`codex-${active}`), { provider: 'openai-codex', model: model.id })
    const session = agent.session
    followup(agent, 'first question')
    await awaitRequest(agent, http)
    const eventsBefore = session.snapshotEvents()
    try {
      http.usage.set(active, 96)
      const state = await ctx.accountsController.refreshUsage(new AbortController().signal)
      expect(state.accounts.find(account => account.active)?.name).toBe(replacement)
      expect(state.accounts).toHaveLength(2)
      expect(new Set(state.accounts.map(account => account.ownerId)).size).toBe(1)
      expect(state.accounts.map(account => account.usageScope).sort()).toEqual(['personal', 'workspace'])
      expect(await ctx.credentials.readRecord(CODEX)).toEqual(codexGrant(replacement))
      expect(switches).toEqual([expect.objectContaining({
        provider: 'openai-codex', reason: 'threshold',
        from: { name: active, usageScope: active }, to: { name: replacement, usageScope: replacement },
      })])
      expect(ctx.agents.get(agent.id)).toBe(agent)
      expect(agent.session).toBe(session)
      expect(session.snapshotEvents()).toEqual(eventsBefore)
      expect(routeValue(ctx)).toEqual(configBefore)
      expect(await readFile(patchPath, 'utf8')).toBe(patchBefore)
    } finally {
      http.release.resolve(undefined)
    }
    await agent.whenIdle()
    const firstTurn = session.snapshotEvents()
    followup(agent, 'second question')
    await agent.whenIdle()
    expect(http.requests.map(request => request.membership)).toEqual([active, replacement])
    expect(http.requests.map(request => request.routeHeader)).toEqual(['codex-preserve', 'codex-preserve'])
    expect(http.requests.map(request => request.authorization)).toEqual([
      `Bearer ${codexGrant(active).payload.access}`,
      `Bearer ${codexGrant(replacement).payload.access}`,
    ])
    expect(http.usageRequests.slice(0, 4)).toEqual([active, replacement, active, replacement])
    expect(http.usageRequests.slice(4, 6)).toEqual([replacement, active])
    expect(session.snapshotEvents().slice(0, firstTurn.length)).toEqual(firstTurn)
    expect(transcript(agent)).toEqual([
      { role: 'system', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { role: 'user', text: 'first question' }, { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'second question' }, { role: 'assistant', text: 'second answer' },
    ])
    expect(ctx.agents.get(agent.id)).toBe(agent)
    expect(agent.session).toBe(session)
  })
})

describe('manual billing dates through the real source Loader', () => {
  it('retains a Kimi reminder during token rotation but removes it on canonical subject replacement', { timeout: 60_000 }, async () => {
    const { ctx, http } = await loadComposition()
    const key = credentialKey('llm-pi-ai', 'kimi-coding')
    const grant = (subject: string, refresh: string) => ({ kind: 'grant' as const, payload: {
      access: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature`,
      refresh, expires: 4_000_000_000_000,
    } })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(grant('first-owner', 'initial-token')))
    const [account] = (await ctx.accountsController.describe()).accounts
    if (account === undefined) throw new Error('Kimi membership was not saved')
    await ctx.accountsController.setManualBillingDate('kimi-coding', account.id, '2028-02-29')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(grant('first-owner', 'rotated-token')))
    expect((await ctx.accountsController.describe()).accounts[0]?.manualBillingDate).toBe('2028-02-29')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(grant('replacement-owner', 'replacement-token')))
    expect((await ctx.accountsController.describe()).accounts[0]).not.toHaveProperty('manualBillingDate')
    expect(await ctx.credentials.readRecord(VAULT))
      .not.toHaveProperty(`payload.providers.kimi-coding.accounts.${account.id}.manualBillingDate`)
    if (root === undefined) throw new Error('Loader home was not allocated')
    expect(await readFile(join(root, '.credentials.yaml'), 'utf8')).not.toContain('2028-02-29')
    expect(http.requests).toEqual([])
    expect(http.usageRequests).toEqual([])
  })

  it('rejects a corrupt saved reminder without rewriting local credentials', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition()
    const account = (id: string, provider: 'zai' | 'opencode') => ({
      id, provider, authMode: 'api-key', credential: { kind: 'api-key', key: `secret-${id}` }, name: id, createdAt: NOW,
    })
    await ctx.credentials.modifyRecord(VAULT, () => Promise.resolve({ kind: 'grant', payload: {
      version: 1, providers: {
        zai: { activeAccountId: 'bad', accounts: {
          malformed: null,
          bad: { ...account('bad', 'zai'), usageError: 123, manualBillingDate: '1900-02-29' }, sibling: account('sibling', 'zai'),
        } },
        opencode: { activeAccountId: 'old', accounts: { old: account('old', 'opencode') } },
      },
    } }))
    if (root === undefined) throw new Error('Loader home was not allocated')
    const credentialsPath = join(root, '.credentials.yaml')
    const before = await readFile(credentialsPath, 'utf8')
    const recordBefore = await ctx.credentials.readRecord(VAULT)
    const changes: AccountsState[] = []
    ctx.on('accounts/changed', (state) => { changes.push(state) })
    await expect(ctx.accountsController.describe()).rejects.toMatchObject({ code: 'accounts/rejected' })
    await expect(ctx.accountsController.setManualBillingDate('zai', 'sibling', '2028-02-29'))
      .rejects.toMatchObject({ code: 'accounts/rejected' })
    expect(await ctx.credentials.readRecord(VAULT)).toEqual(recordBefore)
    expect(await readFile(credentialsPath, 'utf8')).toBe(before)
    expect(changes).toEqual([])
  })

  it('persists redacted membership and provider dates through local-credential restarts, rename and canonical import', { timeout: 60_000 }, async () => {
    const { ctx, patchPath, http } = await loadComposition()
    if (root === undefined) throw new Error('Loader home was not allocated')
    const home = root
    const credentialsPath = join(home, '.credentials.yaml')
    await seedCodex(ctx, 'personal')
    await ctx.accountsController.setAutoSwitch('openai-codex', false)
    const old = await ctx.accountsController.describe()
    expect(old.accounts).toHaveLength(2)
    expect(old.accounts.every(account => !Object.hasOwn(account, 'manualBillingDate'))).toBe(true)
    const personal = old.accounts.find(account => account.usageScope === 'personal')
    const workspace = old.accounts.find(account => account.usageScope === 'workspace')
    if (personal === undefined || workspace === undefined) throw new Error('billing memberships were not saved')
    expect(personal.ownerId).toBe(workspace.ownerId)
    const [keyAccount] = (await ctx.accountsController.addApiKey('zai', 'Billing key', 'loader-billing-secret')).accounts
      .filter(account => account.provider === 'zai')
    if (keyAccount === undefined) throw new Error('billing key was not saved')
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService)
    const changes: AccountsState[] = []
    const eventFiles: Promise<string>[] = []
    ctx.on('accounts/changed', (state) => {
      changes.push(state)
      eventFiles.push(readFile(credentialsPath, 'utf8'))
    })
    const configBefore = routeValue(ctx)
    const patchBefore = await readFile(patchPath, 'utf8')
    const beforeRejected = await ctx.credentials.readRecord(VAULT)
    for (const date of ['1900-02-29', '0000-01-01', '2028-04-31', '2028-02-29T00:00:00Z', false]) {
      await expect(ctx.typertGateway.invoke({ namespace: 'accounts', method: 'setManualBillingDate', args: {
        provider: 'openai-codex', accountId: personal.id, date,
      } })).rejects.toMatchObject({ code: 'accounts/rejected' })
    }
    await expect(ctx.accountsController.setManualBillingDate('zai', personal.id, '2028-02-29'))
      .rejects.toMatchObject({ code: 'accounts/not-found' })
    expect(await ctx.credentials.readRecord(VAULT)).toEqual(beforeRejected)
    expect(changes).toEqual([])
    const saved = await ctx.typertGateway.invoke({ namespace: 'accounts', method: 'setManualBillingDate', args: {
      provider: 'openai-codex', accountId: personal.id, date: '2028-02-29',
    } })
    expect(saved).toHaveProperty('accounts.0.manualBillingDate', '2028-02-29')
    expect(await Promise.all(eventFiles)).toEqual([expect.stringContaining('2028-02-29')])
    await ctx.accountsController.setManualBillingDate('openai-codex', workspace.id, '2030-04-30')
    const state = await ctx.accountsController.setManualBillingDate('zai', keyAccount.id, '0001-01-01')
    expect(changes.at(-1)).toEqual(state)
    const visible = JSON.stringify([saved, state, changes])
    expect(visible).not.toContain('fixture-refresh-never-used')
    expect(visible).not.toContain('signature')
    expect(visible).not.toContain('loader-billing-secret')
    const file = await readFile(credentialsPath, 'utf8')
    for (const date of ['2028-02-29', '2030-04-30', '0001-01-01']) expect(file).toContain(date)
    const durable = await ctx.credentials.readRecord(VAULT)
    expect(durable).toMatchObject({ kind: 'grant', payload: { providers: {
      'openai-codex': { accounts: {
        [personal.id]: { manualBillingDate: '2028-02-29' }, [workspace.id]: { manualBillingDate: '2030-04-30' },
      } }, zai: { accounts: { [keyAccount.id]: { manualBillingDate: '0001-01-01' } } },
    } } })
    expect(routeValue(ctx)).toEqual(configBefore)
    expect(await readFile(patchPath, 'utf8')).toBe(patchBefore)
    expect(await ctx.credentials.readRecord(CODEX)).toEqual(codexGrant('personal'))
    expect(http.usageRequests).toEqual([])
    expect(http.requests).toEqual([])
    await Promise.all(eventFiles)
    await ctx.fiber.dispose()
    context = undefined

    const restarted = await loadComposition(home)
    expect(await restarted.ctx.credentials.readRecord(VAULT)).toEqual(durable)
    const restored = await restarted.ctx.accountsController.describe()
    expect(restored.accounts).toEqual(state.accounts)
    await restarted.ctx.accountsController.rename('openai-codex', personal.id, 'Personal billing')
    const grant = codexGrant('personal')
    const rotated = { ...grant, payload: { ...grant.payload, refresh: 'loader-billing-canonical-rotation' } }
    await restarted.ctx.credentials.modifyRecord(CODEX, () => Promise.resolve(rotated))
    const imported = await restarted.ctx.accountsController.describe()
    expect(imported.accounts.find(account => account.id === personal.id)).toMatchObject({
      name: 'Personal billing', manualBillingDate: '2028-02-29', active: true,
    })
    expect(imported.accounts.find(account => account.id === workspace.id)?.manualBillingDate).toBe('2030-04-30')
    expect(await restarted.ctx.credentials.readRecord(VAULT))
      .toHaveProperty(`payload.providers.openai-codex.accounts.${personal.id}.credential.payload.refresh`, rotated.payload.refresh)
    await restarted.ctx.accountsController.setManualBillingDate('openai-codex', personal.id, null)
    const cleared = await restarted.ctx.accountsController.setManualBillingDate('zai', keyAccount.id, null)
    expect(cleared.accounts.find(account => account.id === personal.id)).not.toHaveProperty('manualBillingDate')
    expect(cleared.accounts.find(account => account.id === keyAccount.id)).not.toHaveProperty('manualBillingDate')
    expect(cleared.accounts.find(account => account.id === workspace.id)?.manualBillingDate).toBe('2030-04-30')
    const clearedFile = await readFile(credentialsPath, 'utf8')
    expect(clearedFile).not.toContain('2028-02-29')
    expect(clearedFile).not.toContain('0001-01-01')
    expect(clearedFile).toContain('2030-04-30')
    await restarted.ctx.fiber.dispose()
    context = undefined

    const afterClear = await loadComposition(home)
    expect((await afterClear.ctx.accountsController.describe()).accounts).toEqual(cleared.accounts)
    expect(await afterClear.ctx.credentials.readRecord(VAULT))
      .not.toHaveProperty(`payload.providers.openai-codex.accounts.${personal.id}.manualBillingDate`)
  })

  it.each(['success', 'error'] as const)(
    'retains concurrent set and clear edits during %s usage with real local storage', { timeout: 60_000 }, async (outcome) => {
      const { ctx, http } = await loadComposition()
      if (root === undefined) throw new Error('Loader home was not allocated')
      const credentialsPath = join(root, '.credentials.yaml')
      await seedCodex(ctx, 'personal')
      await ctx.accountsController.setAutoSwitch('openai-codex', false)
      const accounts = (await ctx.accountsController.describe()).accounts
      const personal = accounts.find(account => account.usageScope === 'personal')
      const workspace = accounts.find(account => account.usageScope === 'workspace')
      if (personal === undefined || workspace === undefined) throw new Error('billing memberships were not saved')
      await ctx.accountsController.setManualBillingDate('openai-codex', personal.id, '2030-01-01')
      await ctx.accountsController.setManualBillingDate('openai-codex', workspace.id, '2031-01-01')
      const held = { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>(), fail: outcome === 'error' }
      http.billingUsage = held
      const refresh = ctx.accountsController.refreshUsage(new AbortController().signal)
      const changes: AccountsState[] = []
      ctx.on('accounts/changed', (state) => { changes.push(state) })
      try {
        await Promise.race([
          held.entered.promise,
          refresh.then(() => { throw new Error('billing refresh settled before HTTP') }),
        ])
        await ctx.accountsController.setManualBillingDate('openai-codex', personal.id, '2032-02-29')
        await ctx.accountsController.setManualBillingDate('openai-codex', workspace.id, null)
        changes.length = 0
        held.release.resolve(undefined)
        const state = await refresh
        expect(state.accounts.find(account => account.id === personal.id)?.manualBillingDate).toBe('2032-02-29')
        expect(state.accounts.find(account => account.id === workspace.id)).not.toHaveProperty('manualBillingDate')
        expect(changes.length).toBeGreaterThan(0)
        expect(changes.every(state => state.accounts.find(account => account.id === personal.id)?.manualBillingDate === '2032-02-29'
          && state.accounts.find(account => account.id === workspace.id)?.manualBillingDate === undefined)).toBe(true)
        expect(state.accounts.every(account => outcome === 'error'
          ? account.usageError === 'Usage is temporarily unavailable.' : account.usage !== undefined)).toBe(true)
        expect(await ctx.accountsController.describe()).toEqual(state)
        const durable = await ctx.credentials.readRecord(VAULT)
        expect(durable).toHaveProperty(`payload.providers.openai-codex.accounts.${personal.id}.manualBillingDate`, '2032-02-29')
        expect(durable).not.toHaveProperty(`payload.providers.openai-codex.accounts.${workspace.id}.manualBillingDate`)
        const file = await readFile(credentialsPath, 'utf8')
        expect(file).toContain('2032-02-29')
        expect(file).not.toContain('2030-01-01')
        expect(file).not.toContain('2031-01-01')
        expect(await ctx.credentials.readRecord(CODEX)).toEqual(codexGrant('personal'))
      } finally {
        held.release.resolve(undefined)
        await Promise.allSettled([refresh])
      }
    },
  )
})
