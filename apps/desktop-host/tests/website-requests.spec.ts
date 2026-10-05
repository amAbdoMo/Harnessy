/** Host request ownership and revocation retain locks until all admitted work settles. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserApproval, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import Tools, { type ToolExecution, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import type { DesktopWebsiteProfileId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { createScope } from '@deepseek-ai/dsh-scope'
import { assertNever, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installWebsiteRequests, type WebsiteRequestSnapshot } from '../src/website-requests.ts'
import { websiteHostSnapshot } from '../src/website-control.ts'
import { websiteAuthorityFixture } from '../../desktop/tests/website-authority-fixture.ts'

async function fixture(
  notice: (request: WebsiteRequestSnapshot) => void | Promise<void> = () => {}, wrapperSignal?: AbortSignal, meta?: JsonValue,
) {
  const ctx = new Context()
  const barriers: PromiseWithResolvers<void>[] = []
  const pending: Promise<unknown>[] = []
  onTestFinished(async () => {
    for (const barrier of barriers) barrier.resolve()
    await Promise.allSettled(pending)
    await ctx.fiber.dispose()
  })
  function track<T>(promise: Promise<T>): Promise<T> { pending.push(promise); return promise }
  function barrier(): PromiseWithResolvers<void> {
    const held: PromiseWithResolvers<void> = Promise.withResolvers()
    barriers.push(held)
    return held
  }
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(UserApproval)
  type ApprovalRequest = Parameters<typeof ctx.approval.request>[0]
  let answer: (request: ApprovalRequest) => Promise<ApprovalOutcome> = () => Promise.resolve('allowed-once')
  const approvals = vi.fn((request: ApprovalRequest) => answer(request))
  const detachAnswerer = ctx.on('approval/request', approvals)
  if (wrapperSignal !== undefined) ctx.on('tools/execute', async (execution, next) => {
    const upstream = execution.signal
    execution.signal = wrapperSignal
    try {
      return await next()
    } finally {
      execution.signal = upstream
    }
  })
  const session = Session.create(SessionId('website-owner'))
  session.append('turn/start', { turn: 1 })
  // The external Agent loop is omitted; the real registry retains this exact owner and Session.
  const agent = { id: session.id, session, ctx } as Agent
  const owner = createScope(ctx, agent)
  Object.assign(agent, { ctx: owner.ctx })
  const detachAgent = ctx.agents.enter(agent, undefined)
  let binding = { identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/mcp' }
  const inspected = vi.fn(async () => binding)
  const notify = vi.fn(notice)
  const nativeAdmission = vi.fn(async (_request: WebsiteRequestSnapshot, _signal: AbortSignal) => {})
  const requests = installWebsiteRequests(ctx, inspected, notify, nativeAdmission)
  const profile = { id: 'cd1b6493-c881-4967-a544-b0a49f2d847f' as DesktopWebsiteProfileId,
    name: 'Portal', accountLabel: 'operator', url: 'https://portal.example.test/', serverName: 'portal', mcpBinding: binding }
  requests.syncProfiles([profile])
  let receipt: WebsiteRequestSnapshot | undefined
  let preparation: ToolRunContext | undefined
  ctx.tools.register({ name: 'prepare', description: 'Capture a website request.', parameters: { type: 'object' },
    output: { schema: { type: 'boolean' }, render: () => [] },
    async execute(_args, execution) { preparation = execution; receipt = requests.create(execution, profile); return true },
  })
  const caller = new AbortController()
  const prepared = await ctx.tools.execute({ agent, signal: caller.signal,
    callId: ToolCallId('prepare'), name: 'prepare', arguments: {} })
  expect(prepared.isError).toBe(false)
  if (receipt === undefined || preparation === undefined) throw new Error('Request was not captured')
  const request = receipt
  const upstream = vi.fn(async (_args: Record<string, unknown>, _execution: ToolExecution) =>
    ({ content: [{ type: 'text', text: 'observed' }] }))
  const definition = createMcpToolDefinition(ctx, { name: 'mcp__portal__read', serverName: 'portal', rawName: 'read',
    description: 'Observe the portal.', inputSchema: { type: 'object' }, call: upstream })
  if (meta !== undefined) definition.output.presentationMeta = () => meta
  ctx.tools.register(definition)
  const call = (signal = new AbortController().signal, args: Record<string, unknown> = {}) => track(ctx.tools.execute({ agent, signal,
    callId: ToolCallId('read'), name: 'mcp__portal__read', arguments: args }))
  let sequence = 0
  const browser = <T>(operation: (signal: AbortSignal) => Promise<T>,
    options: { agent?: Agent | undefined; signal?: AbortSignal; cloneExecution?: true } = {}) => {
    const name = `browser_${++sequence}`
    ctx.tools.register({ name, description: 'Observe the authorized website.', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        ...meta === undefined ? {} : { presentationMeta: () => meta } },
      async execute(_args, execution) {
        return await requests.run(options.cloneExecution ? { ...execution } : execution,
          request.requestId, request.epoch, operation) ?? 'Browser work settled'
      },
    })
    const invokingAgent = 'agent' in options ? options.agent : agent
    return track(ctx.tools.execute({ ...(invokingAgent === undefined ? {} : { agent: invokingAgent }),
      signal: options.signal ?? new AbortController().signal, callId: ToolCallId(name), name, arguments: {} }))
  }
  return { ctx, owner, agent, detachAgent, requests, request, profile, inspected, notify, nativeAdmission, upstream, call, caller,
    preparation, definition, browser, barrier, track, approvals, detachAnswerer,
    approveWith: (operation: typeof answer) => { answer = operation },
    changeBinding: () => { binding = { ...binding, identity: 'b'.repeat(64) } } }
}

it.each(['MCP', 'browser'] as const)(
  'requires a new one-call decision for every resumed %s operation', async (kind) => {
    const f = await fixture()
    await f.requests.validate(f.request.requestId, f.request.epoch)
    await f.requests.commit(f.request.requestId, f.request.epoch)
    for (let index = 0; index < 2; index++) {
      const result = kind === 'MCP' ? await f.call() : await f.browser(async () => 'approved observation')
      expect(result.isError).toBe(false)
    }
    expect(f.approvals).toHaveBeenCalledTimes(2)
    for (const [approval] of f.approvals.mock.calls) {
      expect(approval).toMatchObject({ agent: f.agent, detailMode: 'summary-only' })
      expect(approval.callId).toBeDefined()
      expect(approval.reason).toContain('only to this call')
    }
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'approval/asked')).toHaveLength(2)
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toHaveLength(2)
  },
)

it.each(['rejected', 'cancelled', 'unavailable'] as const)(
  'never dispatches paired MCP work after a %s decision', async (outcome) => {
    const f = await fixture()
    await f.requests.validate(f.request.requestId, f.request.epoch)
    await f.requests.commit(f.request.requestId, f.request.epoch)
    f.approveWith(() => Promise.resolve(outcome))
    expect((await f.call()).isError).toBe(true)
    expect(f.upstream).not.toHaveBeenCalled()
    expect(f.nativeAdmission).not.toHaveBeenCalled()
  },
)

it('presents a correlated MCP summary without secret argument text in the decision or audit', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  f.approveWith((approval) => {
    expect(approval).toMatchObject({ toolName: 'mcp__portal__read', callId: ToolCallId('read'), detailMode: 'summary-only' })
    expect(approval.reason).toContain('mcp__portal__read')
    expect(approval.reason).toContain('Tool arguments are hidden')
    expect(approval.reason).not.toContain('sensitive-credential-value')
    return Promise.resolve('allowed-once')
  })
  expect((await f.call(undefined, { command: 'sensitive-credential-value' })).isError).toBe(false)
  const audit = f.agent.session.snapshotEvents().filter(event => event.type.startsWith('approval/'))
  expect(audit).toHaveLength(2)
  expect(JSON.stringify(audit)).not.toContain('sensitive-credential-value')
  expect(f.upstream).toHaveBeenCalledWith({ command: 'sensitive-credential-value' }, expect.anything())
})

it('requires an open turn for auditable paired MCP consent', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  f.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect((await f.call()).isError).toBe(true)
  expect(f.approvals).not.toHaveBeenCalled()
  expect(f.upstream).not.toHaveBeenCalled()
})

it('fails closed for paired MCP work when no answerer is available', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  f.detachAnswerer()
  expect((await f.call()).isError).toBe(true)
  expect(f.upstream).not.toHaveBeenCalled()
})

it.each(['binding change', 'native refusal', 'takeover'] as const)(
  'revalidates paused MCP consent before dispatch after %s', async (change) => {
    const f = await fixture()
    await f.requests.validate(f.request.requestId, f.request.epoch)
    await f.requests.commit(f.request.requestId, f.request.epoch)
    const entered = f.barrier()
    const release = f.barrier()
    f.approveWith(async () => { entered.resolve(); await release.promise; return 'allowed-once' })
    const running = f.call()
    try {
      await entered.promise
      expect(f.upstream).not.toHaveBeenCalled()
      expect(f.nativeAdmission).not.toHaveBeenCalled()
      if (change === 'binding change') f.changeBinding()
      else if (change === 'native refusal') f.nativeAdmission.mockRejectedValueOnce(new Error('Native grant ended'))
      else f.requests.revoke(f.request.requestId)
    } finally { release.resolve() }
    expect((await running).isError).toBe(true)
    expect(f.upstream).not.toHaveBeenCalled()
    const revoked = f.requests.revoke(f.request.requestId)
    await f.requests.drain(revoked.requestId)
  },
)

it.each(['MCP', 'browser'] as const)(
  'withholds a %s observation revoked while an accepting post-execute listener is pending', async (kind) => {
    const f = await fixture()
    await f.requests.validate(f.request.requestId, f.request.epoch)
    await f.requests.commit(f.request.requestId, f.request.epoch)
    const entered = f.barrier()
    const release = f.barrier()
    const published: ToolExecutionResult[] = []
    f.ctx.on('tools/result', (_execution, result) => { published.push(result) })
    f.ctx.on('tools/post-execute', async (_execution, result, next) => {
      expect(result.isError).toBe(false)
      entered.resolve()
      await release.promise
      return next()
    })
    const running = kind === 'MCP' ? f.call() : f.browser(async () => 'private browser observation')
    await entered.promise
    const revoked = f.requests.revoke(f.request.requestId)
    await f.requests.drain(f.request.requestId)
    await f.requests.validate(revoked.requestId, revoked.epoch)
    await f.requests.commit(revoked.requestId, revoked.epoch)
    release.resolve()
    const result = await running
    expectBrowserFailure(result, 'not authorized')
    expect(published).toEqual([result])
    expect(JSON.stringify(result)).not.toContain(kind === 'MCP' ? 'observed' : 'private browser observation')
  },
)

it.each(['MCP', 'browser'] as const)(
  'withholds a %s observation when its restored wrapper signal cancels during post-execute', async (kind) => {
    const wrapper = new AbortController()
    const caller = new AbortController()
    const f = await fixture(undefined, wrapper.signal)
    await f.requests.validate(f.request.requestId, f.request.epoch)
    await f.requests.commit(f.request.requestId, f.request.epoch)
    const entered = f.barrier()
    const release = f.barrier()
    const published: ToolExecutionResult[] = []
    f.ctx.on('tools/result', (_execution, result) => { published.push(result) })
    f.ctx.on('tools/post-execute', async (_execution, result, next) => {
      expect(result.isError).toBe(false)
      entered.resolve()
      await release.promise
      return next()
    })
    const running = kind === 'MCP'
      ? f.call(caller.signal)
      : f.browser(async () => 'private browser observation', { signal: caller.signal })
    await entered.promise
    wrapper.abort(new Error('Wrapper observation permission ended'))
    release.resolve()
    const result = await running
    expectBrowserFailure(result, 'Wrapper observation permission ended')
    expect(published).toEqual([result])
    expect(JSON.stringify(result)).not.toContain(kind === 'MCP' ? 'observed' : 'private browser observation')
    expect(caller.signal.aborted).toBe(false)
    expect(f.request.signal.aborted).toBe(false)
  },
)

it.each(['native validation', 'post-execute'] as const)(
  'withholds an MCP observation when a later guard cancels during final %s', async (phase) => {
    const f = await fixture()
    await f.requests.validate(f.request.requestId, f.request.epoch)
    await f.requests.commit(f.request.requestId, f.request.epoch)
    const added = new AbortController()
    f.ctx.on('mcp/tool-call', (payload, next) => {
      payload.addCancellation(added.signal)
      return next()
    })
    const entered = f.barrier()
    const release = f.barrier()
    if (phase === 'native validation') {
      f.nativeAdmission.mockResolvedValueOnce(undefined)
      f.nativeAdmission.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
    } else {
      f.ctx.on('tools/post-execute', async (_execution, result, next) => {
        expect(result.isError).toBe(false)
        entered.resolve()
        await release.promise
        return next()
      })
    }
    const caller = new AbortController()
    const running = f.call(caller.signal)
    await entered.promise
    added.abort(new Error('Guard observation permission ended'))
    if (phase === 'native validation') expect(f.nativeAdmission.mock.calls.at(-1)?.[1].aborted).toBe(true)
    release.resolve()
    const result = await running
    expectBrowserFailure(result, 'Guard observation permission ended')
    expect(JSON.stringify(result)).not.toContain('observed')
    expect(caller.signal.aborted).toBe(false)
    const revoked = f.requests.revoke(f.request.requestId)
    await f.requests.drain(revoked.requestId)
    await f.requests.validate(revoked.requestId, revoked.epoch)
  },
)

it.each(['MCP timeout', 'MCP transport disconnected'])(
  'revokes the grant and retains the account lock for an uncancelled dispatched %s', async (failure) => {
    const f = await fixture()
    await f.requests.validate(f.request.requestId, f.request.epoch)
    await f.requests.commit(f.request.requestId, f.request.epoch)
    const caller = new AbortController()
    f.upstream.mockImplementationOnce(async (_args, execution) => {
      expect(execution.signal.aborted).toBe(false)
      throw new Error(failure)
    })
    expectBrowserFailure(await f.call(caller.signal), 'not authorized')
    expect(f.upstream).toHaveBeenCalledOnce()
    expect(caller.signal.aborted).toBe(false)
    expect(f.request.signal.aborted).toBe(true)
    const revoked = f.requests.revoke(f.request.requestId)
    await expect(f.requests.drain(revoked.requestId)).rejects.toThrow('drainage failed')
    await expect(f.requests.validate(revoked.requestId, revoked.epoch)).rejects.toThrow('incomplete')
  },
)

it.each(['MCP', 'browser'] as const)(
  'refuses fresh %s dispatch after an uncertain MCP outcome', async (kind) => {
    const f = await fixture()
    await f.requests.validate(f.request.requestId, f.request.epoch)
    await f.requests.commit(f.request.requestId, f.request.epoch)
    const caller = new AbortController()
    f.upstream.mockRejectedValueOnce(new Error('MCP timeout'))
    expect((await f.call(caller.signal)).isError).toBe(true)
    const admissions = f.nativeAdmission.mock.calls.length
    const operation = vi.fn(async () => 'private browser observation')
    const result = kind === 'MCP' ? await f.call() : await f.browser(operation)
    expectBrowserFailure(result, 'not authorized')
    expect(f.upstream).toHaveBeenCalledOnce()
    expect(f.nativeAdmission).toHaveBeenCalledTimes(admissions)
    expect(operation).not.toHaveBeenCalled()
    expect(caller.signal.aborted).toBe(false)
    expect(f.request.signal.aborted).toBe(true)
    const revoked = f.requests.revoke(f.request.requestId)
    await expect(f.requests.drain(revoked.requestId)).rejects.toThrow('drainage failed')
    await expect(f.requests.validate(revoked.requestId, revoked.epoch)).rejects.toThrow('incomplete')
  },
)

it.each(['MCP', 'browser'] as const)(
  'withholds a held %s sibling observation after another MCP dispatch has an unknown outcome', async (kind) => {
    const meta = { secret: 'private checkpoint metadata' }
    const f = await fixture(undefined, undefined, meta)
    await f.requests.validate(f.request.requestId, f.request.epoch)
    await f.requests.commit(f.request.requestId, f.request.epoch)
    const entered = f.barrier()
    const release = f.barrier()
    const caller = new AbortController()
    let holdNext = true
    f.ctx.on('tools/post-execute', async (_execution, result, next) => {
      if (!holdNext) return next()
      holdNext = false
      expect(result.isError).toBe(false)
      expect(result.meta).toEqual(meta)
      entered.resolve()
      await release.promise
      return next()
    })
    const held = kind === 'MCP' ? f.call() : f.browser(async () => 'private browser observation')
    await entered.promise
    f.upstream.mockRejectedValueOnce(new Error('MCP transport disconnected'))
    expect((await f.call(caller.signal)).isError).toBe(true)
    release.resolve()
    const result = await held
    expectBrowserFailure(result, 'not authorized')
    expect(JSON.stringify(result)).not.toContain(kind === 'MCP' ? 'observed' : 'private browser observation')
    expect(result.meta).toBeUndefined()
    expect(f.upstream).toHaveBeenCalledTimes(kind === 'MCP' ? 2 : 1)
    expect(caller.signal.aborted).toBe(false)
    expect(f.request.signal.aborted).toBe(true)
  },
)

it.each(['pre-dispatch denial', 'protocol error', 'post-response cancellation'] as const)(
  'does not retain an uncertain MCP outcome for %s', async (outcome) => {
    const f = await fixture()
    await f.requests.validate(f.request.requestId, f.request.epoch)
    await f.requests.commit(f.request.requestId, f.request.epoch)
    const caller = new AbortController()
    if (outcome === 'pre-dispatch denial') {
      f.ctx.on('mcp/tool-call', () => { throw new Error('Denied before upstream dispatch') })
    } else {
      f.upstream.mockImplementationOnce(async () => {
        if (outcome === 'post-response cancellation') caller.abort(new Error('Caller cancelled after response'))
        return { content: [], isError: outcome === 'protocol error' }
      })
    }
    expect((await f.call(caller.signal)).isError).toBe(true)
    expect(f.upstream).toHaveBeenCalledTimes(outcome === 'pre-dispatch denial' ? 0 : 1)
    const revoked = f.requests.revoke(f.request.requestId)
    await f.requests.drain(revoked.requestId)
    await f.requests.validate(revoked.requestId, revoked.epoch)
  },
)

function expectBrowserFailure(result: ToolExecutionResult, message: string): void {
  expect(result.isError).toBe(true)
  if (result.isError) expect(result.error.message).toContain(message)
}

async function linkedFixture() {
  const native = websiteAuthorityFixture()
  const f = await fixture((request) => { native.notifyRevocation(websiteHostSnapshot(request)) })
  native.control.mockImplementation(async (command) => {
    switch (command.action) {
      case 'sync': f.requests.syncProfiles(command.profiles); return undefined
      case 'validate': return websiteHostSnapshot(await f.requests.validate(command.id, command.epoch))
      case 'commit': return websiteHostSnapshot(await f.requests.commit(command.id, command.epoch))
      case 'revoke': return websiteHostSnapshot(f.requests.revoke(command.id))
      case 'drain': await f.requests.drain(command.id); return undefined
      case 'remove': await f.requests.remove(command.id); return undefined
      default: return assertNever(command)
    }
  })
  return { native, f }
}

it.each(['missing Agent', 'same Session object', 'same durable Session id'] as const)(
  'denies a fresh browser invocation with %s instead of the initiating Agent', async (kind) => {
    const f = await fixture()
    await f.requests.validate(f.request.requestId, f.request.epoch)
    const grant = await f.requests.commit(f.request.requestId, f.request.epoch)
    const agent = kind === 'missing Agent' ? undefined : kind === 'same Session object' ? { ...f.agent }
      : { ...f.agent, session: Session.create(f.agent.id) }
    const operation = vi.fn(async () => 'private browser observation')
    const result = await f.browser(operation, { agent })
    expectBrowserFailure(result, 'not authorized')
    expect(operation).not.toHaveBeenCalled()
    expect(f.nativeAdmission).not.toHaveBeenCalled()
    expect(f.notify).not.toHaveBeenCalled()
    expect(() => { f.requests.assertCurrent(grant) }).not.toThrow()
    expect(await f.browser(operation)).toMatchObject({ isError: false, value: 'private browser observation' })
  },
)

it('denies a copied execution even while its registered invocation is active', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  const operation = vi.fn(async () => 'private browser observation')
  expectBrowserFailure(await f.browser(operation, { cloneExecution: true }), 'not authorized')
  expect(operation).not.toHaveBeenCalled()
  expect(f.nativeAdmission).not.toHaveBeenCalled()
})

it('denies a settled preparation execution as authority for a new browser operation', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  const operation = vi.fn(async () => 'private browser observation')
  await expect(f.requests.run(f.preparation, f.request.requestId, f.request.epoch, operation)).rejects.toThrow('not authorized')
  expect(operation).not.toHaveBeenCalled()
  expect(f.nativeAdmission).not.toHaveBeenCalled()
})

it('denies a protected MCP executor called with an already settled execution', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  const grant = await f.requests.commit(f.request.requestId, f.request.epoch)
  await expect(f.definition.execute({}, f.preparation)).rejects.toThrow('not authorized')
  expect(f.upstream).not.toHaveBeenCalled()
  expect(f.nativeAdmission).not.toHaveBeenCalled()
  expect(f.notify).not.toHaveBeenCalled()
  expect(() => { f.requests.assertCurrent(grant) }).not.toThrow()
  expect((await f.call()).isError).toBe(false)
})

it('denies a protected MCP executor called with a copy of an active execution', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  f.ctx.tools.register({ name: 'copy-mcp', description: 'Attempt a copied invocation.', parameters: { type: 'object' },
    output: { schema: { type: 'boolean' }, render: () => [] },
    async execute(_args, execution) { await f.definition.execute({}, { ...execution }); return true },
  })
  const result = await f.ctx.tools.execute({ agent: f.agent, signal: new AbortController().signal,
    callId: ToolCallId('copy-mcp'), name: 'copy-mcp', arguments: {} })
  expectBrowserFailure(result, 'not authorized')
  expect(f.upstream).not.toHaveBeenCalled()
  expect(f.nativeAdmission).not.toHaveBeenCalled()
})

it.each(['dispatch', 'publication'] as const)(
  'retains wrapped MCP caller cancellation during native %s validation', async (phase) => {
    const f = await fixture(undefined, new AbortController().signal)
    await f.requests.validate(f.request.requestId, f.request.epoch)
    const grant = await f.requests.commit(f.request.requestId, f.request.epoch)
    const entered = f.barrier()
    const settled = f.barrier()
    const caller = new AbortController()
    if (phase === 'publication') f.nativeAdmission.mockResolvedValueOnce(undefined)
    f.nativeAdmission.mockImplementationOnce(async () => { entered.resolve(); await settled.promise })
    const running = f.call(caller.signal)
    await entered.promise
    caller.abort(new Error('MCP invocation cancelled'))
    expect(f.nativeAdmission.mock.calls.at(-1)?.[1].aborted).toBe(true)
    settled.resolve()
    const result = await running
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('observed')
    expect(f.upstream).toHaveBeenCalledTimes(phase === 'dispatch' ? 0 : 1)
    expect(() => { f.requests.assertCurrent(grant) }).not.toThrow()
  },
)

it('retains an unknown MCP outcome after wrapped current caller cancellation until physical settlement', async () => {
  const f = await fixture(undefined, new AbortController().signal)
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  const entered = f.barrier()
  const settled = f.barrier()
  const caller = new AbortController()
  f.upstream.mockImplementation(async (_args, execution) => {
    entered.resolve()
    await settled.promise
    expect(execution.signal.aborted).toBe(true)
    throw new Error('Upstream MCP cancellation did not return a response')
  })
  const running = f.call(caller.signal)
  await entered.promise
  caller.abort(new Error('MCP invocation cancelled'))
  f.requests.revoke(f.request.requestId)
  let drained = false
  const drainage = f.track(f.requests.drain(f.request.requestId).then(() => { drained = true },
    (error: unknown) => { drained = true; return error }))
  await Promise.resolve()
  expect(drained).toBe(false)
  settled.resolve()
  const result = await running
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).not.toContain('observed')
  expect(await drainage).toBeInstanceOf(AggregateError)
  await expect(f.requests.validate(f.request.requestId, f.request.epoch + 1)).rejects.toThrow('incomplete')
})

it.each(['dispatch', 'publication'] as const)('fuses current invocation cancellation into native %s validation', async (phase) => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  const entered = f.barrier()
  const settled = f.barrier()
  const caller = new AbortController()
  if (phase === 'publication') f.nativeAdmission.mockResolvedValueOnce(undefined)
  f.nativeAdmission.mockImplementationOnce(async () => { entered.resolve(); await settled.promise })
  const operation = vi.fn(async () => 'private browser observation')
  const running = f.browser(operation, { signal: caller.signal })
  await entered.promise
  caller.abort(new Error('Browser invocation cancelled'))
  const admission = f.nativeAdmission.mock.calls.at(-1)
  expect(admission?.[1].aborted).toBe(true)
  settled.resolve()
  const result = await running
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).not.toContain('private browser observation')
  expect(operation).toHaveBeenCalledTimes(phase === 'dispatch' ? 0 : 1)
})

it.each(['caller', 'dispatch wrapper'] as const)('joins physical browser settlement after current %s cancellation', async (source) => {
  const caller = new AbortController()
  const wrapper = new AbortController()
  const f = await fixture(undefined, source === 'dispatch wrapper' ? wrapper.signal : undefined)
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  const entered = f.barrier()
  const settled = f.barrier()
  let observedSignal: AbortSignal | undefined
  const running = f.browser(async (signal) => {
    observedSignal = signal
    entered.resolve()
    await settled.promise
    return 'private browser observation'
  }, { signal: caller.signal })
  await entered.promise
  if (source === 'caller') caller.abort(new Error('Browser invocation cancelled'))
  else wrapper.abort(new Error('Browser dispatch cancelled'))
  expect(observedSignal?.aborted).toBe(true)
  const revoked = f.requests.revoke(f.request.requestId)
  const drainage = f.track(f.requests.drain(revoked.requestId))
  await expect(f.requests.validate(revoked.requestId, revoked.epoch)).rejects.toThrow('incomplete')
  expect(() => { f.requests.assertDrained(revoked.requestId) }).toThrow('stale')
  settled.resolve()
  const result = await running
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).not.toContain('private browser observation')
  await drainage
  expect(() => { f.requests.assertDrained(revoked.requestId) }).not.toThrow()
})

it('denies every MCP dispatch until the complete saved inventory has initialized the guard', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const upstream = vi.fn(async () => ({ content: [{ type: 'text', text: 'ordinary result' }] }))
  const requests = installWebsiteRequests(ctx, async () => ({ identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/' }),
    () => {}, async () => {})
  ctx.tools.register(createMcpToolDefinition(ctx, { name: 'mcp__ordinary__read', serverName: 'ordinary', rawName: 'read',
    description: 'Read an ordinary server.', inputSchema: { type: 'object' }, call: upstream }))
  const call = () => ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('read'),
    name: 'mcp__ordinary__read', arguments: {} })
  expect((await call()).isError).toBe(true)
  expect(upstream).not.toHaveBeenCalled()
  requests.syncProfiles([])
  expect((await call()).isError).toBe(false)
  expect(upstream).toHaveBeenCalledOnce()
})

it('denies inactive paired namespaces and commits only a freshly validated exact owner', async () => {
  const f = await fixture()
  expect((await f.call()).isError).toBe(true)
  expect(f.upstream).not.toHaveBeenCalled()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  expect((await f.call()).isError).toBe(false)
  expect(f.upstream).toHaveBeenCalledOnce()
  expect(() => f.requests.commit(f.request.requestId, f.request.epoch)).toThrow('Validate')
  f.requests.revoke(f.request.requestId)
  await f.requests.drain(f.request.requestId)
  expect((await f.call()).isError).toBe(true)
})

it('cannot unguard an enrolled namespace through removed or stale empty inventory', async () => {
  const f = await fixture()
  f.requests.syncProfiles([])
  expect((await f.call()).isError).toBe(true)
  expect(f.upstream).not.toHaveBeenCalled()
  expect(f.notify).toHaveBeenCalledOnce()
})

it('cannot regrant a request to a replacement Agent sharing the same durable Session id', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  f.detachAgent()
  const replacement = { ...f.agent, session: Session.create(f.agent.id) }
  f.ctx.agents.enter(replacement, undefined)
  expectBrowserFailure(await f.browser(async () => 'private'), 'not authorized')
  expect(f.notify).toHaveBeenCalledOnce()
  expect((await f.call()).isError).toBe(true)
  expect(f.upstream).not.toHaveBeenCalled()
})

it('revokes immediately on owner disposal while the original Agent is still registered', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  f.notify.mockImplementation(() => { expect(f.ctx.agents.get(f.agent.id)).toBe(f.agent) })
  await f.owner.dispose()
  expect(f.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ terminal: true, status: 'revoked' }))
  expect((await f.call()).isError).toBe(true)
  expect(f.upstream).not.toHaveBeenCalled()
  expect(() => f.requests.validate(f.request.requestId, f.request.epoch + 1)).toThrow('not authorized')
})

it('checks current native authority before dispatch and refuses observation after native loss', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  f.nativeAdmission.mockRejectedValue(new Error('Native page is hidden'))
  expect((await f.call()).isError).toBe(true)
  expect(f.upstream).not.toHaveBeenCalled()
  expect(f.notify).toHaveBeenCalledOnce()
  await f.requests.drain(f.request.requestId)
})

it('withholds a completed MCP observation when native authority disappears before publication', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  f.nativeAdmission.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Native page is hidden'))
  const result = await f.call()
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).not.toContain('observed')
  expect(f.upstream).toHaveBeenCalledOnce()
  expect(f.nativeAdmission).toHaveBeenCalledTimes(2)
})

it('withholds a browser result when revocation overtakes the final native admission reply', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  const revoke = vi.fn(() => f.requests.revoke(f.request.requestId))
  f.nativeAdmission.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    queueMicrotask(() => { queueMicrotask(() => { queueMicrotask(revoke) }) })
  })
  const result = await f.browser(async () => 'withheld browser observation')
  expectBrowserFailure(result, 'not authorized')
  expect(JSON.stringify(result)).not.toContain('withheld browser observation')
  expect(revoke).toHaveBeenCalledOnce()
  await f.requests.drain(f.request.requestId)
})

it('withholds an MCP result when revocation overtakes the final native admission reply', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  const revoke = vi.fn(() => f.requests.revoke(f.request.requestId))
  f.nativeAdmission.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    queueMicrotask(() => { queueMicrotask(() => { queueMicrotask(revoke) }) })
  })
  const result = await f.call()
  expect(revoke).toHaveBeenCalledOnce()
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).not.toContain('observed')
  expect(f.upstream).toHaveBeenCalledOnce()
  await f.requests.drain(f.request.requestId)
})

it('joins asynchronous revocation delivery and blocks failed delivery from releasing account locks', async () => {
  const f = await fixture()
  const delivery = f.barrier()
  f.notify.mockImplementation(() => delivery.promise)
  f.requests.revoke(f.request.requestId)
  const drainage = f.requests.drain(f.request.requestId)
  const rejected = expect(drainage).rejects.toThrow('drainage failed')
  delivery.reject(new Error('Parent IPC write failed'))
  await rejected
  await expect(f.requests.remove(f.request.requestId)).rejects.toThrow('Drain')
})

it('permits only a current revoked receipt to finish cleanup after its original caller cancels', async () => {
  const f = await fixture()
  f.caller.abort()
  const revoked = f.requests.revoke(f.request.requestId)
  expect(() => { f.requests.assertCurrent(revoked) }).not.toThrow()
  await f.requests.drain(f.request.requestId)
  expect(() => { f.requests.assertDrained(f.request.requestId) }).not.toThrow()
  await f.requests.remove(f.request.requestId)
  expect(() => { f.requests.assertCurrent(revoked) }).toThrow('not authorized')
})

it('retains original caller cancellation after a wrapped preparation tool returns', async () => {
  const wrapper = new AbortController()
  const f = await fixture(undefined, wrapper.signal)
  f.caller.abort('cancel returned preparation')
  expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ requestId: f.request.requestId, status: 'revoked', terminal: true }))
  await f.requests.drain(f.request.requestId)
  expect(() => f.requests.validate(f.request.requestId, f.request.epoch)).toThrow('not authorized')
  expect(wrapper.signal.aborted).toBe(false)
})

it.each(['wrapper cancellation', 'body failure', 'post-dispatch denial'])('terminates unfinished preparation after %s without cancelling a settled request', async (failure) => {
  const wrapper = new AbortController()
  const f = await fixture(undefined, wrapper.signal)
  const entered = Promise.withResolvers<WebsiteRequestSnapshot>()
  const release = f.barrier()
  f.ctx.on('tools/post-execute', (execution, _result, next) => failure === 'post-dispatch denial' && execution.name === 'unfinished'
    ? Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: 'Preparation denied' }] }) : next())
  f.ctx.tools.register({ name: 'unfinished', description: 'Capture unfinished preparation.', parameters: { type: 'object' },
    output: { schema: { type: 'boolean' }, render: () => [] },
    async execute(_args, execution) {
      entered.resolve(f.requests.create(execution, f.profile))
      await release.promise
      if (failure === 'body failure') throw new Error('Preparation failed')
      return true
    },
  })
  const preparing = f.track(f.ctx.tools.execute({ agent: f.agent, signal: new AbortController().signal,
    callId: ToolCallId('unfinished'), name: 'unfinished', arguments: {} }))
  const captured = await entered.promise
  expect(() => f.requests.validate(captured.requestId, captured.epoch)).toThrow('preparation has not settled')
  if (failure === 'wrapper cancellation') wrapper.abort('timeout during preparation')
  release.resolve()
  expect((await preparing).isError).toBe(true)
  expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ requestId: captured.requestId, status: 'revoked', terminal: true }))
  expect(() => f.requests.validate(captured.requestId, captured.epoch)).toThrow('not authorized')
  await expect(f.requests.validate(f.request.requestId, f.request.epoch)).resolves.toMatchObject({ status: 'pending' })
})

it('refuses request creation from a copied execution instead of the registered invocation', async () => {
  const f = await fixture()
  f.ctx.tools.register({ name: 'copy-prepare', description: 'Attempt a copied invocation.', parameters: { type: 'object' },
    output: { schema: { type: 'boolean' }, render: () => [] },
    async execute(_args, execution) { f.requests.create({ ...execution }, f.profile); return true },
  })
  const result = await f.ctx.tools.execute({ agent: f.agent, signal: new AbortController().signal,
    callId: ToolCallId('copy-prepare'), name: 'copy-prepare', arguments: {} })
  expect(result).toMatchObject({ isError: true, error: { message: 'Website request is not authorized for this owner and generation' } })
})

it('removes original caller cancellation when a wrapped request is retired', async () => {
  const f = await fixture(undefined, new AbortController().signal)
  f.requests.revoke(f.request.requestId)
  await f.requests.drain(f.request.requestId)
  await f.requests.remove(f.request.requestId)
  f.notify.mockClear()
  f.caller.abort('cancel removed request')
  expect(f.notify).not.toHaveBeenCalled()
})

it('marks cancellation terminal even after reversible revocation already drained', async () => {
  const f = await fixture()
  const hidden = f.requests.revoke(f.request.requestId)
  expect(hidden.terminal).toBeUndefined()
  await f.requests.drain(f.request.requestId)
  f.caller.abort()
  const terminal = f.requests.revoke(f.request.requestId)
  expect(terminal).toMatchObject({ terminal: true, epoch: hidden.epoch + 1 })
  expect(() => { f.requests.assertCurrent(hidden) }).toThrow('not authorized')
  await f.requests.drain(f.request.requestId)
  expect(() => f.requests.validate(terminal.requestId, terminal.epoch)).toThrow('not authorized')
  await f.requests.remove(terminal.requestId)
})

it.each(['captured', 'prepared', 'granted'])('settles real Host owner disposal across Main authority from %s', async (phase) => {
  const { native, f } = await linkedFixture()
  const request = websiteHostSnapshot(f.request)
  native.prepare(request)
  if (phase !== 'captured') {
    const receipt = native.authority.prepare(native.owner, request.id, native.lease)
    if (phase === 'granted') await native.authority.requests.resume(native.owner, receipt)
  }
  const removed: PromiseWithResolvers<void> = Promise.withResolvers()
  const detach = native.authority.subscribe(() => {
    if (!native.authority.list(request.sessionId).some(item => item.id === request.id)) removed.resolve()
  })
  onTestFinished(detach)
  await f.owner.dispose()
  await removed.promise
  expect(native.control).toHaveBeenCalledWith({ action: 'remove', id: request.id })
  expect(() => { f.requests.assertCurrent(f.request) }).toThrow('not authorized')
  expect(native.authority.list(request.sessionId)).toEqual([])
})

it.each(['owner disposal', 'execution cancellation'])('retains granted Main and Host requests through native settlement after %s', async (transition) => {
  const { native, f } = await linkedFixture()
  const request = websiteHostSnapshot(f.request)
  native.prepare(request)
  const receipt = native.authority.prepare(native.owner, request.id, native.lease)
  await native.authority.requests.resume(native.owner, receipt)
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const settled = f.barrier()
  const revoked: PromiseWithResolvers<void> = Promise.withResolvers()
  const removed: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(native.authority.subscribe(() => {
    const requests = native.authority.list(request.sessionId)
    if (requests.some(saved => saved.terminal === true)) revoked.resolve()
    if (requests.length === 0) removed.resolve()
  }))
  const running = f.browser(operationSignal => native.authority.requests.run(
    native.host, request.id, operationSignal, async (_guest, signal) => {
      entered.resolve()
      await settled.promise
      expect(signal.aborted).toBe(true)
    },
  ))
  const rejected = f.track(running.then((result) => { expectBrowserFailure(result, 'not authorized') }))
  await entered.promise
  let disposal: Promise<void> | undefined
  if (transition === 'execution cancellation') f.caller.abort()
  else disposal = f.owner.dispose()
  await revoked.promise
  expect(native.authority.list(request.sessionId)).toMatchObject([{ status: 'revoked', terminal: true }])
  expect(() => { native.authority.requests.assertGranted(native.host, request.id) }).toThrow()
  expect(native.control).not.toHaveBeenCalledWith({ action: 'remove', id: request.id })
  settled.resolve()
  await rejected
  await disposal
  await removed.promise
  expect(native.authority.list(request.sessionId)).toEqual([])
  expect(() => { f.requests.assertCurrent(f.request) }).toThrow('not authorized')
})

it('refuses retained grant and drain responses after revocation or renewal', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  const granted = await f.requests.commit(f.request.requestId, f.request.epoch)
  expect(() => { f.requests.assertCurrent(granted) }).not.toThrow()
  f.requests.revoke(f.request.requestId)
  expect(() => { f.requests.assertCurrent(granted) }).toThrow('not authorized')
  await f.requests.drain(f.request.requestId)
  expect(() => { f.requests.assertDrained(f.request.requestId) }).not.toThrow()
  await f.requests.validate(f.request.requestId, f.request.epoch + 1)
  expect(() => { f.requests.assertDrained(f.request.requestId) }).toThrow('stale')
})

it('rechecks binding at commit rather than reusing earlier inspection', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  f.changeBinding()
  await expect(f.requests.commit(f.request.requestId, f.request.epoch)).rejects.toThrow('pairing changed')
  expect((await f.call()).isError).toBe(true)
  expect(f.upstream).not.toHaveBeenCalled()
})

it('retains failed notification even when an abort observer reenters drainage synchronously', async () => {
  const f = await fixture()
  const signal = (await f.requests.validate(f.request.requestId, f.request.epoch)).signal
  let joined: Promise<void> | undefined
  signal.addEventListener('abort', () => { joined = f.requests.drain(f.request.requestId); void joined.catch(() => {}) })
  f.notify.mockImplementation(() => { throw new Error('Main notification failed') })
  expect(() => f.requests.revoke(f.request.requestId)).toThrow('Main notification failed')
  await expect(joined).rejects.toThrow('drainage failed')
  await expect(f.requests.drain(f.request.requestId)).rejects.toThrow('drainage failed')
  await expect(f.requests.validate(f.request.requestId, f.request.epoch + 1)).rejects.toThrow('incomplete')
})

it.each(['takeover', 'owner cancellation'])('keeps interrupted MCP outcomes locked after %s', async (transition) => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const settled = f.barrier()
  f.upstream.mockImplementation(async () => {
    entered.resolve()
    await settled.promise
    throw new Error('Upstream MCP cancellation did not return a response')
  })
  const running = f.call()
  await entered.promise
  if (transition === 'owner cancellation') f.caller.abort()
  const revoked = f.requests.revoke(f.request.requestId)
  expect(revoked.terminal).toBe(transition === 'owner cancellation' ? true : undefined)
  settled.resolve()
  expect((await running).isError).toBe(true)
  await expect(f.requests.drain(f.request.requestId)).rejects.toThrow('drainage failed')
  await expect(f.requests.remove(f.request.requestId)).rejects.toThrow('Drain')
})

it('keeps the deny guard installed while native work physically drains during teardown', async () => {
  const f = await fixture()
  await f.requests.validate(f.request.requestId, f.request.epoch)
  await f.requests.commit(f.request.requestId, f.request.epoch)
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const settled = f.barrier()
  const running = f.browser(async () => { entered.resolve(); await settled.promise })
  const rejected = f.track(running.then((result) => { expectBrowserFailure(result, 'not authorized') }))
  await entered.promise
  const stopping = f.ctx.fiber.dispose()
  expect((await f.call()).isError).toBe(true)
  expect(f.upstream).not.toHaveBeenCalled()
  settled.resolve()
  await rejected
  await stopping
})
