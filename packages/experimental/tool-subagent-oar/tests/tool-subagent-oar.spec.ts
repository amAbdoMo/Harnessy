import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture as mountWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { expect, it, vi } from 'vitest'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '../../../jobs/tool-jobs/src/index.ts'
import * as externalTool from '../src/index.ts'

async function setup(withControls = true) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(JobsLocal)
  if (withControls) await ctx.plugin(ToolJobs)
  const calls: { provider: string; request: ResolvedSubagentStartRequest }[] = []
  for (const name of ['codex-provider', 'claude-provider', 'future-provider']) {
    ctx.subagents.registerProvider({
      name, capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
      start: async (request) => {
        calls.push({ provider: name, request })
        return {
          id: SessionId(randomUUID()),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text' as const, text: 'child result' }], stopReason: 'completed' as const }),
          dispose: () => Promise.resolve(),
        }
      },
    })
  }
  const parent = await harness.create(SessionId(randomUUID()), {}, { cwd: process.cwd() })
  return { ctx, parent, calls }
}

it('selects one configured provider per call and exposes only task inputs', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  const fiber = await ctx.plugin(externalTool, {
    providers: { codex: 'codex-provider', claude: 'claude-provider', future: 'future-provider' },
  })
  const schema = ctx.tools.schemas().find(tool => tool.name === 'subagent_oar')
  expect(schema?.parameters.required).toEqual(['runtime', 'description', 'prompt'])
  expect(Object.keys(schema?.parameters.properties as Record<string, unknown>).sort()).toEqual(['description', 'prompt', 'runtime'])
  expect(schema?.parameters.properties).toMatchObject({ runtime: { enum: ['codex', 'claude', 'future'] } })
  for (const runtime of ['codex', 'claude', 'future']) {
    const result = await ctx.tools.execute({
      agent: parent, name: 'subagent_oar', signal: test.signal,
      callId: ToolCallId(randomUUID()),
      arguments: { runtime, description: `Use ${runtime}`, prompt: 'independent task' },
    })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(result.content).toHaveLength(1)
    const content = result.content[0]
    expect(content?.type).toBe('text')
    if (content?.type === 'text') expect(content.text).toMatch(/^started background job /u)
  }
  expect(calls.map(call => call.provider)).toEqual(['codex-provider', 'claude-provider', 'future-provider'])
  expect(calls[0]?.request.prompt).toEqual([{ type: 'text', text: 'independent task' }])
  expect(calls[0]?.request.parent).toBe(parent)
  expect(calls[0]?.request.parent.session.header.cwd).toBe(process.cwd())
  expect(ctx.tools.executionMode({
    name: 'subagent_oar', arguments: { runtime: 'codex', description: 'task', prompt: 'task' },
    callId: ToolCallId(randomUUID()), signal: test.signal,
  })).toEqual({ kind: 'parallel' })
  await fiber.dispose()
  expect(ctx.tools.schemas().some(tool => tool.name === 'subagent_oar')).toBe(false)
})

it('rejects unconfigured runtime names before starting any child', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(externalTool, { providers: { codex: 'codex-provider' } })
  const result = await ctx.tools.execute({
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'unconfigured', description: 'task', prompt: 'task' },
  })
  expect(result.isError).toBe(true)
  expect(calls).toEqual([])
})

it('fails visibly when the selected provider disappears', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(externalTool, { providers: { missing: 'missing-provider' } })
  const result = await ctx.tools.execute({
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'missing', description: 'task', prompt: 'task' },
  })
  expect(result.isError).toBe(true)
  expect(calls).toEqual([])
})

it('rejects empty runtime maps and keeps Loader metadata', async (test) => {
  const { ctx } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  expect('default' in externalTool).toBe(false)
  const loader = Object.create(Loader.prototype) as Loader
  expect(loader.unwrapExports(externalTool)).toBe(externalTool)
  await expect(ctx.plugin(externalTool, { providers: {} })).rejects.toThrow('at least one')
  await expect(ctx.plugin(externalTool, { providers: { ' ': 'codex-provider' } })).rejects.toThrow('non-empty')
})

