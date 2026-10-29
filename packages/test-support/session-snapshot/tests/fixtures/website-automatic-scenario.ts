/** Test-only automatic website model and Host adapters for the recorded ACP scenario. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { deriveReplayScript, parseSessionLog, type ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import { installWebsiteControlReceiver } from '../../../../../apps/desktop-host/src/website-control.ts'
import { installWebsiteParentChannel } from '../../../../../apps/desktop-host/src/website-parent.ts'
import { installWebsiteRequests } from '../../../../../apps/desktop-host/src/website-requests.ts'
import { installWebsiteRequestTools, installWebsiteTools } from '../../../../../apps/desktop-host/src/website-tools.ts'

export const name = 'snapshot-website-automatic-scenario'
export const inject = ['agents', 'tools', 'llm', 'approval', 'skills']

/** @param ctx - actual shipped ACP composition. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.skills.register({
    name: 'diagnose-windows-sandbox-acl',
    description: 'Platform ACL diagnosis is outside this website access scenario.',
    content: '', source: 'custom', invocation: { modelInvocable: false, userInvocable: false },
  }))
  assert.ok(process.send !== undefined, 'Website scenario requires the opt-in private IPC driver')
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    assert.ok(process.send !== undefined)
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  const parent = installWebsiteParentChannel(ctx, send)
  const binding = { identity: 'a'.repeat(64), endpoint: 'https://website.example/mcp' }
  const requests = installWebsiteRequests(ctx,
    async (serverName) => { assert.equal(serverName, 'saved-site'); return binding },
    request => send({ type: 'website-revoked', id: request.requestId }),
    (request, signal) => parent.check({ id: request.requestId, profile: request.profileId,
      sessionId: request.sessionId, epoch: request.epoch, status: request.status }, signal),
    { mcpAuthorization: 'paired-requests', installTool: scope => installWebsiteRequestTools(scope, parent) })
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
    ? deriveReplayScript(parseSessionLog(readFileSync(required(file), 'utf8')))
    : undefined
  ctx.effect(() => ctx.llm.registerAdapter(['snapshot-website-automatic'], new WebsiteAutomaticModel(replay)))
}

class WebsiteAutomaticModel extends LlmAdapter {
  private cursor = 0
  constructor(private readonly replay: readonly ReplayEntry[] | undefined) { super() }
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'website-model', name: 'Website automatic model double' }])
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const index = this.cursor++
    const inventory = options.tools ?? []
    const pageInfo = inventory.find(tool => tool.name.startsWith('website_page_info_'))
    if (this.replay !== undefined) {
      const entry = this.replay[index]
      assert.ok(entry?.kind === 'chunks', 'Recorded website requests must have stream chunks')
      for (const chunk of entry.chunks) {
        if (chunk.type === 'tool-call-delta' && chunk.name?.startsWith('website_page_info_')) {
          yield { ...chunk, name: required(pageInfo?.name) }
        } else yield chunk
      }
      return
    }
    const tool = index === 0 ? 'website_profiles' : index === 1 || index === 3 ? 'website_prepare'
      : index === 2 ? required(pageInfo?.name) : undefined
    if (tool !== undefined) {
      assert.ok(inventory.some(candidate => candidate.name === tool))
      const argumentsDelta = index === 1 ? { profileId: '11111111-1111-4111-8111-111111111111' }
        : index === 3 ? { profileId: '22222222-2222-4222-8222-222222222222' } : {}
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId(`website-automatic-call-${index}`), name: tool,
        argumentsDelta: JSON.stringify(argumentsDelta) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    assert.equal(index, 4)
    assert.ok(JSON.stringify(options.messages).includes('Saved website access is ready for this request.'))
    assert.ok(JSON.stringify(options.messages).includes('Saved website access is disabled'))
    yield { type: 'text-delta', index: 0,
      text: 'Automatic saved access read Saved guest page without a per-call approval; disabled access was refused.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function required<T>(value: T | undefined): T { assert.ok(value !== undefined); return value }
