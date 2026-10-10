/** Keyless tool output, committed opening and observation authority through real Loader, Tools, Agents, controller and parent. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { setApprovalPolicy, type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { expect, it } from 'vitest'
import { devicePreviewToolsFixture } from './device-preview-tools.fixture.ts'
import { TINY_PNG, WebsiteTestAttachments, WebsiteTestModels } from './website-browser.fixture.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'device-preview-test': { kind: 'device-preview-test' }
  }
}

const URL = 'http://localhost:4179/'
const UNOPENED = '4bd58e9c-d546-4c16-bd21-b48160ed4d8c'
const NAMES = ['device_preview_project', 'device_preview_open', 'device_preview_observe', 'device_preview_stop']

function planOf(result: ToolExecutionResult) {
  assert.ok(!result.isError && result.value !== null && typeof result.value === 'object' && !Array.isArray(result.value))
  const plan = result.value.plan
  assert.ok(plan !== null && typeof plan === 'object' && !Array.isArray(plan))
  assert.equal(typeof plan.projectId, 'string')
  assert.equal(typeof plan.url, 'string')
  assert.equal(typeof plan.cwd, 'string')
  assert.equal(typeof plan.command, 'string')
  return { projectId: String(plan.projectId), cwd: String(plan.cwd), command: String(plan.command), url: String(plan.url) }
}

function output(result: ToolExecutionResult) {
  return { isError: result.isError, value: result.value, content: result.content, meta: result.meta }
}

/** Normalize only identifier fields after independently checking byte-exact rendering; keep observation text verbatim. */
function normalizeIds(results: Record<string, ReturnType<typeof output>>, ids: Array<[string, string]>): object {
  const replacements = new Map(ids)
  const normalize = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value,
    (key, item: unknown) => (key === 'previewId' || key === 'projectId') && typeof item === 'string'
      ? replacements.get(item) ?? item : item))
  return Object.fromEntries(Object.entries(results).map(([name, result]) => {
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
    const value = normalize(result.value)
    return [name, { isError: result.isError, value,
      content: [{ type: 'text', text: JSON.stringify(value) }], meta: normalize(result.meta) }]
  }))
}

it('prepares without execution, publishes only committed external metadata and removes the contributing tool registrations', async () => {
  const f = await devicePreviewToolsFixture()
  const approvals: ApprovalRequest[] = []
  f.ctx.on('approval/request', (request) => { approvals.push(request); return Promise.resolve<ApprovalOutcome>('allowed-once') })
  const prepared = await f.invoke('device_preview_project', { project: 'app', script: 'dev', url: URL })
  const plan = planOf(prepared)
  expect(plan).toEqual({ projectId: expect.stringMatching(/^[0-9a-f-]{36}$/), cwd: '/inert-device-preview/app',
    command: "npm run 'dev'", url: URL })
  expect(f.files.reads).toEqual([{ path: '/inert-device-preview/app/package.json', maxBytes: 128 * 1024 }])
  expect(f.processes.specs).toEqual([])
  expect(f.ctx.jobs.list()).toEqual([])
  expect(f.openings).toEqual([])
  f.commitWith(false)
  const pending = f.invoke('device_preview_open', { url: 'https://EXAMPLE.test/device' })
  const request = await f.openingEntered.promise
  let completed = false
  const completion = pending.then(() => { completed = true })
  try {
    expect(completed).toBe(false)
    expect(request).toEqual({ type: 'device-preview-open', requestId: expect.any(String), previewId: expect.any(String),
      sessionId: f.agent.session.id, server: { cwd: '', url: 'https://example.test/device', ownership: 'external', status: 'external' } })
    expect((await f.invoke('device_preview_observe', { previewId: request.previewId, slot: 'phone', operation: 'layout' })).isError).toBe(true)
    expect(f.observations).toEqual([])
    expect(approvals).toEqual([])
  } finally {
    f.parent.receive({ type: 'device-preview-result', requestId: request.requestId, ok: true,
      result: { kind: 'opened', previewId: request.previewId } })
  }
  const opened = await pending
  await completion
  expect(completed).toBe(true)
  expect(f.observations).toEqual([])
  expect(approvals).toEqual([])
  const layout = await f.invoke('device_preview_observe', { previewId: request.previewId, slot: 'phone', operation: 'layout' })
  const expected: object = JSON.parse(await readFile(new globalThis.URL('./expected/device-preview-tools.json', import.meta.url), 'utf8'))
  expect(normalizeIds({ prepared: output(prepared), opened: output(opened), layout: output(layout) },
    [[plan.projectId, '<project-id>'], [request.previewId, '<preview-id>']])).toEqual(expected)
  expect(f.processes.specs).toEqual([])
  expect(f.ctx.jobs.list()).toEqual([])
  const tools = f.ctx.tools
  await f.toolsFiber.dispose()
  for (const name of NAMES) expect(tools.get(name, f.agent)).toBeUndefined()
})

