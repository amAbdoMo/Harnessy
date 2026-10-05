/** Host-owned request handoff and correlated native operations over the private parent channel. */
import type { Context } from '@deepseek-ai/cordis'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  DesktopWebsiteHostSnapshot,
  DesktopWebsiteOperationCommand,
  DesktopWebsiteOperationId,
  DesktopWebsiteOperationResponse,
  DesktopWebsitePageInfo, DesktopWebsiteBrowserOperation, DesktopWebsiteBrowserResult,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { isWebsiteBrowserResult } from './website-browser-result.ts'

/** Native completion is unconfirmed; request drainage must retain the account reservation. */
export class WebsiteOperationUnknownOutcomeError extends Error {
  constructor() {
    super('Website operation settlement is unknown')
    this.name = 'WebsiteOperationUnknownOutcomeError'
  }
}

/** Private request callbacks; no global browser transport or renderer-created authority is exposed. */
export interface WebsiteParentChannel {
  /**
   * @param request - pending captured Host request.
   * @param signal - exact caller lifetime.
   * @returns after Main captures its owner, without granting access.
   */
  prepare(request: DesktopWebsiteHostSnapshot, signal: AbortSignal): Promise<void>
  /**
   * @param request - granted Host generation.
   * @param signal - effective operation cancellation.
   * @returns only while its exact native guest is still authorized.
   */
  check(request: DesktopWebsiteHostSnapshot, signal: AbortSignal): Promise<void>
  /**
   * @param snapshot - exact captured Host generation.
   * @param operation - exact approved native operation.
   * @param signal - caller cancellation and deadline; abort rejects result without confirming native completion.
   * @returns result and independent physical settlement; always await settled in finally.
   * Unknown settlement rejects it and must retain the account lock.
   */
  beginOperation(snapshot: DesktopWebsiteHostSnapshot, operation: 'page-info', signal: AbortSignal): {
    result: Promise<DesktopWebsitePageInfo>
    settled: Promise<void>
  }
  /** @param snapshot - captured granted Host generation. @param operation - separately consented browser fallback.
   * @param signal - additive cancellation. @returns result plus independent physical settlement, which must always be awaited.
   */
  beginOperation(snapshot: DesktopWebsiteHostSnapshot, operation: DesktopWebsiteBrowserOperation, signal: AbortSignal): {
    result: Promise<DesktopWebsiteBrowserResult>
    settled: Promise<void>
  }
  /** Mark channel loss synchronously; outstanding native work has unknown settlement. */
  close(): void
  /** @param message - untrusted parent IPC response. @returns whether this private response channel handled it. */
  receive(message: unknown): boolean
}

// Fixed private-protocol security ceilings, including JSON escaping and the complete envelope.
const MAX_OPERATION_ENVELOPE_BYTES = 4096
const MAX_UNFINISHED_OPERATIONS = 64
const MAX_ORIGIN_BYTES = 2048
const MAX_TITLE_BYTES = 512
const TITLE_CONTROLS = /[\x00-\x1f\x7f-\x9f]/

