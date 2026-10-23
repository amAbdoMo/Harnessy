/** Fixed phone management commands through PC owners; admitted writes settle without cancellation or rollback. */
import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ApplicationBudget, ApplicationRequest, ManagementAction, ManagementResult,
} from '@deepseek-ai/dsh-companion-protocol'
import { encodeApplicationResult } from '@deepseek-ai/dsh-companion-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  WorkspaceActiveSessionError, WorkspaceArchivedSessionPinError, WorkspaceUnknownSessionError,
} from '@deepseek-ai/dsh-workspace'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { MobileViewError, mobileSessionSummary, requireVisibleSession } from './session-view.ts'

/** Parsed closed management request, never an arbitrary RPC invocation. */
export type ManagementRequest = Extract<ApplicationRequest,
  { type: 'createSession' | 'renameSession' | 'archiveSession' | 'setSessionPinned' }>
/** Fixed refusal codes; diagnostics and paths remain PC-local. */
export type ManagementRejectionCode = Extract<ManagementResult, { outcome: 'rejected' }>['code']

/** Admission authority is re-read after every asynchronous preflight and immediately before a PC call. */
export interface ManagementExecutionOptions {
  readonly budget: ApplicationBudget
  readonly signal: AbortSignal
  readonly requireAdmission: () => void
  readonly errorCode: (error: unknown) => ManagementRejectionCode
}

/**
 * Map a closed wire command to its result action.
 * @param request - Parsed management request.
 * @returns the fixed phone action.
 */
export function managementAction(request: ManagementRequest): ManagementAction {
  switch (request.type) {
    case 'createSession': return 'create'
    case 'renameSession': return 'rename'
    case 'archiveSession': return 'archive'
    case 'setSessionPinned': return 'pin'
    default: return assertNever(request, 'companion management request')
  }
}

/**
 * Produce a definite refusal before admission, without retaining exception details.
 * @param request - Original correlation and target.
 * @param code - Fixed phone refusal.
 * @returns the correlated management rejection.
 */
export function rejectManagement(request: ManagementRequest, code: ManagementRejectionCode): ManagementResult {
  return { v: 1, type: 'managed', requestId: request.requestId, operationId: request.operationId,
    sessionId: request.sessionId, action: managementAction(request), outcome: 'rejected', code }
}

class ManagementRefusal extends Error {
  constructor(readonly code: ManagementRejectionCode) { super('PC operation refused before effects') }
}

async function invokeOwner(write: () => Promise<unknown>, request: ManagementRequest): Promise<unknown> {
  try { return await write() } catch (error: unknown) {
    const code = noEffectsCode(error, request)
    if (code !== undefined) throw new ManagementRefusal(code)
    throw error
  }
}

function noEffectsCode(error: unknown, request: ManagementRequest): ManagementRejectionCode | undefined {
  if (request.type !== 'archiveSession' && request.type !== 'setSessionPinned') return undefined
  if (error instanceof WorkspaceActiveSessionError) return 'busy'
  if (error instanceof WorkspaceUnknownSessionError) return 'notFound'
  if (error instanceof WorkspaceArchivedSessionPinError) return 'denied'
  return undefined
}

/**
 * Execute one supported PC write. Create and rename await the targeted Session flush, requiring a listener.
 * Cancellation after service admission cannot undo the write or prevent its flush; failures then are unknown
 * except for domain errors explicitly guaranteeing no effects. This function stores no durable replay receipt.
 * @param ctx - Current PC Session controller, persistence, and Workspace registry.
 * @param request - Codec-validated command with phone-known create identity.
 * @param options - Fresh admission authority, preflight cancellation, and result limits.
 * @returns applied only after the PC owner's awaited commit policy; partial effects are unknown.
 */
