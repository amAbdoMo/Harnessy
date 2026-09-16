/**
 * A real in-process child backend: the shipped spawn provider, the shipped
 * agent loop, and the real sandbox policy, so a definition's access can be
 * observed on the child's own log rather than on a request object.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import type { LlmModelReasoningInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { SubagentRunLimiter } from '../src/limiter.ts'
import { subagentRosterView } from '../src/settings.ts'
import { installRosterTools } from '../src/tools.ts'
import type { SubagentSettings } from '../src/types.ts'

/** One booted real composition and the children it produced. */
export interface RealChild {
  readonly ctx: Context
  readonly parent: Agent
  /** Every child the provider published, in order. */
  readonly children: Session[]
  /** The delegated mode on one child's own log, or undefined without one. */
  modeOf(child: Session): SandboxMode | undefined
  /** Every `sandbox/mode` event on one child's own log. */
  modeEvents(child: Session): readonly SessionEvent<'sandbox/mode'>[]
  dispose(): Promise<void>
}

/** Options for one real child composition. */
export interface RealChildOptions {
  /** Workspace both the deployment policy and the session use. */
  readonly workspace: string
  /** The deployment's sandbox mode, which applies while the parent names no override. */
  readonly deploymentMode: SandboxMode
  /** The roster document the delegation resolves against. */
  readonly settings: SubagentSettings
  /** Model script the child consumes; one text response by default. */
  readonly script?: StreamChunk[][]
  /**
   * Provider id the mock adapter answers for; `mock` by default. A test that
   * pins a definition to a real provider/model pair registers the adapter under
   * that provider, because the adapter answers for whatever route it is given.
   */
  readonly adapterProvider?: string
  /**
   * Reasoning capability the adapter advertises for the routes it serves.
   * Omitted means it advertises none, so a definition that names an effort is
   * correctly refused; a test that pins an effort supplies the levels here.
   */
  readonly adapterReasoning?: LlmModelReasoningInfo
}

/** Mount the shipped spawn provider over the real agent loop and sandbox policy. */
export async function bootRealChild(options: RealChildOptions): Promise<RealChild> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(SandboxPolicyService, { mode: options.deploymentMode, workspaceRoot: options.workspace })
  await ctx.plugin(SandboxedFileSystem, { cwd: options.workspace })
  await ctx.plugin(ToolFs)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(
    [options.adapterProvider ?? 'mock'],
    new MockAdapter(options.script ?? [textResponse('child done')], options.adapterReasoning),
  )
  const limiter = new SubagentRunLimiter(() => options.settings.limits.maxConcurrentRuns)
  installRosterTools(ctx, {
    viewFor: () => subagentRosterView(options.settings, null),
    acquire: signal => limiter.acquire(signal),
  })
  const children: Session[] = []
  // The child is published, and its delegated policy already appended, when the
  // lifecycle edge fires, so the session is captured before the run is disposed.
  ctx.on('subagent/start', (info) => {
    const session = ctx.sessions.get(info.id)
    if (session !== undefined) children.push(session)
  })
  const parent = await ctx.agentLoop.create(
    SessionId('real-parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: options.workspace },
  )
  return {
    ctx,
    parent,
    children,
    modeOf: child => ctx.sandboxPolicy.overrideOf(child),
    modeEvents: child => child.snapshotEvents()
      .filter((event): event is SessionEvent<'sandbox/mode'> => event.type === 'sandbox/mode'),
    dispose: () => ctx.fiber.dispose(),
  }
}