it('forgets a Main-retired preview before another observation can request approval or page data', async () => {
  const f = await devicePreviewToolsFixture()
  const approvals: ApprovalRequest[] = []
  f.ctx.on('approval/request', (request) => { approvals.push(request); return Promise.resolve<ApprovalOutcome>('allowed-once') })
  expect((await f.invoke('device_preview_open', { url: URL })).isError).toBe(false)
  const previewId = f.openings[0]!.previewId
  expect(f.parent.receive({ type: 'device-preview-retired', previewId })).toBe(true)
  const result = await f.invoke('device_preview_observe', { previewId, slot: 'phone', operation: 'layout' })
  expect(result.isError).toBe(true)
  expect(approvals).toEqual([])
  expect(f.observations).toEqual([])
  expect(f.processes.specs).toEqual([])
})

it('does not restore observation authority when retirement precedes a late opening response', async () => {
  const f = await devicePreviewToolsFixture()
  f.commitWith(false)
  const opening = f.invoke('device_preview_open', { url: URL })
  const request = await f.openingEntered.promise
  f.parent.receive({ type: 'device-preview-retired', previewId: request.previewId })
  f.parent.receive({ type: 'device-preview-result', requestId: request.requestId, ok: true,
    result: { kind: 'opened', previewId: request.previewId } })
  expect((await opening).isError).toBe(true)
  expect((await f.invoke('device_preview_observe', { previewId: request.previewId, slot: 'phone', operation: 'layout' })).isError).toBe(true)
  expect(f.observations).toEqual([])
})

it('opens and stops only the exact prepared owned plan and reports managed starting state without page inspection', async () => {
  const f = await devicePreviewToolsFixture()
  const plan = planOf(await f.invoke('device_preview_project', { project: 'app', script: 'dev', url: URL }))
  const approvals: ApprovalRequest[] = []
  f.ctx.on('approval/request', (request) => { approvals.push(request); return Promise.resolve<ApprovalOutcome>('allowed-once') })
  expect((await f.invoke('device_preview_open', { projectId: plan.projectId, url: URL + 'different' })).isError).toBe(true)
  expect(f.processes.specs).toEqual([])
  expect(approvals).toEqual([])
  const opened = await f.invoke('device_preview_open', { projectId: plan.projectId, url: plan.url }, 'owned-open')
  const request = f.openings[0]!
  const job = f.ctx.jobs.list()[0]!
  const value = { kind: 'opened', previewId: request.previewId,
    server: { ...plan, ownership: 'owned', status: 'starting', jobId: job.id } }
  expect(output(opened)).toEqual({ isError: false, value,
    content: [{ type: 'text', text: JSON.stringify(value) }], meta: { devicePreview: value } })
  expect(request.server).toEqual(value.server)
  expect(job.owner).toBeUndefined()
  expect(f.processes.specs).toHaveLength(1)
  expect(f.processes.specs[0]?.cwd).toBe(plan.cwd)
  expect(approvals).toHaveLength(1)
  expect(approvals[0]?.agent).toBe(f.agent)
  expect(approvals[0]?.callId).toBe(ToolCallId('owned-open'))
  expect(f.observations).toEqual([])
  expect((await f.invoke('device_preview_stop', { projectId: plan.projectId, port: 4179 })).isError).toBe(true)
  expect(f.processes.ranges).toEqual([{ terminated: false }])
  const stopped = await f.invoke('device_preview_stop', { projectId: plan.projectId })
  expect(stopped).toMatchObject({ isError: false, value: { kind: 'stopped', projectId: plan.projectId },
    meta: { devicePreview: { kind: 'stopped', projectId: plan.projectId } } })
  expect(f.processes.ranges).toEqual([{ terminated: true }])
  expect(f.observations).toEqual([])
})

