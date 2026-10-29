import { LlmError, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Agent, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime, { settleRun, snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { maxTokensResponse, MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startInProcessRun } from '../src/index.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'late-metadata': { kind: 'late-metadata' } & ContextFormed
  }
}

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function setup(script: Script, parentOptions: Partial<AgentOptions> = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock', ...parentOptions })
  return { ctx, parent, adapter }
}

function request(parent: Agent, signal = new AbortController().signal) {
  return {
    cwd: parent.ctx.get('workingDirectory')!.get(parent.session),
    label: 'child task',
    prompt: [{ type: 'text' as const, text: 'child task' }],
    parent,
    signal,
    descriptor: snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: 'test',
      label: 'child task',
    }),
  }
}

function text(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('startInProcessRun', () => {
  it.each(['AUTH', 'Bearer private-canary'])('retains safe failure routing for %s before the first response', async (code) => {
    const { parent } = await setup([() => {
      throw new LlmError('private-canary provider body', code, { status: 401 })
    }])
    const run = await startInProcessRun(request(parent), {})
    const outcome = await settleRun(run)
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain(JSON.stringify({ childSessionId: run.id, phase: 'turn',
      code: code === 'AUTH' ? 'AUTH' : 'UNKNOWN', status: 401 }))
    expect(outcome.detail).not.toContain('private-canary')
    expect(outcome.result).toBeUndefined()
  })

  it('captures the parent execution directory without replacing original project authority or following later changes', async () => {
    const { ctx } = await setup([textResponse('directory inherited')])
    const selected = await realpath(await mkdtemp(join(tmpdir(), 'subagent-directory-')))
    onTestFinished(() => rm(selected, { recursive: true, force: true }))
    const origin = process.cwd()
    const parent = await ctx.agentLoop.create(SessionId('directory-parent'), { provider: 'mock', model: 'mock' }, { cwd: origin })
    await ctx.workingDirectory.set(parent, selected)
    const run = await startInProcessRun(request(parent), {})
    try {
      const child = ctx.agents.get(run.id)!
      expect(child.session.header.cwd).toBe(origin)
      expect(ctx.workingDirectory.get(child.session)).toBe(selected)
      await ctx.workingDirectory.set(parent, origin)
      expect(ctx.workingDirectory.get(child.session)).toBe(selected)
      expect(parent.session.header.cwd).toBe(origin)
      await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    } finally {
      await run.dispose()
    }
  })

  it('returns only after publication, drives a fresh child, and disposes it', async () => {
    const { ctx, parent } = await setup([textResponse('driver answer')])
    const run = await startInProcessRun(request(parent), {})
    expect(ctx.agents.get(run.id)).toBeDefined()
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('driver answer')
    expect(ctx.agents.get(run.id)!.options.subagentDepth).toBe(1)
    await run.dispose()
    await run.dispose()
    expect(ctx.agents.get(run.id)).toBeUndefined()
  })

  it('uses explicit child model selectors when the parent has none and preserves its cwd', async () => {
    const { ctx } = await setup([textResponse('driver answer')])
    const parent = await ctx.agentLoop.create(SessionId('bare-parent'), {}, { cwd: process.cwd() })
    const run = await startInProcessRun({
      ...request(parent),
      agentOptions: { provider: 'mock', model: 'mock' },
    }, {})

    const child = ctx.agents.get(run.id)!
    expect(child.options).toMatchObject({ provider: 'mock', model: 'mock' })
    expect(child.session.header.cwd).toBe(process.cwd())
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    await run.dispose()
  })

  it('reports a prompt a pre-step rejection discarded as refusal, not completion', async () => {
    const { ctx, parent } = await setup([])
    // A UserPromptSubmit deny or a policy plugin: the child claims its prompt,
    // the rejection discards it, and the turn closes `blocked` with no step.
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject === parent) return next()
      return { kind: 'reject' as const }
    })

    const run = await startInProcessRun(request(parent), {})
    await expect(run.result).resolves.toMatchObject({ stopReason: 'refusal' })
    await run.dispose()
  })

  it('does not add a final durability checkpoint to a foreground run', async () => {
    const { ctx, parent } = await setup([textResponse('driver answer')])
    let flushes = 0
    ctx.on('session/flush', (session) => {
      if (session.header.parentSession === undefined) return
      flushes++
      throw new Error('disk full')
    })

    const run = await startInProcessRun(request(parent), {})
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(flushes).toBe(0)
    await run.dispose()
  })

  it('keeps published run and handle disposal failures on separate channels', async () => {
    const { ctx, parent } = await setup([])
    const runError = new Error('published run failed')
    const disposalError = new Error('published handle disposal failed')
    const beforeAgents = ctx.agents.list().length
    const beforeSessions = ctx.sessions.list().length
    const create = ctx.agents.create.bind(ctx.agents)
    const creation = vi.spyOn(ctx.agents, 'create').mockImplementation(async (options) => {
      const handle = await create(options)
      handle.agent.followup = () => { throw runError }
      return {
        ...handle,
        dispose: async () => {
          await handle.dispose()
          throw disposalError
        },
      }
    })
    onTestFinished(() => { creation.mockRestore() })

    const run = await startInProcessRun(request(parent), {})
    expect(ctx.agents.get(run.id)).toBeDefined()
    await expect(run.result).rejects.toBe(runError)
    await expect(run.dispose()).rejects.toBe(disposalError)
    expect(ctx.agents.list()).toHaveLength(beforeAgents)
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
  })
  it('reports the turn outcome when later metadata is appended during flush', async () => {
    const { ctx, parent } = await setup([maxTokensResponse('partial answer')])
    let injected = false
    ctx.on('session/flush', (session) => {
      if (injected || session.header.parentSession === undefined) return
      const lastEnd = session.snapshotEvents().findLast(event => event.type === 'turn/end')
      if (lastEnd?.type !== 'turn/end' || lastEnd.data.reason.kind !== 'max-tokens') return
      injected = true
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'late metadata' }],
        source: { kind: 'late-metadata' },
      }), { surfaceOp: 'append' })
    })

    const run = await startInProcessRun(request(parent), {})
    const result = await run.result
    const child = ctx.agents.get(run.id)!

    expect(injected).toBe(false)
    expect(child.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'max-tokens' } } })
    expect(result.stopReason).toBe('max-tokens')
    await run.dispose()
  })

  it('keeps earlier streamed text when the final step appends an empty usage-only message', async () => {
    // A tool-only max-tokens step records an empty assistant/message for
    // usage. The result retains the preceding assistant output.
    const { ctx, parent } = await setup([
      toolCallResponse('t1', 'noop', {}, 'partial one'),
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: ToolCallId('t2'), name: 'noop', argumentsDelta: '{}' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('t2'), name: 'noop', arguments: '{}' } },
        { type: 'usage', usage: { inputTokens: 20, outputTokens: 5 } },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
    ])
    const disposeNoop = ctx.tools.register(defineContentToolFixture({
      name: 'noop', description: 'probe', parameters: {},
      execute() { return Promise.resolve([{ type: 'text', text: 'noop result' }]) },
    }))
    const run = await startInProcessRun(request(parent), {})
    const result = await run.result
    expect(result.stopReason).toBe('max-tokens')
    expect(text(result.output)).toBe('partial one')
    await run.dispose()
    disposeNoop()
  })

  it('seeds a forked child but reads only the child-owned output', async () => {
    const { ctx, parent } = await setup([textResponse('parent answer'), textResponse('child answer')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent question' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const seed = parent.session.snapshotEvents()
    const run = await startInProcessRun(request(parent), { seed })
    const result = await run.result
    expect(text(result.output)).toBe('child answer')
    const child = ctx.agents.get(run.id)!
    expect(child.session.header.isSeeded).toBe(true)
    expect(child.session.inheritedEventCount).toBe(seed.length)
    expect(child.session.snapshotEvents().slice(0, seed.length)).toEqual(seed)
    // The seeded `system/message` stays surface node 0: the child renders the
    // same prompt, so its loop appends no second system node.
    const seededSystem = seed.find(event => event.type === 'system/message')
    expect(seededSystem).toBeDefined()
    expect(child.session.snapshotEvents().filter(event => event.type === 'system/message')).toHaveLength(1)
    expect(child.session.surface.nodes[0]).toBe(seededSystem?.seq)
    expect(child.session.deriveMessages()[0]).toEqual(parent.session.deriveMessages()[0])
    await run.dispose()
  })

  it('replaces a seeded system node in place when the forked child renders a different prompt', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('parent answer'), textResponse('child answer')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent question' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const seed = parent.session.snapshotEvents()
    const seededSystem = seed.find(event => event.type === 'system/message')
    if (seededSystem === undefined) throw new Error('the parent log lacks a system node')
    ctx.systemPrompt.section({ name: 'test:after-fork', order: 10, text: 'Registered after the fork seed.' })

    const run = await startInProcessRun(request(parent), { seed })
    await run.result
    const child = ctx.agents.get(run.id)!
    const systemNodes = child.session.snapshotEvents().filter(event => event.type === 'system/message')
    expect(systemNodes.map(event => event.seq)).toEqual([seededSystem.seq, systemNodes[1]?.seq])
    expect(systemNodes[1]?.surfaceOp).toEqual({ op: 'replace', startSeq: seededSystem.seq, endSeq: seededSystem.seq })
    expect(systemNodes[1]?.sourceEventSeqs).toEqual([seededSystem.seq])
    expect(child.session.surface.nodes[0]).toBe(systemNodes[1]?.seq)
    const childRequest = adapter.requests.at(-1)!
    expect(childRequest.system).toBeUndefined()
    expect(childRequest.messages[0]?.role).toBe('system')
    expect(text(childRequest.messages[0]?.content ?? [])).toContain('Registered after the fork seed.')
    await run.dispose()
  })

  it('persists the child origin and depth in its session header', async () => {
    const { ctx, parent } = await setup([textResponse('child answer')])
    const run = await startInProcessRun(request(parent), {})
    await run.result
    // The recursion budget is durable session data, not only runtime options —
    // a depth that lived only in AgentOptions would reset to 0 on resume.
    expect(ctx.agents.get(run.id)!.session.header).toMatchObject({
      origin: 'subagent',
      delegationDepth: 1,
    })
    await run.dispose()
  })

  it('inherits the parent output-token cap and accepts an explicit child override', async () => {
    const { ctx, parent, adapter } = await setup(
      [textResponse('inherited'), textResponse('overridden')],
      { maxTokens: 111 },
    )
    const inherited = await startInProcessRun(request(parent), {})
    await inherited.result
    expect(adapter.requests[0]?.maxTokens).toBe(111)
    expect(ctx.agents.get(inherited.id)?.options.maxTokens).toBe(111)
    await inherited.dispose()

    const overridden = await startInProcessRun({
      ...request(parent),
      agentOptions: { maxTokens: 222 },
    }, {})
    await overridden.result
    expect(adapter.requests[1]?.maxTokens).toBe(222)
    expect(ctx.agents.get(overridden.id)?.options.maxTokens).toBe(222)
    await overridden.dispose()
  })

  it('counts a RESUMED child by its persisted header depth, not the absent runtime depth', async () => {
    // Resume rebuilds runtime options, so the durable header must keep this
    // depth-1 child from delegating as though it were top-level.
    const { ctx } = await setup([textResponse('unused')])
    const resumed = (await ctx.agents.create({
      sessionId: SessionId('resumed-child'),
      meta: { parentSession: SessionId('root'), delegationDepth: 1 },
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: new AbortController().signal,
    })).agent
    await expect(startInProcessRun({ ...request(resumed), maxDepth: 1 }, {}))
      .rejects.toMatchObject({ name: 'SubagentDepthError', attemptedDepth: 2, maxDepth: 1 })
  })

  it('lets runtime options deepen but never lower the persisted depth', async () => {
    const { ctx } = await setup([textResponse('unused')])
    const parent = (await ctx.agents.create({
      sessionId: SessionId('deep-parent'),
      meta: { delegationDepth: 2 },
      agentOptions: { provider: 'mock', model: 'mock', subagentDepth: 1 },
      signal: new AbortController().signal,
    })).agent
    // Persisted 2 vs runtime 1: the child is depth 3, so maxDepth 2 rejects.
    await expect(startInProcessRun({ ...request(parent), maxDepth: 2 }, {}))
      .rejects.toMatchObject({ name: 'SubagentDepthError', attemptedDepth: 3, maxDepth: 2 })
  })

  it('rejects invalid and exceeded depth before publication', async () => {
    const { ctx, parent } = await setup([])
    await expect(startInProcessRun({ ...request(parent), maxDepth: -1 }, {}))
      .rejects.toThrow('non-negative safe integer')
    await expect(startInProcessRun({ ...request(parent), maxDepth: 0 }, {}))
      .rejects.toMatchObject({ name: 'SubagentDepthError' })
    const invalidDepths = [Number.NaN, 1.5, -1, -0, Number.MAX_SAFE_INTEGER + 1]
    for (const [index, value] of invalidDepths.entries()) {
      const malformed = await ctx.agentLoop.create(SessionId(`invalid-depth-${index}`), { subagentDepth: value })
      await expect(startInProcessRun(request(malformed), {}))
        .rejects.toThrow('agent subagentDepth must be a non-negative safe integer')
    }
    const maxParent = await ctx.agentLoop.create(SessionId('max-depth'), { subagentDepth: Number.MAX_SAFE_INTEGER })
    await expect(startInProcessRun(request(maxParent), {})).rejects.toBeInstanceOf(RangeError)
  })

  it('rejects an already-aborted request without publishing a child', async () => {
    const { ctx, parent } = await setup([])
    const beforeAgents = ctx.agents.list().length
    const beforeSessions = ctx.sessions.list().length
    const controller = new AbortController()
    controller.abort('too late')
    await expect(startInProcessRun(request(parent, controller.signal), {}))
      .rejects.toThrow('aborted before child publication')
    expect(ctx.agents.list()).toHaveLength(beforeAgents)
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
  })

  it('stamps only the resolved depth when neither parent nor request declares a model route', async () => {
    // The one-shot analogue of the deleted resume coverage ("resumes without
    // inventing undeclared agent model options"): a bare parent with no request
    // agentOptions yields a child whose options carry ONLY the stamped depth —
    // no provider/model is fabricated, so the child's turn errors for want of a
    // route rather than silently adopting one.
    const { ctx } = await setup([])
    const parent = await ctx.agentLoop.create(SessionId('routeless-parent'), {})
    const run = await startInProcessRun(request(parent), {})
    const child = ctx.agents.get(run.id)!
    expect(child.options).toEqual({ subagentDepth: 1 })
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
    await run.dispose()
  })

  it.each(['error', 'max-tokens', 'refusal', 'completed'] as const)(
    'preserves a recorded %s when cancellation arrives at the idle notification', async (reason) => {
      const script = reason === 'max-tokens' ? [maxTokensResponse('partial answer')]
        : reason === 'completed' ? [textResponse('finished answer')] : []
      const { ctx, parent } = await setup(script)
      onTestFinished(async () => { await ctx.fiber.dispose() })
      const beforeAgents = ctx.agents.list().length
      const beforeSessions = ctx.sessions.list().length
      const controller = new AbortController()
      if (reason === 'refusal') {
        ctx.on('agent/pre-step', async ({ agent: subject }, next) => subject === parent
          ? next() : { kind: 'reject' as const })
      }
      ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject !== parent && status === 'idle') controller.abort('late cancellation')
      })
      const run = await startInProcessRun(request(parent, controller.signal), {})
      await expect(run.result).resolves.toMatchObject({ stopReason: reason })
      expect(controller.signal.aborted).toBe(true)
      const terminal = ctx.agents.get(run.id)!.session.snapshotEvents().findLast(event => event.type === 'turn/end')
      expect(terminal?.type === 'turn/end' && terminal.data.reason.kind).toBe(reason === 'refusal' ? 'blocked' : reason)
      expect((await settleRun(run)).status).toBe(reason === 'completed' ? 'completed' : 'failed')
      expect(ctx.agents.get(run.id)).toBeUndefined()
      expect(ctx.agents.list()).toHaveLength(beforeAgents)
      expect(ctx.sessions.list()).toHaveLength(beforeSessions)
    },
  )

  it('uses the request signal after publication and dispose as cancellation paths', async () => {
    const { parent, adapter } = await setup(['hang', 'hang'])
    const controller = new AbortController()
    const signalled = await startInProcessRun(request(parent, controller.signal), {})
    await new Promise(resolve => setTimeout(resolve, 30))
    controller.abort('stop child')
    // No step completed a message, so the text streamed before the abort is
    // the cancelled run's output.
    await expect(signalled.result).resolves.toEqual({
      output: [{ type: 'text', text: 'partial' }],
      stopReason: 'aborted',
    })
    expect(adapter.requests[0]?.signal?.reason).toEqual({ kind: 'parent' })
    const child = parent.ctx.agents.get(signalled.id)
    const turnEnd = child?.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'parent' } })
    await signalled.dispose()

    const disposed = await startInProcessRun(request(parent), {})
    await new Promise(resolve => setTimeout(resolve, 30))
    await disposed.dispose()
    await expect(disposed.result).resolves.toMatchObject({ stopReason: 'aborted' })
  })

  it('cleans a failed unpublished setup before rejecting', async () => {
    const { ctx, parent } = await setup([])
    const beforeAgents = ctx.agents.list().length
    const beforeSessions = ctx.sessions.list().length
    await expect(startInProcessRun({
      ...request(parent),
      toolFilter: { deny: ['unknown-tool'] },
    }, {})).rejects.toThrow('unknown global tool')
    expect(ctx.agents.list()).toHaveLength(beforeAgents)
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
  })

  it('treats abort after factory publication as a cancelled run with an id', async () => {
    const { ctx, parent } = await setup([])
    const controller = new AbortController()
    const beforeAgents = ctx.agents.list().length
    const beforeSessions = ctx.sessions.list().length
    const create = ctx.agents.create.bind(ctx.agents)
    const creation = vi.spyOn(ctx.agents, 'create').mockImplementation(async (options) => {
      const handle = await create(options)
      // Publication has detached its creation-only listener; the run has not yet installed its live listener.
      controller.abort('handoff race')
      return handle
    })
    onTestFinished(() => { creation.mockRestore() })
    const run = await startInProcessRun(request(parent, controller.signal), {})
    expect(ctx.agents.get(run.id)).toBeDefined()
    await expect(run.result).resolves.toEqual({ output: [], stopReason: 'aborted' })
    await run.dispose()
    expect(ctx.agents.list()).toHaveLength(beforeAgents)
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
  })
})
