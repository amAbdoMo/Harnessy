/**
 * The Command Code subagent backend: a `ctx.subagents` provider that runs one
 * delegation through the user's installed CLI, reusing the package's own run,
 * concurrency gate, and argv machinery.
 *
 * The provider owns its model space. Command Code model ids come from the CLI's
 * own catalog, which the composed LLM runtime does not serve, so a role's route
 * reaches `--model` untouched and this backend is what validates it.
 *
 * @module @deepseek-ai/dsh-subagent-commandcode/backend
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  ResolvedSubagentStartRequest,
  SubagentAccess,
  SubagentCapabilities,
  SubagentProvider,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { composeCommandCodeBrief } from './lanes.ts'
import type { CommandCodeDelegationApi } from './tools.ts'
import { COMMAND_CODE_EFFORTS } from './types.ts'
import type {
  CommandCodeAccess,
  CommandCodeDelegationView,
  CommandCodeEffort,
  CommandCodeRunSpec,
} from './types.ts'

/**
 * Registry name of the Command Code backend. It is fixed rather than
 * configurable because stored roles name it: the roster projects every
 * pre-roster Command Code lane onto this backend, so a deployment that renamed
 * the provider would leave those roles without a backend.
 */
export const COMMAND_CODE_SUBAGENT_BACKEND = 'commandcode'

/**
 * Map one delegation's requested access onto the CLI's two permission levels.
 *
 * The CLI expresses a native read-only plan mode and unrestricted full access.
 * `workspace-write` sits between them, so it is refused here rather than
 * silently rounded to one of the two, and `'inherit'` or an omitted access
 * keeps the level a run that names none has always started on.
 * @param access - the sandbox access the delegating role asked for.
 * @returns the CLI access level to run with.
 * @throws {TypeError} when the request names a level the CLI cannot express.
 */
export function commandCodeAccess(access: SubagentAccess | undefined): CommandCodeAccess {
  switch (access) {
    case undefined:
    case 'inherit':
    case 'read-only':
      return 'read-only'
    case 'danger-full-access':
      return 'full-access'
    case 'workspace-write':
      throw new TypeError(
        'commandcode: the CLI has no workspace-write permission mode, so this role must name read-only or danger-full-access access',
      )
    default:
      return assertNever(access, 'SubagentAccess')
  }
}

/**
 * Map one delegation's requested reasoning effort onto the CLI's own levels.
 * @param effort - the effort the delegating role asked for, when it named one.
 * @returns the CLI effort; `default` omits the flag.
 * @throws {TypeError} when the request names an effort the CLI does not accept.
 */
export function commandCodeEffort(effort: string | undefined): CommandCodeEffort {
  if (effort === undefined) return 'default'
  const known = COMMAND_CODE_EFFORTS.find(candidate => candidate === effort)
  if (known === undefined) {
    throw new TypeError(`commandcode: the CLI accepts no reasoning effort "${effort}"`)
  }
  return known
}

/**
 * Flatten one delegation's prompt to the text the CLI reads on stdin.
 * @param prompt - the request's content blocks.
 * @returns the concatenated text.
 * @throws {TypeError} when the prompt carries a part the CLI cannot receive.
 */
function promptText(prompt: readonly ContentBlock[]): string {
  return prompt.map((block) => {
    if (block.type !== 'text') {
      throw new TypeError(`commandcode: the CLI reads text on stdin, so the prompt cannot carry a "${block.type}" part`)
    }
    return block.text
  }).join('')
}

/**
 * Resolve one start request into the CLI's own execution parameters. The role
 * supplies the route and the access; the Command Code settings supply the turn
 * cap and the wall-clock bound, exactly as they do for a stored lane.
 */
function backendRunSpec(
  request: ResolvedSubagentStartRequest,
  view: CommandCodeDelegationView,
): CommandCodeRunSpec {
  const model = request.agentOptions?.model
  return {
    laneName: request.label ?? COMMAND_CODE_SUBAGENT_BACKEND,
    // An omitted route lets the CLI answer with its own configured default.
    ...model === undefined ? {} : { model },
    effort: commandCodeEffort(request.agentOptions?.reasoningEffort),
    access: commandCodeAccess(request.sandboxMode),
    maxTurns: view.maxTurns,
    timeoutMs: view.timeoutMs,
  }
}

/**
 * Publish one started run under the concurrency slot its start took. Disposal
 * releases the process tree first and the slot second, so a failed teardown
 * still returns the slot the run held.
 * @param run - the run the CLI machinery published.
 * @param release - the slot to return once the process is gone.
 * @returns the run the seam hands its caller.
 */
function heldRun(run: SubagentRun, release: () => void): SubagentRun {
  return {
    id: run.id,
    localAgent: run.localAgent,
    result: run.result,
    async dispose(): Promise<void> {
      try {
        await run.dispose()
      } finally {
        release()
      }
    },
  }
}

/**
 * The Command Code backend. It honours `agentOptions` (the model and effort the
 * role pins), `persona` (the standing instructions that prefix the brief), and
 * `accessPolicy` (the CLI's permission mode). A CLI child owns its own tools,
 * delegation depth, and structured output, so those capabilities are advertised
 * false rather than pretended.
 */
class CommandCodeSubagentProvider implements SubagentProvider {
  readonly name = COMMAND_CODE_SUBAGENT_BACKEND

  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: true,
    accessPolicy: true,
    // The CLI's catalog is its own; nothing here resolves through `ctx.llm`.
    runtimeRoute: false,
  }

  // Context contract: the CLI child is a separate product that never sees the
  // delegating conversation.
  readonly inheritsParentContext = false

  constructor(private readonly api: CommandCodeDelegationApi) {}

  /**
   * Run one delegation to completion of its publication boundary. The route,
   * the access, and the prompt are resolved before any slot or process is
   * taken, so a request this backend cannot express refuses the start; a
   * failure after the slot is taken returns it before rejecting.
   */
  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const workspace = request.parent.session.header.cwd
    if (workspace === undefined) {
      throw new Error('commandcode: the delegating session has no working directory to run in')
    }
    const spec = backendRunSpec(request, this.api.viewFor(workspace))
    const brief = composeCommandCodeBrief(request.persona ?? '', promptText(request.prompt))
    const health = await this.api.preflight(request.signal)
    if (!health.installed || !health.authenticated) {
      // No fallback to another product, model, or executable: the user's own
      // Command Code CLI is the only backend this provider has.
      throw new Error(health.detail ?? `the ${health.command} CLI is unavailable`)
    }
    const release = await this.api.acquire(request.signal)
    let run: SubagentRun
    try {
      run = this.api.start({ brief, cwd: workspace, signal: request.signal }, spec, () => {})
    } catch (error: unknown) {
      // Nothing was published, so the slot this start took goes back.
      release()
      throw error
    }
    return heldRun(run, release)
  }
}

/**
 * Register the Command Code backend on `ctx.subagents`. Registration starts no
 * process and reads no CLI state: both happen per delegation.
 * @param ctx - Context carrying the subagent registry.
 * @param api - the plugin's CLI, settings, and scheduling surface.
 * @returns the exact Cordis effect disposer.
 */
export function registerCommandCodeBackend(ctx: Context, api: CommandCodeDelegationApi): () => void {
  return ctx.subagents.registerProvider(new CommandCodeSubagentProvider(api))
}
