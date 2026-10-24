/** Explicit phone chat activation; list, history and catalog reads never call this owner. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { encodeApplicationResult } from '@deepseek-ai/dsh-companion-protocol'
import type {
  ApplicationBudget, ApplicationRequest, MutationRefusalCode, SessionOpenedResult,
} from '@deepseek-ai/dsh-companion-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { mobileSessionSummary, requireVisibleSession } from './session-view.ts'

/** An authenticated, one-shot existing-chat mutation, not a task submission. */
export type SessionOpenRequest = Extract<ApplicationRequest, { readonly type: 'openSession' }>

/** Current activation authority and reply lifetime; admitted work belongs to the PC API owner. */
export interface SessionActivationOptions {
  readonly budget: ApplicationBudget
  readonly signal: AbortSignal
  readonly requireAdmission: () => void
  readonly errorCode: (error: unknown) => MutationRefusalCode
}

/**
 * Refuse an opening without claiming it reached the PC's writable Agent lifecycle.
 * @param request - Fenced existing-chat target.
 * @param code - Fixed pre-admission reason.
 * @returns A definite rejection with the original mutation identity.
 */
export function rejectSessionOpen(request: SessionOpenRequest, code: MutationRefusalCode): SessionOpenedResult {
  return { v: 1, type: 'sessionOpened', requestId: request.requestId, operationId: request.operationId,
    sessionId: request.sessionId, outcome: 'rejected', code }
}

/**
 * Open one existing ordinary chat after explicit phone consent, with no Desktop navigation or input.
 * @param ctx - Real PC Session and Agent owners.
 * @param request - One-shot existing-chat identity; missing chats are never created.
 * @param options - Fresh authority, bounded reply lifetime and fixed result budget.
 * @returns Applied after activation and targeted persistence, rejected before admission, otherwise unknown.
 */
export async function executeSessionOpen(
  ctx: Context, request: SessionOpenRequest, options: SessionActivationOptions,
): Promise<SessionOpenedResult> {
  const admission = { started: false }
  const common = { v: 1 as const, type: 'sessionOpened' as const, requestId: request.requestId,
    operationId: request.operationId, sessionId: request.sessionId }
  try {
    options.requireAdmission()
    const agent = await ctx.sessionController.activateExistingAgent(request.sessionId, {
      signal: options.signal, requireAdmission: options.requireAdmission,
      onAdmitted: () => { admission.started = true },
    })
    options.requireAdmission()
    requireVisibleSession(ctx, agent.session.header)
    const session = mobileSessionSummary(ctx, agent.session.header, options.budget, 'navigation')
    if (ctx.agents.get(request.sessionId) !== agent || ctx.sessions.get(request.sessionId) !== agent.session
      || session.status === 'closed' || session.navigation === undefined) throw new Error('companion-host: activated chat ownership changed')
    const result: SessionOpenedResult = { ...common, outcome: 'applied',
      session: { ...session, status: session.status, navigation: session.navigation } }
    encodeApplicationResult(result, options.budget)
    return result
  } catch (error: unknown) {
    if (admission.started) return { ...common, outcome: 'unknown' }
    const code = error instanceof RemoteError && (error.code === 'session/agent-busy' || error.code === 'session/writer-held')
      ? 'busy' : options.errorCode(error)
    return rejectSessionOpen(request, code)
  }
}
