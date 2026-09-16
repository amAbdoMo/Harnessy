/**
 * Execution-time authority check for the `manual` invocation policy: a role
 * restricted to direct human input may only be started from a turn a human
 * actually opened on a runtime root.
 *
 * @module @deepseek-ai/dsh-subagent-roster/authority
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'

/** The calling agent plus the immutable event cut and open-turn start it authorizes against. */
export interface DelegationAuthorityWindow {
  /** The exact agent whose turn is being judged. */
  readonly agent: Agent
  /** Immutable event cut taken when the tool call started. */
  readonly events: readonly SessionEvent[]
  /** Seq of the open turn's `turn/start`. */
  readonly openTurnStartSeq: SessionSeq
}

/**
 * Resolve the calling agent's open-turn authority window.
 * @param ctx - Context carrying the calling agent's session projections.
 * @param exec - Tool execution metadata supplied by the registry.
 * @returns the calling agent and its immutable open-turn window.
 * @throws {SubagentError} when the call has no agent, or runs outside an open model turn.
 */
export function delegationAuthorityWindow(ctx: Context, exec: ToolRunContext): DelegationAuthorityWindow {
  const agent = exec.agent
  if (agent === undefined) {
    throw new SubagentError('delegate requires a calling agent (exec.agent was undefined)', 'SUBAGENT_TOOL_AGENT_REQUIRED')
  }
  const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
  if (boundary === undefined || boundary.openTurnStartSeq === null) {
    throw new SubagentError(
      'delegate requires an open model turn',
      'SUBAGENT_TOOL_DRIVER_REQUIRED',
    )
  }
  return { agent, events: agent.session.snapshotEvents(), openTurnStartSeq: boundary.openTurnStartSeq }
}

/**
 * Whether host-attested human input appears in the current root-agent turn. An
 * omitted `Agent.followup()` / `steer()` source resolves to `user`, so non-human
 * producers supply their own source rather than inheriting this authority.
 * @param ctx - Context carrying the live agent graph.
 * @param window - the calling agent's open-turn authority window.
 * @returns whether the turn qualifies as direct human input.
 */
function hasDirectHumanInput(ctx: Context, window: DelegationAuthorityWindow): boolean {
  if (!ctx.agents.roots().includes(window.agent)) return false
  for (let seq = window.openTurnStartSeq + 1; seq < window.events.length; seq += 1) {
    const event = window.events[seq]
    if (event !== undefined && event.type === 'user/message' && event.data.source.kind === 'user') return true
  }
  return false
}

/**
 * Require authority originating in a human message accepted by a runtime root.
 * @param ctx - Context carrying the live agent graph.
 * @param window - the calling agent's open-turn authority window.
 * @throws {SubagentError} when the turn was not opened by direct human input on a root.
 */
export function requireDirectHuman(ctx: Context, window: DelegationAuthorityWindow): void {
  if (hasDirectHumanInput(ctx, window)) return
  throw new SubagentError(
    'this subagent may only be started from a direct human turn on a top-level agent',
    'SUBAGENT_INVOCATION_REQUIRES_HUMAN',
  )
}
