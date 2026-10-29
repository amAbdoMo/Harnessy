/** Real tool registration and result logging use a private native adapter without paired MCP preparation. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { installBrowserPreview, type BrowserPreviewChannel } from '../src/browser-preview.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-preview-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const config = join(root, 'cordis.yml')
  await writeFile(config, "- name: '@deepseek-ai/dsh-agent'\n- name: '@deepseek-ai/dsh-system-prompt'\n- name: '@deepseek-ai/dsh-tools'\n")
  let channel: BrowserPreviewChannel | undefined
  const sent: object[] = []
  let automatic = true
  const ctx = await boot('browser-preview-test', config, [], (owner) => {
    channel = installBrowserPreview(owner, async (message) => {
      sent.push(message)
      if (automatic && 'type' in message && message.type === 'browser-preview' && 'requestId' in message) {
        channel?.receive({ type: 'browser-preview-result', requestId: message.requestId, ok: true,
          result: { tabs: [{ tabId: 'tab-one', sessionId: 'browser-chat', humanControl: false, generation: 0, url: 'https://example.test/', title: 'Example', loading: false }] } })
      }
    })
    const modules = new Map<string, unknown>([['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools]])
    owner.loader.internal = {
      version: 'v2', loadCache: new Map(),
      async import(specifier: string) { if (!modules.has(specifier)) throw new Error('Unexpected test module'); return modules.get(specifier) },
      register() { throw new Error('Unexpected module registration') },
      async getOrCreateModuleJob() { throw new Error('Unexpected module job') },
      resolveSync() { throw new Error('Unexpected module resolution') },
      async load() { throw new Error('Unexpected module load') },
    }
  })
  onTestFinished(() => ctx.fiber.dispose())
  if (channel === undefined) throw new Error('Browser preview did not install')
  const session = Session.create(SessionId('browser-chat'))
  const agent = { id: session.id, session, ctx, options: {} } as Agent
  ctx.agents.enter(agent, undefined)
  const lifetime = new AbortController()
  const invoke = (name: string, args: object) => ctx.tools.execute({
    agent, signal: lifetime.signal, callId: ToolCallId(name), name, arguments: args,
  })
  return { ctx, agent, channel, sent, invoke, lifetime, pause: () => { automatic = false } }
}

it('registers stable browser tools and logs complete status without a profile or MCP server', async () => {
  const f = await fixture()
  for (const name of ['preview_status', 'preview_open', 'preview_navigate', 'preview_snapshot', 'preview_act', 'preview_evaluate']) expect(f.ctx.tools.get(name)).toBeDefined()
  const result = await f.invoke('preview_status', {})
  expect(result).toMatchObject({ isError: false, value: { tabs: [{ tabId: 'tab-one', sessionId: 'browser-chat' }] },
    content: [{ type: 'text', text: JSON.stringify({ tabs: [{ tabId: 'tab-one', sessionId: 'browser-chat', humanControl: false, generation: 0, url: 'https://example.test/', title: 'Example', loading: false }] }) }] })
  expect(f.sent).toEqual([expect.objectContaining({ type: 'browser-preview', sessionId: 'browser-chat', operation: { kind: 'status' } })])
})

it('cancels pending native work when the caller ends and ignores late native results', async () => {
  const f = await fixture()
  f.pause()
  const running = f.invoke('preview_evaluate', { tabId: 'tab-one', expression: 'document.title' })
  await viWait(() => f.sent.length > 0)
  f.lifetime.abort()
  await expect(running).resolves.toMatchObject({ isError: true })
  expect(f.sent).toContainEqual(expect.objectContaining({ type: 'browser-preview-cancel' }))
})

async function viWait(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !ready(); attempt++) await new Promise(resolve => setTimeout(resolve, 1))
  expect(ready()).toBe(true)
}