it('asks fresh approval on the captured Agent and exact callId for each operation and pane', async () => {
  const f = await devicePreviewToolsFixture({ attachments: true })
  await f.invoke('device_preview_open', { url: URL })
  const previewId = f.openings[0]!.previewId
  const approvals: ApprovalRequest[] = []
  f.ctx.on('approval/request', (request) => { approvals.push(request); return Promise.resolve<ApprovalOutcome>('allowed-once') })
  const calls = []
  for (const slot of ['phone', 'tablet'] as const) {
    for (const operation of ['layout', 'screenshot'] as const) {
      for (let repeat = 0; repeat < 2; repeat++) {
        const callId = `${slot}-${operation}-${repeat}`
        calls.push({ previewId, slot, operation, callId })
        expect((await f.invoke('device_preview_observe', { previewId, slot, operation }, callId)).isError).toBe(false)
        const approval = approvals.at(-1)!
        expect(approval.agent).toBe(f.agent)
        expect(approval.callId).toBe(ToolCallId(callId))
        expect(approval.toolName).toBe('device_preview_observe')
        expect(approval.detailMode).toBe('summary-only')
        expect(approval.reason).toBe(`Read ${operation} from the ${slot} pane of preview ${previewId}. Permission applies only to this call; opening grants no page access.`)
      }
    }
  }
  expect(approvals).toHaveLength(calls.length)
  expect(f.observations).toEqual(calls.map(({ callId: _callId, ...args }) => ({ type: 'device-preview-observe',
    requestId: expect.any(String), sessionId: f.agent.session.id, ...args })))
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'approval/asked').map(event => event.data.callId))
    .toEqual(calls.map(call => call.callId))
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome))
    .toEqual(calls.map(() => 'allowed-once'))
})

it.each(['rejected', 'cancelled', 'unavailable', 'missing approval', 'never', 'foreign owner', 'unopened id', 'missing Agent'] as const)
('sends no observation IPC and publishes no page data for %s', async (denial) => {
  const f = await devicePreviewToolsFixture({ approval: denial !== 'missing approval' })
  await f.invoke('device_preview_open', { url: URL })
  const previewId = denial === 'unopened id' ? UNOPENED : f.openings[0]!.previewId
  let asked = 0
  f.ctx.on('approval/request', () => {
    asked++
    return Promise.resolve<ApprovalOutcome>(denial === 'rejected' || denial === 'cancelled' || denial === 'unavailable' ? denial : 'allowed-once')
  })
  if (denial === 'never') setApprovalPolicy(f.agent.session, 'never')
  const args = { previewId, slot: 'tablet', operation: 'layout' }
  const result = denial === 'missing Agent'
    ? await f.ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('agentless'),
      name: 'device_preview_observe', arguments: args })
    : await f.invoke('device_preview_observe', args, 'denied-observation',
      denial === 'foreign owner' ? await f.createAgent('device-preview-tools-other') : f.agent)
  expect(result.isError).toBe(true)
  expect(result.value).toBeUndefined()
  expect(result.meta).toBeUndefined()
  expect(f.observations).toEqual([])
  expect(asked).toBe(['rejected', 'cancelled', 'unavailable'].includes(denial) ? 1 : 0)
})

it.each([
  ['device_preview_open', { url: URL, projectId: 'not-a-uuid' }],
  ['device_preview_open', { url: 'https://@example.test/' }],
  ['device_preview_open', { url: 'https://user:password@example.test/' }],
  ['device_preview_open', { url: 'file:///private' }],
  ['device_preview_open', { url: URL + '\n' }],
  ['device_preview_open', { url: URL, pid: 42 }],
  ['device_preview_project', { project: 'app', script: 'dev', url: 'javascript:alert(1)' }],
  ['device_preview_project', { project: 'app', command: 'install' }],
  ['device_preview_observe', { previewId: 'not-a-uuid', slot: 'phone', operation: 'layout' }],
  ['device_preview_observe', { previewId: UNOPENED.toUpperCase(), slot: 'phone', operation: 'layout' }],
  ['device_preview_observe', { previewId: UNOPENED, slot: 'desktop', operation: 'layout' }],
  ['device_preview_observe', { previewId: UNOPENED, slot: 'phone', operation: 'evaluate' }],
  ['device_preview_observe', { previewId: UNOPENED, slot: 'phone', operation: 'layout', url: URL }],
  ['device_preview_stop', { projectId: 'not-a-uuid' }],
] as const)('rejects malformed model JSON for %s: %j before approval or IPC', async (name, args) => {
  const f = await devicePreviewToolsFixture()
  if (name === 'device_preview_observe') await f.invoke('device_preview_open', { url: URL })
  const openings = [...f.openings]
  const input = 'previewId' in args && args.previewId === UNOPENED
    ? { ...args, previewId: f.openings[0]!.previewId } : args
  let asked = 0
  f.ctx.on('approval/request', () => { asked++; return Promise.resolve<ApprovalOutcome>('allowed-once') })
  const result = await f.invoke(name, input)
  expect(result.isError).toBe(true)
  if (('previewId' in args && args.previewId !== UNOPENED) || ('projectId' in args && args.projectId === 'not-a-uuid')) {
    expect(result.error?.message).toContain('exact recorded device preview identifier')
  }
  expect(asked).toBe(0)
  expect(f.openings).toEqual(openings)
  expect(f.observations).toEqual([])
  expect(f.files.reads).toEqual([])
  expect(f.processes.specs).toEqual([])
})

