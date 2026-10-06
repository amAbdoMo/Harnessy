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
  readonly usage = new Map<string, number>([['personal', 10], ['workspace', 20]])
  failFirstCodexQuota = false

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
    if (request.url !== 'https://chatgpt.com/backend-api/wham/usage') {
      throw new Error(`unexpected usage URL: ${request.url}`)
    }
    const membership = request.headers.get('chatgpt-account-id')
    if (membership === null || !this.usage.has(membership)) throw new Error('unexpected usage membership')
    this.usageRequests.push(membership)
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

async function loadComposition(): Promise<{ ctx: Context; patchPath: string; http: ProviderWire }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-accounts-loader-'))
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
