/** Keyless real-Loader website discovery and pending-request output; the private parent is the external adapter. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserApproval, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import Tools, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import LlmRuntime, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { TINY_PNG, WebsiteTestAttachments, WebsiteTestModels } from './website-browser.fixture.ts'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { DesktopWebsiteHostSnapshot, DesktopWebsiteProfileId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { expect, it, onTestFinished } from 'vitest'
import { installWebsiteParentChannel, type WebsiteParentChannel } from '../src/website-parent.ts'
import { installWebsiteRequests, type WebsiteRequestsController, type WebsiteRequestToolScope } from '../src/website-requests.ts'
import { installWebsitePageInfoTool, installWebsiteRequestTools, installWebsiteTools } from '../src/website-tools.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'website-test': { kind: 'website-test' }
  }
}

const PROFILE = { id: 'cd1b6493-c881-4967-a544-b0a49f2d847f' as DesktopWebsiteProfileId,
  name: 'Portal', accountLabel: 'operator', url: 'https://portal.example.test/', serverName: 'portal',
  mcpBinding: { identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/private-mcp' } }

async function fixture(services: { attachments?: boolean; llm?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-website-tools-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'", "- name: '@deepseek-ai/dsh-system-prompt'", "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-user-approval'",
    ...services.attachments ? ["- name: 'website-test-attachments'"] : [],
    ...services.llm ? ["- name: '@deepseek-ai/dsh-llm'"] : [], '',
  ].join('\n'))
  let requests: WebsiteRequestsController | undefined
  let parent: WebsiteParentChannel | undefined
  let toolsReady: ReturnType<typeof installWebsiteTools> | undefined
  let install = (scope: WebsiteRequestToolScope): (() => void) => {
    if (parent === undefined) throw new Error('Parent is unavailable')
    return installWebsitePageInfoTool(scope, parent)
  }
  const captured: DesktopWebsiteHostSnapshot[] = []
  const revoked: DesktopWebsiteHostSnapshot['id'][] = []
  const observations: object[] = []
  let observe: (message: object) => void = (message) => {
    if (!('operationId' in message) || !('snapshot' in message)) throw new Error('Invalid operation packet')
    parent?.receive({ type: 'website-operation-result', operationId: message.operationId, snapshot: message.snapshot,
      outcome: 'success', value: { origin: 'https://portal.example.test', title: 'Current page', titleTruncated: false } })
  }
  let capture: (snapshot: DesktopWebsiteHostSnapshot) => void = (snapshot) => {
    if (parent === undefined) throw new Error('Website parent channel is not installed')
    parent.receive({ type: 'website-prepared-ack', id: snapshot.id })
  }
  const ctx = await boot('website-tools-test', configPath, [], (owner) => {
    parent = installWebsiteParentChannel(owner, async (message) => {
      if ('type' in message && message.type === 'website-operation' && 'operationId' in message && 'snapshot' in message) {
        observations.push(message)
        observe(message)
        return
      }
      if (!('type' in message) || message.type !== 'website-prepared' || !('snapshot' in message)) {
        throw new Error('Unexpected private website message')
      }
      const snapshot = message.snapshot as DesktopWebsiteHostSnapshot
      captured.push(snapshot)
      capture(snapshot)
    })
    requests = installWebsiteRequests(owner, async () => PROFILE.mcpBinding,
      (request) => { revoked.push(request.requestId) }, async () => {}, scope => install(scope))
    toolsReady = installWebsiteTools(owner, requests, parent)
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
      ['@deepseek-ai/dsh-user-approval', UserApproval], ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['website-test-attachments', WebsiteTestAttachments],
    ])
    owner.loader.internal = {
      version: 'v2', loadCache: new Map(),
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error('Unexpected fixture module: ' + specifier)
        return modules.get(specifier)
      },
      register() { throw new Error('Unexpected fixture hook registration') },
      async getOrCreateModuleJob() { throw new Error('Unexpected fixture module job') },
      resolveSync() { throw new Error('Unexpected fixture module resolution') },
      async load() { throw new Error('Unexpected fixture module load') },
    }
  })
  onTestFinished(() => ctx.fiber.dispose())
  if (requests === undefined || parent === undefined || toolsReady === undefined) throw new Error('Website preparation did not install')
  await toolsReady.await()
  expect(ctx.tools.get('website_profiles')).toBeDefined()
  const session = Session.create(SessionId('website-tools-owner'))
  // The external Agent loop is omitted; live ownership uses the real registry and scoped context.
  const agent = { id: session.id, session, ctx, options: { provider: 'website-test', model: 'vision' } } as Agent
  await ctx.plugin(Object.assign((injected: typeof ctx) => {
    const owner = createScope(injected, agent)
    Object.assign(agent, { ctx: owner.ctx })
  }, { inject: ['tools', 'systemPrompt'] }))
  const llm = ctx.get('llm')
  llm?.registerAdapter(['website-test', 'website-header'], new WebsiteTestModels())
  ctx.agents.enter(agent, undefined)
  const caller = new AbortController()
  const invoke = (name: string, args: object) => ctx.tools.execute({ agent, signal: caller.signal,
    callId: ToolCallId(name), name, arguments: args })
  return { ctx, requests, parent, agent, captured, revoked, observations, caller, invoke,
    captureWith: (operation: (snapshot: DesktopWebsiteHostSnapshot) => void) => { capture = operation },
    observeWith: (operation: (message: object) => void) => { observe = operation },
    installWith: (operation: typeof install) => { install = operation } }
}

it('publishes saved labels and an ungranted request through actual loaded desktop tools, then removes both tools', async () => {
  const f = await fixture()
  expect((await f.invoke('website_profiles', {})).isError).toBe(true)
  f.requests.syncProfiles([PROFILE])
  expect(await f.invoke('website_profiles', {})).toMatchObject({ isError: false,
    value: [{ profileId: PROFILE.id, name: 'Portal', accountLabel: 'operator', url: 'https://portal.example.test/', mcpServerName: 'portal' }],
    content: [{ type: 'text', text: '[{"profileId":"cd1b6493-c881-4967-a544-b0a49f2d847f","name":"Portal","accountLabel":"operator","url":"https://portal.example.test/","mcpServerName":"portal"}]' }],
  })
  const prepared = await f.invoke('website_prepare', { profileId: PROFILE.id })
  expect(f.captured).toHaveLength(1)
  const request = f.captured[0]!
  expect(request.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(request).toEqual({ id: request.id, profile: PROFILE.id,
    sessionId: f.agent.session.id, epoch: 1, status: 'pending' })
  expect(prepared).toMatchObject({ isError: false,
    value: { requestId: request.id, profileId: PROFILE.id, mcpServerName: 'portal', status: 'pending' },
    content: [{ type: 'text', text: `{"requestId":"${request.id}","profileId":"${PROFILE.id}","mcpServerName":"portal","status":"pending"}\nWaiting for the human to Resume this request. No page access is granted.` }],
  })
  expect(JSON.stringify(prepared)).not.toContain(PROFILE.mcpBinding.endpoint)
  expect(f.revoked).toEqual([])
  const tools = f.ctx.tools
  await f.ctx.fiber.dispose()
  expect(tools.get('website_profiles')).toBeUndefined()
  expect(tools.get('website_prepare')).toBeUndefined()
})

it('publishes only an authorization error when a loaded paired MCP result outlives takeover and renewal', async () => {
  const f = await fixture()
  f.agent.session.append('turn/start', { turn: 1 })
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  f.requests.syncProfiles([PROFILE])
  expect((await f.invoke('website_prepare', { profileId: PROFILE.id })).isError).toBe(false)
  const request = f.captured[0]!
  await f.requests.validate(request.id, request.epoch)
  await f.requests.commit(request.id, request.epoch)
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  const published: ToolExecutionResult[] = []
  f.ctx.effect(() => f.ctx.tools.register(createMcpToolDefinition(f.ctx, {
    name: 'mcp__portal__read', serverName: 'portal', rawName: 'read', description: 'Read the paired website.',
    inputSchema: { type: 'object' }, call: async () => ({ content: [{ type: 'text', text: 'private website observation' }] }),
  })))
  f.ctx.on('tools/result', (_exec, result) => { published.push(result) })
  f.ctx.on('tools/post-execute', async (_exec, _result, next) => {
    entered.resolve()
    await release.promise
    return next()
  })
  const running = f.invoke('mcp__portal__read', {})
  try {
    await entered.promise
    const revoked = f.requests.revoke(request.id)
    await f.requests.drain(request.id)
    await f.requests.validate(request.id, revoked.epoch)
    await f.requests.commit(request.id, revoked.epoch)
    release.resolve()
    const result = await running
    expect(result).toMatchObject({ isError: true,
      content: [{ type: 'text', text: 'Error: Website request is not authorized for this owner and generation' }],
      error: { message: 'Website request is not authorized for this owner and generation' } })
    expect(JSON.stringify(result)).not.toContain('private website observation')
    expect(published).toEqual([result])
    const tools = f.ctx.tools
    await f.ctx.fiber.dispose()
    expect(tools.get('mcp__portal__read')).toBeUndefined()
  } finally {
    release.resolve()
    await running
  }
})

it.each(['parent refusal', 'original cancellation'])('never publishes a usable preparation after %s', async (failure) => {
  const f = await fixture()
  f.requests.syncProfiles([PROFILE])
  f.captureWith((request) => {
    if (failure === 'parent refusal') f.parent.receive({ type: 'website-prepared-ack', id: request.id, error: 'Native request refused' })
    else f.caller.abort('cancel native handoff')
  })
  const result = await f.invoke('website_prepare', { profileId: PROFILE.id })
  expect(result.isError).toBe(true)
  expect(f.captured).toHaveLength(1)
  const request = f.captured[0]!
  expect(f.revoked).toEqual([request.id])
  expect(() => f.requests.validate(request.id, request.epoch)).toThrow('not authorized')
  await f.requests.drain(request.id)
  await f.requests.remove(request.id)
})

it('denies a non-agent invocation and an unenrolled profile without creating native work', async () => {
  const f = await fixture()
  f.requests.syncProfiles([PROFILE])
  expect((await f.ctx.tools.execute({ signal: new AbortController().signal,
    callId: ToolCallId('no-agent'), name: 'website_prepare', arguments: { profileId: PROFILE.id } })).isError).toBe(true)
  expect((await f.invoke('website_prepare', { profileId: '07275b7a-ab10-4445-bb1a-221cbf0a3621' })).isError).toBe(true)
  expect(f.captured).toEqual([])
})

it('exposes page-info only to the granted owner, asks once per invocation, and removes exposure before takeover', async () => {
  const f = await fixture()
  f.requests.syncProfiles([PROFILE])
  await f.invoke('website_prepare', { profileId: PROFILE.id })
  const request = f.captured[0]!
  const name = `website_page_info_${request.id}`
  expect(f.ctx.tools.get(name, f.agent)).toBeUndefined()
  await f.requests.validate(request.id, request.epoch)
  await f.requests.commit(request.id, request.epoch)
  expect(f.ctx.tools.get(name)).toBeUndefined()
  expect(f.ctx.tools.get(name, f.agent)).toBeDefined()
  f.agent.session.append('turn/start', { turn: 1 })
  let asked = 0
  f.ctx.on('approval/request', (approval) => {
    expect(approval.agent).toBe(f.agent)
    expect(approval.callId).toBe(ToolCallId(name))
    expect(approval.toolName).toBe(name)
    asked++
    return Promise.resolve<ApprovalOutcome>('allowed-once')
  })
  for (let index = 0; index < 2; index++) {
    expect(await f.invoke(name, {})).toMatchObject({ isError: false,
      value: { origin: 'https://portal.example.test', title: 'Current page', titleTruncated: false } })
  }
  expect(asked).toBe(2)
  expect(f.observations).toHaveLength(2)
  f.requests.revoke(request.id)
  expect(f.ctx.tools.get(name, f.agent)).toBeUndefined()
  await f.requests.drain(request.id)
  expect((await f.invoke(name, {})).isError).toBe(true)
  expect(f.observations).toHaveLength(2)
})

it.each(['rejected', 'cancelled', 'unavailable'] as const)('never starts browser observation after approval %s', async (outcome) => {
  const f = await fixture()
  f.requests.syncProfiles([PROFILE])
  await f.invoke('website_prepare', { profileId: PROFILE.id })
  const request = f.captured[0]!
  await f.requests.validate(request.id, request.epoch)
  await f.requests.commit(request.id, request.epoch)
  f.agent.session.append('turn/start', { turn: 1 })
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>(outcome))
  expect((await f.invoke(`website_page_info_${request.id}`, {})).isError).toBe(true)
  expect(f.observations).toEqual([])
})

it('removes a returned scoped registration after reentrant installer revocation', async () => {
  const f = await fixture()
  f.requests.syncProfiles([PROFILE])
  await f.invoke('website_prepare', { profileId: PROFILE.id })
  const request = f.captured[0]!
  f.installWith((scope) => {
    const detach = installWebsitePageInfoTool(scope, f.parent)
    f.requests.revoke(request.id)
    return detach
  })
  await f.requests.validate(request.id, request.epoch)
  await expect(f.requests.commit(request.id, request.epoch)).rejects.toThrow('not authorized')
  expect(f.ctx.tools.get(`website_page_info_${request.id}`, f.agent)).toBeUndefined()
  await f.requests.drain(request.id)
  const revoked = f.requests.revoke(request.id)
  f.installWith(scope => installWebsitePageInfoTool(scope, f.parent))
  await f.requests.validate(request.id, revoked.epoch)
  await f.requests.commit(request.id, revoked.epoch)
  expect(f.ctx.tools.get(`website_page_info_${request.id}`, f.agent)).toBeDefined()
})

it('rolls back a grant when the scoped tool installer throws', async () => {
  const f = await fixture()
  f.requests.syncProfiles([PROFILE])
  await f.invoke('website_prepare', { profileId: PROFILE.id })
  const request = f.captured[0]!
  f.installWith(() => { throw new Error('Scoped tool installation failed') })
  await f.requests.validate(request.id, request.epoch)
  await expect(f.requests.commit(request.id, request.epoch)).rejects.toThrow('Scoped tool installation failed')
  expect(f.revoked).toEqual([request.id])
  expect(f.agent.ctx.tools.get(`website_page_info_${request.id}`)).toBeUndefined()
  await f.requests.drain(request.id)
})

it('removes scoped exposure once and retains a failed disposer during drainage', async () => {
  const f = await fixture()
  f.requests.syncProfiles([PROFILE])
  await f.invoke('website_prepare', { profileId: PROFILE.id })
  const request = f.captured[0]!
  let detachments = 0
  f.installWith((scope) => {
    const detach = installWebsitePageInfoTool(scope, f.parent)
    return () => {
      detachments++
      detach()
      throw new Error('Scoped tool cleanup failed')
    }
  })
  await f.requests.validate(request.id, request.epoch)
  await f.requests.commit(request.id, request.epoch)
  const revoked = f.requests.revoke(request.id)
  f.requests.revoke(request.id)
  expect(detachments).toBe(1)
  expect(f.agent.ctx.tools.get(`website_page_info_${request.id}`)).toBeUndefined()
  expect(revoked.signal.aborted).toBe(true)
  await expect(f.requests.drain(request.id)).rejects.toThrow('drainage failed')
  await expect(f.requests.validate(request.id, revoked.epoch)).rejects.toThrow('incomplete')
  expect(f.observations).toEqual([])
})

it('does not observe after takeover while fresh approval is pending', async () => {
  const f = await fixture()
  f.requests.syncProfiles([PROFILE])
  await f.invoke('website_prepare', { profileId: PROFILE.id })
  const request = f.captured[0]!
  await f.requests.validate(request.id, request.epoch)
  await f.requests.commit(request.id, request.epoch)
  f.agent.session.append('turn/start', { turn: 1 })
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const release = Promise.withResolvers<ApprovalOutcome>()
  f.ctx.on('approval/request', () => { entered.resolve(); return release.promise })
  const pending = f.invoke(`website_page_info_${request.id}`, {})
  try {
    await entered.promise
    f.requests.revoke(request.id)
    expect(f.ctx.tools.get(`website_page_info_${request.id}`, f.agent)).toBeUndefined()
  } finally { release.resolve('allowed-once') }
  expect((await pending).isError).toBe(true)
  await f.requests.drain(request.id)
  expect(f.observations).toEqual([])
})

it.each(['send failure', 'disconnect'] as const)('revokes exposure and retains the account lock after browser %s', async (failure) => {
  const f = await fixture()
  f.requests.syncProfiles([PROFILE])
  await f.invoke('website_prepare', { profileId: PROFILE.id })
  const request = f.captured[0]!
  await f.requests.validate(request.id, request.epoch)
  await f.requests.commit(request.id, request.epoch)
  f.agent.session.append('turn/start', { turn: 1 })
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  f.observeWith(() => {
    if (failure === 'disconnect') f.parent.close()
    else throw new Error('Transport failure without native settlement')
  })
  expect((await f.invoke(`website_page_info_${request.id}`, {})).isError).toBe(true)
  expect(f.ctx.tools.get(`website_page_info_${request.id}`, f.agent)).toBeUndefined()
  const revoked = f.requests.revoke(request.id)
  await expect(f.requests.drain(request.id)).rejects.toThrow('drainage failed')
  await expect(f.requests.validate(request.id, revoked.epoch)).rejects.toThrow('incomplete')
  expect(f.observations).toHaveLength(1)
})

it('withholds the complete observation when post-execute adds oversized context', async () => {
  const f = await fixture()
  f.requests.syncProfiles([PROFILE])
  await f.invoke('website_prepare', { profileId: PROFILE.id })
  const request = f.captured[0]!
  await f.requests.validate(request.id, request.epoch)
  await f.requests.commit(request.id, request.epoch)
  f.agent.session.append('turn/start', { turn: 1 })
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  f.ctx.on('tools/post-execute', async (_execution, _result, next) => ({
    ...await next(), additionalContexts: [createUserMessage({
      content: [{ type: 'text', text: 'oversized ' + 'x'.repeat(8192) }], source: { kind: 'website-test' },
    })],
  }))
  const result = await f.invoke(`website_page_info_${request.id}`, {})
  expect(result).toMatchObject({ isError: true, error: { message: 'Website page information exceeded the complete result limit' } })
  expect(JSON.stringify(result)).not.toContain('Current page')
  expect(JSON.stringify(result)).not.toContain('oversized')
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8192)
})

async function browserFixture(services: { attachments?: boolean; llm?: boolean } = {}) {
  const f = await fixture(services)
  f.installWith(scope => installWebsiteRequestTools(scope, f.parent))
  f.requests.syncProfiles([PROFILE])
  await f.invoke('website_prepare', { profileId: PROFILE.id })
  const request = f.captured[0]!
  await f.requests.validate(request.id, request.epoch)
  await f.requests.commit(request.id, request.epoch)
  f.agent.session.append('turn/start', { turn: 1 })
  return { ...f, request, name: `website_browser_${request.id}`, pageInfo: `website_page_info_${request.id}` }
}

function reply(f: Awaited<ReturnType<typeof browserFixture>>, message: object, value: object): void {
  if (!('operationId' in message) || !('snapshot' in message)) throw new Error('Invalid operation packet')
  f.parent.receive({ type: 'website-operation-result', operationId: message.operationId, snapshot: message.snapshot,
    outcome: 'success', value })
}

const FALLBACK = 'Paired MCP has no operation for this task'
const SCREENSHOT_ARGS = { operation: 'screenshot', fallbackReason: FALLBACK, clip: { x: 0, y: 0, width: 1, height: 1 } }
const SCREENSHOT_RESULT = { kind: 'screenshot', png: TINY_PNG, width: 1, height: 1 }
const BROWSER_CASES = [
  { operation: { kind: 'dom-read', selector: 'main > div.result', maxElements: 2, maxTextChars: 64 },
    observation: { elements: [{ tag: 'div', text: 'Visible result' }], truncated: false } },
  { operation: { kind: 'click', selector: '#publish' }, observation: { attempted: true } },
  { operation: { kind: 'fill', selector: 'form .title', text: 'New title' }, observation: { attempted: true } },
  { operation: { kind: 'navigate', url: 'https://portal.example.test/items?view=published#top' }, observation: { attempted: true } },
]

it.each(BROWSER_CASES)('dispatches the exact approved $operation.kind packet and bounded JSON output', async ({ operation, observation }) => {
  const f = await browserFixture()
  const { kind, ...details } = operation
  const args = { operation: kind, fallbackReason: FALLBACK, ...details }
  const approvals: string[] = []
  f.ctx.on('approval/request', (approval) => {
    expect(approval.agent).toBe(f.agent)
    expect(approval.toolName).toBe(f.name)
    expect(approval.detailMode).toBe('summary-only')
    assert.ok(approval.reason !== undefined)
    approvals.push(approval.reason)
    return Promise.resolve<ApprovalOutcome>('allowed-once')
  })
  f.observeWith((message) => { reply(f, message, { kind: 'json', value: observation }) })
  for (let index = 0; index < 2; index++) {
    const value = { operation: kind, observation }
    expect(await f.invoke(f.name, args)).toMatchObject({ isError: false, value,
      content: [{ type: 'text', text: JSON.stringify(value) }] })
  }
  expect(approvals).toHaveLength(2)
  for (const reason of approvals) {
    expect(reason).toContain(JSON.stringify(FALLBACK))
    expect(reason).toContain(`Requested operation: ${JSON.stringify(operation)}.`)
    expect(reason).toContain('Permission applies only to this call')
  }
  expect(f.observations).toEqual([1, 2].map(operationId => ({ type: 'website-operation', operationId,
    snapshot: { ...f.request, status: 'granted' }, operation })))
  expect(f.ctx.tools.get(f.name)).toBeUndefined()
  expect(f.ctx.tools.get(f.pageInfo, f.agent)).toBeDefined()
  f.requests.revoke(f.request.id)
  expect(f.ctx.tools.get(f.name, f.agent)).toBeUndefined()
  expect(f.ctx.tools.get(f.pageInfo, f.agent)).toBeUndefined()
  await f.requests.drain(f.request.id)
})

it.each([
  { operation: 'unknown' },
  { operation: 'evaluate', code: 'document.cookie' },
  { operation: 'evaluate', code: 'navigator.serviceWorker.register("/worker.js")' },
  { operation: 'click', selector: '#publish', code: 'private extra field' },
  { operation: 'click', selector: '#publish', unexpected: true },
  ...['input[type=password]', 'button:first-child', 'a,button', 'div + button', '#publish\n'].map(selector => ({ operation: 'click', selector })),
  ...['https://user:password@portal.example.test/', 'https://@portal.example.test/', 'javascript:alert(1)',
    '//portal.example.test/', 'https://', ' https://portal.example.test/', 'https://portal.example.test/\n',
    'https:\\portal.example.test/'].map(url => ({ operation: 'navigate', url })),
  { operation: 'click', selector: '#publish', fallbackReason: ' ' },
  { operation: 'click', selector: '#publish', fallbackReason: 'reason\nspoof' },
])('rejects malformed operation arguments before approval or native dispatch: %j', async (args) => {
  const f = await browserFixture()
  let asked = 0
  f.ctx.on('approval/request', () => { asked++; return Promise.resolve<ApprovalOutcome>('allowed-once') })
  expect((await f.invoke(f.name, { fallbackReason: FALLBACK, ...args })).isError).toBe(true)
  expect(asked).toBe(0)
  expect(f.observations).toEqual([])
})

it.each(['rejected', 'cancelled', 'unavailable'] as const)('withholds browser data after approval %s', async (outcome) => {
  const f = await browserFixture()
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>(outcome))
  const result = await f.invoke(f.name, { operation: 'click', selector: '#publish', fallbackReason: FALLBACK })
  expect(result.isError).toBe(true)
  expect(result.value).toBeUndefined()
  expect(f.observations).toEqual([])
})

it('returns no browser observation after native admission refuses the approved operation', async () => {
  const f = await browserFixture()
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  f.observeWith((message) => {
    if (!('operationId' in message) || !('snapshot' in message)) throw new Error('Invalid operation packet')
    f.parent.receive({ type: 'website-operation-result', operationId: message.operationId,
      snapshot: message.snapshot, outcome: 'rejected' })
  })
  const result = await f.invoke(f.name, { operation: 'dom-read', selector: 'main', maxElements: 1, maxTextChars: 64, fallbackReason: FALLBACK })
  expect(f.observations).toHaveLength(1)
  expect(result.isError).toBe(true)
  expect(result.value).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain('observation')
})

it('withholds browser data when the human takes over during fresh approval', async () => {
  const f = await browserFixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<ApprovalOutcome>()
  f.ctx.on('approval/request', () => { entered.resolve(undefined); return release.promise })
  const running = f.invoke(f.name, { operation: 'dom-read', selector: 'main', maxElements: 1, maxTextChars: 64, fallbackReason: FALLBACK })
  try {
    await entered.promise
    f.requests.revoke(f.request.id)
  } finally { release.resolve('allowed-once') }
  const result = await running
  expect(result.isError).toBe(true)
  expect(result.value).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain('private result')
  expect(f.observations).toEqual([])
  await f.requests.drain(f.request.id)
})

it.each([
  { services: { llm: true }, model: 'vision', error: 'durable image storage' },
  { services: { attachments: true }, model: 'vision', error: 'image-capable active model' },
  { services: { attachments: true, llm: true }, model: 'text-only', error: 'image-capable active model' },
])('admits no capture or storage without screenshot prerequisites: %j', async ({ services, model, error }) => {
  const f = await browserFixture(services)
  f.agent.options.model = model
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  const result = await f.invoke(f.name, SCREENSHOT_ARGS)
  expect(result.isError).toBe(true)
  expect(result.error?.message).toContain(error)
  expect(f.observations).toEqual([])
  const storage = f.ctx.get('attachments')
  if (storage instanceof WebsiteTestAttachments) expect(storage.images.size).toBe(0)
})

it.each(['agent options', 'session header'] as const)('returns a durable image and receipt using the active model from %s', async (selection) => {
  const f = await browserFixture({ attachments: true, llm: true })
  if (selection === 'session header') {
    f.agent.options.provider = 'unregistered'
    f.agent.options.model = 'text-only'
    f.agent.session.append('request/header', { reason: 'initial', header: { config: { provider: 'website-header', model: 'vision' } } })
  }
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  f.observeWith((message) => { reply(f, message, SCREENSHOT_RESULT) })
  const result = await f.invoke(f.name, SCREENSHOT_ARGS)
  expect(result.isError).toBe(false)
  const image = result.content.find(block => block.type === 'image')
  if (image?.type !== 'image') throw new Error('Screenshot did not project an image')
  const ref = image.attachment
  const value = { operation: 'screenshot', attachmentId: ref.attachmentId, mediaType: 'image/png',
    bytes: Buffer.from(TINY_PNG, 'base64').length, width: 1, height: 1 }
  expect(result.value).toEqual(value)
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(value) }, { type: 'image', attachment: ref }])
  expect(ref.attachmentId).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(JSON.stringify(result)).not.toContain(TINY_PNG)
  expect(JSON.stringify(result)).not.toContain('base64')
  const storage = f.ctx.get('attachments')
  if (!(storage instanceof WebsiteTestAttachments)) throw new Error('Test storage was not loaded')
  expect(Buffer.from((await storage.readImage(ref)).data)).toEqual(Buffer.from(TINY_PNG, 'base64'))
  expect(f.observations).toHaveLength(1)
})

it.each(['oversized context', 'substituted receipt'] as const)('does not resurrect a screenshot projection after %s', async (change) => {
  const f = await browserFixture({ attachments: true, llm: true })
  const substituted = { operation: 'screenshot', attachmentId: 'substituted', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  f.observeWith((message) => { reply(f, message, SCREENSHOT_RESULT) })
  f.ctx.on('tools/post-execute', async (_execution, _result, next) => {
    const result = await next()
    if (result.kind !== 'accept') return result
    return change === 'substituted receipt' ? { kind: 'accept', value: substituted }
      : { ...result, additionalContexts: [createUserMessage({ content: [{ type: 'text', text: 'private oversized ' + 'é'.repeat(128 * 1024) }],
        source: { kind: 'website-test' } })] }
  })
  const result = await f.invoke(f.name, SCREENSHOT_ARGS)
  expect(result.content.some(block => block.type === 'image')).toBe(false)
  expect(JSON.stringify(result)).not.toContain(TINY_PNG)
  if (change === 'oversized context') {
    expect(result).toMatchObject({ isError: true, error: { message: 'Website browser operation exceeded the complete result limit' } })
    expect(JSON.stringify(result)).not.toContain('private oversized')
    expect(JSON.stringify(result)).not.toContain('attachmentId')
  } else {
    expect(result.isError).toBe(false)
    expect(result.value).toEqual(substituted)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(substituted) }])
  }
})

it.each(['JSON', 'screenshot'] as const)('withholds complete %s data if takeover follows successful dispatch', async (kind) => {
  const f = await browserFixture({ attachments: true, llm: true })
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  f.observeWith((message) => { reply(f, message, kind === 'screenshot' ? SCREENSHOT_RESULT : { kind: 'json', value: 'private page data' }) })
  f.ctx.on('tools/post-execute', async (_execution, _result, next) => {
    const result = await next()
    f.requests.revoke(f.request.id)
    return result
  })
  const published: ToolExecutionResult[] = []
  f.ctx.on('tools/result', (_execution, result) => { published.push(result) })
  const result = await f.invoke(f.name, kind === 'screenshot' ? SCREENSHOT_ARGS
    : { operation: 'dom-read', selector: 'main', maxElements: 1, maxTextChars: 64, fallbackReason: FALLBACK })
  expect(f.observations).toHaveLength(1)
  expect(result.isError).toBe(true)
  expect(result.value).toBeUndefined()
  expect(result.content.some(block => block.type === 'image')).toBe(false)
  expect(JSON.stringify(result)).not.toContain('private page data')
  expect(JSON.stringify(result)).not.toContain('attachmentId')
  expect(JSON.stringify(result)).not.toContain(TINY_PNG)
  expect(published).toEqual([result])
  await f.requests.drain(f.request.id)
})

it('waits for physical storage settlement after takeover and withholds the screenshot', async () => {
  const f = await browserFixture({ attachments: true, llm: true })
  const storage = f.ctx.get('attachments')
  if (!(storage instanceof WebsiteTestAttachments)) throw new Error('Test storage was not loaded')
  const release = Promise.withResolvers<undefined>()
  storage.waitForStorage = release.promise
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  f.observeWith((message) => { reply(f, message, SCREENSHOT_RESULT) })
  const published: ToolExecutionResult[] = []
  f.ctx.on('tools/result', (_execution, result) => { published.push(result) })
  const running = f.invoke(f.name, SCREENSHOT_ARGS)
  let drained = false
  let drainage: Promise<void> | undefined
  try {
    await storage.entered.promise
    f.requests.revoke(f.request.id)
    drainage = f.requests.drain(f.request.id).then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(published).toEqual([])
    expect(storage.images.size).toBe(0)
    expect(f.ctx.tools.get(f.name, f.agent)).toBeUndefined()
    expect(f.ctx.tools.get(f.pageInfo, f.agent)).toBeUndefined()
  } finally { release.resolve(undefined) }
  const result = await running
  await drainage
  expect(drained).toBe(true)
  expect(storage.images.size).toBe(1)
  expect(result.isError).toBe(true)
  expect(result.value).toBeUndefined()
  expect(result.content.some(block => block.type === 'image')).toBe(false)
  expect(JSON.stringify(result)).not.toContain('attachmentId')
  expect(JSON.stringify(result)).not.toContain(TINY_PNG)
  expect(published).toEqual([result])
})