it.each([
  { attachments: false, model: 'vision', error: 'durable image storage' },
  { attachments: true, model: 'text-only', error: 'image-capable active model' },
])('withholds screenshot capture without $error', async ({ attachments, model, error }) => {
  const f = await devicePreviewToolsFixture({ attachments })
  f.agent.options.model = model
  await f.invoke('device_preview_open', { url: URL })
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  const result = await f.invoke('device_preview_observe', { previewId: f.openings[0]!.previewId, slot: 'phone', operation: 'screenshot' })
  expect(result.error?.message).toContain(error)
  expect(result.isError).toBe(true)
  expect(f.observations).toEqual([])
  const store = f.ctx.get('attachments')
  if (store instanceof WebsiteTestAttachments) expect(store.images.size).toBe(0)
})

it.each(['Agent options', 'session header'] as const)('logs durable screenshot references and card metadata using the active model from %s', async (selection) => {
  const f = await devicePreviewToolsFixture({ attachments: true })
  if (selection === 'session header') {
    f.agent.options.provider = 'unregistered'
    f.agent.options.model = 'text-only'
    f.agent.session.append('request/header', { reason: 'initial', header: { config: { provider: 'website-header', model: 'vision' } } })
  }
  await f.invoke('device_preview_open', { url: URL })
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  const args = { previewId: f.openings[0]!.previewId, slot: 'tablet', operation: 'screenshot' }
  const result = await f.logged('device_preview_observe', args, 'logged-screenshot')
  expect(result.isError).toBe(false)
  const image = result.content.find(block => block.type === 'image')
  assert.ok(image?.type === 'image')
  const ref = image.attachment
  expect(ref).toMatchObject({ attachmentId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    mediaType: 'image/png', bytes: Buffer.from(TINY_PNG, 'base64').length, width: 1, height: 1, name: 'device-preview-tablet.png' })
  const value = { ...args, kind: 'screenshot', attachmentId: ref.attachmentId, mediaType: ref.mediaType,
    bytes: ref.bytes, width: 1, height: 1 }
  expect(output(result)).toEqual({ isError: false, value,
    content: [{ type: 'text', text: JSON.stringify(value) }, { type: 'image', attachment: ref }], meta: { devicePreview: value } })
  const store = f.ctx.get('attachments')
  assert.ok(store instanceof WebsiteTestAttachments)
  expect(Buffer.from((await store.readImage(ref)).data)).toEqual(Buffer.from(TINY_PNG, 'base64'))
  const logged = f.agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'logged-screenshot')
  assert.ok(logged?.type === 'tool/result')
  expect(logged.data.message.content).toEqual(result.content)
  expect(logged.data.meta).toEqual(result.meta)
  expect(f.agent.session.deriveMessages().find(message => message.role === 'tool' && message.toolCallId === 'logged-screenshot')?.content).toEqual(result.content)
  expect(f.ctx.tools.get('device_preview_observe', f.agent)?.presentCall?.(args)).toEqual({ card: 'generic',
    title: 'Read device preview screenshot: tablet', kind: 'read' })
  expect(JSON.stringify(result)).not.toContain(TINY_PNG)
  expect(JSON.stringify(logged.data)).not.toContain('base64')
})

it('withholds an individually bounded preparation when its complete rendered output and metadata exceed the limit', async () => {
  const f = await devicePreviewToolsFixture()
  f.files.content = JSON.stringify({ scripts: { dev: 'vite ' + 'é'.repeat(45 * 1024) } })
  expect(Buffer.byteLength(f.files.content)).toBeLessThan(128 * 1024)
  const result = await f.invoke('device_preview_project', { project: 'app' })
  expect(result).toMatchObject({ isError: true, error: { message: 'Device preview exceeded the complete result limit' } })
  expect(result.value).toBeUndefined()
  expect(result.meta).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain('vite ')
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024)
  expect(f.processes.specs).toEqual([])
  expect(f.openings).toEqual([])
})

