/** Grant-owned closed phone operations; this dispatcher owns no credentials or transport. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  encodeApplicationRequest, encodeApplicationResult, parseApplicationBudget, parseGeneration,
} from '@deepseek-ai/dsh-companion-protocol'
import type {
  ApplicationBudget, ApplicationRequest, ApplicationResult, GrantId, MobileSessionId,
  MobileOperationId, ReadCursor, SubscriptionId, WorkspaceSummary,
} from '@deepseek-ai/dsh-companion-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  listMobileSessions, MobileViewError, mobileActivityRow, mobileHistoryPage, mobileHistoryRow,
  mobileSessionStatus, requireVisibleSession, sanitizedText,
} from './session-view.ts'
import type { MobileHistoryOptions, SessionListPosition } from './session-view.ts'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { mobileToolCall } from './tool-activity.ts'
import type { MobileToolActivityContext, MobileToolCall } from './tool-activity.ts'
import { executeManagement, rejectManagement } from './session-management.ts'
import type { ManagementRequest } from './session-management.ts'
import { createSessionModels, rejectModelSelection } from './session-models.ts'
import { executeSessionOpen, rejectSessionOpen } from './session-activation.ts'
import type { SessionOpenRequest } from './session-activation.ts'

/** Explicit per-channel policy supplied by the service that owns authorization and transport. */
export interface ApplicationDispatcherOptions {
  /** Aborted on channel disposal, grant revocation, expiry, or authorization generation change. */
  readonly signal: AbortSignal
  /** Synchronously throw unless this exact channel and grant generation still have authority. */
  readonly requireCurrent: () => void
  /** Check current channel authority and read the fresh grant's management permission; never capture a boolean. */
  readonly managementAccess: () => boolean
  /** Fresh independent model-selection permission; chat management never implies it. */
  readonly modelAccess: () => boolean
  /** Fresh independent permission for historical and live tool location/status summaries. */
  readonly toolDetailsAccess: () => boolean
  /** Fresh independent permission to obtain writable ownership of an existing ordinary chat. */
  readonly activationAccess: () => boolean
  readonly grantId: GrantId
  readonly generation: number
  readonly budget: ApplicationBudget
  readonly maxWatches: number
  readonly maxPendingRequests: number
  /** Bounds queued progress messages, pending compact call identities and setup settlements per watch; in-flight send is separate. */
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
  const mutationOperations = new Set<MobileOperationId>()
  let closing: Promise<void> | undefined
  const models = createSessionModels(ctx, { budget, requireCurrent, modelAccess: options.modelAccess })

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
    if (request.type === 'selectSessionModel') return checked(rejectModelSelection(request, code))
    if (request.type === 'openSession') return checked(rejectSessionOpen(request, code))
    return checked('operationId' in request
      ? rejectManagement(request, code)
      : { v: 1, type: 'error', requestId: request.requestId, code })
  }

  function cursorMac(payload: Buffer, sessionId: MobileSessionId | undefined): Buffer {
    return createHmac('sha256', cursorKey)
      .update(JSON.stringify([options.grantId, generation, sessionId ?? null]))
      .update(payload).digest()
  }

  function sealCursor(payload: Buffer, sessionId?: MobileSessionId): ReadCursor {
    return brandString<ReadCursor>(Buffer.concat([payload, cursorMac(payload, sessionId)]).toString('base64url'))
  }

  function openCursor(cursor: ReadCursor, kind: 1 | 2 | 3, sessionId?: MobileSessionId): Buffer {
    const bytes = Buffer.from(cursor, 'base64url')
    const length = kind === 2 ? 25 : 49
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

  function managementCatalog(
    request: Extract<ApplicationRequest, { type: 'listManagementWorkspaces' }>, read: ReadScope,
  ): ApplicationResult {
    requireRead(read)
    if (!options.managementAccess()) {
      return checked({ v: 1, type: 'managementWorkspaces', requestId: request.requestId, enabled: false, workspaces: [] })
    }
    requireRead(read)
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) throw new MobileViewError('unavailable')
    const catalog = registry.list()
    const snapshot = createHash('sha256').update(JSON.stringify(catalog.map(item => [item.id, item.title]))).digest()
    let start = 0
    if (request.cursor !== undefined) {
      const payload = openCursor(request.cursor, 3)
      if (!timingSafeEqual(snapshot, payload.subarray(9, 41))) throw new MobileViewError('expired')
      start = Number(payload.readBigUInt64BE(1))
      if (!Number.isSafeInteger(start) || start < 1 || start >= catalog.length) throw new MobileViewError('expired')
    }
    function continuation(offset: number): ReadCursor {
      const payload = Buffer.alloc(49)
      payload[0] = 3
      payload.writeBigUInt64BE(BigInt(offset), 1)
      snapshot.copy(payload, 9)
      payload.writeBigUInt64BE(BigInt(Date.now() + budget.subscriptionLifetimeMs), 41)
      return sealCursor(payload)
    }
    const workspaces: WorkspaceSummary[] = []
    let end = start
    let result: ApplicationResult = checked({
      v: 1, type: 'managementWorkspaces', requestId: request.requestId, enabled: true, workspaces: [],
    })
    while (end < catalog.length && workspaces.length < request.limit) {
      requireRead(read)
      if (!options.managementAccess()) throw new MobileViewError('denied')
      const item = catalog[end]
      if (item === undefined) throw new MobileViewError('expired')
      try {
        const row = { id: item.id, title: sanitizedText(item.title, budget.maxTitleBytes), order: end }
        const candidate = checked({
          v: 1, type: 'managementWorkspaces', requestId: request.requestId, enabled: true,
          workspaces: [...workspaces, row], ...(end + 1 < catalog.length ? { cursor: continuation(end + 1) } : {}),
        })
        workspaces.push(row)
        result = candidate
        end++
      } catch (error: unknown) {
        if (!(error instanceof MobileViewError) || error.code !== 'limit' || workspaces.length === 0) throw error
        break
      }
    }
    requireRead(read)
    if (!options.managementAccess()) throw new MobileViewError('denied')
    return result
  }

  async function manage(request: ManagementRequest, read: ReadScope): Promise<ApplicationResult> {
    const requireAdmission = (): void => {
      requireRead(read)
      if (!options.managementAccess()) throw new MobileViewError('denied')
      requireRead(read)
    }
    requireAdmission()
    if (mutationOperations.has(request.operationId)) return checked(rejectManagement(request, 'conflict'))
    mutationOperations.add(request.operationId)
    try {
      const result = await executeManagement(ctx, request, {
        budget, signal: read.signal, requireAdmission, errorCode: error => errorCode(error, read),
      })
      // Revocation withdraws the reply, not the admitted write or its targeted flush.
      if (result.outcome !== 'rejected') {
        try { requireAdmission() } catch (_error: unknown) {
          return checked({ v: 1, type: 'managed', requestId: request.requestId, operationId: request.operationId,
            sessionId: request.sessionId, action: result.action, outcome: 'unknown' })
        }
      }
      return checked(result)
    } finally { mutationOperations.delete(request.operationId) }
  }

  async function openSession(request: SessionOpenRequest, read: ReadScope): Promise<ApplicationResult> {
    const requireAdmission = (): void => {
      requireRead(read)
      if (!options.activationAccess()) throw new MobileViewError('denied')
      requireRead(read)
    }
    requireAdmission()
    if (mutationOperations.has(request.operationId)) return checked(rejectSessionOpen(request, 'conflict'))
    mutationOperations.add(request.operationId)
    try {
      return checked(await executeSessionOpen(ctx, request, {
        budget, signal: read.signal, requireAdmission, errorCode: error => errorCode(error, read),
      }))
    } finally { mutationOperations.delete(request.operationId) }
  }

  function toolDetailsRead(cwd: string, read: ReadScope): MobileHistoryOptions['toolDetails'] {
    if (!options.toolDetailsAccess()) return undefined
    return { cwd, requireCurrent: () => {
      requireRead(read)
      if (!options.toolDetailsAccess()) throw new MobileViewError('denied')
    } }
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
    const toolDetails = toolDetailsRead(observation.header.cwd, read)
    const page = mobileHistoryPage(observation.events, {
      ...cut, limit: request.limit, budget, requireCurrent: () => { requireRead(read) },
      ...(toolDetails === undefined ? {} : { toolDetails }),
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
    const targetAgent = ctx.agents.get(request.sessionId)
    if (targetAgent === undefined || ctx.sessions.get(request.sessionId) !== targetAgent.session) {
      throw new MobileViewError('unavailable')
    }
    const requestId = brandString<SessionRequestId>(`phone-${createHash('sha256')
      .update(JSON.stringify(['phoneSubmissionId', options.grantId, request.sessionId, request.submissionId]))
      .digest('hex')}`)
    let task = submissions.get(requestId)
    if (task === undefined) {
      if (submissions.size >= budget.maxPendingSubmissionsPerGrant) throw new MobileViewError('limit')
      const admission = (): void => {
        requireCurrent()
        if (ctx.agents.get(request.sessionId) !== targetAgent || ctx.sessions.get(request.sessionId) !== targetAgent.session) {
          throw new MobileViewError('unavailable')
        }
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
    const calls = new Map<SessionSeq, MobileToolCall>()
    const settledDuringSetup = new Set<SessionSeq>()
    const cwd = session.header.cwd
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
      calls.clear()
      settledDuringSetup.clear()
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

    function retainCall(call: MobileToolCall): void {
      if (calls.size >= options.maxProgressBuffer) throw new MobileViewError('limit')
      calls.set(call.seq, call)
    }
    function rememberSettlement(sequence: SessionSeq): void {
      calls.delete(sequence)
      if (!initialized) {
        if (settledDuringSetup.size >= options.maxProgressBuffer) throw new MobileViewError('limit')
        settledDuringSetup.add(sequence)
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
        const detailsAllowed = options.toolDetailsAccess()
        const call = mobileToolCall(event)
        if (detailsAllowed && call !== undefined) retainCall(call)
        const context: MobileToolActivityContext | undefined = detailsAllowed
          ? { cwd, budget, callAt: sequence => calls.get(sequence) } : undefined
        const row = mobileHistoryRow(event, budget) ?? mobileActivityRow(event, budget, context)
        if (detailsAllowed && event.type === 'tool/result' && event.sourceEventSeqs?.length === 1) {
          const source = event.sourceEventSeqs[0]
          if (source !== undefined) rememberSettlement(source)
        }
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
      if (options.toolDetailsAccess()) {
        const laterCalls = [...calls.values()].filter(call => call.seq >= cut)
        calls.clear()
        for (const event of observation.events) {
          requireRead(read)
          const call = mobileToolCall(event)
          if (call !== undefined) retainCall(call)
          else if (event.type === 'tool/result' && event.sourceEventSeqs?.length === 1) {
            const source = event.sourceEventSeqs[0]
            if (source !== undefined) calls.delete(source)
          }
        }
        for (const call of laterCalls) retainCall(call)
        for (const sequence of settledDuringSetup) calls.delete(sequence)
      }
      settledDuringSetup.clear()
      const toolDetails = toolDetailsRead(observation.header.cwd, read)
      const replay = request.cursor === undefined ? cut : historyPosition(request.cursor, request.sessionId).offset
      if (replay > cut) throw new MobileViewError('expired')
      const page = request.cursor === undefined ? { rows: [], nextOffset: cut } : mobileHistoryPage(
        observation.events, {
          offset: replay, through: cut, limit: budget.maxRows, budget, requireCurrent: () => { requireRead(read) },
          ...(toolDetails === undefined ? {} : { toolDetails }),
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
    try { encodeApplicationRequest(request, budget) } catch (error: unknown) {
      if ('operationId' in request || request.type === 'listManagementWorkspaces') {
        throw new MobileViewError('limit', { cause: error })
      }
      throw error
    }
    switch (request.type) {
      case 'listSessionModels': return models.list(request, () => { requireRead(read) }, read.signal)
      case 'selectSessionModel': return models.select(request, () => { requireRead(read) }, read.signal)
      case 'getSessionActivation': return checked({ v: 1, type: 'sessionActivation', requestId: request.requestId,
        enabled: options.activationAccess() })
      case 'openSession': return openSession(request, read)
      case 'listManagementWorkspaces': return managementCatalog(request, read)
      case 'createSession':
      case 'renameSession':
      case 'archiveSession':
      case 'setSessionPinned': return manage(request, read)
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
          ...(request.view === undefined ? {} : { view: request.view }),
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

  function stopReaders(): void {
    models.close()
    for (const owned of [...watches.values()]) owned.stop()
  }
  signal.addEventListener('abort', stopReaders, { once: true })

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
        stopReaders()
        lifetime.abort()
        signal.removeEventListener('abort', stopReaders)
        await Promise.allSettled([...requests, ...sends])
        cursorKey.fill(0)
      })()
      return closing
    },
  }
}
