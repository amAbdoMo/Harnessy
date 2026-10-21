/** Strict text-only mobile JSON parsers; complete encoded messages pay the byte budget. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ApplicationBudget, ApplicationRequest, ApplicationResult, HistoryRow, HistorySequence, ManagementAction, ManagementResult,
  MobileOperationId, MobileRequestId, MobileSessionId, MobileWorkspaceId, ReadCursor, SessionSummary, SubmissionId, SubscriptionId,
  WorkspaceSummary,
} from './application-types.ts'

/** Fixed protocol plaintext ceiling, including JSON wrappers and UTF-8 metadata. */
export const MAX_MOBILE_JSON_BYTES = 49_152

function fail(): never { throw new Error('companion: invalid or over-budget application message') }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail()
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail()
  return value
}
function text(value: unknown, maxBytes: number, nonempty = false): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes || (nonempty && value.length === 0)) fail()
  // Reject lone surrogates: Android and Node must encode exactly the same scalar text.
  if (!value.isWellFormed()) fail()
  return value
}
function token(value: unknown): string {
  const result = text(value, 128, true)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) fail()
  return result
}
function fixed(value: unknown, bytes: number): string {
  const result = text(value, Math.ceil(bytes * 4 / 3), true)
  if (!/^[A-Za-z0-9_-]+$/.test(result)) fail()
  const decoded = Buffer.from(result, 'base64url')
  if (decoded.length !== bytes || decoded.toString('base64url') !== result) fail()
  return result
}
function requestId(value: unknown): MobileRequestId { return brandString<MobileRequestId>(fixed(value, 16)) }
function sessionId(value: unknown): MobileSessionId { return brandString<MobileSessionId>(token(value)) }
function operationId(value: unknown): MobileOperationId { return brandString<MobileOperationId>(fixed(value, 16)) }
function workspaceId(value: unknown): MobileWorkspaceId { return brandString<MobileWorkspaceId>(token(value)) }
function subscriptionId(value: unknown): SubscriptionId { return brandString<SubscriptionId>(fixed(value, 16)) }
function cursor(value: unknown): ReadCursor {
  const result = text(value, 256, true)
  if (!/^[A-Za-z0-9_-]+$/.test(result) || Buffer.from(result, 'base64url').toString('base64url') !== result) fail()
  return brandString<ReadCursor>(result)
}
function optionalCursor(value: Record<string, unknown>): { cursor?: ReadCursor } {
  return Object.hasOwn(value, 'cursor') ? { cursor: cursor(value.cursor) } : {}
}
function decode(json: string, maxBytes: number): Record<string, unknown> {
  text(json, Math.min(maxBytes, MAX_MOBILE_JSON_BYTES), true)
  const value: unknown = JSON.parse(json)
  const result = object(value)
  if (result.v !== 1) fail()
  return result
}
function status(value: unknown): SessionSummary['status'] {
  if (value !== 'idle' && value !== 'queued' && value !== 'running' && value !== 'closed') fail()
  return value
}
function workspaceSummary(value: unknown, budget: ApplicationBudget): WorkspaceSummary {
  const row = object(value)
  exact(row, ['id', 'title', 'order'])
  return {
    id: workspaceId(row.id), title: text(row.title, budget.maxTitleBytes),
    order: integer(row.order, 0, Number.MAX_SAFE_INTEGER),
  }
}
function navigation(value: unknown, budget: ApplicationBudget): NonNullable<SessionSummary['navigation']> {
  const row = object(value)
  exact(row, ['updatedAt', 'pinOrder', 'workspace'])
  const workspace = row.workspace === null ? null : workspaceSummary(row.workspace, budget)
  return {
    updatedAt: integer(row.updatedAt, 0, Number.MAX_SAFE_INTEGER),
    pinOrder: row.pinOrder === null ? null : integer(row.pinOrder, 0, Number.MAX_SAFE_INTEGER),
    workspace,
  }
}
function sessionSummary(value: unknown, budget: ApplicationBudget): SessionSummary {
  const row = object(value)
  exact(row, ['sessionId', 'title', 'status'], ['navigation'])
  return {
    sessionId: sessionId(row.sessionId), title: text(row.title, budget.maxTitleBytes), status: status(row.status),
    ...(Object.hasOwn(row, 'navigation') ? { navigation: navigation(row.navigation, budget) } : {}),
  }
}
function rows(value: unknown, budget: ApplicationBudget): HistoryRow[] {
  if (!Array.isArray(value) || value.length > budget.maxRows) fail()
  let previous = -1n
  const ids = new Set<string>()
  return value.map((item: unknown) => {
    const row = object(item)
    exact(row, ['role', 'seq', 'id', 'text'])
    if (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'tool' && row.role !== 'notice') fail()
    const seq = brandString<HistorySequence>(fixed(row.seq, 8))
    const order = Buffer.from(seq, 'base64url').readBigUInt64BE()
    const id = token(row.id)
    if (order <= previous || ids.has(id)) fail()
    previous = order
    ids.add(id)
    return { role: row.role, seq, id, text: text(row.text, budget.maxTextBytes) }
  })
}

