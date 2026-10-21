/** Keyless real-Loader regressions for Codex socket identity, truncation, and bounded recovery. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, {
  createAssistantMessage, createSystemMessage, createUserMessage, ReasoningEffortId, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Commands from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { closeOpenAICodexWebSocketSessions, resetOpenAICodexWebSocketDebugStats } from '@earendil-works/pi-ai/api/openai-codex-responses'
import * as LlmPiAi from '../src/index.ts'
import { recordKeyFor } from '../src/auth.ts'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import { assemble } from './assemble.ts'
import { memoryAuth } from './auth-double.ts'
import { resolveProfiles } from '../src/config.ts'
import { textEvents } from './mock-server.ts'

/** Mock only the external WebSocket transport; the SDK owns auth, framing, parsing, and its real cache. */
class CodexSocket extends EventTarget {
  static connections: CodexSocket[] = []
  readyState = 1
  requests: string[] = []
  constructor(readonly url: string, readonly options: { headers: Record<string, string> }) {
    super()
    CodexSocket.connections.push(this)
    queueMicrotask(() => this.dispatchEvent(new Event('open')))
  }
  send(body: string): void { this.requests.push(body) }
  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean: code === 1000 }))
  }
  partial(): void {
    for (const event of [
      { type: 'response.created', response: { id: 'resp' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'unfinished' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_partial', call_id: 'call_partial', name: 'lookup', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"query":"unfinished' },
    ]) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
  }
  complete(text: string): void {
    for (const event of completionEvents(text)) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
  }
}

function completionEvents(text: string) {
  const item = { type: 'message', id: 'msg', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
  return [
    { type: 'response.created', response: { id: 'resp' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
  ]
}

function grant(person: string, workspace: string): OAuthCredential {
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_user_id: person, chatgpt_account_id: workspace } })).toString('base64url')
  return { type: 'oauth', access: `e30.${claims}.test`, refresh: 'test-refresh', expires: Date.now() + 3_600_000, accountId: workspace }
}

let ctx: Context | undefined
let root: string | undefined
const streams: Promise<unknown>[] = []
const credentialReleases: Array<() => void> = []

function track<T>(stream: Promise<T>): Promise<T> {
  streams.push(stream)
  void stream.catch((_error: unknown) => {}) // Teardown joins failed streams even when an earlier assertion stops the scenario.
  return stream
}

afterEach(async () => {
  try {
    for (const release of credentialReleases.splice(0)) release()
    closeOpenAICodexWebSocketSessions()
    for (const socket of CodexSocket.connections) socket.close()
    await Promise.allSettled(streams.splice(0))
    try { await ctx?.fiber.dispose() }
    finally { if (root !== undefined) await rm(root, { recursive: true, force: true }) }
  } finally {
    resetOpenAICodexWebSocketDebugStats()
    ctx = undefined
    root = undefined
    CodexSocket.connections = []
    vi.unstubAllGlobals()
  }
})

