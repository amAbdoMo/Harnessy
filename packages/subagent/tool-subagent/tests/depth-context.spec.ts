/** Optional delegation-depth notices follow the live Agent and visible tool definition. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies, provideWorkingDirectoryFixture, type AgentLoopTestDependenciesOptions } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import * as tool from '../src/index.ts'
import { mountScriptedProvider } from './scripted-provider.ts'

/** Own a real Agent registry without the legacy harness's agentless default. */
async function fixture(
  config: Omit<tool.Config, 'provider'> = {},
  dependencies: AgentLoopTestDependenciesOptions = {},
  persisted = false,
) {
  const ctx = new Context()
  let storageRoot: string | undefined
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally {
      if (storageRoot !== undefined) await rm(storageRoot, { recursive: true, force: true })
    }
  })
  await mountAgentLoopTestDependencies(ctx, dependencies)
  provideWorkingDirectoryFixture(ctx)
  if (persisted) {
    storageRoot = await mkdtemp(join(tmpdir(), 'subagent-depth-'))
    await ctx.plugin(JsonlPersistence, { root: storageRoot, compression: 'none' })
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  const settings = await liveConfig(ctx, SubagentRuntime)
  const provider = await mountScriptedProvider(ctx, { name: 'scripted' })
  const plugin = await ctx.plugin(tool, { provider: 'scripted', ...config })
  return { ctx, provider, plugin, settings }
}

/** Read nonempty depth contributions through production prompt assembly. */
async function notices(ctx: Context, agent?: Agent): Promise<string[]> {
  const assembly = await ctx.systemPrompt.assemble(agent === undefined ? undefined : assembleContextFor(agent))
  return assembly.contexts.filter(part => part.name.endsWith(':depth') && part.text !== '').map(part => part.text)
}

function notice(depth: number, maximum: number, name = 'subagent'): string {
  return `Delegation depth for \`${name}\`: current ${depth}, maximum ${maximum}, remaining levels 0.`
    + ` Do not call \`${name}\` at this depth; carry out the work directly.`
}

