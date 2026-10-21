/** Non-activating, bounded phone projections; raw tool payloads and reasoning stay PC-local. */
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {
  ApplicationBudget, HistoryRow, HistorySequence, SessionSummary,
} from '@deepseek-ai/dsh-companion-protocol'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'

/** Safe mobile failures carry no PC diagnostic or payload text. */
export class MobileViewError extends Error {
  /** @param code - Closed phone-facing failure category. */
  constructor(readonly code: 'denied' | 'notFound' | 'limit' | 'expired' | 'unavailable', options?: ErrorOptions) {
    super(`companion application: ${code}`, options)
  }
}

/** Explicit limits and authorization check for one bounded list read. */
export interface MobileSessionListOptions {
  /** Omission preserves the legacy three-field Session summary. */
  readonly view?: 'navigation'
  readonly limit: number
  readonly after: SessionListPosition | undefined
  readonly budget: ApplicationBudget
  readonly signal: AbortSignal
  readonly requireCurrent: () => void
}

/** Explicit cut, row budget, and authorization check for one history projection. */
export interface MobileHistoryOptions {
  readonly offset: number
  readonly through: number
  readonly limit: number
  readonly budget: ApplicationBudget
  readonly requireCurrent: () => void
}

/** Stable header-only ordering key for a list continuation. */
export interface SessionListPosition {
  readonly createdAt: number
  readonly identity: Buffer
}

/** One bounded list page, with an anchor only when another row exists. */
export interface MobileSessionPage {
  readonly sessions: readonly SessionSummary[]
  readonly next?: SessionListPosition
}

/** Exact projected history prefix; nextOffset points before the first unreturned row. */
export interface MobileHistoryPage {
  readonly rows: readonly HistoryRow[]
  readonly nextOffset: number
}

/**
 * Reject hidden, archived, and subagent-owned identities without activating an Agent.
 * @param ctx - Host registries used for live ownership and archival checks.
 * @param header - Existing Session identity being addressed.
 * @returns normally only for an ordinary visible Session.
 */
export function requireVisibleSession(ctx: Context, header: SessionHeader): void {
  const workspaces = ctx.get('workspaceRegistry')
  if (workspaces === undefined) throw new MobileViewError('unavailable')
  if (header.cwd === undefined || header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
    || workspaces.archivedSessionIds.includes(header.id)) throw new MobileViewError('denied')
  const parent = header.parentSession === undefined ? undefined : ctx.agents.get(header.parentSession)
  if (parent !== undefined && ctx.agents.isOwnedBy(header.id, parent)) throw new MobileViewError('denied')
  let directory: boolean
  try { directory = statSync(header.cwd).isDirectory() } catch (_error: unknown) {
    // Unresolvable working directories are not visible phone targets.
    throw new MobileViewError('denied')
  }
  if (!directory) throw new MobileViewError('denied')
}

/**
 * Read live queue/activity status without resolving or resuming an Agent.
 * @param ctx - Host Agent registry.
 * @param sessionId - Existing Session identity.
 * @returns cold Sessions are closed; queued input is not execution completion.
 */
export function mobileSessionStatus(ctx: Context, sessionId: SessionId): SessionSummary['status'] {
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined || ctx.sessions.get(sessionId) !== agent.session) return 'closed'
  if (agent.status === 'running') return 'running'
  if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) return 'queued'
  return 'idle'
}

function position(header: SessionHeader): SessionListPosition {
  return { createdAt: header.createdAt, identity: createHash('sha256').update(header.id).digest() }
}

function compare(left: SessionListPosition, right: SessionListPosition): number {
  return right.createdAt - left.createdAt || Buffer.compare(left.identity, right.identity)
}

/**
 * Project at most limit summaries, retaining only limit + 1 header candidates.
 * Persistence exposes an all-header listing, but no Session log or complete list projection is copied.
 * @param ctx - Session and Workspace registries with cached title and human-prompt activity projections.
 * @param options - Validated page, field, cancellation, and synchronous authorization limits.
 * @returns a deterministic created-time page of visible Sessions; navigation requires its explicit view.
 */
