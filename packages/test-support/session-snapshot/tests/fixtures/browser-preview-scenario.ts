/** Deterministic model for the Desktop preview tool protocol recording. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { deriveReplayScript, parseSessionLog, type ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import { installBrowserPreview } from '../../../../../apps/desktop-host/src/browser-preview.ts'

export const name = 'snapshot-browser-preview-scenario'
export const inject = ['agents', 'tools', 'llm']

/** @param ctx - shipped ACP composition with a test-owned native IPC peer. */
export function apply(ctx: Context): void {
  if (process.send === undefined) throw new Error('Snapshot requires private IPC')
  const channel = installBrowserPreview(ctx, message => new Promise((resolve, reject) => {
    if (process.send === undefined) throw new Error('Snapshot requires private IPC')
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  }))
  const receive = (message: unknown): void => { assert.ok(channel.receive(message)) }
  ctx.effect(() => {
    process.on('message', receive)
    return () => { process.off('message', receive); channel.close() }
  })
  const file = process.env.DSH_SNAPSHOT_FILE
  const replay = process.env.DSH_SNAPSHOT === 'replay'
    ? deriveReplayScript(parseSessionLog(readFileSync(required(file), 'utf8'))) : undefined
  ctx.effect(() => ctx.llm.registerAdapter(['snapshot-browser-preview'], new BrowserPreviewModel(replay)))
}

class BrowserPreviewModel extends LlmAdapter {
  private cursor = 0
  constructor(private readonly replay: readonly ReplayEntry[] | undefined) { super() }
  override listModels(provider: string) { return Promise.resolve([{ provider, id: 'browser-model', name: 'Browser preview model double' }]) }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const index = this.cursor++
    if (this.replay !== undefined) {
      const entry = this.replay[index]
      assert.ok(entry?.kind === 'chunks')
      yield* entry.chunks
      return
    }
    const calls = [
      { name: 'preview_status', args: {} },
      { name: 'preview_evaluate', args: { tabId: 'fixture-tab', expression: 'document.title' } },
      { name: 'preview_snapshot', args: { tabId: 'fixture-tab' } },
      { name: 'preview_evaluate', args: { tabId: 'fixture-tab', expression: 'document.title' } },
    ]
    const call = calls[index]
    if (call !== undefined) {
      assert.ok(options.tools?.some(tool => tool.name === call.name))
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId(`preview-call-${index}`), name: call.name, argumentsDelta: JSON.stringify(call.args) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    assert.equal(index, calls.length)
    const messages = JSON.stringify(options.messages)
    assert.ok(messages.includes('A human controls this browser tab'))
    assert.ok(messages.includes('Observed during takeover'))
    assert.ok(messages.includes('Resumed browser agent'))
    yield { type: 'text-delta', index: 0, text: 'Observed during takeover; resumed on the same browser tab without saved-profile preparation.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function required<T>(value: T | undefined): T { assert.ok(value !== undefined); return value }