async function load(options: { fastMode?: boolean; recovery?: boolean; transport?: 'sse' | 'websocket'; persistence?: boolean } = {}): Promise<Context> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-codex-sockets-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm\n  name: test-llm',
    `- id: credentials\n  name: test-credentials\n  config:\n    path: ${JSON.stringify(join(root, '.credentials.yaml'))}\n    watch: false`,
    ...options.fastMode !== true && options.recovery !== true ? [] : [
      '- id: sessions\n  name: test-sessions',
      '- id: projections\n  name: test-projections',
      '- id: commands\n  name: test-commands',
      '- id: agents\n  name: test-agents',
      '- id: system-prompt\n  name: test-system-prompt',
      '- id: tools\n  name: test-tools',
      ...options.persistence !== true ? [] : [
        `- id: persistence\n  name: test-jsonl\n  config:\n    root: ${JSON.stringify(join(root, 'sessions'))}\n    compression: none`,
      ],
      '- id: agent-loop\n  name: test-agent-loop\n  config:\n    agents: []',
    ],
    ...options.recovery !== true ? [] : ['- id: retry\n  name: test-retry'],
    `- id: llm-pi-ai\n  name: test-pi-ai\n  config:\n    providers:\n      openai-codex:\n        transport: ${options.transport ?? 'websocket'}${options.recovery !== true ? '' : '\n        retryPolicy:\n          mode: normal\n          maxRetries: 1\n          backoff:\n            initialDelayMs: 1\n            maxDelayMs: 1\n            jitterRatio: 0'}`,
    '',
  ].join('\n'))
  const context = new Context()
  ctx = context
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm', LlmRuntime], ['test-credentials', LocalCredentialProvider], ['test-pi-ai', LlmPiAi],
    ['test-sessions', SessionStore], ['test-projections', Projections], ['test-commands', Commands],
    ['test-agents', AgentRegistry], ['test-agent-loop', AgentLoop],
    ['test-system-prompt', SystemPrompt], ['test-tools', Tools], ['test-jsonl', JsonlSessionPersistence], ['test-retry', LlmRetry],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import: (specifier) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job') },
    resolveSync(): never { throw new Error('unexpected synchronous resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  context.loader.internal = internal
  await profileComposition(context, root, configPath)
  return context
}

describe('Codex socket settlement', () => {
  it.each([1000, 1012, 'error'] as const)('treats socket failure %s before completion as retryable truncation and recovers the same Session over SSE', async (code) => {
    vi.stubGlobal('WebSocket', CodexSocket)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('unexpected HTTP request') })
    vi.stubGlobal('fetch', fetch)
    const context = await load()
    const model = getBuiltinModels('openai-codex')[0]
    if (model === undefined) throw new Error('installed Codex catalog has no models')
    await context.credentials.modifyRecord(recordKeyFor('openai-codex'), () => Promise.resolve({ kind: 'grant', payload: grant('person', 'work') }))
    const options = {
      provider: 'openai-codex', model: model.id, sessionId: brandString<Branded<'SessionId'>>(`truncated-session-${code}`), messages: [],
      tools: [{ name: 'lookup', description: 'Look up a query.', parameters: { type: 'object', properties: { query: { type: 'string' } } } }],
    }
    const prepared = await context.llm.prepareCall({ provider: options.provider, model: options.model })
    const chunks: StreamChunk[] = []
    const running = track((async () => {
      for await (const chunk of prepared.stream({ ...options, ...prepared.config })) chunks.push(chunk)
    })())
    await vi.waitFor(() => { expect(CodexSocket.connections[0]?.requests).toHaveLength(1) })
    const first = CodexSocket.connections[0]!
    first.partial()
    await vi.waitFor(() => {
      expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'unfinished' })
      expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-call-delta', index: 1, name: 'lookup', argumentsDelta: '{"query":"unfinished' }))
    })
    if (code === 'error') first.dispatchEvent(new Event('error'))
    else first.close(code)
    await running

    expect(chunks.filter(chunk => chunk.type === 'block-end')).toEqual([])
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') throw new Error('expected failed stream settlement')
    const policy = prepared.retryPolicy
    expect(policy.mode).toBe('normal')
    if (policy.mode !== 'normal') throw new Error('expected normal provider retry policy')
    expect(policy.maxRetries).toBeGreaterThan(0)
    expect(policy.retryableCodes).toContain(finish.reason.failure.code)
    expect(policy.retryableCodes).not.toContain('PI_AI_ERROR')

    // A started response cannot replay inside the SDK; a later same-Session request uses its SSE fallback.
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockResolvedValueOnce(new Response(completionEvents('recovered').map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    }))
    const result = await track(assemble(context, options))
    const outcome = {
      failedFinishes: chunks.flatMap(chunk => chunk.type === 'finish' ? [chunk.reason] : []),
      recovered: { finish: result.finish, content: result.message.content },
    }
    await expect(JSON.stringify(outcome, null, 2) + '\n').toMatchFileSnapshot(`./expected/codex-close-${code}.json`)
    expect(first.readyState).toBe(3)
    expect(CodexSocket.connections).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps a completed response successful when its socket closes normally', async () => {
    vi.stubGlobal('WebSocket', CodexSocket)
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('unexpected HTTP request'))))
    const context = await load()
    const model = getBuiltinModels('openai-codex')[0]
    if (model === undefined) throw new Error('installed Codex catalog has no models')
    await context.credentials.modifyRecord(recordKeyFor('openai-codex'), () => Promise.resolve({ kind: 'grant', payload: grant('person', 'work') }))
    const chunks: StreamChunk[] = []
    const running = track((async () => {
      for await (const chunk of context.llm.stream({
        provider: 'openai-codex', model: model.id,
        sessionId: brandString<Branded<'SessionId'>>('completed-session'), messages: [],
      })) chunks.push(chunk)
    })())
    await vi.waitFor(() => { expect(CodexSocket.connections[0]?.requests).toHaveLength(1) })
    const socket = CodexSocket.connections[0]!
    socket.complete('complete')
    await vi.waitFor(() => {
      expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'complete' } })
    })
    socket.close(1000)
    await running
    expect(chunks.filter(chunk => chunk.type === 'finish')).toEqual([
      expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
    ])
    expect(socket.readyState).toBe(3)
  })
})

