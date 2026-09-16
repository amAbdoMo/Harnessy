/**
 * The two token-stable model-facing tools: the role directory and delegation.
 *
 * `delegate` exposes a role id, a task, and the background choice. It exposes
 * no access, permission, credential, or timeout parameter, so escalation stays
 * unrepresentable at the tool boundary. Route fields are present because one
 * static schema serves both model modes, and they are refused outright for a
 * definition that fixes its route — a call cannot select what the definition
 * already decided.
 *
 * @module @deepseek-ai/dsh-subagent-roster/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'
import {
  parentAgentOptionsForDelegation,
  settleRun,
  SubagentError,
} from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  assertAllowedModelSelection,
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from '@deepseek-ai/dsh-tool-subagent/model-selection'
import type { DelegationModelRequest } from '@deepseek-ai/dsh-tool-subagent/model-selection'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { delegationAuthorityWindow, requireDirectHuman } from './authority.ts'
import { renderSubagentDirectory, subagentDirectory } from './directory.ts'
import { requireEnabledSubagent } from './settings.ts'
import type {
  ResolvedSubagentDefinition,
  SubagentDirectoryEntry,
  SubagentRosterView,
} from './types.ts'

/** Model-facing name of the role directory tool. */
export const LIST_SUBAGENTS_TOOL = 'list_subagents'

/** Model-facing name of the delegation tool. */
export const DELEGATE_TOOL = 'delegate'

/** What the tools need from the plugin that owns the live settings and the run gate. */
export interface SubagentRosterApi {
  /**
   * Resolve the current workspace's roster.
   * @param workspace - the delegating Session's workspace, or null without one.
   */
  viewFor(workspace: string | null): SubagentRosterView
  /**
   * Take one concurrency slot.
   * @param signal - caller cancellation while queued.
   */
  acquire(signal: AbortSignal): Promise<() => void>
}

/** The delegating Session's workspace, or undefined when it has none. */
function workspaceOf(exec: ToolRunContext): string | undefined {
  return exec.agent?.session.header.cwd
}

/** Require the calling agent, which owns delegation and the approval address. */
function requireCallerAgent(exec: ToolRunContext): Agent {
  const agent = exec.agent
  if (agent === undefined) {
    throw new SubagentError('delegate requires a calling agent (exec.agent was undefined)', 'SUBAGENT_TOOL_AGENT_REQUIRED')
  }
  return agent
}

/**
 * Enforce one definition's invocation policy before anything starts.
 * @param ctx - Context carrying the agent graph and the approval channel.
 * @param definition - the resolved role being invoked.
 * @param agent - the calling agent.
 * @param exec - the tool execution owning the call identity and signal.
 * @throws {SubagentError} when the policy refuses this call.
 */
async function enforceInvocation(
  ctx: Context,
  definition: ResolvedSubagentDefinition,
  agent: Agent,
  exec: ToolRunContext,
): Promise<void> {
  switch (definition.invocation) {
    case 'automatic':
      return
    case 'manual':
      requireDirectHuman(ctx, delegationAuthorityWindow(ctx, exec))
      return
    case 'ask-first': {
      const approval = ctx.get('approval')
      if (approval === undefined) {
        throw new SubagentError(
          `subagent "${definition.id}" must be approved before every start, but no approval service is composed`,
          'SUBAGENT_APPROVAL_UNAVAILABLE',
        )
      }
      const outcome = await approval.request({
        agent,
        toolName: DELEGATE_TOOL,
        callId: exec.callId,
        reason: `start the "${definition.name}" subagent: ${definition.purpose}`,
        signal: exec.signal,
      })
      // Only an explicit one-shot grant proceeds; every other outcome is a refusal.
      if (outcome !== 'allowed-once') {
        throw new SubagentError(
          `starting subagent "${definition.id}" was not approved (${outcome})`,
          'SUBAGENT_APPROVAL_REFUSED',
        )
      }
      return
    }
    default:
      return assertNever(definition.invocation, 'SubagentInvocationPolicy')
  }
}

/**
 * Resolve the child's route through the existing selection path.
 *
 * A definition that fixes its route refuses every model-facing route field, so
 * the parent cannot override it. An automatic definition merges the request over
 * its own route and is then authorized against the roster's allowed models and
 * resolved by the live LLM runtime.
 * @param ctx - Context carrying the LLM runtime.
 * @param view - the workspace's resolved roster view.
 * @param definition - the resolved role being invoked.
 * @param parent - the delegating agent.
 * @param request - the model-facing route fields from this call.
 * @param provider - the backend that will start the child, whose route defaults and route resolution decide how far this resolves.
 * @param signal - the tool call's cancellation signal.
 * @returns the child options to request, or undefined to inherit the parent's.
 * @throws {SubagentError} when a fixed route is overridden, selection is disabled, or the route is unauthorized.
 */
