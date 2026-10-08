/** Keyless real-Loader regressions for Codex socket identity and truncated responses. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { type StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { closeOpenAICodexWebSocketSessions, resetOpenAICodexWebSocketDebugStats } from '@earendil-works/pi-ai/api/openai-codex-responses'
import * as LlmPiAi from '../src/index.ts'
import { recordKeyFor } from '../src/auth.ts'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import { assemble } from './assemble.ts'

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

function track<T>(stream: Promise<T>): Promise<T> {
  streams.push(stream)
  void stream.catch(() => {}) // Teardown joins failed streams even when an earlier assertion stops the scenario.
  return stream
}

afterEach(async () => {
  try {
    closeOpenAICodexWebSocketSessions()
    for (const socket of CodexSocket.connections) socket.close()
    await Promise.allSettled(streams.splice(0))
    await ctx?.fiber.dispose()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  } finally {
    resetOpenAICodexWebSocketDebugStats()
    ctx = undefined
    root = undefined
    CodexSocket.connections = []
    vi.unstubAllGlobals()
  }
})

async function load(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-codex-sockets-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm\n  name: test-llm',
    `- id: credentials\n  name: test-credentials\n  config:\n    path: ${JSON.stringify(join(root, '.credentials.yaml'))}\n    watch: false`,
    '- id: llm-pi-ai\n  name: test-pi-ai\n  config:\n    providers:\n      openai-codex:\n        transport: websocket',
    '',
  ].join('\n'))
  const context = new Context()
  ctx = context
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['test-llm', LlmRuntime], ['test-credentials', LocalCredentialProvider], ['test-pi-ai', LlmPiAi]])
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
  it.each([1000, 1012])('treats close %i before completion as retryable truncation and recovers the same Session over SSE', async (code) => {
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
    first.close(code)
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