function managementTarget(value: Record<string, unknown>): Pick<ManagementResult, 'operationId' | 'sessionId'> {
  const target = { operationId: operationId(value.operationId), sessionId: sessionId(value.sessionId) }
  if ((value.type === 'createSession' || value.action === 'create') && target.sessionId !== `mobile-${target.operationId}`) fail()
  return target
}
function managementAction(value: unknown): ManagementAction {
  if (value !== 'create' && value !== 'rename' && value !== 'archive' && value !== 'pin') fail()
  return value
}
function managementWorkspaces(value: Record<string, unknown>, budget: ApplicationBudget): Extract<ApplicationResult, { type: 'managementWorkspaces' }> {
  if (value.enabled !== true && value.enabled !== false) fail()
  exact(value, ['v', 'type', 'requestId', 'enabled', 'workspaces'], value.enabled ? ['cursor'] : [])
  if (!Array.isArray(value.workspaces) || value.workspaces.length > budget.maxSessions) fail()
  const common = { v: 1 as const, type: 'managementWorkspaces' as const, requestId: requestId(value.requestId) }
  if (!value.enabled) {
    if (value.workspaces.length !== 0) fail()
    return { ...common, enabled: false, workspaces: [] }
  }
  const ids = new Set<MobileWorkspaceId>()
  const workspaces = value.workspaces.map((item: unknown) => {
    const row = workspaceSummary(item, budget)
    if (ids.has(row.id)) fail()
    ids.add(row.id)
    return row
  })
  return { ...common, enabled: true, workspaces, ...optionalCursor(value) }
}
function managed(value: Record<string, unknown>, budget: ApplicationBudget): ManagementResult {
  const common = {
    v: 1 as const, type: 'managed' as const, requestId: requestId(value.requestId),
    ...managementTarget(value), action: managementAction(value.action),
  }
  const keys = ['v', 'type', 'requestId', 'operationId', 'sessionId', 'action', 'outcome']
  switch (value.outcome) {
    case 'applied': {
      if (common.action === 'archive') {
        exact(value, keys)
        return { ...common, action: common.action, outcome: value.outcome }
      }
      exact(value, [...keys, 'session'])
      const session = sessionSummary(value.session, budget)
      if (session.sessionId !== common.sessionId || session.navigation === undefined) fail()
      return { ...common, action: common.action, outcome: value.outcome, session: { ...session, navigation: session.navigation } }
    }
    case 'rejected':
      exact(value, [...keys, 'code'])
      if (value.code !== 'denied' && value.code !== 'expired' && value.code !== 'notFound' && value.code !== 'busy'
        && value.code !== 'conflict' && value.code !== 'limit' && value.code !== 'unavailable') fail()
      return { ...common, outcome: value.outcome, code: value.code }
    case 'unknown':
      exact(value, keys)
      return { ...common, outcome: value.outcome }
    default: return fail()
  }
}

/** Validate explicit deployment limits before retaining messages or opening subscriptions.
 * @param input - Untrusted deployment resource budget.
 * @returns Validated budget; throws on missing, extra, or inconsistent limits.
 */
