import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import Approval from '@deepseek-ai/dsh-user-approval'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startInProcessRun } from '../src/index.ts'

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-child-directory-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const seedDir = join(root, 'seed')
  const capturedDir = join(root, 'captured')
  const laterDir = join(root, 'later')
  await Promise.all([seedDir, capturedDir, laterDir].map(path => mkdir(path)))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(SandboxedFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory, {})
  await ctx.plugin(Approval)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('first turn done'), textResponse('child done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
  return { ctx, parent, root, seedDir, capturedDir, laterDir, adapter }
}

function request(parent: Agent, signal = new AbortController().signal) {
  return {
    parent,
    signal,
    prompt: [{ type: 'text' as const, text: 'child task' }],
    descriptor: snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'spawn' }),
  }
}

describe('one-shot directory capture', () => {
  it.each(['spawn', 'fork'] as const)('captures committed cwd synchronously for %s while a parent change is pending', async (mode) => {
    const { ctx, parent, root, seedDir, capturedDir, laterDir } = await setup()
    await ctx.workingDirectory.set(parent, seedDir)
    if (mode === 'fork') {
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'seed work' }], source: { kind: 'user' } }))
      await parent.whenIdle()
    }
    const seed = mode === 'fork' ? parent.session.snapshotEvents() : undefined
    await ctx.workingDirectory.set(parent, capturedDir)
    setSandboxMode(parent.session, 'read-only')
    const parentLogLength = parent.session.snapshotEvents().length
    const parentEntered = Promise.withResolvers<undefined>()
    const releaseParent = Promise.withResolvers<undefined>()
    const childEntered = Promise.withResolvers<undefined>()
    const releaseChild = Promise.withResolvers<undefined>()
    const stat = ctx.fs.stat.bind(ctx.fs)
    const interception = vi.spyOn(ctx.fs, 'stat').mockImplementation(async (target, signal) => {
      if (ctx.fs.processPath(target) === laterDir) {
        parentEntered.resolve(undefined)
        await releaseParent.promise
      } else {
        childEntered.resolve(undefined)
        await releaseChild.promise
      }
      return stat(target, signal)
    })
    const reads = vi.spyOn(ctx.workingDirectory, 'get')
    const changing = ctx.workingDirectory.set(parent, laterDir)
    await parentEntered.promise
    reads.mockClear()
    const starting = startInProcessRun(request(parent), seed === undefined ? {} : { seed })
    const settled = starting.then(run => ({ run }), (error: unknown) => ({ error }))
    try {
      expect(reads.mock.calls.some(([session]) => session === parent.session)).toBe(true)
      await childEntered.promise
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
      releaseParent.resolve(undefined)
      await changing
      expect(ctx.workingDirectory.get(parent.session)).toBe(laterDir)
      setSandboxMode(parent.session, 'danger-full-access')
      releaseChild.resolve(undefined)
      const run = await starting
      try {
        const child = run.localAgent
        if (child === undefined) throw new Error('in-process run has no child')
        expect(child.session.header.cwd).toBe(root)
        expect(child.session.header.isSeeded).toBe(mode === 'fork')
        expect(ctx.workingDirectory.get(child.session)).toBe(capturedDir)
        expect(ctx.sandboxPolicy.resolve({ session: child.session })).toMatchObject({ mode: 'read-only', workspaceRoot: root })
        expect(ctx.approval.overrideOf(child.session)).toBe('never')
        const own = child.session.snapshotEvents().slice(seed?.length ?? 0)
        const installed = own.findIndex(event => event.type === 'working-directory/change' && event.data.cwd === capturedDir)
        expect(installed).toBeGreaterThan(own.findIndex(event => event.type === 'approval/policy'))
        await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
        expect(parent.session.snapshotEvents().slice(parentLogLength).filter(event => event.type === 'working-directory/change'))
          .toMatchObject([{ data: { cwd: laterDir } }])
      } finally {
        await run.dispose()
      }
    } finally {
      releaseParent.resolve(undefined)
      releaseChild.resolve(undefined)
      await changing
      const outcome = await settled
      if ('run' in outcome) await outcome.run.dispose()
      interception.mockRestore()
      reads.mockRestore()
    }
  })

  it.each(['missing', 'cancelled'] as const)('does not publish or accept input when captured child directory installation is %s', async (failure) => {
    const { ctx, parent, capturedDir, adapter } = await setup()
    await ctx.workingDirectory.set(parent, capturedDir)
    const beforeSessions = ctx.sessions.list()
    const beforeEvents = parent.session.snapshotEvents()
    const published: string[] = []
    const accepted: string[] = []
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) published.push(agent.id)
    })
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent !== parent && message.source.kind === 'user') accepted.push(agent.id)
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const stat = ctx.fs.stat.bind(ctx.fs)
    const interception = vi.spyOn(ctx.fs, 'stat').mockImplementation(async (target, signal) => {
      entered.resolve(undefined)
      await release.promise
      return stat(target, signal)
    })
    const controller = new AbortController()
    const starting = startInProcessRun(request(parent, controller.signal), {})
    const rejection = expect(starting).rejects.toThrow()
    try {
      await entered.promise
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
      if (failure === 'cancelled') controller.abort(new Error('cancel child install'))
      else await rm(capturedDir, { recursive: true })
      release.resolve(undefined)
      await rejection
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
      expect(ctx.sessions.list()).toEqual(beforeSessions)
      expect(parent.session.snapshotEvents()).toEqual(beforeEvents)
      expect(published).toEqual([])
      expect(accepted).toEqual([])
      expect(adapter.requests).toHaveLength(0)
    } finally {
      release.resolve(undefined)
      await rejection
      interception.mockRestore()
    }
  })
})
