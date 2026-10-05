/** Test-only model/Main adapters around the production website controller and tools. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { deriveReplayScript, parseSessionLog, type ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import { installWebsiteControlReceiver } from '../../../../../apps/desktop-host/src/website-control.ts'
import { installWebsiteParentChannel } from '../../../../../apps/desktop-host/src/website-parent.ts'
import { installWebsiteRequests } from '../../../../../apps/desktop-host/src/website-requests.ts'
import { installWebsiteRequestTools, installWebsiteTools } from '../../../../../apps/desktop-host/src/website-tools.ts'

export const name = 'snapshot-website-scenario'
export const inject = ['agents', 'tools', 'llm', 'approval']

/** @param ctx - actual shipped ACP composition. */
export function apply(ctx: Context): void {
  assert.ok(process.send !== undefined, 'Website scenario requires the opt-in private IPC driver')
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    assert.ok(process.send !== undefined)
    process.send(message, (error) => {
      if (error === null) resolve()
      else reject(error)
    })
  })
  const parent = installWebsiteParentChannel(ctx, send)
  const binding = { identity: 'a'.repeat(64), endpoint: 'https://website.example/mcp' }
  const requests = installWebsiteRequests(ctx,
    async (serverName) => { assert.equal(serverName, 'saved-site'); return binding },
    request => send({ type: 'website-revoked', id: request.requestId }),
    (request, signal) => parent.check({ id: request.requestId, profile: request.profileId,
      sessionId: request.sessionId, epoch: request.epoch, status: request.status }, signal),
    scope => installWebsiteRequestTools(scope, parent))
  const control = installWebsiteControlReceiver(() => requests, send)
  const receive = (message: unknown): void => {
    assert.ok(parent.receive(message) || control(message), 'Unexpected Website scenario IPC packet')
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => { process.off('message', receive) }
  })
  installWebsiteTools(ctx, requests, parent)
  const file = process.env.DSH_SNAPSHOT_FILE
  const replay = process.env.DSH_SNAPSHOT === 'replay'
    ? deriveReplayScript(parseSessionLog(readFileSync(assertFile(file), 'utf8')))
    : undefined
  const adapter = new WebsiteModel(replay)
  ctx.effect(() => ctx.llm.registerAdapter(['snapshot-website'], adapter))
}

function assertFile(file: string | undefined): string {
  assert.ok(file)
  return file
}

class WebsiteModel extends LlmAdapter {
  private cursor = 0
  constructor(private readonly replay: readonly ReplayEntry[] | undefined) { super() }
  override listModels(provider: string) { return Promise.resolve([{ provider, id: 'website-model', name: 'Website model double' }]) }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const index = this.cursor++
    const inventory = options.tools ?? []
    const pageInfo = inventory.filter(tool => tool.name.startsWith('website_page_info_'))
    const browser = inventory.filter(tool => tool.name.startsWith('website_browser_'))
    const count = index <= 2 || index === 8 ? 0 : 1
    assert.equal(pageInfo.length, count, 'Page-info is scoped to the resumed request, absent before Resume and after Takeover')
    assert.equal(browser.length, count, 'Browser fallback shares the resumed request lifetime')
    if (index === 2) assert.ok(JSON.stringify(options.messages).includes('Waiting for the human to Resume'))
    if (index === 5) {
      assert.ok(JSON.stringify(options.messages).includes('Saved guest page'))
      assert.ok(JSON.stringify(options.messages).includes('Guest heading'))
    }
    const chunks = this.replay?.[index]
    if (this.replay !== undefined) {
      assert.equal(chunks?.kind, 'chunks', 'Every recorded model request must finish')
      assert.ok(chunks && chunks.kind === 'chunks')
      for (const chunk of chunks.chunks) {
        // Bind only the recorded request-scoped tool name to the fresh inventory;
        // all recorded stream text, arguments and finish facts remain unchanged.
        if (chunk.type === 'tool-call-delta' && chunk.name?.startsWith('website_page_info_')) {
          yield { ...chunk, name: required(pageInfo[0]?.name) }
        } else if (chunk.type === 'tool-call-delta' && chunk.name?.startsWith('website_browser_')) {
          yield { ...chunk, name: required(browser[0]?.name) }
        } else yield chunk
      }
      return
    }
    const tool = index === 0 ? 'website_profiles' : index === 1 ? 'website_prepare'
      : index === 3 ? required(pageInfo[0]?.name)
        : index === 4 || index === 6 ? required(browser[0]?.name) : undefined
    if (tool !== undefined) {
      assert.ok(inventory.some(candidate => candidate.name === tool))
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId(`website-call-${index}`), name: tool,
        argumentsDelta: JSON.stringify(index === 1 ? { profileId: '11111111-1111-4111-8111-111111111111' }
          : index === 4 || index === 6 ? { operation: 'dom-read', fallbackReason: 'The paired MCP cannot read this guest heading.',
            selector: 'h1', maxElements: 1, maxTextChars: 64 } : {}) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const text = index === 2 ? 'The saved website request is pending. Resume it to allow a fresh one-call approval.'
        : index === 5 ? 'The separately approved page info and bounded DOM report Saved guest page and Guest heading at https://website.example.'
          : index === 7 ? 'The fresh DOM observation was denied; no additional guest operation ran.'
            : index === 8 ? 'The human took over. The request-scoped page observation tools are no longer available.' : undefined
      assert.ok(text, `Unexpected model request ${index}`)
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

function required(value: string | undefined): string { assert.ok(value); return value }