async function resolveDelegationRoute(
  ctx: Context,
  view: SubagentRosterView,
  definition: ResolvedSubagentDefinition,
  parent: Agent,
  request: DelegationModelRequest,
  provider: SubagentProvider,
  signal: AbortSignal,
): Promise<AgentOptions | undefined> {
  if (definition.model.mode === 'fixed' && hasDelegationModelRequest(request)) {
    throw new SubagentError(
      `subagent "${definition.id}" fixes its model, so this call cannot select a route`,
      'SUBAGENT_ROUTE_FIXED',
    )
  }
  const route = definition.model.route
  const configured: AgentOptions | undefined = route === undefined
    ? undefined
    : {
      provider: route.provider,
      model: route.model,
      ...route.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
    }
  const parentOptions = parentAgentOptionsForDelegation(parent)
  const backendRouteDefaults = provider.agentRouteDefaults
  const requiresPreflight = hasDelegationModelRequest(request) || hasConfiguredLlmSelection(configured)
  const childDefaults = requiresPreflight && backendRouteDefaults !== undefined
    ? { ...backendRouteDefaults, ...configured }
    : configured
  const requested = requestedAgentOptions(
    parentOptions,
    childDefaults,
    request,
    view.automaticRouting.enabled,
  )
  assertAllowedModelSelection(
    { routes: view.automaticRouting.allowedModels },
    parentOptions,
    requested,
    request,
  )
  // A backend that owns its model space resolves its own route: the composed
  // runtime has no adapter for a model it does not run, so the route reaches
  // the backend untouched and the backend validates it at start.
  if (requiresPreflight && provider.capabilities.runtimeRoute) {
    const llm = ctx.get('llm')
    if (llm === undefined) {
      throw new SubagentError(
        'cannot resolve the selected child LLM route because the `llm` service is unavailable',
        'SUBAGENT_LLM_UNAVAILABLE',
      )
    }
    await preflightChildLlmRoute(llm, parentOptions, requested, signal, backendRouteDefaults === undefined)
    signal.throwIfAborted()
  }
  return requested
}

/**
 * Resolve the background choice from the definition's schedule policy.
 * @param definition - the resolved role being invoked.
 * @param requested - the model's explicit choice, when it made one.
 * @returns whether this delegation runs in the background.
 * @throws {SubagentError} when the call asks for a schedule the definition rules out.
 */
function resolveBackground(definition: ResolvedSubagentDefinition, requested: boolean | undefined): boolean {
  if (definition.execution.background === 'foreground' && requested === true) {
    throw new SubagentError(
      `subagent "${definition.id}" runs in the foreground, so this call cannot put it in the background`,
      'SUBAGENT_BACKGROUND_FIXED',
    )
  }
  return requested ?? definition.execution.background === 'background'
}

/**
 * Bound one delegation by its own wall clock, releasing the timer with the run
 * so a long-lived process never carries an armed deadline it no longer owns.
 * @param signal - the caller's cancellation signal.
 * @param timeoutMs - the effective wall-clock bound.
 * @returns the composed signal and its release.
 */
function boundRun(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController()
  const forward = (): void => { controller.abort(signal.reason) }
  if (signal.aborted) forward()
  else signal.addEventListener('abort', forward, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new Error(`subagent run exceeded its ${timeoutMs} ms limit`))
  }, timeoutMs)
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', forward)
    },
  }
}

/**
 * Await one background start without rejecting the job producer contract.
 * @param start - the pending start.
 * @param signal - the task's signal, which decides killed from failed.
 * @returns the run's terminal task outcome.
 */