describe('Codex dispatch identity', () => {
  it('switches people in one workspace and Personal/Work without interrupting the dispatched stream', async () => {
    vi.stubGlobal('WebSocket', CodexSocket)
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('unexpected HTTP request'))))
    const context = await load()
    const model = getBuiltinModels('openai-codex')[0]
    if (model === undefined) throw new Error('installed Codex catalog has no models')
    const key = recordKeyFor('openai-codex')
    await context.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: grant('first-person', 'shared-work') }))
    const options = { provider: 'openai-codex', model: model.id, sessionId: brandString<Branded<'SessionId'>>('switching-session'), messages: [] }

    const warm = track(assemble(context, options))
    await vi.waitFor(() =>{  expect(CodexSocket.connections[0]?.requests).toHaveLength(1) })
    const first = CodexSocket.connections[0]!
    first.complete('warm')
    expect((await warm).message.content).toEqual([{ type: 'text', text: 'warm' }])

    const running = track(assemble(context, options))
    await vi.waitFor(() =>{  expect(first.requests).toHaveLength(2) })
    const prepared = await context.llm.prepareCall({ provider: options.provider, model: options.model })
    await context.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: grant('second-person', 'shared-work') }))
    const switched = track((async () => {
      const chunks = []
      for await (const chunk of prepared.stream({ ...prepared.config, ...options })) chunks.push(chunk)
      return chunks
    })())
    await vi.waitFor(() =>{  expect(CodexSocket.connections[1]?.requests).toHaveLength(1) })
    const second = CodexSocket.connections[1]!
    expect(second.options.headers.authorization).toBe(`Bearer ${grant('second-person', 'shared-work').access}`)
    expect(first.readyState).toBe(1)
    first.complete('first still finishes')
    second.complete('second dispatch')
    expect((await running).message.content).toEqual([{ type: 'text', text: 'first still finishes' }])
    expect(await switched).toContainEqual({ type: 'text-delta', index: 0, text: 'second dispatch' })
    expect(await switched).toContainEqual(expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }))

    await context.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: grant('second-person', 'personal') }))
    const personal = track(assemble(context, options))
    await vi.waitFor(() =>{  expect(CodexSocket.connections[2]?.requests).toHaveLength(1) })
    CodexSocket.connections[2]!.complete('personal')
    expect((await personal).message.content).toEqual([{ type: 'text', text: 'personal' }])

    await context.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: grant('second-person', 'shared-work') }))
    const work = track(assemble(context, options))
    await vi.waitFor(() =>{  expect(second.requests).toHaveLength(2) })
    second.complete('work again')
    expect((await work).message.content).toEqual([{ type: 'text', text: 'work again' }])
    expect(CodexSocket.connections).toHaveLength(3)
    expect(second.requests.join('')).not.toContain(grant('second-person', 'shared-work').access)
  })
})