export function parseApplicationBudget(input: unknown): ApplicationBudget {
  const value = object(input)
  exact(value, ['maxRequestBytes', 'maxResultBytes', 'maxTextBytes', 'maxTitleBytes', 'maxRows', 'maxSessions', 'maxSubscriptionsPerGrant', 'maxPendingSubmissionsPerGrant', 'readTimeoutMs', 'subscriptionLifetimeMs'])
  const budget: ApplicationBudget = {
    maxRequestBytes: integer(value.maxRequestBytes, 512, MAX_MOBILE_JSON_BYTES),
    maxResultBytes: integer(value.maxResultBytes, 512, MAX_MOBILE_JSON_BYTES),
    maxTextBytes: integer(value.maxTextBytes, 1, MAX_MOBILE_JSON_BYTES),
    maxTitleBytes: integer(value.maxTitleBytes, 1, 1024),
    maxRows: integer(value.maxRows, 1, 256),
    maxSessions: integer(value.maxSessions, 1, 256),
    maxSubscriptionsPerGrant: integer(value.maxSubscriptionsPerGrant, 1, 64),
    maxPendingSubmissionsPerGrant: integer(value.maxPendingSubmissionsPerGrant, 1, 64),
    readTimeoutMs: integer(value.readTimeoutMs, 100, 60_000),
    subscriptionLifetimeMs: integer(value.subscriptionLifetimeMs, 1000, 3_600_000),
  }
  if (budget.maxTextBytes + 256 > Math.min(budget.maxRequestBytes, budget.maxResultBytes)
    || budget.maxTitleBytes + 256 > budget.maxResultBytes) fail()
  return Object.freeze(budget)
}

/** Parse one decrypted phone request after key confirmation, before PC authorization.
 * @param json - Complete plaintext JSON, bounded before parsing.
 * @param budget - Validated deployment limits.
 * @returns Closed request union; throws on unsupported fields, operations, or limits.
 */
export function parseApplicationRequest(json: string, budget: ApplicationBudget): ApplicationRequest {
  const value = decode(json, budget.maxRequestBytes)
  const common = { v: 1 as const, requestId: requestId(value.requestId) }
  switch (value.type) {
    case 'listSessions':
      exact(value, ['v', 'type', 'requestId', 'limit'], ['cursor', 'view'])
      if (Object.hasOwn(value, 'view') && value.view !== 'navigation') fail()
      return {
        ...common, type: value.type, limit: integer(value.limit, 1, budget.maxSessions), ...optionalCursor(value),
        ...(value.view === 'navigation' ? { view: value.view } : {}),
      }
    case 'listManagementWorkspaces':
      exact(value, ['v', 'type', 'requestId', 'limit'], ['cursor'])
      return { ...common, type: value.type, limit: integer(value.limit, 1, budget.maxSessions), ...optionalCursor(value) }
    case 'createSession':
      exact(value, ['v', 'type', 'requestId', 'operationId', 'sessionId', 'workspaceId'])
      return { ...common, type: value.type, ...managementTarget(value), workspaceId: workspaceId(value.workspaceId) }
    case 'renameSession':
      exact(value, ['v', 'type', 'requestId', 'operationId', 'sessionId', 'title'])
      return { ...common, type: value.type, ...managementTarget(value), title: text(value.title, budget.maxTitleBytes) }
    case 'archiveSession':
      exact(value, ['v', 'type', 'requestId', 'operationId', 'sessionId'])
      return { ...common, type: value.type, ...managementTarget(value) }
    case 'setSessionPinned':
      exact(value, ['v', 'type', 'requestId', 'operationId', 'sessionId', 'pinned'])
      if (typeof value.pinned !== 'boolean') fail()
      return { ...common, type: value.type, ...managementTarget(value), pinned: value.pinned }
    case 'readHistory':
      exact(value, ['v', 'type', 'requestId', 'sessionId', 'limit'], ['cursor'])
      return {
        ...common, type: value.type, sessionId: sessionId(value.sessionId),
        limit: integer(value.limit, 1, budget.maxRows), ...optionalCursor(value),
      }
    case 'watchProgress':
      exact(value, ['v', 'type', 'requestId', 'sessionId'], ['cursor'])
      return { ...common, type: value.type, sessionId: sessionId(value.sessionId), ...optionalCursor(value) }
    case 'submitText':
      exact(value, ['v', 'type', 'requestId', 'sessionId', 'text', 'submissionId'])
      return {
        ...common, type: value.type, sessionId: sessionId(value.sessionId), text: text(value.text, budget.maxTextBytes, true),
        submissionId: brandString<SubmissionId>(fixed(value.submissionId, 16)),
      }
    case 'cancelRead':
      exact(value, ['v', 'type', 'requestId', 'subscriptionId'])
      return { ...common, type: value.type, subscriptionId: subscriptionId(value.subscriptionId) }
    default: return fail()
  }
}

