/** Fetch-boundary replay through the real DeepSeek adapter and shipped retry policy. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'

export const name = 'snapshot-idle-timeout-recovery'
export const inject = ['skills', 'tools']

/** Install an abort-ignoring first response and a session-authored successful response.
 * @param ctx - the shipped headless composition.
 */
export function apply(ctx: Context): void {
  const file = process.env.DSH_SNAPSHOT_FILE
  assert.ok(file, 'idle timeout replay requires DSH_SNAPSHOT_FILE')
  const text = parseSessionLog(readFileSync(file, 'utf8'))
    .flatMap(event => event.type === 'assistant/message' ? event.data.message.content : [])
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  assert.ok(text, 'idle timeout replay requires an authored assistant answer')
  // The model does not call tools; retain one platform-neutral schema for the header pin.
  ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict({ allow: ['working_directory'] }) })
  // Platform ACL guidance is unrelated to this transport-only replay.
  ctx.effect(() => ctx.skills.register({
    name: 'diagnose-windows-sandbox-acl',
    description: 'Platform ACL diagnosis is outside this transport scenario.',
    content: '', source: 'custom',
    invocation: { modelInvocable: false, userInvocable: false },
  }))
  const frame = (type: string, data: object): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  const body = [
    frame('message_start', { type: 'message_start', message: {
      id: 'timeout-recovery', type: 'message', role: 'assistant', model: 'deepseek-v4-flash',
      content: [], usage: { input_tokens: 10, output_tokens: 0 },
    } }),
    frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
    frame('message_stop', { type: 'message_stop' }),
  ].join('')
  ctx.effect(() => {
    const original = globalThis.fetch
    let attempts = 0
    let firstBody: string | undefined
    let firstSignal: AbortSignal | null | undefined
    let blocked: ReadableStreamDefaultController<Uint8Array> | undefined
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      assert.equal(url, 'https://timeout-fixture.invalid/v1/messages', 'unexpected network request in keyless replay')
      assert.equal(typeof init?.body, 'string', 'expected serialized Messages request')
      attempts += 1
      assert.ok(attempts <= 2, 'idle timeout replay made an unexpected third request')
      if (attempts === 1) {
        firstBody = String(init?.body)
        firstSignal = init?.signal
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { blocked = controller },
          cancel() { blocked = undefined },
        }), { headers: { 'content-type': 'text/event-stream' } })
      }
      assert.equal(firstSignal?.aborted, true, 'the timed-out request must be aborted')
      assert.equal(init?.body, firstBody, 'retry changed the model-visible request')
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    return () => {
      globalThis.fetch = original
      blocked?.close()
      assert.equal(attempts, 2, 'idle timeout replay must settle after exactly one retry')
    }
  })
}