export async function listMobileSessions(
  ctx: Context, options: MobileSessionListOptions,
): Promise<MobileSessionPage> {
  const { view, limit, after, budget, signal, requireCurrent } = options
  requireCurrent()
  const candidates: { header: SessionHeader; key: SessionListPosition }[] = []
  const consider = (header: SessionHeader): void => {
    requireCurrent()
    signal.throwIfAborted()
    try { requireVisibleSession(ctx, header) } catch (error: unknown) {
      if (error instanceof MobileViewError && error.code === 'denied') return
      throw error
    }
    const key = position(header)
    if (after !== undefined && compare(key, after) <= 0) return
    const index = candidates.findIndex(item => compare(key, item.key) < 0)
    candidates.splice(index < 0 ? candidates.length : index, 0, { header, key })
    if (candidates.length > limit + 1) candidates.pop()
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    const stored = await persistence.list({ signal })
    requireCurrent()
    signal.throwIfAborted()
    for (const item of stored) {
      if (ctx.sessions.get(item.header.id) === undefined) consider(item.header)
    }
  }
  for (const session of ctx.sessions.list()) consider(session.header)
  const sessions: SessionSummary[] = []
  for (const item of candidates.slice(0, limit)) {
    requireCurrent()
    signal.throwIfAborted()
    sessions.push(mobileSessionSummary(ctx, item.header, budget, view))
  }
  const last = candidates[limit - 1]
  return { sessions, ...(candidates.length > limit && last !== undefined ? { next: last.key } : {}) }
}

/**
 * Project one visible Session without activating its Agent or reading its log.
 * @param ctx - Host registries and cached projections.
 * @param header - Existing Session identity; visibility is checked even for management replies.
 * @param budget - UTF-8 field limits.
 * @param view - Explicit navigation opt-in; omission preserves legacy rows.
 * @returns the approved summary, with navigation only when requested.
 */
export function mobileSessionSummary(
  ctx: Context, header: SessionHeader, budget: ApplicationBudget, view?: 'navigation',
): SessionSummary {
  requireVisibleSession(ctx, header)
  const registry = view === 'navigation' ? ctx.get('workspaceRegistry') : undefined
  if (view === 'navigation' && registry === undefined) throw new MobileViewError('unavailable')
  const keys = view === 'navigation' ? ['title', 'sessionListMetadata'] as const : ['title'] as const
  const live = ctx.sessions.get(header.id)
  const projections = live === undefined
    ? ctx.get('sessionProjectionCache')?.cachedSnapshot(header, keys)
    : ctx.get('sessionProjections')?.cachedSnapshot(live, keys)
  const summary: SessionSummary = {
    sessionId: header.id, title: sanitizedText(projections?.values.title ?? '', budget.maxTitleBytes),
    status: mobileSessionStatus(ctx, header.id),
  }
  if (registry === undefined) return summary
  const workspaces = registry.list()
  const order = workspaces.findIndex(workspace => workspace.sessionIds.includes(header.id))
  const workspace = workspaces[order]
  const pinOrder = registry.pinnedSessionIds.indexOf(header.id)
  return {
    ...summary,
    navigation: {
      updatedAt: Math.max(header.createdAt, projections?.values.sessionListMetadata?.lastPromptAt ?? 0),
      pinOrder: pinOrder < 0 ? null : pinOrder,
      workspace: workspace === undefined ? null : {
        id: workspace.id, title: sanitizedText(workspace.title, budget.maxTitleBytes), order,
      },
    },
  }
}

/**
 * Remove URI targets and control characters from literal phone text; never shorten a row.
 * @param text - First-party visible text, never a tool result or reasoning block.
 * @param maxBytes - Explicit UTF-8 field limit.
 * @returns sanitized complete text; throws limit rather than silently truncating.
 */
export function sanitizedText(text: string, maxBytes: number): string {
  if (!text.isWellFormed() || Buffer.byteLength(text, 'utf8') > maxBytes) throw new MobileViewError('limit')
  const safe = text.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|file|mailto|data|javascript):|www\.)[^\s<>"']*/giu, '[link omitted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
  if (Buffer.byteLength(safe, 'utf8') > maxBytes) throw new MobileViewError('limit')
  return safe
}

