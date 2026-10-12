/** Grant-owned closed phone operations; this dispatcher owns no credentials or transport. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  encodeApplicationRequest, encodeApplicationResult, parseApplicationBudget, parseGeneration,
} from '@deepseek-ai/dsh-companion-protocol'
import type {
  ApplicationBudget, ApplicationRequest, ApplicationResult, GrantId, MobileSessionId,
  ReadCursor, SubscriptionId,
} from '@deepseek-ai/dsh-companion-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  listMobileSessions, MobileViewError, mobileActivityRow, mobileHistoryPage, mobileHistoryRow,
  mobileSessionStatus, requireVisibleSession,
} from './session-view.ts'
import type { SessionListPosition } from './session-view.ts'

/** Explicit per-channel policy supplied by the service that owns authorization and transport. */
export interface ApplicationDispatcherOptions {
  /** Aborted on channel disposal, grant revocation, expiry, or authorization generation change. */
  readonly signal: AbortSignal
  /** Synchronously throw unless this exact channel and grant generation still have authority. */
  readonly requireCurrent: () => void
  readonly grantId: GrantId
  readonly generation: number
  readonly budget: ApplicationBudget
  readonly maxWatches: number
  readonly maxPendingRequests: number
  /** Maximum queued complete progress messages per watch; the in-flight send is separate. */
  readonly maxProgressBuffer: number
  /** Send a complete result; the carrier must bound send time and settle sends on channel abort. */
  readonly sendProgress: (result: ApplicationResult) => Promise<void>
}

/** One channel's dispatcher and all read subscriptions it owns. */
export interface ApplicationDispatcher {
  /**
   * Authorize and dispatch only a parsed closed phone request.
   * @param request - Shared validated application request.
   * @returns a fully encodable result; submitted acknowledges only volatile inbox admission.
   */
  dispatch(request: ApplicationRequest): Promise<ApplicationResult>
  /** Close listeners before aborting pending admissions, then await requests and sends. */
  close(): Promise<void>
}

interface ReadScope {
  readonly signal: AbortSignal
  readonly deadlineAt: number
}

interface HistoryPosition {
  readonly offset: number
  readonly through: number
}

interface OwnedWatch {
  stop(): void
}

type ErrorCode = Extract<ApplicationResult, { type: 'error' }>['code']

/**
 * Create one grant-generation dispatcher with context-bound signed cursors and owned cancellation.
 * Initial watches publish a status-only live cut; reconnect cursors replay complete committed text.
 * Assistant start/end activity is live, but partial deltas are never exported or retained.
 * @param ctx - Host Session, query, controller, Agent, and Workspace capabilities.
 * @param options - Explicit grant authority, resource limits, cancellation, and bounded sender.
 * @returns the channel-owned dispatcher; close before releasing its transport owner.
 */
