/**
 * The two token-stable model-facing tools: lane discovery and Command Code
 * delegation. Neither exposes a model, an effort, a timeout, a turn bound, an
 * executable, a credential, or a permission: the model names a lane, and the
 * lane's stored policy decides everything else.
 *
 * @module @deepseek-ai/dsh-subagent-commandcode/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { MAX_COMMAND_CODE_OUTPUT_BYTES } from './bound.ts'
import { startCommandCodeJob } from './job.ts'
import type { CommandCodeJobApi } from './job.ts'
import { composeCommandCodeBrief, laneDirectory } from './lanes.ts'
import { requireEnabledLane } from './settings.ts'
import { commandCodeVisibleText } from './run.ts'
import type { CommandCodeDelegationView, CommandCodeLaneSummary, CommandCodeRunSpec } from './types.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** Command Code delegations started from this profile. */
    commandcode: 'commandcode'
  }
}

/** Model-facing name of the delegation tool. */
export const COMMAND_CODE_DELEGATE_TOOL = 'commandcode_delegate'

/** Model-facing name of the lane directory tool. */
export const COMMAND_CODE_LANES_TOOL = 'list_commandcode_lanes'

/** What the tools need from the plugin that owns the CLI and the settings. */
export interface CommandCodeDelegationApi extends CommandCodeJobApi {
  /**
   * Resolve the current workspace's lanes and bounds.
   * @param workspace - the delegating Session's workspace, or null without one.
   */
  viewFor(workspace: string | null): CommandCodeDelegationView
  /**
   * Report one absorbed start-time failure on the Host.
   * @param error - the underlying host failure, kept out of every model-visible surface.
   */
  onStartError(error: Error): void
}