it('withholds screenshot references, page data and metadata when post-execute adds oversized context', async () => {
  const f = await devicePreviewToolsFixture({ attachments: true })
  await f.invoke('device_preview_open', { url: URL })
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  f.ctx.on('tools/post-execute', async (_execution, _result, next) => ({ ...await next(),
    additionalContexts: [createUserMessage({ content: [{ type: 'text', text: 'private oversized ' + 'é'.repeat(128 * 1024) }],
      source: { kind: 'device-preview-test' } })] }))
  const published: ToolExecutionResult[] = []
  f.ctx.on('tools/result', (_execution, result) => { published.push(result) })
  const result = await f.invoke('device_preview_observe', { previewId: f.openings[0]!.previewId, slot: 'phone', operation: 'screenshot' })
  expect(result).toMatchObject({ isError: true, error: { message: 'Device preview exceeded the complete result limit' } })
  expect(result.value).toBeUndefined()
  expect(result.meta).toBeUndefined()
  expect(result.content.some(block => block.type === 'image')).toBe(false)
  expect(JSON.stringify(result)).not.toContain('attachmentId')
  expect(JSON.stringify(result)).not.toContain('private oversized')
  expect(JSON.stringify(result)).not.toContain(TINY_PNG)
  expect(f.observations).toHaveLength(1)
  expect(published).toEqual([result])
})

it('does not capture when approval becomes disabled during screenshot model admission', async () => {
  const f = await devicePreviewToolsFixture({ attachments: true })
  await f.invoke('device_preview_open', { url: URL })
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  class PolicyChangingModels extends WebsiteTestModels {
    override resolveModel(provider: string, model: string) {
      setApprovalPolicy(f.agent.session, 'never')
      return super.resolveModel(provider, model)
    }
  }
  f.ctx.effect(() => f.ctx.llm.registerAdapter(['policy-change'], new PolicyChangingModels()))
  f.agent.options.provider = 'policy-change'
  const result = await f.invoke('device_preview_observe', { previewId: f.openings[0]!.previewId,
    slot: 'tablet', operation: 'screenshot' })
  expect(result.isError).toBe(true)
  expect(f.observations).toEqual([])
  const store = f.ctx.get('attachments')
  assert.ok(store instanceof WebsiteTestAttachments)
  expect(store.images.size).toBe(0)
})

it('withholds approved layout after the approval policy changes before final publication', async () => {
  const f = await devicePreviewToolsFixture()
  await f.invoke('device_preview_open', { url: URL })
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  f.ctx.on('tools/post-execute', async (_execution, _result, next) => {
    const accepted = await next()
    setApprovalPolicy(f.agent.session, 'never')
    return accepted
  })
  const result = await f.invoke('device_preview_observe', { previewId: f.openings[0]!.previewId,
    slot: 'phone', operation: 'layout' })
  expect(f.observations).toHaveLength(1)
  expect(result).toMatchObject({ isError: true, error: { message: 'Device preview observation approval is no longer available' } })
  expect(result.value).toBeUndefined()
  expect(result.meta).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain('Submit')
})

it('keeps preview installation, readiness, receive routing and shutdown in the source-only Host integration', async () => {
  const source = await readFile(new globalThis.URL('../src/index.ts', import.meta.url), 'utf8')
  function ordered(fragment: string, needles: string[]) {
    let position = -1
    for (const needle of needles) {
      const next = fragment.indexOf(needle, position + 1)
      expect(next, needle).toBeGreaterThan(position)
      position = next
    }
  }
  const prepare = source.slice(source.indexOf('prepare(ctx)'), source.indexOf('...(process.argv[5]'))
  ordered(prepare, ['installDevicePreviewController(ctx, send)', 'installDevicePreviewParentChannel(ctx, send)',
    'installDevicePreviewTools(ctx, previewController, previewParent)'])
  ordered(source, ['const { ctx } = await application', 'await ctx.loader.await()', 'await control.devicePreviewTools.await()',
    'await control.devicePreviewController.await()', "process.send?.({ type: 'ready'"])
  const receiver = source.slice(source.indexOf("process.on('message'"), source.indexOf("process.once('disconnect'"))
  ordered(receiver, ['control.devicePreviewController?.receive(message)', 'control.devicePreviewParent?.receive(message)',
    "message.type === 'shutdown'"])
  const shutdown = source.slice(source.indexOf('const stop ='), source.indexOf("process.on('message'"))
  ordered(shutdown, ['control.devicePreviewParent?.close()', 'await application.catch', 'control.devicePreviewParent?.close()',
    'await control.devicePreviewController?.dispose()', 'finally { await running?.shutdown.shutdown(0) }', "type: 'shutdown-complete'"])
  const disconnect = source.slice(source.indexOf("process.once('disconnect'"), source.indexOf('const { ctx } = await application'))
  ordered(disconnect, ['control.devicePreviewParent?.close()', 'void stop()'])
})