function visibleText(content: readonly ContentBlock[], budget: ApplicationBudget): string | undefined {
  const texts: string[] = []
  let bytes = 0
  for (const block of content) {
    // Content blocks are merge-extensible; only declared visible text is exported.
    if (block.type !== 'text') continue
    bytes += Buffer.byteLength(block.text, 'utf8') + (texts.length === 0 ? 0 : 1)
    if (bytes > budget.maxTextBytes) throw new MobileViewError('limit')
    texts.push(block.text)
  }
  return texts.length === 0 ? undefined : sanitizedText(texts.join('\n'), budget.maxTextBytes)
}

function row(seq: number, role: HistoryRow['role'], text: string): HistoryRow {
  const encoded = Buffer.alloc(8)
  encoded.writeBigUInt64BE(BigInt(seq))
  return { seq: brandString<HistorySequence>(encoded.toString('base64url')), id: `event-${seq}`, role, text }
}

/**
 * Project only human user text and assistant visible text from one durable event.
 * @param event - Immutable Session event from the caller's observation or live listener.
 * @param budget - Explicit per-row UTF-8 limit.
 * @returns one complete row, or undefined for every other event and block kind.
 */
export function mobileHistoryRow(event: SessionEvent, budget: ApplicationBudget): HistoryRow | undefined {
  let role: 'user' | 'assistant'
  let content: readonly ContentBlock[]
  switch (event.type) {
    case 'user/message':
      if (event.data.source.kind !== 'user') return undefined
      role = 'user'
      content = event.data.content
      break
    case 'assistant/message':
      role = 'assistant'
      content = event.data.message.content
      break
    // Session events are merge-extensible; undeclared phone projections stay private.
    default: return undefined
  }
  const text = visibleText(content, budget)
  return text === undefined ? undefined : row(event.seq, role, text)
}

/**
 * Project a bounded chronological page from an immutable caller-owned log cut.
 * @param events - Observation events, never acquired through SessionController.follow.
 * @param options - Verified immutable cut, complete-row budget, and synchronous authorization/deadline check.
 * @returns exact rows and the first unconsumed offset; oversized rows fail explicitly.
 */
export function mobileHistoryPage(
  events: readonly SessionEvent[], options: MobileHistoryOptions,
): MobileHistoryPage {
  const { offset, through, limit, budget, requireCurrent } = options
  const rows: HistoryRow[] = []
  let nextOffset = offset
  for (; nextOffset < through; nextOffset++) {
    requireCurrent()
    const event = events[nextOffset]
    if (event === undefined) throw new MobileViewError('expired')
    if (rows.length === limit) {
      const content = event.type === 'user/message' && event.data.source.kind === 'user'
        ? event.data.content : event.type === 'assistant/message' ? event.data.message.content : undefined
      if (content?.some(block => block.type === 'text') === true) break
      continue
    }
    const projected = mobileHistoryRow(event, budget)
    if (projected !== undefined) rows.push(projected)
  }
  return { rows, nextOffset }
}

/**
 * Project live tool activity using a restricted name or a fixed notice, never payloads.
 * @param event - One committed live event.
 * @param budget - Explicit phone text limit.
 * @returns a tool/notice row only for safe activity categories.
 */
export function mobileActivityRow(event: SessionEvent, budget: ApplicationBudget): HistoryRow | undefined {
  switch (event.type) {
    case 'tool/call': {
      const name = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/u.test(event.data.name)
        ? event.data.name : 'tool'
      return row(event.seq, 'tool', sanitizedText(name, budget.maxTextBytes))
    }
    case 'tool/result': return row(event.seq, 'notice', sanitizedText('Tool completed', budget.maxTextBytes))
    case 'turn/end':
      if (event.data.reason.kind === 'error') return row(event.seq, 'notice', sanitizedText('Turn failed', budget.maxTextBytes))
      return undefined
    default: return undefined
  }
}
