// @vitest-environment jsdom
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Include from '@deepseek-ai/cordis-plugin-include'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { act, fireEvent, within } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteMock, ok } from '@deepseek-ai/dsh-remote-mock'
import { TestClient, remoteDefaultResponses, approvalRuntimePlan } from './approval-runtime.client.ts'
import { SESSION_FORMAT_VERSION, SessionSeq, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionFollowFrame, SessionPage, SessionSummary, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import { assertSessionWireEvent } from '../../../api/session-controller/src/client/session-wire-event.ts'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import * as approvalPlugin from '../src/client/index.ts'
import type { ApprovalPresentationRequest } from '../src/client/contract/slots.ts'
import { createToolResultMessage, LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { RemoteEventAgentId, RemoteEventId, RemoteEventInvocationFrame } from '../../../api/gateway/src/stream-protocol.ts'

const SID = 'approval-replay' as SessionId
const REQUEST = ApprovalRequestId('replay-request')
const ENTRY = 'approval-replay-feature'
const CALL = ToolCallId('approval-command')
const COMMAND = 'printf correlated-command'

function toolCall(seq: number, argumentsRaw = JSON.stringify({ command: COMMAND }), callId = CALL, name = 'bash'): SessionEvent<'tool/call'> {
  return { type: 'tool/call', seq: SessionSeq(seq), time: seq,
    data: { turn: 1, step: 1, callId, name, arguments: argumentsRaw } }
}
function toolResult(seq: number): SessionEvent<'tool/result'> {
  return { type: 'tool/result', seq: SessionSeq(seq), time: seq, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: createToolResultMessage({ callId: CALL, content: [{ type: 'text', text: 'Done' }], isError: false }) } }
}

function asked(seq: number, id = REQUEST): SessionEvent<'approval/asked'> {
  return { type: 'approval/asked', seq: SessionSeq(seq), time: seq,
    data: { id, toolName: 'read', callId: CALL, reason: 'Read the selected file' } }
}
function decided(seq: number, outcome: SessionEvent<'approval/decided'>['data']['outcome'] = 'allowed-once', id = REQUEST): SessionEvent<'approval/decided'> {
  return { type: 'approval/decided', seq: SessionSeq(seq), time: seq, data: { id, outcome } }
}
function wireEvent(event: SessionEvent): SessionWireEvent {
  const value: unknown = JSON.parse(JSON.stringify(event))
  assertSessionWireEvent(value)
  return value
}
function opening(events: readonly SessionEvent[], hasMore = false): SessionFollowFrame {
  const cursor = events.at(-1)?.seq ?? -1
  return { type: 'snapshot', header: { version: SESSION_FORMAT_VERSION, id: SID, createdAt: 1, isSeeded: false },
    cursor, records: events.map(event => ({ type: 'event', event: wireEvent(event) })), hasMore,
    projections: { asOfSeq: cursor, values: {} }, assistantStream: { revision: 0 } }
}

async function bench(events: readonly SessionEvent[], hasMore = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-approval-replay-'))
  const language = document.documentElement.getAttribute('lang')
  const cleanup: { dispose?: () => Promise<void>; unmount?: () => void } = {}
  const container = document.createElement('div')
  onTestFinished(async () => {
    try {
      await act(async () => { cleanup.unmount?.(); await cleanup.dispose?.() })
    } finally {
      container.remove()
      if (language === null) document.documentElement.removeAttribute('lang')
      else document.documentElement.setAttribute('lang', language)
      await rm(root, { recursive: true, force: true })
    }
  })
  const config = join(root, 'cordis.yml')
  await writeFile(config, `- id: ${ENTRY}\n  name: cordis:testApproval\n`)
  const mock = RemoteMock.create().load(remoteDefaultResponses)
  const summary: SessionSummary = { sessionId: SID, updatedAt: 1, agentAvailable: true, running: false, blank: false }
  mock.unary('session/list', ok({ items: [summary] }))
  mock.unary('session/projections', ok({ asOfSeq: -1, values: {} }))
  mock.unary('$events/result', ok(undefined))
  mock.stream('session/follow', (_args, stream) => { stream.push(opening(events, hasMore)) })
  const client = await TestClient.start(approvalRuntimePlan, mock)
  cleanup.dispose = () => client.dispose()
  document.body.append(container)
  client.ctx.loader.builtins.include = Include
  client.ctx.loader.builtins.testApproval = approvalPlugin
  await client.ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await client.ctx.loader.await()
  await client.ctx.sessions.refresh()
  await act(async () => {
    client.ctx.uiWorkspace.openSession(SID)
    await mock.streams.opened('session/follow', 1)
    await mock.streams.drained('session/follow')
    await vi.waitFor(() => {
      expect(client.ctx.sessions.binding(SID)?.eventSource.getSnapshot().entries.length).toBeGreaterThanOrEqual(events.length)
    })
  })
  await act(async () => { cleanup.unmount = client.ctx.uiRenderer.mount(container) })
  const feature = [...client.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:testApproval')
  if (feature === undefined) throw new Error('approval YAML entry is missing')
  const binding = client.ctx.uiConversation.binding(SID)
  binding.activate('chat')
  const requestApproval = async (request: Omit<ApprovalPresentationRequest, 'signal'>) => {
    const frame: RemoteEventInvocationFrame = { type: 'waterfall', event: 'approval/request',
      eventId: 'approval-live' as RemoteEventId, agentId: SID as string as RemoteEventAgentId,
      request: { ...request } }
    await mock.streams.opened('$events', 1)
    await act(async () => { mock.streams.push('$events', frame); await mock.streams.drained('$events') })
    await vi.waitFor(() => { expect(container.querySelector('[data-approval-key]')).not.toBeNull() })
    const panel = container.querySelector<HTMLElement>('[data-approval-key]')
    if (panel === null) throw new Error('approval panel is missing')
    return { panel, prompt: within(panel) }
  }
  return { client, mock, container, view: within(container), binding, feature, requestApproval }
}

describe('approval replay through test-only cordis.yml', () => {
  usePinnedBrowserLanguages('en')
  it('folds a keyless asked/decided log into one read-only permission checkpoint', async () => {
    const { view, container } = await bench([asked(0), decided(1)])
    await vi.waitFor(() => { expect(view.getByText('Permission granted once')).toBeTruthy() })
    expect(view.getAllByText('Approval: read')).toHaveLength(1)
    expect(view.getByText('Read the selected file')).toBeTruthy()
    expect(container.querySelector('[data-approval-key]')).toBeNull()
    expect(view.queryByRole('button', { name: 'Allow once' })).toBeNull()
    expect(view.queryByRole('button', { name: 'Reject' })).toBeNull()
    expect(container.textContent).not.toMatch(/execution (?:completed|succeeded)/i)
  }, 60_000)

  it('correlates live decisions by requestId without reporting tool completion or retaining arguments', async () => {
    const secret = 'SECRET_DURABLE_ROOT_318'
    const other = ApprovalRequestId('other-request')
    const { client, mock, view, binding } = await bench([
      toolCall(0, JSON.stringify({ command: `printf ${secret}` })), asked(1), asked(2, other),
    ])
    const key = client.ctx.uiConversation.contextKey('approval-checkpoint', REQUEST)
    const otherKey = client.ctx.uiConversation.contextKey('approval-checkpoint', other)
    const frame: SessionFollowFrame = { type: 'event', event: decided(3) }
    await act(async () => { mock.streams.push('session/follow', frame); await mock.streams.drained('session/follow') })
    await vi.waitFor(() => { expect(view.getByText('Permission granted once')).toBeTruthy() })
    const nodes = binding.target('chat').getSnapshot()?.nodes
    expect(nodes?.get(key)).toMatchObject({ key, id: REQUEST, anchorSeq: 1 })
    expect(nodes?.get(key)?.data).toEqual({
      requestId: REQUEST, toolName: 'read', reason: 'Read the selected file', status: 'allowed-once',
    })
    expect(nodes?.get(otherKey)?.data).toMatchObject({ requestId: other, status: 'asked' })
    expect(nodes?.get(client.ctx.uiConversation.contextKey('tool-call', CALL)))
      .toMatchObject({ data: { root: { phase: 'start' } } })
    expect(JSON.stringify(nodes?.get(key))).not.toContain(secret)
    expect(view.getAllByText('Approval: read')).toHaveLength(2)
    const result: SessionFollowFrame = { type: 'event', event: wireEvent(toolResult(4)) }
    await act(async () => { mock.streams.push('session/follow', result); await mock.streams.drained('session/follow') })
    expect(view.getByText('Permission granted once')).toBeTruthy()
    expect(binding.target('chat').getSnapshot()?.nodes.get(key)?.data).toMatchObject({ status: 'allowed-once' })
  }, 60_000)

  it('removes the checkpoint on fiber disposal and renders it once after Loader re-add', async () => {
    const { client, feature, view, binding } = await bench([asked(0), decided(1)])
    const key = client.ctx.uiConversation.contextKey('approval-checkpoint', REQUEST)
    const originalFiber = feature.fiber
    expect(originalFiber).toBeDefined()
    await vi.waitFor(() => { expect(view.getByText('Permission granted once')).toBeTruthy() })
    await act(async () => {
      await feature.update({ disabled: true })
      await originalFiber?.dispose()
      await client.ctx.loader.await()
    })
    await vi.waitFor(() => { expect(view.queryByText('Approval: read')).toBeNull() })
    expect(client.ctx.uiConversation.events.entries().some(definition => definition.kind === 'approval-checkpoint')).toBe(false)
    expect(binding.target('chat').getSnapshot()?.nodes.get(key)).toBeUndefined()
    expect(client.ctx.slots.entries('conversation.chat.node').some(entry => entry.options.key === 'approval-checkpoint')).toBe(false)
    await act(async () => {
      await feature.update({ disabled: false })
      await client.ctx.loader.await()
    })
    await vi.waitFor(() => { expect(view.getAllByText('Approval: read')).toHaveLength(1) })
    expect(view.getByText('Permission granted once')).toBeTruthy()
    expect(feature.fiber).not.toBe(originalFiber)
    expect(client.ctx.uiConversation.events.entries().filter(definition => definition.kind === 'approval-checkpoint')).toHaveLength(1)
    expect(client.ctx.slots.entries('conversation.chat.node').filter(entry => entry.options.key === 'approval-checkpoint')).toHaveLength(1)
    expect(binding.target('chat').getSnapshot()?.nodes.get(key)?.data).toMatchObject({ status: 'allowed-once' })
    await act(async () => {
      if (feature.fiber === undefined) throw new Error('re-added approval fiber is missing')
      await feature.fiber.restart()
      await client.ctx.loader.await()
    })
    await vi.waitFor(() => { expect(view.getAllByText('Approval: read')).toHaveLength(1) })
  }, 60_000)

  it('replays the replacement page after a follow gap without duplicating the checkpoint', async () => {
    const { mock, view, binding, client } = await bench([asked(0), decided(1)])
    await vi.waitFor(() => { expect(view.getByText('Permission granted once')).toBeTruthy() })
    const replacement: SessionPage = { records: [asked(0), decided(1), decided(2, 'rejected'), toolCall(3)].map(event => ({ type: 'event', event })), hasMore: false }
    mock.unary('session/page', ok(replacement))
    const append: SessionFollowFrame = { type: 'event', event: toolCall(3) }
    await act(async () => { mock.streams.push('session/follow', append); await mock.streams.drained('session/follow') })
    await vi.waitFor(() => { expect(view.getByText('Rejected')).toBeTruthy() })
    expect(view.queryByText('Permission granted once')).toBeNull()
    expect(view.getAllByText('Approval: read')).toHaveLength(1)
    expect(binding.target('chat').getSnapshot()?.nodes.get(client.ctx.uiConversation.contextKey('approval-checkpoint', REQUEST)))
      .toMatchObject({ anchorSeq: 0, data: { status: 'rejected' } })
  }, 60_000)

  it('keeps localized summary-only requests free of raw reasons and command detail', async () => {
    const secret = 'SECRET_APPROVAL_TOKEN_729'
    const { client, binding, requestApproval } = await bench([toolCall(0, JSON.stringify({ command: `printf ${secret}` }), CALL, 'ptc')])
    expect(binding.target('chat').getSnapshot()?.nodes.get(client.ctx.uiConversation.contextKey('tool-call', CALL)))
      .toMatchObject({ data: { root: { phase: 'start', argsRaw: JSON.stringify({ command: `printf ${secret}` }) } } })
    let detailInvoked = false
    client.ctx.effect(() => client.ctx.slots.register({
      name: 'conversation.approval.detail', priority: -100,
    }, () => {
      detailInvoked = true
      return <span>Optional extension detail</span>
    }))
    const { panel, prompt } = await requestApproval({ toolName: 'bash', callId: CALL,
      reason: `Audit reason ${secret}`, detailMode: 'summary-only',
      displayReason: { en: 'Permission to run the selected command' } })
    expect(prompt.getByText('Permission to run the selected command')).toBeTruthy()
    expect(panel.textContent).not.toContain(secret)
    expect(panel.textContent).not.toContain('Audit reason')
    expect(detailInvoked).toBe(false)
    expect(prompt.queryByText('Optional extension detail')).toBeNull()
    expect(prompt.getByRole('button', { name: 'Allow once' })).toBeTruthy()
    await act(async () => { fireEvent.click(prompt.getByRole('button', { name: 'Reject' })) })
    await vi.waitFor(() => { expect(panel.isConnected).toBe(false) })
    const ordinary = await requestApproval({ toolName: 'bash', callId: CALL })
    expect(ordinary.prompt.getByText('Optional extension detail')).toBeTruthy()
    expect(detailInvoked).toBe(true)
  }, 60_000)

  it('renders only the exact correlated running command and removes it when that call settles', async () => {
    const { mock, requestApproval } = await bench([toolCall(0, JSON.stringify({ command: 'unrelated-command' }), ToolCallId('unrelated')), toolCall(1)])
    const { panel, prompt } = await requestApproval({ toolName: 'bash', callId: CALL, reason: 'Run the selected command' })
    expect(prompt.getByText(COMMAND)).toBeTruthy()
    expect(panel.textContent).not.toContain('unrelated-command')
    const append: SessionFollowFrame = { type: 'event', event: wireEvent(toolResult(2)) }
    await act(async () => { mock.streams.push('session/follow', append); await mock.streams.drained('session/follow') })
    await vi.waitFor(() => { expect(prompt.queryByText(COMMAND)).toBeNull() })
    expect(prompt.getByRole('button', { name: 'Allow once' })).toBeTruthy()
    await act(async () => { fireEvent.click(prompt.getByRole('button', { name: 'Allow once' })) })
    await vi.waitFor(() => { expect(panel.isConnected).toBe(false) })
  }, 60_000)

  it.each([
    { name: 'absent correlation', events: [toolCall(0, undefined, ToolCallId('unrelated'))] },
    { name: 'settled correlation', events: [toolCall(0), toolResult(1)] },
    { name: 'malformed JSON', events: [toolCall(0, '{')] },
    { name: 'non-command arguments', events: [toolCall(0, '{"file_path":"a.txt"}')] },
    { name: 'non-string command', events: [toolCall(0, '{"command":42}')] },
  ])('keeps decisions available without detail for $name', async ({ events }) => {
    const { requestApproval } = await bench(events)
    const { panel, prompt } = await requestApproval({ toolName: 'bash', callId: CALL, reason: 'Permission required' })
    expect(panel.textContent).not.toContain(COMMAND)
    expect(prompt.getByText('Permission required')).toBeTruthy()
    expect(prompt.getByRole('button', { name: 'Allow once' })).toBeTruthy()
    expect(prompt.getByRole('button', { name: 'Reject' })).toBeTruthy()
  }, 60_000)

  it('does not preview a preparing call before dispatch', async () => {
    const { client, mock, binding, requestApproval } = await bench([
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(1), time: 1, data: { turn: 1, step: 1 } },
    ])
    const attemptId = LlmAttemptId('approval-preparing')
    const frames: SessionFollowFrame[] = [
      { type: 'assistant-stream', frame: { type: 'start', attemptId, revision: 1, startedAfterSeq: SessionSeq(1), turn: 1, step: 1 } },
      { type: 'assistant-stream', frame: { type: 'chunk', attemptId, revision: 2, index: 0, time: 1,
        chunk: { type: 'tool-call-delta', index: 0, id: CALL, name: 'bash', argumentsDelta: JSON.stringify({ command: COMMAND }) } } },
    ]
    await act(async () => {
      for (const frame of frames) { mock.streams.push('session/follow', frame); await mock.streams.drained('session/follow') }
    })
    await vi.waitFor(() => {
      expect(binding.target('chat').getSnapshot()?.nodes.get(client.ctx.uiConversation.contextKey('tool-call', CALL)))
        .toMatchObject({ data: { root: { phase: 'preparing' } } })
    })
    const { panel, prompt } = await requestApproval({ toolName: 'bash', callId: CALL })
    expect(panel.textContent).not.toContain(COMMAND)
    expect(prompt.getByRole('button', { name: 'Allow once' })).toBeTruthy()
  }, 60_000)

  it('supports requests without a detail correlation', async () => {
    const { requestApproval } = await bench([toolCall(0)])
    const { panel, prompt } = await requestApproval({ toolName: 'bash' })
    expect(panel.textContent).not.toContain(COMMAND)
    expect(prompt.getByRole('button', { name: 'Reject' })).toBeTruthy()
    await act(async () => { fireEvent.click(prompt.getByRole('button', { name: 'Reject' })) })
    await vi.waitFor(() => { expect(panel.isConnected).toBe(false) })
  }, 60_000)

  it('rebuilds an update-only opening when its asked record is prepended', async () => {
    const { client, mock, view, binding } = await bench([decided(1)], true)
    expect(view.queryByText('Approval: read')).toBeNull()
    const page: SessionPage = { records: [{ type: 'event', event: asked(0) }], hasMore: false }
    mock.unary('session/page', ok(page))
    await act(async () => {
      const session = client.ctx.sessions.binding(SID)?.session
      if (session === undefined) throw new Error('session binding is missing')
      await session.loadOlder()
    })
    await vi.waitFor(() => { expect(view.getAllByText('Approval: read')).toHaveLength(1) })
    expect(view.getByText('Permission granted once')).toBeTruthy()
    const node = binding.target('chat').getSnapshot()?.nodes.get(client.ctx.uiConversation.contextKey('approval-checkpoint', REQUEST))
    expect(node).toMatchObject({ anchorSeq: 0, location: { kind: 'session' }, data: { status: 'allowed-once' } })
  }, 60_000)
})