describe('Codex bounded recovery in real Loader composition', () => {
  it.each(['websocket', 'fetch', 'exhausted', 'quota'] as const)('settles %s through the shipping agent loop', async (scenario) => {
    vi.stubGlobal('WebSocket', CodexSocket)
    const request = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      await codexRequest(input, init)
      if (scenario === 'exhausted' || scenario === 'fetch' && request.mock.calls.length === 1) {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('private network detail'), { code: 'ECONNRESET' }) })
      }
      if (scenario === 'quota') return new Response(JSON.stringify({ error: { message: 'You have hit your ChatGPT usage limit.' } }), { status: 429 })
      return sseCompletion()
    })
    vi.stubGlobal('fetch', request)
    const context = await load({ recovery: true, transport: scenario === 'websocket' ? 'websocket' : 'sse' })
    const model = getBuiltinModels('openai-codex')[0]
    if (model === undefined) throw new Error('installed Codex catalog has no models')
    await context.credentials.modifyRecord(recordKeyFor('openai-codex'), () => Promise.resolve({ kind: 'grant', payload: grant('person', 'work') }))
    const agent = await context.agentLoop.create(SessionId(`recovery-${scenario}`), { provider: 'openai-codex', model: model.id })
    let streamed = false
    context.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'chunk') streamed = true })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    const idle = track(agent.whenIdle())
    if (scenario === 'websocket') {
      await vi.waitFor(() => { expect(CodexSocket.connections[0]?.requests).toHaveLength(1) })
      const socket = CodexSocket.connections[0]!
      socket.partial()
      await vi.waitFor(() => { expect(streamed).toBe(true) })
      socket.dispatchEvent(new Event('error'))
    }
    await idle
    const events = agent.session.snapshotEvents()
    const ending = events.at(-1)
    if (ending?.type !== 'turn/end') throw new Error('expected a settled turn')
    const outcome = {
      failedAttempts: events.filter(event => event.type === 'assistant/attempt').length,
      retries: events.flatMap(event => event.type === 'llm/retry' ? [event.data.failure] : []),
      assistant: agent.session.deriveMessages().filter(message => message.role === 'assistant').map(message => message.content),
      end: ending.data.reason,
    }
    expect(request).toHaveBeenCalledTimes(scenario === 'fetch' || scenario === 'exhausted' ? 2 : 1)
    expect(CodexSocket.connections).toHaveLength(scenario === 'websocket' ? 1 : 0)
    await expect(JSON.stringify(outcome, null, 2) + '\n').toMatchFileSnapshot(`./expected/codex-recovery-${scenario}.json`)
  })
})

interface CodexWireRequest {
  model: string
  service_tier?: string
  reasoning?: { effort: string }
  instructions?: string
  input?: unknown[]
  tools?: unknown[]
}

