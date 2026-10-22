/** Native Codex WebSocket checkpoints without a live account or network. */

import { afterEach, expect, it, vi } from 'vitest'
import { closeOpenAICodexWebSocketSessions } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

afterEach(() => {
  closeOpenAICodexWebSocketSessions()
  vi.unstubAllGlobals()
})

it.each([false, true])('observes native Codex output without changing reasoning or priority (fast=%s)', async (fastMode) => {
  const requests: Record<string, unknown>[] = []
  const lines: string[] = []
  class Socket extends EventTarget {
    readyState = 0
    constructor() {
      super()
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) })
    }

    send(body: string): void {
      requests.push(JSON.parse(body))
      queueMicrotask(() => {
        const item = { type: 'message', id: 'fixture-message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture reply', annotations: [] }] }
        for (const event of [
          { type: 'response.created', response: { id: 'fixture-response' } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
          { type: 'response.output_text.delta', output_index: 0, delta: 'fixture reply' },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'fixture-response', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
        ]) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
      })
    }

    close(code = 1000): void {
      if (this.readyState === 3) return
      this.readyState = 3
      this.dispatchEvent(Object.assign(new Event('close'), { code, reason: '', wasClean: true }))
    }
  }
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('fetch', () => { throw new Error('unexpected network fallback') })
  const access = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'private-fixture-account' } })).toString('base64url')}.fixture`
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ 'openai-codex': {
      transport: 'websocket', reasoning: 'high',
      models: [{ id: 'fixture-model', contextWindow: 8192, maxTokens: 1024, reasoningEfforts: { high: 'high' } }],
    } }),
    resolveApiKey: () => Promise.resolve(undefined),
    resolveFastMode: () => fastMode,
    auth: memoryAuth({ 'openai-codex': { type: 'oauth', access, refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 } }),
    logRequestTiming: (line) => { lines.push(line) },
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'openai-codex', model: 'fixture-model', messages: [], sessionId: SessionId(`fixture-${fastMode}`),
  })) chunks.push(chunk)
  expect(chunks.at(-1), JSON.stringify(chunks.at(-1))).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ model: 'fixture-model', reasoning: { effort: 'high' } })
  expect(requests[0]?.service_tier).toBe(fastMode ? 'priority' : undefined)
  const records: Record<string, unknown>[] = lines.map(line => JSON.parse(line.slice('llm-pi-ai request-timing '.length)))
  expect(records.map(record => record.phase)).toEqual([
    'started', 'credential-reference-resolved', 'context-ready', 'payload-ready', 'first-output', 'settled',
  ])
  expect(records.at(-1)).toMatchObject({ outcome: 'completed', api: 'openai-codex-responses', transport: 'websocket', fastMode })
  expect(lines.join('\n')).not.toMatch(/private-fixture|fixture-model|fixture reply|fixture-response/)
  expect(lines.join('\n')).not.toContain(access)
})
