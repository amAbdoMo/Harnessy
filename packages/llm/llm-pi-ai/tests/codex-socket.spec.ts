/** Keyless real-Loader regression for switching users sharing a Codex workspace. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { closeOpenAICodexWebSocketSessions } from '@earendil-works/pi-ai/api/openai-codex-responses'
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
  close(): void { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  complete(text: string): void {
    const item = { type: 'message', id: 'msg', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
    for (const event of [
      { type: 'response.created', response: { id: 'resp' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
    ]) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
  }
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
  closeOpenAICodexWebSocketSessions()
  await Promise.allSettled(streams.splice(0))
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  CodexSocket.connections = []
  vi.unstubAllGlobals()
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