/** The delegating Session's workspace, or undefined when it has none. */
function workspaceOf(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

/**
 * Await one foreground run, then release it.
 *
 * The terminal result comes first and the disposal follows it: a real managed
 * process is terminated by disposal, so disposing in parallel with the result
 * would cancel a run that was about to answer. Cleanup is guaranteed to run and
 * never hides an independent run failure.
 * @param run - the published run.
 * @param release - the concurrency slot to return.
 * @returns the completed run's bounded text.
 */
async function settleForeground(run: SubagentRun, release: () => void): Promise<string> {
  let outcome: { readonly text: string } | { readonly error: unknown }
  try {
    const result = await run.result
    outcome = result.stopReason === 'completed'
      ? { text: commandCodeVisibleText(result) }
      : { error: new Error(commandCodeVisibleText(result)) }
  } catch (error: unknown) {
    outcome = { error }
  }

  let disposal: Error | undefined
  try {
    await run.dispose()
  } catch (error: unknown) {
    disposal = error instanceof Error ? error : new Error(String(error))
  } finally {
    release()
  }

  if ('error' in outcome) {
    if (disposal === undefined) throw outcome.error
    throw new AggregateError(
      [outcome.error, disposal],
      `${String(outcome.error)}; dispose failed: ${disposal.message}`,
    )
  }
  if (disposal !== undefined) throw disposal
  return outcome.text
}

/** Present one delegation call in the conversation surface. */
function delegatePresentation(laneId: string): GenericCallView {
  return { card: 'generic', title: `Delegate to the Command Code lane "${laneId}"`, kind: 'execute', rawInput: laneId }
}

/**
 * Register the model-facing Command Code tools.
 * @param ctx - Context that owns the registrations.
 * @param api - the plugin's CLI, settings, and scheduling surface.
 */
export function installCommandCodeTools(ctx: Context, api: CommandCodeDelegationApi): void {
  ctx.tools.register(defineTool({
    name: COMMAND_CODE_LANES_TOOL,
    description: 'List the Command Code lanes configured for this workspace. Each lane fixes a model, a '
      + 'reasoning effort, and an access level; `commandcode_delegate` takes one of these ids.',
    parameters: {},
    output: {
      schema: { type: 'array', items: { type: 'json' } },
      render: (_args, lanes) => [{
        type: 'text',
        text: lanes.length === 0
          ? '(no Command Code lanes are enabled)'
          : (lanes as unknown as CommandCodeLaneSummary[])
            .map(lane => `${lane.id} — ${lane.name} (${lane.access}, model ${lane.model}, effort ${lane.effort}): ${lane.purpose}`)
            .join('\n'),
      }],
    },
    execute(_args, exec): Promise<JsonValue[]> {
      const lanes = laneDirectory(api.viewFor(workspaceOf(exec) ?? null).lanes)
      return Promise.resolve(lanes as unknown as JsonValue[])
    },
    presentCall: () => ({ card: 'generic', title: 'List Command Code lanes', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: COMMAND_CODE_DELEGATE_TOOL,
    description: 'Delegate a self-contained task to the user\'s installed Command Code CLI through one configured '
      + 'lane. The lane decides the model, reasoning effort, and access level, so a call cannot change them. '
      + 'The call runs in the background by default and returns a job id immediately; the runtime notifies you '
      + 'when it settles, `job_output` collects its result, and `job_kill` stops it. Set `run_in_background: false` '
      + 'only when your next action depends on the result. The delegated agent does not see this conversation, so '
      + 'give it a complete, standalone task.',
    parameters: {
      lane: {
        type: 'string',
        required: true,
        description: 'Id of the Command Code lane to delegate through, as listed by list_commandcode_lanes.',
      },
      task: {
        type: 'string',
        required: true,
        description: 'The complete, self-contained task for the delegated agent. It does not share this '
          + 'conversation\'s context, so include everything the task needs.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Whether to run in the background and return a job id. Defaults to true; set false to wait '
          + 'for the result when your next action depends on it.',
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
          ? `started background Command Code delegation job ${value.jobId}`
          : value.text,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('commandcode_delegate requires a calling agent (exec.agent was undefined)')
      }
      const workspace = workspaceOf(exec)
      if (workspace === undefined) {
        throw new Error(
          'commandcode_delegate needs a session workspace: this session has no working directory',
        )
      }
      // Lane policy is resolved here, from the live settings document, and is
      // the only authority this delegation carries.
      const view = api.viewFor(workspace)
      const lane = requireEnabledLane(view, args.lane)
      const spec: CommandCodeRunSpec = {
        laneName: lane.name,
        model: lane.model,
        effort: lane.effort,
        access: lane.access,
        maxTurns: view.maxTurns,
        timeoutMs: view.timeoutMs,
      }
      const brief = composeCommandCodeBrief(lane.instructions, args.task)
      const label = `Command Code · ${lane.name}`

      if (args.run_in_background === false) {
        const health = await api.preflight(exec.signal)
        if (!health.installed || !health.authenticated) {
          // No fallback to another product, model, or executable: the user's own
          // Command Code CLI is the only backend this tool has.
          throw new Error(health.detail ?? `the ${health.command} CLI is unavailable`)
        }
        const release = await api.acquire(exec.signal)
        let run: SubagentRun
        try {
          run = api.start({ brief, cwd: workspace, signal: exec.signal }, spec, () => {})
        } catch (error: unknown) {
          release()
          throw error
        }
        return { kind: 'foreground' as const, text: await settleForeground(run, release) }
      }

      const jobs = ctx.get('jobs')
      if (jobs === undefined) {
        throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
      }
      // Registration is synchronous and returns the id before any probe or
      // admission happens; the starter the registry calls owns both from here.
      const jobId = jobs.start({
        kind: 'commandcode',
        label,
        owner: parent,
        outputLimitBytes: MAX_COMMAND_CODE_OUTPUT_BYTES,
        run: () => startCommandCodeJob({
          api,
          brief,
          workspace,
          spec,
          label,
          onError: (error) => { api.onStartError(error) },
        }),
      })
      return { kind: 'background' as const, jobId }
    },
    presentCall: args => delegatePresentation(args.lane),
  }))
}
