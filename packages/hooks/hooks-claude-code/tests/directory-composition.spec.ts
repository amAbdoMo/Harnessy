/** Source-only hook command boundary; real YAML/Loader, Agents, loop and directory projections. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ShellExecutor, { type ShellExecRequest, type ShellExecSpec, type ShellExecution } from '@deepseek-ai/dsh-shell'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SubagentRuntime, { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import * as Claude from '../src/index.ts'
import * as Codex from '@deepseek-ai/dsh-hooks-codex'
import { expect, it, onTestFinished, vi } from 'vitest'

/** The external command's deterministic exit/output; no native bash is invoked. */
class CommandBoundary extends ShellExecutor {
  readonly calls: ShellExecSpec[] = []
  resolve(request: ShellExecRequest): ShellExecSpec {
    return { ...request, workdir: request.workdir ?? process.cwd(), timeoutMs: request.timeoutMs ?? 1000,
      onExpiry: request.onExpiry ?? 'kill', stdoutMaxBytes: request.stdoutMaxBytes ?? 64000, sandboxPolicy: request.sandboxPolicy }
  }
  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    spec.signal?.throwIfAborted()
    this.calls.push(spec)
    const block = spec.command === 'block-prompt'
    const reader = { readFrom: (from: number) => ({ text: '', nextOffset: from, lossy: false }) }
    return { status: 'completed', exitCode: block ? 2 : 0, signal: null, done: Promise.resolve(),
      readOutput: () => ({ delta: '', lossy: false }), observed: { stdout: reader, stderr: reader }, kill: () => false,
      result: async () => ({ exitCode: block ? 2 : 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
        stdout: { text: '', truncated: false }, stderr: { text: block ? 'Blocked by configured policy' : '', truncated: false } }),
    }
  }
}

class ControlledModel extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: ['text'] }
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function composition(dialect: 'claude' | 'codex', lifecycle = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hook-directory-'))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  const moved = join(root, 'moved')
  await mkdir(moved)
  await mountAgentLoopTestDependencies(ctx)
  ctx.effect(() => ctx.llm.registerAdapter(['unused'], new ControlledModel()))
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(CommandBoundary)
  const boundary = ctx.get('shell')
  if (!(boundary instanceof CommandBoundary)) throw new Error('Command boundary did not mount')
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(SubagentRuntime, {})
  const configPath = join(root, 'hooks.json')
  await writeFile(configPath, JSON.stringify({ hooks: lifecycle ? {
    SubagentStart: [{ hooks: [{ type: 'command', command: 'observe-start' }] }],
    SubagentStop: [{ hooks: [{ type: 'command', command: 'observe-stop' }] }],
  } : { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'block-prompt' }] }] } }))
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify([{ id: 'hook-consumer', name: 'cordis:hook', config: { configPath } }]))
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.hook = dialect === 'claude' ? Claude : Codex
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'hook-consumer')
  if (entry?.fiber === undefined) throw new Error('Hook consumer did not load')
  const agent = await harness.create(SessionId(`hook-${dialect}`), { provider: 'unused', model: 'unused' }, { cwd: root })
  return { ctx, agent, root, moved, boundary, entry }
}

it.each(['claude', 'codex'] as const)('%s applies prompt hook policy in the real Agent execution directory', async (dialect) => {
  const b = await composition(dialect)
  const directory = await b.ctx.workingDirectory.set(b.agent, b.moved)
  const stream = vi.spyOn(b.ctx.llm, 'stream')
  b.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Policy-controlled task' }], source: { kind: 'user' } }))
  await b.agent.whenIdle()
  expect(b.boundary.calls).toHaveLength(1)
  expect(b.boundary.calls[0]?.workdir).toBe(directory)
  expect(JSON.parse(b.boundary.calls[0]?.stdin ?? '{}')).toMatchObject({ cwd: directory, session_id: b.agent.id })
  expect(b.agent.session.header.cwd).toBe(b.root)
  expect(b.agent.session.snapshotEvents().some(event => event.type === 'hook/result')).toBe(true)
  expect(stream).not.toHaveBeenCalled()
})

it('runs SubagentStop in the last committed directory after real child disposal', async () => {
  const b = await composition('claude', true)
  const handle = await b.ctx.agents.create({ sessionId: SessionId('stopped-child'), parentAgent: b.agent,
    agentOptions: { provider: 'unused', model: 'unused' }, meta: { cwd: b.root } })
  const child = handle.agent
  const info = { runId: SubagentRunId('directory-epoch'), provider: 'fixture', id: child.id, local: true }
  const carrier = scopeTarget(b.ctx.subagents, b.agent)
  b.ctx.emit(carrier, 'subagent/start', info)
  await vi.waitFor(() => { expect(b.boundary.calls.filter(call => call.command === 'observe-start')).toHaveLength(1) })
  const directory = await b.ctx.workingDirectory.set(child, b.moved)
  await handle.dispose()
  expect(child.ctx.fiber.uid).toBeNull()
  expect(b.ctx.agents.get(child.id)).toBeUndefined()
  const retainedEvents = child.session.snapshotEvents()
  b.ctx.emit(carrier, 'subagent/end', { ...info, stopReason: 'completed' })
  await vi.waitFor(() => { expect(b.boundary.calls.filter(call => call.command === 'observe-stop')).toHaveLength(1) })
  const stop = b.boundary.calls.find(call => call.command === 'observe-stop')
  expect(stop?.workdir).toBe(directory)
  expect(JSON.parse(stop?.stdin ?? '{}')).toMatchObject({ cwd: directory, session_id: child.id })
  expect(child.session.header.cwd).toBe(b.root)
  expect(child.session.snapshotEvents()).toEqual(retainedEvents)
  await b.entry.fiber?.dispose()
})