/** Parse one complete PC result; total UTF-8 size includes rows, wrappers, and cursors.
 * @param json - Complete decrypted result JSON.
 * @param budget - Validated deployment limits.
 * @returns Closed result union with approved text fields only; throws on invalid results.
 */
export function parseApplicationResult(json: string, budget: ApplicationBudget): ApplicationResult {
  const value = decode(json, budget.maxResultBytes)
  const base = { v: 1 as const }
  if (value.type === 'progress') {
    exact(value, ['v', 'type', 'subscriptionId', 'sessionId', 'rows', 'status'], ['cursor'])
    return {
      ...base, type: value.type, subscriptionId: subscriptionId(value.subscriptionId), sessionId: sessionId(value.sessionId),
      rows: rows(value.rows, budget), status: status(value.status), ...optionalCursor(value),
    }
  }
  const common = { ...base, requestId: requestId(value.requestId) }
  switch (value.type) {
    case 'managementWorkspaces': return managementWorkspaces(value, budget)
    case 'managed': return managed(value, budget)
    case 'sessions': {
      exact(value, ['v', 'type', 'requestId', 'sessions'], ['cursor'])
      if (!Array.isArray(value.sessions) || value.sessions.length > budget.maxSessions) fail()
      const ids = new Set<MobileSessionId>()
      const sessions = value.sessions.map((item: unknown): SessionSummary => {
        const row = sessionSummary(item, budget)
        if (ids.has(row.sessionId)) fail()
        ids.add(row.sessionId)
        return row
      })
      return { ...common, type: value.type, sessions, ...optionalCursor(value) }
    }
    case 'history':
      exact(value, ['v', 'type', 'requestId', 'sessionId', 'rows'], ['cursor'])
      return {
        ...common, type: value.type, sessionId: sessionId(value.sessionId), rows: rows(value.rows, budget), ...optionalCursor(value),
      }
    case 'watching':
      exact(value, ['v', 'type', 'requestId', 'sessionId', 'subscriptionId'])
      return {
        ...common, type: value.type, sessionId: sessionId(value.sessionId), subscriptionId: subscriptionId(value.subscriptionId),
      }
    case 'submitted':
      exact(value, ['v', 'type', 'requestId', 'sessionId', 'submissionId', 'admission'])
      if (value.admission !== 'inMemoryInbox') fail()
      return {
        ...common, type: value.type, sessionId: sessionId(value.sessionId),
        submissionId: brandString<SubmissionId>(fixed(value.submissionId, 16)), admission: value.admission,
      }
    case 'cancelled':
      exact(value, ['v', 'type', 'requestId', 'subscriptionId'])
      return { ...common, type: value.type, subscriptionId: subscriptionId(value.subscriptionId) }
    case 'error':
      exact(value, ['v', 'type', 'requestId', 'code'])
      if (value.code !== 'denied' && value.code !== 'notFound' && value.code !== 'limit' && value.code !== 'expired' && value.code !== 'unavailable') fail()
      return { ...common, type: value.type, code: value.code }
    default: return fail()
  }
}

/** Encode a phone request with the same wire limits enforced on received requests.
 * @param request - Typed phone operation; submission is always a queued follow-up.
 * @param budget - Validated deployment limits.
 * @returns Complete bounded JSON; throws before encryption on excessive bytes or fields.
 */
export function encodeApplicationRequest(request: ApplicationRequest, budget: ApplicationBudget): string {
  const json = JSON.stringify(request)
  parseApplicationRequest(json, budget)
  return json
}

/** Encode a PC read, volatile submission admission, or management outcome; applied requires a completed Session flush.
 * @param result - Typed PC result; no attachments, arbitrary projections, or URLs as metadata.
 * @param budget - Validated deployment limits.
 * @returns Complete bounded JSON; throws before encryption on excessive bytes or fields.
 */
export function encodeApplicationResult(result: ApplicationResult, budget: ApplicationBudget): string {
  const json = JSON.stringify(result)
  parseApplicationResult(json, budget)
  return json
}