type OperationTransaction = {
  readonly snapshot: DesktopWebsiteHostSnapshot
  readonly operation: 'page-info' | DesktopWebsiteBrowserOperation
  finish: (response: DesktopWebsiteOperationResponse) => void
  unknown: () => void
  dispose: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function matchesSnapshot(value: unknown, captured: DesktopWebsiteHostSnapshot): value is DesktopWebsiteHostSnapshot {
  return isRecord(value) && hasOnlyKeys(value, ['id', 'profile', 'sessionId', 'epoch', 'status', 'terminal'])
    && value.id === captured.id && value.profile === captured.profile && value.sessionId === captured.sessionId
    && value.epoch === captured.epoch && value.status === captured.status && value.terminal === captured.terminal
    && captured.id.length <= MAX_OPERATION_ENVELOPE_BYTES && captured.profile.length <= MAX_OPERATION_ENVELOPE_BYTES
    && captured.sessionId.length <= MAX_OPERATION_ENVELOPE_BYTES
}

function isPageInfo(value: unknown): value is DesktopWebsitePageInfo {
  if (!isRecord(value) || !hasOnlyKeys(value, ['origin', 'title', 'titleTruncated'])
    || typeof value.origin !== 'string' || value.origin.length > MAX_ORIGIN_BYTES
    || Buffer.byteLength(value.origin, 'utf8') > MAX_ORIGIN_BYTES
    || typeof value.title !== 'string' || value.title.length > MAX_TITLE_BYTES
    || Buffer.byteLength(value.title, 'utf8') > MAX_TITLE_BYTES || TITLE_CONTROLS.test(value.title)
    || typeof value.titleTruncated !== 'boolean') return false
  let url: URL
  try { url = new URL(value.origin) }
  catch (_error) { return false }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
    && url.origin === value.origin
}

function isOperationResponse(
  packet: Record<string, unknown>, captured: DesktopWebsiteHostSnapshot, operation: 'page-info' | DesktopWebsiteBrowserOperation,
): packet is Record<string, unknown> & DesktopWebsiteOperationResponse {
  if (!matchesSnapshot(packet.snapshot, captured)) return false
  if (packet.outcome === 'success') {
    if (!hasOnlyKeys(packet, ['type', 'operationId', 'snapshot', 'outcome', 'value'])
      || !(operation === 'page-info' ? isPageInfo(packet.value) : isWebsiteBrowserResult(packet.value, operation))) return false
  } else if (packet.outcome !== 'rejected' || !hasOnlyKeys(packet, ['type', 'operationId', 'snapshot', 'outcome'])) return false
  // Fields and strings are bounded before serialization; unknown fields cannot enlarge the envelope.
  const limit = operation === 'page-info' || packet.outcome === 'rejected' ? MAX_OPERATION_ENVELOPE_BYTES
    : operation.kind === 'screenshot' ? 2 * 1024 * 1024 : 64 * 1024
  return Buffer.byteLength(JSON.stringify(packet), 'utf8') <= limit
}

/**
 * @param ctx - Host lifetime; disposal represents channel loss, not native settlement.
 * @param send - private process sender, rejecting unavailable or ambiguous delivery.
 * @returns bounded request callbacks and a retained operation response receiver.
 */
export function installWebsiteParentChannel(ctx: Context, send: (message: object) => Promise<void>): WebsiteParentChannel {
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  const operations = new Map<DesktopWebsiteOperationId, OperationTransaction>()
  let sequence = 0
  let operationSequence = 0
  let stopped = false
  const isStopped = () => stopped
  ctx.effect(() => close)
  function close(): void {
    stopped = true
    for (const call of pending.values()) call.reject(new Error('Website request Host is stopping'))
    pending.clear()
    for (const transaction of operations.values()) transaction.dispose()
    operations.clear()
  }

  async function invoke(key: string, message: object, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (stopped || pending.has(key)) throw new Error('Website parent request is unavailable or already pending')
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        pending.set(key, { resolve, reject })
        abort = () => { reject(new Error('Website parent request was canceled')) }
        signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => { reject(new Error('Website native admission timed out')) }, 10_000)
        void send(message).catch(reject)
      })
      signal.throwIfAborted()
      if (isStopped()) throw new Error('Website request Host stopped during native admission')
    } finally {
      clearTimeout(timer)
      if (abort !== undefined) signal.removeEventListener('abort', abort)
      pending.delete(key)
    }
  }

  function beginOperation(request: DesktopWebsiteHostSnapshot, operation: 'page-info', signal: AbortSignal): {
    result: Promise<DesktopWebsitePageInfo>
    settled: Promise<void>
  }
  function beginOperation(request: DesktopWebsiteHostSnapshot, operation: DesktopWebsiteBrowserOperation, signal: AbortSignal): {
    result: Promise<DesktopWebsiteBrowserResult>
    settled: Promise<void>
  }
  function beginOperation(request: DesktopWebsiteHostSnapshot, operation: 'page-info' | DesktopWebsiteBrowserOperation, signal: AbortSignal): {
    result: Promise<DesktopWebsitePageInfo | DesktopWebsiteBrowserResult>
    settled: Promise<void>
  } {
    if (signal.aborted) throw new Error('Website operation was canceled')
    if (stopped || operations.size >= MAX_UNFINISHED_OPERATIONS) throw new Error('Website operation is unavailable')
    const nextId = operationSequence + 1
    if (!Number.isSafeInteger(nextId)) throw new Error('Website operation correlation is exhausted')
    const operationId = nextId as DesktopWebsiteOperationId
    const snapshot = { ...request }
    const message: DesktopWebsiteOperationCommand = { type: 'website-operation', operationId, snapshot, operation }
    if (Buffer.byteLength(JSON.stringify(message), 'utf8') > (operation === 'page-info' ? MAX_OPERATION_ENVELOPE_BYTES : 64 * 1024)) {
      throw new Error('Website operation request exceeds its limit')
    }
    operationSequence = nextId
    const result = Promise.withResolvers<DesktopWebsitePageInfo | DesktopWebsiteBrowserResult>()
    const settled = Promise.withResolvers<void>()
    // Callers may await result before settled; an early settlement failure still has an observer.
    void settled.promise.catch((_error: unknown) => { /* The caller observes the original rejection in finally. */ })
    let finished = false
    const cleanup = () => { signal.removeEventListener('abort', abort) }
    const unknown = () => {
      if (finished) return
      const error = new WebsiteOperationUnknownOutcomeError()
      result.reject(error)
      settled.reject(error)
    }
    const dispatch = (command: DesktopWebsiteOperationCommand) => {
      try { void send(command).catch(unknown) }
      catch (_error) { unknown() }
    }
    const abort = () => {
      result.reject(new Error('Website operation was canceled'))
      dispatch({ type: 'website-operation-cancel', operationId })
    }
    const transaction: OperationTransaction = {
      snapshot, operation,
      unknown,
      dispose() {
        unknown()
        cleanup()
        finished = true
      },
      finish(response) {
        if (finished) return
        finished = true
        cleanup()
        operations.delete(operationId)
        if (signal.aborted) result.reject(new Error('Website operation was canceled'))
        else switch (response.outcome) {
          case 'success':
            result.resolve(response.value)
            break
          case 'rejected':
            result.reject(new Error('Website operation was rejected'))
            break
          default: assertNever(response)
        }
        settled.resolve()
      },
    }
    operations.set(operationId, transaction)
    signal.addEventListener('abort', abort, { once: true })
    dispatch(message)
    return {
      result: result.promise.then((value) => {
        if (signal.aborted || stopped) throw new Error('Website operation was canceled')
        return value
      }),
      settled: settled.promise,
    }
  }

  return {
    prepare: (request, signal) => invoke(`prepare:${request.id}`, { type: 'website-prepared', snapshot: request }, signal),
    check: (request, signal) => {
      const requestId = ++sequence
      return invoke(`check:${requestId}`, { type: 'website-check', requestId, snapshot: request }, signal)
    },
    beginOperation,
    close,
    receive(message) {
      if (isRecord(message) && message.type === 'website-operation-result') {
        const operationId = message.operationId
        if (typeof operationId !== 'number' || !Number.isSafeInteger(operationId) || operationId <= 0) return true
        const transaction = operations.get(operationId as DesktopWebsiteOperationId)
        if (transaction === undefined) return true
        if (isOperationResponse(message, transaction.snapshot, transaction.operation)) transaction.finish(message)
        else transaction.unknown()
        return true
      }
      if (typeof message !== 'object' || message === null || !('type' in message)
        || (message.type !== 'website-prepared-ack' && message.type !== 'website-check-result')) return false
      const packet = message as Record<string, unknown>
      const key = packet.type === 'website-prepared-ack'
        ? (typeof packet.id === 'string' ? `prepare:${packet.id}` : undefined)
        : (typeof packet.requestId === 'number' && Number.isSafeInteger(packet.requestId) ? `check:${packet.requestId}` : undefined)
      const call = key === undefined ? undefined : pending.get(key)
      if (call === undefined) return true
      if (packet.error !== undefined || (packet.type === 'website-check-result' && packet.accepted !== true)) {
        call.reject(new Error(typeof packet.error === 'string' && packet.error.length <= 2048
          ? packet.error : 'Website native admission was refused'))
      } else call.resolve()
      return true
    },
  }
}