async function settleStart(start: Promise<SubagentRun>, signal: AbortSignal): Promise<JobOutcome> {
  try {
    return await settleRun(await start)
  } catch (error: unknown) {
    // Product providers aggregate startup and rollback failures. Cancellation
    // must not turn a failed cleanup into a cleanly killed job.
    return signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

/** Build the child request one resolved definition describes. */
function childRequest(
  definition: ResolvedSubagentDefinition,
  parent: Agent,
  task: string,
  agentOptions: AgentOptions | undefined,
  signal: AbortSignal,
): SubagentStartRequest {
  const instructions = definition.instructions
  const { maxDepth } = definition
  return {
    label: definition.name,
    prompt: [{ type: 'text', text: task }] as ContentBlock[],
    parent,
    signal,
    ...agentOptions === undefined ? {} : { agentOptions },
    ...maxDepth === undefined ? {} : { maxDepth },
    ...definition.tools === undefined ? {} : { toolFilter: definition.tools },
    // Empty standing instructions must not shadow the deployment persona.
    ...instructions.trim().length === 0 ? {} : { persona: instructions },
    sandboxMode: definition.access,
  }
}

/**
 * Register the model-facing roster tools.
 * @param ctx - Context that owns the registrations and the delegated services.
 * @param api - the plugin's live settings read and run gate.
 */
export function installRosterTools(ctx: Context, api: SubagentRosterApi): void {
  ctx.tools.register(defineTool({
    name: LIST_SUBAGENTS_TOOL,
    description: 'List the subagents enabled for this workspace. Each entry fixes its own access, model, and '
      + 'invocation policy; `delegate` takes one of these ids.',
    parameters: {},
    output: {
      schema: { type: 'array', items: { type: 'json' } },
      render: (_args, entries) => [{
        type: 'text',
        text: renderSubagentDirectory(entries as unknown as readonly SubagentDirectoryEntry[]),
      }],
    },
    execute(_args, exec): Promise<JsonValue[]> {
      const entries = subagentDirectory(api.viewFor(workspaceOf(exec) ?? null))
      return Promise.resolve(entries as unknown as JsonValue[])
    },
    presentCall: (): GenericCallView => ({ card: 'generic', title: 'List subagents', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: DELEGATE_TOOL,
    description: 'Delegate a self-contained task to one configured subagent. The subagent decides its own model, '
      + 'reasoning effort, and access level, so a call cannot change them. Give it a complete, standalone task: '
      + 'it does not see this conversation. Omit `provider`, `model`, and `reasoning_effort` unless the subagent '
      + 'uses automatic model selection, which `list_subagents` reports as a selection of allowed routes.',
    parameters: {
      subagent: {
        type: 'string',
        required: true,
        description: 'Id of the subagent to delegate to, as listed by list_subagents.',
      },
      task: {
        type: 'string',
        required: true,
        description: 'The complete, self-contained task for the subagent. It does not share this '
          + 'conversation\'s context, so include everything the task needs.',
      },
      provider: {
        type: 'string',
        description: 'LLM provider route for the child, only for a subagent whose model mode is automatic. '
          + 'Supply together with model; omit both to use the configured route or inherit the parent route.',
      },
      model: {
        type: 'string',
        description: 'Model id interpreted by provider, only for a subagent whose model mode is automatic. '
          + 'Supply together with provider; omit both to use the configured route or inherit the parent route.',
      },
      reasoning_effort: {
        type: 'string',
        description: 'Adapter-owned reasoning effort for an effective automatic route. Omit to use the '
          + 'configured effort or the selected model\'s default.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Whether to run as a background job and return its id. Defaults to the subagent\'s own '
          + 'schedule; collect a background run with job_output and stop it with job_kill.',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              text: { type: 'string', required: true },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background subagent job ${value.jobId}`
          : value.text,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = requireCallerAgent(exec)
      const view = api.viewFor(workspaceOf(exec) ?? null)
      const definition = requireEnabledSubagent(view, args.subagent)
      const backend = definition.execution.backend
      const provider = ctx.subagents.getProvider(backend)
      if (provider === undefined) {
        throw new SubagentError(`no subagent provider registered for "${backend}"`, 'NO_PROVIDER')
      }
      await enforceInvocation(ctx, definition, parent, exec)

      const requested = args as DelegationModelRequest
      const agentOptions = await resolveDelegationRoute(
        ctx,
        view,
        definition,
        parent,
        requested,
        provider,
        exec.signal,
      )
      const timeoutMs = definition.execution.timeoutMs ?? view.limits.defaultTimeoutMs
      const runInBackground = resolveBackground(definition, args.run_in_background)

      if (!runInBackground) {
        const bounded = boundRun(exec.signal, timeoutMs)
        let release: (() => void) | undefined
        try {
          release = await api.acquire(bounded.signal)
          const run = await ctx.subagents.start(
            backend,
            childRequest(definition, parent, args.task, agentOptions, bounded.signal),
          )
          const outcome = await settleRun(run)
          if (outcome.status !== 'completed') {
            throw new Error(outcome.detail ?? `subagent run ${outcome.status}`)
          }
          return { kind: 'foreground' as const, text: outcome.output ?? '' }
        } finally {
          release?.()
          bounded.release()
        }
      }

      const jobs = ctx.get('jobs')
      if (jobs === undefined) {
        throw new SubagentError(
          'background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs',
          'SUBAGENT_JOBS_UNAVAILABLE',
        )
      }
      // Registration is synchronous and returns the id before any admission
      // happens; the starter the registry calls owns the gate and the run.
      const jobId = jobs.start({
        kind: 'subagent',
        label: `${definition.name} · ${definition.id}`,
        owner: parent,
        run: (): JobHooks => {
          const controller = new AbortController()
          const bounded = boundRun(controller.signal, timeoutMs)
          const done = (async (): Promise<JobOutcome> => {
            let release: (() => void) | undefined
            try {
              release = await api.acquire(bounded.signal)
              return await settleStart(
                ctx.subagents.start(
                  backend,
                  childRequest(definition, parent, args.task, agentOptions, bounded.signal),
                ),
                bounded.signal,
              )
            } catch (error: unknown) {
              // The only failure this catch can see is the run gate refusing a
              // caller that cancelled: `settleStart` settles every child
              // failure itself, including a provider's aggregated rollback.
              return bounded.signal.aborted
                ? { status: 'killed' }
                : { status: 'failed', detail: String(error) }
            } finally {
              release?.()
              bounded.release()
            }
          })()
          return {
            cancel: (reason?: string) => {
              if (controller.signal.aborted) return
              controller.abort(reason ?? 'background subagent delegation killed')
            },
            done,
          }
        },
      })
      return { kind: 'background' as const, jobId }
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: `Delegate to the "${args.subagent}" subagent`,
      kind: 'execute',
      rawInput: args.subagent,
    }),
  }))
}
