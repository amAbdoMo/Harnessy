import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { loadStoredSession } from './persistence-helpers.ts'
import { TestSessionQuery } from './test-session-query.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-continuation-directory-')))
  const ctx = new Context()
  cleanups.push(async () => {
    try { await ctx.fiber.dispose() } finally { rmSync(root, { recursive: true, force: true }) }
  })
  const directory = (name: string): string => {
    const path = join(root, name)
    mkdirSync(path)
    return realpathSync.native(path)
  }
  const paths = {
    origin: directory('origin'),
    seedDir: directory('seedDir'),
    parentDir: directory('parentDir'),
    pendingDir: directory('pendingDir'),
    laterDir: directory('laterDir'),
    childDir: directory('childDir'),
  }
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: paths.origin })
  return { ctx, parent, paths, adapter }
}

function startSpec(parent: Agent, provider: string, signal = new AbortController().signal) {
  return {
    provider,
    childId: SessionId('directory-child'),
    label: 'directory task',
    request: { parent, prompt: [{ type: 'text' as const, text: 'child task' }] },
    signal,
  }
}

function directoryChanges(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'working-directory/change' ? [event.data.cwd] : [])
}

function settledChild(ctx: Context, childId: SessionId): Promise<void> {
  const settled = Promise.withResolvers<undefined>()
  const dispose = ctx.on('subagent/end', (info) => {
    if (info.id !== childId) return
    dispose()
    settled.resolve(undefined)
  })
  return settled.promise
}

describe('continuable committed directory capture', () => {
  it.each(['spawn', 'fork'])(
    '%s captures before a queued parent set and provider preparation, then cold-resumes the child directory',
    async (providerName) => {
      const { ctx, parent, paths, adapter } = await setup([textResponse('parent seed'), 'hang', textResponse('resumed child')])
      await ctx.workingDirectory.set(parent, paths.seedDir)
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent work' }], source: { kind: 'user' } }))
      await parent.whenIdle()
      ctx.on('agent/pre-step', async ({ agent }, next) => agent === parent ? { kind: 'reject' as const } : next())
      await ctx.workingDirectory.set(parent, paths.parentDir)

      const provider = ctx.subagents.getProvider(providerName)
      if (provider?.prepareContinuable === undefined) throw new Error('expected a continuable provider')
      const prepare = provider.prepareContinuable.bind(provider)
      const entered = Promise.withResolvers<string>()
      const release = Promise.withResolvers<undefined>()
      const preparation = vi.spyOn(provider, 'prepareContinuable').mockImplementation(async (request) => {
        const prepared = prepare(request)
        entered.resolve(request.cwd)
        await release.promise
        return prepared
      })
      const pendingSet = ctx.workingDirectory.set(parent, paths.pendingDir)
      expect(ctx.workingDirectory.get(parent.session)).toBe(paths.parentDir)
      const spec = startSpec(parent, providerName)
      const starting = ctx.subagents.startContinuable(spec)
      try {
        expect(await entered.promise).toBe(paths.pendingDir)
        await pendingSet
        expect(ctx.workingDirectory.get(parent.session)).toBe(paths.pendingDir)
        await ctx.workingDirectory.set(parent, paths.laterDir)
        expect(ctx.agents.get(spec.childId)).toBeUndefined()
        expect(ctx.sessionProjections.snapshot(parent.session).values.subagentCatalog).toEqual([])
      } finally {
        release.resolve(undefined)
        preparation.mockRestore()
        await pendingSet
        await starting
      }
      const started = await starting
      const child = ctx.agents.get(started.childId)
      if (child === undefined) throw new Error('expected the child to remain live')
      expect(ctx.workingDirectory.get(child.session)).toBe(paths.pendingDir)
      expect(child.session.header).toMatchObject({ cwd: paths.origin, parentSession: parent.id })
      expect(ctx.sandboxPolicy.resolve({ session: child.session })).toMatchObject({ mode: 'workspace-write', workspaceRoot: paths.origin })
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
      const captured = await ctx.workingDirectory.set(child, paths.childDir)
      await ctx.subagents.drainContinuableChildren(parent, [started.childId])
      expect(ctx.agents.get(started.childId)).toBeUndefined()
      const stored = await loadStoredSession(ctx.sessionPersistence, started.childId)
      expect(directoryChanges(stored.events.slice(stored.inheritedEventCount))).toEqual([paths.pendingDir, captured])
      expect(directoryChanges(stored.events.slice(0, stored.inheritedEventCount)))
        .toEqual(providerName === 'fork' ? [paths.seedDir] : [])
      const storedChild = Session.create(started.childId, stored.events, stored.meta, stored.inheritedEventCount)
      expect(ctx.workingDirectory.get(storedChild)).toBe(captured)

      const resumedDirectories: string[] = []
      ctx.on('agent/created', ({ agent }) => {
        if (agent.id !== started.childId) return
        resumedDirectories.push(ctx.workingDirectory.get(agent.session))
        expect(agent.session.header.cwd).toBe(paths.origin)
        expect(ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot).toBe(paths.origin)
      })
      const settled = settledChild(ctx, started.childId)
      await queueHostSubagentPrompt(ctx.subagents, parent, started.childId,
        [{ type: 'text', text: 'continue' }], { kind: 'user' }, new AbortController().signal)
      await settled
      expect(resumedDirectories).toEqual([captured])
      const resumed = await loadStoredSession(ctx.sessionPersistence, started.childId)
      expect(resumed.meta.cwd).toBe(paths.origin)
      expect(directoryChanges(resumed.events)).toEqual(directoryChanges(stored.events))
      expect(ctx.workingDirectory.get(parent.session)).toBe(paths.laterDir)
      expect(ctx.sessionProjections.snapshot(parent.session).values.subagentCatalog).toMatchObject([{ id: started.childId, mode: 'continuable' }])
    },
  )

  it.each(['reject', 'cancel'] as const)('directory installation %s publishes no child, catalog, or initial input', async (outcome) => {
    const { ctx, parent, paths, adapter } = await setup([])
    await ctx.workingDirectory.set(parent, paths.parentDir)
    const controller = new AbortController()
    const spec = startSpec(parent, 'spawn', controller.signal)
    const installed: Agent[] = []
    const published: Agent[] = []
    const initialInputs: SessionId[] = []
    ctx.on('working-directory/before-change', (agent, directory, _signal, next) => {
      if (agent.id !== spec.childId) return next()
      installed.push(agent)
      expect(directory).toBe(paths.parentDir)
      expect(ctx.agents.get(agent.id)).toBeUndefined()
      if (outcome === 'cancel') {
        controller.abort(new Error('cancel directory installation'))
        return next()
      }
      return false
    })
    ctx.on('agent/created', ({ agent }) => { if (agent.id === spec.childId) published.push(agent) })
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent.id === spec.childId && message.source.kind === 'user') initialInputs.push(agent.id)
    })

    await expect(ctx.subagents.startContinuable(spec)).rejects.toThrow(
      outcome === 'cancel' ? 'cancel directory installation' : 'change rejected by the Session policy',
    )
    expect(installed).toHaveLength(1)
    expect(published).toEqual([])
    expect(initialInputs).toEqual([])
    expect(ctx.agents.get(spec.childId)).toBeUndefined()
    expect(ctx.sessions.get(spec.childId)).toBeUndefined()
    expect(ctx.sessionProjections.snapshot(parent.session).values.subagentCatalog).toEqual([])
    expect(adapter.requests).toEqual([])
  })
})
