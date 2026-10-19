import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import type { Config as NodeRuntimeConfig } from '@deepseek-ai/dsh-ptc-runtime-node'
import { onTestFinished } from 'vitest'

/** Mount real Node execution services with a private working directory and awaited cleanup. */
export async function mountPtcRuntime(ctx: Context, mode: SandboxMode = 'danger-full-access') {
  const root = await mkdtemp(join(homedir(), '.dsh-workflow-test-'))
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  await mountWorkflowRuntime(ctx, { cwd, mode, runtimeConfig: { graceMs: 50 } })
  return { root, cwd }
}

/** Mount the real execution services in a caller-owned context and directory. */
export async function mountWorkflowRuntime(
  ctx: Context,
  options: { cwd?: string; mode?: SandboxMode; runtimeConfig?: NodeRuntimeConfig } = {},
): Promise<NodePtcRuntime> {
  await mountWorkflowDirectoryFixture(ctx)
  if (!ctx.get('subprocess')) await ctx.plugin(Subprocess)
  if (!ctx.get('sandbox')) await ctx.plugin(Sandbox)
  if (!ctx.get('sandboxPolicy')) await ctx.plugin(SandboxPolicy, {
    mode: options.mode ?? 'danger-full-access',
    ...options.cwd === undefined ? {} : { workspaceRoot: options.cwd },
  })
  if (!ctx.get('ptcRuntime')) await ctx.plugin(NodePtcRuntime, options.runtimeConfig ?? {})
  return ctx.ptcRuntime as NodePtcRuntime
}

/** Mount real directory and Agent services beside any prerequisites already owned by the test. */
export async function mountWorkflowDirectoryFixture(ctx: Context): Promise<void> {
  if (!ctx.get('llm')) await ctx.plugin(LlmRuntime)
  if (!ctx.get('sessions')) await ctx.plugin(SessionStore)
  if (!ctx.get('sessionProjections')) await ctx.plugin(SessionProjections)
  if (!ctx.get('systemPrompt')) await ctx.plugin(SystemPrompt)
  if (!ctx.get('tools')) await ctx.plugin(ToolRuntime)
  if (!ctx.get('agents')) await ctx.plugin(AgentRegistry)
  if (!ctx.get('fs')) await ctx.plugin(FileSystem)
  if (!ctx.get('workingDirectory')) await ctx.plugin(WorkingDirectory, {})
}

/** Give a stub subagent provider a production Agent with an immutable project directory. */
export async function realParent(ctx: Context) {
  if (!ctx.get('agentLoop')) await mountAgentLoopTestHarness(ctx)
  return ctx.agentLoop.create(SessionId(randomUUID()), {}, { cwd: ctx.sandboxPolicy.workspaceRoot })
}