it('requires a caller and independently scoped one-shot providers', async (test) => {
  const { ctx, parent } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  ctx.subagents.registerProvider({
    name: 'inherited', capabilities: NO_START_CAPABILITIES, inheritsParentContext: true,
    start: async () => { throw new Error('must not run') },
  })
  await ctx.plugin(externalTool, { providers: { inherited: 'inherited' } })
  const args = { runtime: 'inherited', description: 'task', prompt: 'task' }
  const noParent = await ctx.tools.execute({
    name: 'subagent_oar', arguments: args, callId: ToolCallId(randomUUID()), signal: test.signal,
  })
  expect(noParent.isError).toBe(true)
  const inherited = await ctx.tools.execute({
    agent: parent, name: 'subagent_oar', arguments: args, callId: ToolCallId(randomUUID()), signal: test.signal,
  })
  expect(inherited.isError).toBe(true)
  expect(JSON.stringify(inherited.content)).toContain('independent conversation')
})

it('inherits the caller directory and presents the task description', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(externalTool, { providers: { codex: 'codex-provider' } })
  const args = { runtime: 'codex', description: 'Inspect child', prompt: 'task' }
  expect(ctx.tools.get('subagent_oar')?.presentCall?.(args)).toEqual({
    card: 'generic', title: 'Inspect child', rawInput: args,
  })
  const result = await ctx.tools.execute({
    agent: parent, name: 'subagent_oar', arguments: args, callId: ToolCallId(randomUUID()), signal: test.signal,
  })
  expect(result.isError).toBe(false)
  expect(calls[0]?.request.parent.session.header.cwd).toBe(process.cwd())
})

it('supports direct composition with the declared optional defaults', async (test) => {
  const { ctx } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  externalTool.apply(ctx, { providers: { codex: 'codex-provider' } })
  expect(ctx.tools.schemas().some(tool => tool.name === 'subagent_oar')).toBe(true)
})

it('refuses to start a child without job controls in the caller composition', async (test) => {
  const { ctx, parent, calls } = await setup(false)
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(externalTool, { providers: { codex: 'codex-provider' } })
  const result = await ctx.tools.execute({
    agent: parent, name: 'subagent_oar', arguments: { runtime: 'codex', description: 'task', prompt: 'task' },
    callId: ToolCallId(randomUUID()), signal: test.signal,
  })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('no job controller')
  expect(calls).toEqual([])
})

it('cancels the accepted child through its parent job and disposes the run once', async (test) => {
  const { ctx, parent } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  const finished = Promise.withResolvers<SubagentResult>()
  const dispose = vi.fn(async () => {})
  let signal: AbortSignal | undefined
  ctx.subagents.registerProvider({
    name: 'held', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    start: async (request) => {
      signal = request.signal
      request.signal.addEventListener('abort', () => { finished.resolve({ output: [], stopReason: 'aborted' }) }, { once: true })
      return { id: SessionId(randomUUID()), localAgent: undefined, result: finished.promise, dispose }
    },
  })
  await ctx.plugin(externalTool, { providers: { held: 'held' } })
  const result = await ctx.tools.execute({
    agent: parent, name: 'subagent_oar', arguments: { runtime: 'held', description: 'Held task', prompt: 'task' },
    callId: ToolCallId(randomUUID()), signal: test.signal,
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const value = result.value
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof value.jobId !== 'string') {
    throw new Error('missing background job acknowledgement')
  }
  const jobId = JobId(value.jobId)
  expect(ctx.jobs.kill(jobId, parent.id)).toBe('requested')
  expect((await ctx.jobs.wait(jobId, 5000, parent.id)).status).toBe('killed')
  expect(signal?.aborted).toBe(true)
  expect(dispose).toHaveBeenCalledOnce()
})