export async function executeManagement(
  ctx: Context, request: ManagementRequest, options: ManagementExecutionOptions,
): Promise<ManagementResult> {
  const common = { v: 1 as const, type: 'managed' as const, requestId: request.requestId,
    operationId: request.operationId, sessionId: request.sessionId }
  const action = managementAction(request)
  let admitted = false
  const settleSessionWrite = async (write: () => Promise<unknown>): Promise<void> => {
    const settlement = await invokeOwner(write, request).then(
      () => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }),
    )
    const live = ctx.sessions.get(request.sessionId)
    if (live === undefined && settlement.ok) throw new MobileViewError('unavailable')
    if (live !== undefined && !(await ctx.sessions.flush(live))) throw new MobileViewError('unavailable')
    if (!settlement.ok) throw settlement.error
  }
  try {
    options.requireAdmission()
    const registry = ctx.get('workspaceRegistry')
    const persistence = ctx.get('sessionPersistence')
    if (registry === undefined || persistence === undefined) throw new MobileViewError('unavailable')
    let header: SessionHeader | undefined
    if (request.type === 'createSession') {
      if (request.sessionId !== `mobile-${request.operationId}`) return rejectManagement(request, 'conflict')
      if (ctx.sessions.get(request.sessionId) !== undefined) return rejectManagement(request, 'conflict')
      const stored = await persistence.stat(request.sessionId, { signal: options.signal })
      options.requireAdmission()
      if (stored !== undefined || ctx.sessions.get(request.sessionId) !== undefined) return rejectManagement(request, 'conflict')
      const workspace = registry.get(request.workspaceId)
      if (workspace === undefined) return rejectManagement(request, 'notFound')
      if (!(await stat(workspace.path)).isDirectory()) return rejectManagement(request, 'notFound')
      options.requireAdmission()
      if (registry.get(request.workspaceId) !== workspace) return rejectManagement(request, 'notFound')
      if (ctx.sessions.get(request.sessionId) !== undefined) return rejectManagement(request, 'conflict')
      admitted = true
      await settleSessionWrite(() => ctx.sessionController.create({ newSessionId: request.sessionId, workspaceId: request.workspaceId }))
    } else {
      const live = ctx.sessions.get(request.sessionId)
      header = live?.header ?? (await persistence.stat(request.sessionId, { signal: options.signal }))?.header
      options.requireAdmission()
      if (header === undefined) return rejectManagement(request, 'notFound')
      requireVisibleSession(ctx, ctx.sessions.get(request.sessionId)?.header ?? header)
      if (request.type === 'renameSession' && ctx.agents.get(request.sessionId) === undefined) {
        return rejectManagement(request, 'unavailable')
      }
      // Visibility checks are synchronous; no preflight await separates authority from PC-call admission.
      options.requireAdmission()
      admitted = true
      switch (request.type) {
        case 'renameSession':
          await settleSessionWrite(async () => ctx.sessionController.renameLiveSession({
            sessionId: request.sessionId, title: request.title,
          }))
          break
        case 'archiveSession':
          await invokeOwner(() => registry.archiveSession(request.sessionId), request)
          return { ...common, action: 'archive', outcome: 'applied' }
        case 'setSessionPinned':
          await invokeOwner(() => request.pinned
            ? registry.pinSession(request.sessionId) : registry.unpinSession(request.sessionId), request)
          break
        default: return assertNever(request, 'companion existing Session management')
      }
    }
    const live = ctx.sessions.get(request.sessionId)
    const currentHeader = live?.header ?? header
    if (currentHeader === undefined) throw new MobileViewError('unavailable')
    const session = mobileSessionSummary(ctx, currentHeader, options.budget, 'navigation')
    if (session.navigation === undefined || action === 'archive') throw new MobileViewError('unavailable')
    const result: ManagementResult = { ...common, action, outcome: 'applied', session: { ...session, navigation: session.navigation } }
    encodeApplicationResult(result, options.budget)
    return result
  } catch (error: unknown) {
    const definite = admitted ? (error instanceof ManagementRefusal ? error.code : undefined) : options.errorCode(error)
    return definite === undefined
      ? { ...common, action, outcome: 'unknown' }
      : rejectManagement(request, definite)
  }
}