function sseCompletion(): Response {
  return new Response(completionEvents('reply').map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function codexRequest(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): Promise<CodexWireRequest> {
  const request = new Request(input, init)
  if (request.url !== 'https://chatgpt.com/backend-api/codex/responses') throw new Error(`unexpected HTTP request: ${request.url}`)
  const payload = Buffer.from(await request.arrayBuffer())
  const decoded = request.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(payload) : payload
  return JSON.parse(decoded.toString()) as CodexWireRequest
}

describe('Codex current-chat priority in real Loader composition', () => {
  it.each(['websocket', 'sse'] as const)('dispatches /fast over %s without lowering reasoning or affecting another chat', async (transport) => {
    const requests: CodexWireRequest[] = []
    class CompletingSocket extends CodexSocket {
      override send(body: string): void {
        super.send(body)
        requests.push(JSON.parse(body) as CodexWireRequest)
        queueMicrotask(() => { this.complete('reply') })
      }
    }
    vi.stubGlobal('WebSocket', CompletingSocket)
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (transport !== 'sse') throw new Error('unexpected SSE fallback')
      requests.push(await codexRequest(input, init))
      return sseCompletion()
    })
    vi.stubGlobal('fetch', fetch)
    const context = await load({ fastMode: true, transport })
    const model = getBuiltinModels('openai-codex')[0]!
    await context.credentials.modifyRecord(recordKeyFor('openai-codex'), () => Promise.resolve({ kind: 'grant', payload: grant('person', 'work') }))
    const receiving = await context.agents.create({ sessionId: SessionId('priority-chat') })
    const other = await context.agents.create({ sessionId: SessionId('standard-chat') })
    const events: SessionEvent[] = []
    context.on('session/event', (session, event) => { if (session === receiving.agent.session) events.push(event) })
    const command = async (line: string) => {
      const execution = await context.commands.execute(receiving.agent, line, [], new AbortController().signal)
      if (execution === undefined) throw new Error('fast command was not registered by Loader')
      return execution.result
    }
    const commands = [await command('/fast status'), await command('/fast on'), await command('/fast status')]
    const options = {
      provider: 'openai-codex', model: model.id, reasoningEffort: ReasoningEffortId('high'),
      messages: [
        createSystemMessage('Keep the response concise.'),
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Earlier question' }] }),
        createAssistantMessage({ source: { provider: 'openai-codex', model: model.id }, content: [{ type: 'text', text: 'Earlier answer' }] }),
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Follow-up question' }] }),
      ],
      tools: [{ name: 'lookup', description: 'Look up a query.', parameters: { type: 'object', properties: { query: { type: 'string' } } } }],
    }
    const enabled = await track(assemble(context, { ...options, sessionId: receiving.agent.id }))
    expect(enabled.message.content).toEqual([{ type: 'text', text: 'reply' }])
    expect(requests[0]).toMatchObject({ model: model.id, service_tier: 'priority', reasoning: { effort: 'high' } })
    const standard = await track(assemble(context, { ...options, sessionId: other.agent.id }))
    expect(standard.message.content).toEqual([{ type: 'text', text: 'reply' }])
    expect(requests[1]).not.toHaveProperty('service_tier')
    commands.push(await command('/fast off'))
    const disabled = await track(assemble(context, { ...options, sessionId: receiving.agent.id }))
    expect(disabled.message.content).toEqual([{ type: 'text', text: 'reply' }])
    expect(requests[2]).not.toHaveProperty('service_tier')
    expect(requests).toHaveLength(3)
    for (const request of requests) expect(request.reasoning).toMatchObject({ effort: 'high' })
    expect(requests[0]).toMatchObject({
      instructions: 'Keep the response concise.',
      input: [
        expect.objectContaining({ role: 'user', content: [{ type: 'input_text', text: 'Earlier question' }] }),
        expect.objectContaining({ role: 'assistant', content: [{ type: 'output_text', text: 'Earlier answer', annotations: [] }] }),
        expect.objectContaining({ role: 'user', content: [{ type: 'input_text', text: 'Follow-up question' }] }),
      ],
      tools: [expect.objectContaining({ type: 'function', name: 'lookup', description: 'Look up a query.', parameters: options.tools[0]!.parameters })],
    })
    const { service_tier: tier, ...priorityRequest } = requests[0]!
    expect(tier).toBe('priority')
    expect(requests[1]).toMatchObject({
      model: priorityRequest.model, reasoning: priorityRequest.reasoning,
      instructions: priorityRequest.instructions, input: priorityRequest.input, tools: priorityRequest.tools,
    })
    expect(requests[2]).toEqual(priorityRequest)
    expect(context.sessionProjections.stateOf(other.agent.session, 'codexFastMode')).toBe(false)
    expect(receiving.agent.session.deriveMessages()).toEqual([])
    const outcome = {
      commands,
      events: events.flatMap(event => event.type === 'llm-pi-ai/fast-mode'
        ? [{ type: event.type, data: event.data, ignorable: event.ignorable }] : []),
      requests: requests.map(request => ({ serviceTier: request.service_tier ?? null, reasoningEffort: request.reasoning?.effort })),
    }
    await expect(JSON.stringify(outcome, null, 2) + '\n').toMatchFileSnapshot('./expected/codex-fast-mode.json')
    if (transport === 'websocket') {
      expect(CodexSocket.connections).toHaveLength(2)
      expect(CodexSocket.connections[0]?.requests).toHaveLength(2)
      expect(CodexSocket.connections[1]?.requests).toHaveLength(1)
      for (const socket of CodexSocket.connections) expect(socket.options.headers.authorization).toBe(`Bearer ${grant('person', 'work').access}`)
      expect(fetch).not.toHaveBeenCalled()
    } else {
      expect(CodexSocket.connections).toEqual([])
      expect(fetch).toHaveBeenCalledTimes(3)
    }
  })

  it.each([true, false])('restores persisted fast=%s into the live Session after JSONL close/reopen and dispatches its tier', async (enabled) => {
    const requests: CodexWireRequest[] = []
    vi.stubGlobal('WebSocket', CodexSocket)
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push(await codexRequest(input, init))
      return sseCompletion()
    }))
    const options = { fastMode: true, transport: 'sse', persistence: true } as const
    const first = await load(options)
    await first.credentials.modifyRecord(recordKeyFor('openai-codex'), () => Promise.resolve({ kind: 'grant', payload: grant('person', 'work') }))
    const sessionId = SessionId('persisted-priority-chat')
    const receiving = await first.agents.create({ sessionId, meta: { delegationDepth: 0 } })
    const defaultId = SessionId('persisted-default-chat')
    const defaultChat = await first.agents.create({ sessionId: defaultId })
    defaultChat.agent.session.append('session/end-seed', {})
    await first.sessions.flush(defaultChat.agent.session)
    for (const line of enabled ? ['/fast on'] : ['/fast on', '/fast off']) {
      const execution = await first.commands.execute(receiving.agent, line, [], new AbortController().signal)
      expect(execution?.result.kind).toBe('success')
    }
    await first.sessions.flush(receiving.agent.session)
    const firstStore = first.sessions
    await first.fiber.dispose()
    expect(firstStore.get(sessionId)).toBeUndefined()

    const restored = await load(options)
    expect(restored).not.toBe(first)
    expect(restored.sessions.get(sessionId)).toBeUndefined()
    const reopened = await restored.agents.resume({ resumeSessionId: sessionId })
    const standard = await restored.agents.resume({ resumeSessionId: defaultId })
    expect(reopened.agent.session).not.toBe(receiving.agent.session)
    expect(reopened.agent.session.header).toEqual(receiving.agent.session.header)
    expect(restored.sessions.get(sessionId)).toBe(reopened.agent.session)
    expect(restored.sessionProjections.stateOf(reopened.agent.session, 'codexFastMode')).toBe(enabled)
    expect(restored.sessionProjections.stateOf(standard.agent.session, 'codexFastMode')).toBe(false)
    const stored = await restored.sessionPersistence.open(sessionId, 'read')
    try {
      const { events } = await stored.read()
      expect(events.filter(event => event.type === 'llm-pi-ai/fast-mode')).toMatchObject(
        (enabled ? [true] : [true, false]).map(value => ({ data: { enabled: value }, ignorable: true })),
      )
    } finally {
      await stored.close()
    }
    const request = {
      provider: 'openai-codex', model: getBuiltinModels('openai-codex')[0]!.id,
      reasoningEffort: ReasoningEffortId('high'), messages: [],
    }
    for (const agent of [reopened.agent, standard.agent]) {
      const result = await track(assemble(restored, { ...request, sessionId: agent.id }))
      expect(result.finish).toEqual({ kind: 'stop' })
      expect(result.message.content).toEqual([{ type: 'text', text: 'reply' }])
    }
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ model: request.model, reasoning: { effort: 'high' } })
    if (enabled) expect(requests[0]).toHaveProperty('service_tier', 'priority')
    else expect(requests[0]).not.toHaveProperty('service_tier')
    expect(requests[1]).not.toHaveProperty('service_tier')
    expect(CodexSocket.connections).toEqual([])
  })

  it('freezes priority before awaiting a credential, so toggles only affect later requests', async () => {
    const requests: CodexWireRequest[] = []
    vi.stubGlobal('WebSocket', CodexSocket)
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push(await codexRequest(input, init))
      return sseCompletion()
    }))
    let enabled = true
    const entered = Promise.withResolvers<undefined>()
    const credential = Promise.withResolvers<string | undefined>()
    const access = grant('person', 'work').access
    credentialReleases.push(() => { credential.resolve(access) })
    const profiles = resolveProfiles({ 'openai-codex': { apiKeyEnv: 'FROZEN_CODEX_TEST_KEY', transport: 'sse' } })
    const adapter = new LlmPiAi.PiAiAdapter({
      profiles: () => profiles,
      auth: memoryAuth(),
      resolveFastMode: () => enabled,
      resolveApiKey: () => { entered.resolve(undefined); return credential.promise },
    })
    const options = {
      provider: 'openai-codex', model: getBuiltinModels('openai-codex')[0]!.id,
      sessionId: SessionId('frozen-priority'), reasoningEffort: ReasoningEffortId('high'), messages: [],
    }
    const consume = async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream(options)) chunks.push(chunk)
      return chunks
    }
    const running = track(consume())
    try {
      await entered.promise
      enabled = false
    } finally {
      credential.resolve(access)
    }
    expect(await running).toContainEqual(expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }))
    expect(requests[0]).toMatchObject({ service_tier: 'priority', reasoning: { effort: 'high' } })
    expect(await track(consume())).toContainEqual(expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }))
    expect(requests[1]).not.toHaveProperty('service_tier')
    expect(requests[1]?.reasoning).toMatchObject({ effort: 'high' })
  })

  it.each(['codex-without-session', 'non-codex-with-session', 'session-title', 'compaction'] as const)('keeps %s on its unchanged simple path without reading the preference', async (scenario) => {
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal('WebSocket', CodexSocket)
    const codex = scenario !== 'non-codex-with-session'
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (codex) {
        requests.push({ ...await codexRequest(input, init) })
        return sseCompletion()
      }
      const request = new Request(input, init)
      if (request.url !== 'https://fixture.invalid/chat/completions') throw new Error(`unexpected HTTP request: ${request.url}`)
      requests.push(await request.json() as Record<string, unknown>)
      return new Response(textEvents.map(event => `data: ${event}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const provider = codex ? 'openai-codex' : 'deepseek'
    const profiles = resolveProfiles({ [provider]: {
      apiKeyEnv: 'IGNORED_FAST_TEST_KEY', transport: 'sse',
      ...codex ? {} : { baseURL: 'https://fixture.invalid' },
    } })
    const adapter = new LlmPiAi.PiAiAdapter({
      profiles: () => profiles,
      auth: memoryAuth(),
      resolveApiKey: () => Promise.resolve(grant('person', 'work').access),
      resolveFastMode: () => { throw new Error('this request must not read a chat preference') },
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider, model: codex ? getBuiltinModels('openai-codex')[0]!.id : 'deepseek-flash',
      messages: [], ...scenario === 'codex-without-session' ? {} : { sessionId: SessionId('ignored-fast-chat') },
      ...scenario === 'session-title' || scenario === 'compaction' ? { purpose: scenario } : {},
      reasoningEffort: ReasoningEffortId('high'),
    })) chunks.push(chunk)
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }))
    expect(requests).toHaveLength(1)
    expect(requests[0]).not.toHaveProperty('service_tier')
    if (codex) expect(requests[0]).toMatchObject({ reasoning: { effort: 'high' } })
    else expect(requests[0]).toMatchObject({ reasoning_effort: 'high' })
  })
})