export function createApplicationDispatcher(
  ctx: Context, options: ApplicationDispatcherOptions,
): ApplicationDispatcher {
  const budget = parseApplicationBudget(options.budget)
  for (const [name, value] of [
    ['maxWatches', options.maxWatches], ['maxPendingRequests', options.maxPendingRequests],
    ['maxProgressBuffer', options.maxProgressBuffer],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`companion: ${name} must be a positive safe integer`)
  }
  if (options.maxWatches > budget.maxSubscriptionsPerGrant) throw new TypeError('companion: maxWatches exceeds the application budget')
  const generation = parseGeneration(options.generation)
  const lifetime = new AbortController()
  const signal = AbortSignal.any([options.signal, lifetime.signal])
  const cursorKey = randomBytes(32)
  const watches = new Map<SubscriptionId, OwnedWatch>()
  const requests = new Set<Promise<ApplicationResult>>()
  const sends = new Set<Promise<void>>()
  const submissions = new Map<SessionRequestId, Promise<void>>()
  let closing: Promise<void> | undefined

  function requireCurrent(): void {
    if (signal.aborted) throw new RemoteError('gateway/cancelled', 'companion admission was cancelled', {})
    try { options.requireCurrent() } catch (error: unknown) {
      throw new RemoteError('gateway/cancelled', 'companion authorization is no longer current', {}, { cause: error })
    }
  }

  function requireRead(read: ReadScope): void {
    requireCurrent()
    if (read.signal.aborted || Date.now() >= read.deadlineAt) throw new MobileViewError('expired')
  }

  function checked(result: ApplicationResult): ApplicationResult {
    try { encodeApplicationResult(result, budget) } catch (error: unknown) {
      throw new MobileViewError('limit', { cause: error })
    }
    return result
  }

  function failure(request: ApplicationRequest, code: ErrorCode): ApplicationResult {
    return checked({ v: 1, type: 'error', requestId: request.requestId, code })
  }

  function cursorMac(payload: Buffer, sessionId: MobileSessionId | undefined): Buffer {
    return createHmac('sha256', cursorKey)
      .update(JSON.stringify([options.grantId, generation, sessionId ?? null]))
      .update(payload).digest()
  }

  function sealCursor(payload: Buffer, sessionId?: MobileSessionId): ReadCursor {
    return brandString<ReadCursor>(Buffer.concat([payload, cursorMac(payload, sessionId)]).toString('base64url'))
  }

  function openCursor(cursor: ReadCursor, kind: 1 | 2, sessionId?: MobileSessionId): Buffer {
    const bytes = Buffer.from(cursor, 'base64url')
    const length = kind === 1 ? 49 : 25
    if (bytes.length !== length + 32 || bytes.toString('base64url') !== cursor) throw new MobileViewError('denied')
    const payload = bytes.subarray(0, length)
    if (payload[0] !== kind || !timingSafeEqual(bytes.subarray(length), cursorMac(payload, sessionId))) {
      throw new MobileViewError('denied')
    }
    if (payload.readBigUInt64BE(length - 8) <= BigInt(Date.now())) throw new MobileViewError('expired')
    return payload
  }

  function listCursor(key: SessionListPosition): ReadCursor {
    const payload = Buffer.alloc(49)
    payload[0] = 1
    payload.writeBigUInt64BE(BigInt(key.createdAt), 1)
    key.identity.copy(payload, 9)
    payload.writeBigUInt64BE(BigInt(Date.now() + budget.subscriptionLifetimeMs), 41)
    return sealCursor(payload)
  }

  function historyCursor(sessionId: MobileSessionId, offset: number, through: number): ReadCursor {
    const payload = Buffer.alloc(25)
    payload[0] = 2
    payload.writeBigUInt64BE(BigInt(offset), 1)
    payload.writeBigUInt64BE(BigInt(through), 9)
    payload.writeBigUInt64BE(BigInt(Date.now() + budget.subscriptionLifetimeMs), 17)
    return sealCursor(payload, sessionId)
  }

  function historyPosition(cursor: ReadCursor, sessionId: MobileSessionId): HistoryPosition {
    const payload = openCursor(cursor, 2, sessionId)
    const offset = Number(payload.readBigUInt64BE(1))
    const through = Number(payload.readBigUInt64BE(9))
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(through) || offset > through) throw new MobileViewError('denied')
    return { offset, through }
  }

  async function history(
    request: Extract<ApplicationRequest, { type: 'readHistory' }>, read: ReadScope,
  ): Promise<ApplicationResult> {
    using observation = await ctx.sessionQuery.observeSession(request.sessionId, { signal: read.signal, projectionMode: 'none' })
    requireRead(read)
    requireVisibleSession(ctx, observation.header)
    const count = observation.cursor + 1
    const cut = request.cursor === undefined ? { offset: 0, through: count } : historyPosition(request.cursor, request.sessionId)
    if (cut.through > count) throw new MobileViewError('expired')
    const page = mobileHistoryPage(observation.events, {
      ...cut, limit: request.limit, budget, requireCurrent: () => { requireRead(read) },
    })
    const rows = [...page.rows]
    let nextOffset = page.nextOffset
    for (;;) {
      const result: ApplicationResult = {
        v: 1, type: 'history', requestId: request.requestId, sessionId: request.sessionId, rows,
        ...(nextOffset < cut.through ? { cursor: historyCursor(request.sessionId, nextOffset, cut.through) } : {}),
      }
      try { return checked(result) } catch (error: unknown) {
        if (!(error instanceof MobileViewError) || error.code !== 'limit' || rows.length <= 1) throw error
        const removed = rows.pop()
        if (removed === undefined) throw error
        nextOffset = Number(Buffer.from(removed.seq, 'base64url').readBigUInt64BE())
      }
    }
  }

  async function submit(
    request: Extract<ApplicationRequest, { type: 'submitText' }>, read: ReadScope,
  ): Promise<ApplicationResult> {
    const admissionSignal = read.signal
    if (request.text.trim().length === 0) throw new MobileViewError('denied')
    using observation = await ctx.sessionQuery.observeSession(request.sessionId, { signal: admissionSignal, projectionMode: 'none' })
    requireRead(read)
    requireVisibleSession(ctx, observation.header)
    const requestId = brandString<SessionRequestId>(`phone-${createHash('sha256')
      .update(JSON.stringify(['phoneSubmissionId', options.grantId, request.sessionId, request.submissionId]))
      .digest('hex')}`)
    let task = submissions.get(requestId)
    if (task === undefined) {
      if (submissions.size >= budget.maxPendingSubmissionsPerGrant) throw new MobileViewError('limit')
      const admission = (): void => {
        requireCurrent()
        if (admissionSignal.aborted || Date.now() >= read.deadlineAt) {
          throw new RemoteError('gateway/cancelled', 'companion admission was cancelled', {})
        }
        const current = ctx.sessions.get(request.sessionId)
        requireVisibleSession(ctx, current?.header ?? observation.header)
      }
      const acknowledgement = checked({
        v: 1, type: 'submitted', requestId: request.requestId, sessionId: request.sessionId,
        submissionId: request.submissionId, admission: 'inMemoryInbox',
      })
      task = ctx.sessionController.admitPrompt({
        requestId, sessionId: request.sessionId, mode: 'queue', content: [{ type: 'text', text: request.text }],
      }, admission).then(() => undefined)
      submissions.set(requestId, task)
      try { await task } finally { submissions.delete(requestId) }
      // Admission is the receipt's commit point; cancellation after it cannot retract the receipt.
      return acknowledgement
    }
    await task
    return checked({
      v: 1, type: 'submitted', requestId: request.requestId, sessionId: request.sessionId,
      submissionId: request.submissionId, admission: 'inMemoryInbox',
    })
  }

  async function watch(
    request: Extract<ApplicationRequest, { type: 'watchProgress' }>, read: ReadScope,
  ): Promise<ApplicationResult> {
    if (watches.size >= options.maxWatches) throw new MobileViewError('limit')
    const currentSession = ctx.sessions.get(request.sessionId)
    if (currentSession === undefined) throw new MobileViewError('unavailable')
    const session = currentSession
    requireVisibleSession(ctx, session.header)
    const subscriptionId = brandString<SubscriptionId>(randomBytes(16).toString('base64url'))
    const acknowledgement = checked({ v: 1, type: 'watching', requestId: request.requestId, sessionId: request.sessionId, subscriptionId })
    const queue: ApplicationResult[] = []
    const disposers: (() => void)[] = []
    let stopped = false
    let initialized = false
    let sending = false
    let cut: number = session.seq
    let terminalCode: ErrorCode | undefined
    let immediate: ReturnType<typeof setImmediate> | undefined

    function detach(): void {
      if (stopped) return
      stopped = true
      for (const dispose of disposers.splice(0)) dispose()
      clearTimeout(timer)
    }

    function stop(): void {
      detach()
      watches.delete(subscriptionId)
      queue.length = 0
      if (immediate !== undefined) clearImmediate(immediate)
      immediate = undefined
    }

    function requireWatch(): void {
      requireCurrent()
      if (ctx.sessions.get(request.sessionId) !== session) throw new MobileViewError('unavailable')
      requireVisibleSession(ctx, session.header)
    }

    function schedule(): void {
      if (!initialized || sending || immediate !== undefined || queue.length === 0) return
      immediate = setImmediate(() => {
        immediate = undefined
        sending = true
        const task = (async () => {
          while (queue.length > 0) {
            requireWatch()
            const result = queue.shift()
            if (result === undefined) break
            await options.sendProgress(result)
          }
        })().catch((_error: unknown) => {
          // Transport or authority failure ends this read; no PC diagnostics reach the phone.
          stop()
        }).finally(() => {
          sending = false
          sends.delete(task)
          if (stopped && queue.length === 0) watches.delete(subscriptionId)
          schedule()
        })
        sends.add(task)
      })
    }

    function terminate(code: ErrorCode): void {
      if (stopped) return
      terminalCode = code
      detach()
      queue.length = 0
      queue.push(failure(request, code))
      schedule()
    }

    function enqueue(result: ApplicationResult): void {
      if (stopped) return
      try {
        requireWatch()
        checked(result)
        if (queue.length >= options.maxProgressBuffer) {
          terminate('limit')
          return
        }
        queue.push(result)
        schedule()
      } catch (error: unknown) {
        if (error instanceof MobileViewError && error.code === 'limit') terminate('limit')
        else stop()
      }
    }

    function progress(rows: Extract<ApplicationResult, { type: 'progress' }>['rows'], offset: number): ApplicationResult {
      return {
        v: 1, type: 'progress', subscriptionId, sessionId: request.sessionId, rows,
        status: mobileSessionStatus(ctx, request.sessionId), cursor: historyCursor(request.sessionId, offset, offset),
      }
    }

    const timer = setTimeout(() => { terminate('expired') }, budget.subscriptionLifetimeMs)
    timer.unref()
    watches.set(subscriptionId, { stop })
    // Listeners precede the baseline cut; only sanitized complete values enter the bounded queue.
    disposers.push(ctx.on('session/event', (current, event) => {
      if (current !== session || stopped) return
      try {
        requireWatch()
        if (event.seq < cut) return
        const row = mobileHistoryRow(event, budget) ?? mobileActivityRow(event, budget)
        if (row !== undefined || event.type === 'agent/inbox/spliced' || event.type === 'turn/end') {
          enqueue(progress(row === undefined ? [] : [row], event.seq + 1))
        }
      } catch (error: unknown) {
        if (error instanceof MobileViewError && error.code === 'limit') terminate('limit')
        else stop()
      }
    }))
    disposers.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent.session === session && !stopped && frame.type !== 'chunk') enqueue(progress([], session.seq))
    }))
    disposers.push(ctx.on('agent/status', ({ agent }) => {
      if (agent.session === session && !stopped) enqueue(progress([], session.seq))
    }))
    disposers.push(ctx.on('session/disposed', (current) => { if (current === session) stop() }))
    disposers.push(ctx.on('agent/disposed', ({ agent }) => { if (agent.session === session) stop() }))
    try {
      using observation = await ctx.sessionQuery.observeSession(request.sessionId, { signal: read.signal, projectionMode: 'none' })
      requireRead(read)
      requireWatch()
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- deadline/event callbacks can stop this watch during observation.
      if (stopped) throw new MobileViewError(terminalCode ?? 'unavailable')
      if (observation.source !== 'live') throw new MobileViewError('unavailable')
      requireVisibleSession(ctx, observation.header)
      cut = observation.cursor + 1
      const replay = request.cursor === undefined ? cut : historyPosition(request.cursor, request.sessionId).offset
      if (replay > cut) throw new MobileViewError('expired')
      const page = request.cursor === undefined ? { rows: [], nextOffset: cut } : mobileHistoryPage(
        observation.events, {
          offset: replay, through: cut, limit: budget.maxRows, budget, requireCurrent: () => { requireRead(read) },
        },
      )
      if (page.nextOffset < cut) throw new MobileViewError('limit')
      const rows = page.rows
      // Pre-baseline notifications are represented by this exact cut; later notifications remain queued.
      const later = queue.filter(result => result.type === 'progress'
        && result.cursor !== undefined && historyPosition(result.cursor, request.sessionId).offset > cut)
      queue.length = 0
      queue.push(checked(progress(rows, cut)), ...later)
      if (queue.length > options.maxProgressBuffer) throw new MobileViewError('limit')
      initialized = true
      schedule()
      return acknowledgement
    } catch (error: unknown) {
      stop()
      throw error
    }
  }

  async function run(request: ApplicationRequest, read: ReadScope): Promise<ApplicationResult> {
    requireRead(read)
    encodeApplicationRequest(request, budget)
    switch (request.type) {
      case 'listSessions': {
        let after: SessionListPosition | undefined
        if (request.cursor !== undefined) {
          const payload = openCursor(request.cursor, 1)
          const createdAt = Number(payload.readBigUInt64BE(1))
          if (!Number.isSafeInteger(createdAt)) throw new MobileViewError('denied')
          after = { createdAt, identity: payload.subarray(9, 41) }
        }
        const page = await listMobileSessions(ctx, {
          limit: request.limit, after, budget, signal: read.signal, requireCurrent: () => { requireRead(read) },
        })
        requireRead(read)
        return checked({
          v: 1, type: 'sessions', requestId: request.requestId, sessions: page.sessions,
          ...(page.next === undefined ? {} : { cursor: listCursor(page.next) }),
        })
      }
      case 'readHistory': return history(request, read)
      case 'watchProgress': return watch(request, read)
      case 'submitText': return submit(request, read)
      case 'cancelRead':
        watches.get(request.subscriptionId)?.stop()
        return checked({ v: 1, type: 'cancelled', requestId: request.requestId, subscriptionId: request.subscriptionId })
      default: return assertNever(request, 'companion application request')
    }
  }

  function errorCode(error: unknown, read: ReadScope): ErrorCode {
    if (signal.aborted) return 'denied'
    if (read.signal.aborted || Date.now() >= read.deadlineAt) return 'expired'
    if (error instanceof MobileViewError) return error.code
    if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return 'notFound'
    if (error instanceof RemoteError && error.code === 'session/not-found') return 'notFound'
    if (error instanceof RemoteError && error.code === 'gateway/cancelled') return 'denied'
    return 'unavailable'
  }

  function stopWatches(): void {
    for (const owned of [...watches.values()]) owned.stop()
  }
  signal.addEventListener('abort', stopWatches, { once: true })

  return {
    dispatch(request) {
      try { requireCurrent() } catch (_error: unknown) { return Promise.resolve(failure(request, 'denied')) }
      if (requests.size >= options.maxPendingRequests) return Promise.resolve(failure(request, 'limit'))
      const deadline = new AbortController()
      const readSignal = AbortSignal.any([signal, deadline.signal])
      const timer = setTimeout(() => { deadline.abort() }, budget.readTimeoutMs)
      timer.unref()
      const read: ReadScope = { signal: readSignal, deadlineAt: Date.now() + budget.readTimeoutMs }
      const task = run(request, read).catch((error: unknown) => failure(request, errorCode(error, read)))
        .finally(() => {
          clearTimeout(timer)
          requests.delete(task)
        })
      requests.add(task)
      return task
    },
    close() {
      closing ??= (async () => {
        stopWatches()
        lifetime.abort()
        signal.removeEventListener('abort', stopWatches)
        await Promise.allSettled([...requests, ...sends])
        cursorKey.fill(0)
      })()
      return closing
    },
  }
}