describe('delegation depth context', () => {
  it.each([
    { depth: 0, maxDepth: 0 },
    { depth: 0, maxDepth: 1 },
    { depth: 1, maxDepth: 1 },
    { depth: 1, maxDepth: 2 },
    { depth: 2, maxDepth: 1 },
  ])('reports saved depth $depth with cap $maxDepth without changing system text or schemas', async ({ depth, maxDepth }) => {
    const { ctx } = await fixture({ maxDepth })
    const { agent: root } = await ctx.agents.create({ sessionId: SessionId('depth-root') })
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('depth-child'),
      meta: { delegationDepth: depth },
      agentOptions: { subagentDepth: 0 },
    })
    const baseline = await ctx.systemPrompt.assemble(assembleContextFor(root))
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(assembly.sections).toEqual(baseline.sections)
    expect(assembly.tools).toEqual(baseline.tools)
    const expected = depth >= maxDepth ? [notice(depth, maxDepth)] : []
    expect(await notices(ctx, agent)).toEqual(expected)
    const restore = agent.ctx.systemPrompt.suppressRuntimeContext()
    try {
      expect(await notices(ctx, agent)).toEqual([])
      expect((await ctx.systemPrompt.assemble(assembleContextFor(agent)))
        .contexts.some(part => part.name.endsWith(':depth'))).toBe(false)
    } finally {
      restore()
    }
    expect(await notices(ctx, agent)).toEqual(expected)
    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).contexts
      .filter(part => part.name.endsWith(':depth') && part.text !== '').map(part => part.text)).toEqual(expected)
  })

  it('uses runtime depth when deeper than the saved header', async () => {
    const { ctx } = await fixture({ maxDepth: 2 })
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('deeper-runtime'),
      meta: { delegationDepth: 1 },
      agentOptions: { subagentDepth: 2 },
    })
    expect(agent.session.header.delegationDepth).toBe(1)
    expect(await notices(ctx, agent)).toEqual([notice(2, 2)])
  })

  it('omits provider-managed caps and agentless diagnostics', async () => {
    const { ctx } = await fixture({ maxDepth: 'provider-managed' })
    const { agent } = await ctx.agents.create({ sessionId: SessionId('provider-managed') })
    expect(await notices(ctx, agent)).toEqual([])
    await ctx.plugin(tool, { provider: 'scripted', toolName: 'bounded', maxDepth: 0 })
    expect(await notices(ctx)).toEqual([])
    expect(await notices(ctx, agent)).toEqual([notice(0, 0, 'bounded')])
  })

  it('follows restrictions, scoped overrides, removal and provider replacement', async () => {
    const { ctx, provider } = await fixture({ maxDepth: 0 })
    const { agent: root } = await ctx.agents.create({ sessionId: SessionId('visible-root') })
    const { agent: child } = await ctx.agents.create({
      sessionId: SessionId('visible-child'),
      meta: { delegationDepth: 1 },
      setup: async (agentCtx) => { await agentCtx.plugin(tool, { provider: 'scripted', maxDepth: 1 }) },
    })
    expect(await notices(ctx, child)).toEqual([notice(1, 1)])
    const unrestrict = root.ctx.tools.restrict({ deny: ['subagent'] })
    expect(await notices(ctx, root)).toEqual([])
    unrestrict()
    expect(await notices(ctx, root)).toEqual([notice(0, 0)])
    const definition = ctx.tools.get('subagent')
    if (definition === undefined) throw new Error('missing delegation definition')
    const removeOverride = root.ctx.tools.register({ ...definition, description: 'Scoped replacement' })
    expect(await notices(ctx, root)).toEqual([])
    removeOverride()
    expect(await notices(ctx, root)).toEqual([notice(0, 0)])
    await provider.dispose()
    expect(ctx.tools.get('subagent')).toBeUndefined()
    expect(await notices(ctx, root)).toEqual([])
    expect(await notices(ctx, child)).toEqual([])
    await mountScriptedProvider(ctx, { name: 'scripted', inheritsParentContext: true })
    expect(ctx.tools.get('subagent')).not.toBe(definition)
    expect(ctx.tools.get('subagent')?.description).toContain('inherits this conversation')
    expect(await notices(ctx, root)).toEqual([notice(0, 0)])
    expect(await notices(ctx, child)).toEqual([notice(1, 1)])
  })

  it('withdraws the context registration when its tool plugin is disposed', async () => {
    const { ctx, plugin } = await fixture({ maxDepth: 0 })
    const { agent } = await ctx.agents.create({ sessionId: SessionId('dispose-depth') })
    expect(await notices(ctx, agent)).toEqual([notice(0, 0)])
    await plugin.dispose()
    expect(ctx.tools.get('subagent')).toBeUndefined()
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(assembly.contexts.some(part => part.name === 'tool:subagent:depth')).toBe(false)
  })

  it.each(['one-shot', 'continuable'] as const)('suppresses configured optional context without bypassing %s depth enforcement', async (backgroundMode) => {
    const { ctx } = await fixture({ maxDepth: 0 }, { systemPrompt: { includeRuntimeContext: false } }, true)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(tool, { provider: 'spawn', toolName: 'bounded', backgroundMode, maxDepth: 0 })
    const { agent } = await ctx.agents.create({ sessionId: SessionId('suppressed-depth') })
    expect(await notices(ctx, agent)).toEqual([])
    const result = await ctx.tools.execute({
      callId: ToolCallId('suppressed-depth-call'),
      name: 'bounded',
      arguments: { description: 'Check depth enforcement', prompt: 'work' },
      agent,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: subagent depth 1 exceeds maxDepth 0' }])
    expect(ctx.agents.list().map(candidate => candidate.id)).toEqual([agent.id])
  })

  it('refreshes the saved default cap without remounting tools or changing the prefix', async () => {
    const { ctx, settings } = await fixture()
    const { agent } = await ctx.agents.create({ sessionId: SessionId('refresh-depth') })
    const context = assembleContextFor(agent)
    const initial = await ctx.systemPrompt.assemble(context)
    const definition = ctx.tools.get('subagent')
    expect(await notices(ctx, agent)).toEqual([])
    await settings.update({ maxDepth: 0 })
    const capped = await ctx.systemPrompt.assemble(context)
    expect(capped.contexts.filter(part => part.name === 'tool:subagent:depth').map(part => part.text))
      .toEqual([notice(0, 0)])
    expect(capped.sections).toEqual(initial.sections)
    expect(capped.tools).toEqual(initial.tools)
    expect(ctx.tools.get('subagent')).toBe(definition)
    await settings.update({ maxDepth: 2 })
    expect((await ctx.systemPrompt.assemble(context)).contexts
      .filter(part => part.name === 'tool:subagent:depth').map(part => part.text)).toEqual([''])
    expect(await notices(ctx, agent)).toEqual([])
  })
})
