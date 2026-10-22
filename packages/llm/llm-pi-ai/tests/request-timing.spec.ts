/** Provider-attempt timing, privacy, and failure isolation through the real SDK. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeMockServers()
})

function fixture(baseURL: string, resolveApiKey = () => Promise.resolve('private-fixture-key'), log?: (line: string) => void) {
  const lines: string[] = []
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ gateway: {
      api: 'openai-completions', baseURL,
      models: [{ id: 'fixture-model', contextWindow: 8192, maxTokens: 1024 }],
    } }),
    resolveApiKey,
    auth: memoryAuth(),
    logRequestTiming: (line) => { lines.push(line); log?.(line) },
  })
  const stream = (signal?: AbortSignal) => adapter.stream({
    provider: 'gateway', model: 'fixture-model', ...signal === undefined ? {} : { signal },
    messages: [createUserMessage({ content: [{ type: 'text', text: 'private-fixture-prompt' }], source: { kind: 'user' } })],
  })
  const records = (): Record<string, unknown>[] => lines.map(line => JSON.parse(line.slice('llm-pi-ai request-timing '.length)))
  return { adapter, lines, stream, records }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('provider request timing', () => {
  it('separates credential waiting from payload and output without logging request data', async () => {
    const server = await mockServer([{ events: textEvents }])
    const credential = Promise.withResolvers<string>()
    const { stream, lines, records } = fixture(server.url, () => credential.promise)
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const pending = drain(stream())
    expect(records().map(record => record.phase)).toEqual(['started'])
    now = 125
    credential.resolve('private-fixture-key')
    const chunks = await pending
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(records().map(record => record.phase)).toEqual([
      'started', 'credential-reference-resolved', 'context-ready', 'payload-ready',
      'response-headers', 'first-output', 'settled',
    ])
    expect(records()[1]).toMatchObject({ elapsedMs: 25, sincePreviousMs: 25 })
    expect(records().at(-1)).toMatchObject({ elapsedMs: 25, outcome: 'completed', fastMode: false })
    expect(new Set(records().map(record => record.request)).size).toBe(1)
    expect(lines.join('\n')).not.toMatch(/private-fixture|127\.0\.0\.1|authorization|hello/i)
  })

  it('records credential failure without claiming a payload or output existed', async () => {
    const { stream, lines, records } = fixture('http://127.0.0.1:9', () => Promise.reject(new LlmError('private-fixture-error', 'MISSING_CREDENTIAL')))
    await expect(drain(stream())).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(records().map(record => record.phase)).toEqual(['started', 'settled'])
    expect(records().at(-1)).toMatchObject({ outcome: 'error' })
    expect(lines.join('\n')).not.toContain('private-fixture-error')
  })

  it('records an in-stream provider error without emitting its response body', async () => {
    const server = await mockServer([{ status: 400, body: '{"error":{"message":"private-fixture-error"}}' }])
    const { stream, lines, records } = fixture(server.url)
    expect((await drain(stream())).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(records().at(-1)).toMatchObject({ phase: 'settled', outcome: 'error' })
    expect(records().some(record => record.phase === 'first-output')).toBe(false)
    expect(lines.join('\n')).not.toContain('private-fixture-error')
  })

  it('settles a cancelled request and closes its pending response', async () => {
    const server = await mockServer([{ events: [], holdOpen: true }])
    const { stream, records } = fixture(server.url)
    const controller = new AbortController()
    const pending = drain(stream(controller.signal))
    const settled = pending.then(
      (chunks) => { expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } }) },
      (error: unknown) => { expect(error).toMatchObject({ code: 'ABORTED' }) },
    )
    await server.requestReceived
    controller.abort()
    await settled
    await server.responseClosed
    expect(records().at(-1)).toMatchObject({ phase: 'settled', outcome: 'aborted' })
  })

  it.each([false, true])('distinguishes consumer closure after output from completion (aborted=%s)', async (aborted) => {
    const server = await mockServer([{ events: textEvents.slice(0, 2), holdOpen: true }])
    const { stream, records } = fixture(server.url)
    const controller = new AbortController()
    for await (const _chunk of stream(controller.signal)) {
      if (aborted) controller.abort()
      break
    }
    await server.responseClosed
    expect(records().at(-1)).toMatchObject({ phase: 'settled', outcome: aborted ? 'aborted' : 'closed' })
  })

  it('keeps overlapping requests separate', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const { stream, records } = fixture(server.url)
    const results = await Promise.all([drain(stream()), drain(stream())])
    expect(results.every(chunks => chunks.at(-1)?.type === 'finish')).toBe(true)
    const starts = records().filter(record => record.phase === 'started')
    const ends = records().filter(record => record.phase === 'settled')
    expect(new Set(starts.map(record => record.request)).size).toBe(2)
    expect(ends.map(record => record.request).sort()).toEqual(starts.map(record => record.request).sort())
  })

  it('continues streaming when the diagnostic sink throws', async () => {
    const server = await mockServer([{ events: textEvents }])
    const { stream } = fixture(server.url, undefined, () => { throw new Error('diagnostic sink unavailable') })
    const chunks = await drain(stream())
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hello' })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })
})
