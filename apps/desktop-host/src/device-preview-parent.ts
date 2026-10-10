/** Private Host-to-Main device-preview requests; opening does not authorize observation or launcher termination. */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type {
  DevicePreviewCancelRequest,
  DevicePreviewId,
  DevicePreviewObservation,
  DevicePreviewObserveRequest,
  DevicePreviewOpenRequest,
  DevicePreviewRequestId,
  DevicePreviewResponse,
} from '@deepseek-ai/dsh-client-ui-device-preview/types'

/** Main's committed acknowledgement of the exact requested preview. */
export type DevicePreviewOpenedResult = Extract<Extract<DevicePreviewResponse, { ok: true }>['result'], { kind: 'opened' }>

/** Private, caller-cancelled requests; no renderer authority or stop operation is exposed. */
export interface DevicePreviewParentChannel {
  /**
   * @param request - explicitly permitted opening and its initiating Session.
   * @param signal - caller lifetime; cancellation does not stop the launcher.
   * @returns the exact committed opening, rejecting refusal, invalid replies, channel loss or a 60-second deadline.
   */
  open(request: Omit<DevicePreviewOpenRequest, 'type' | 'requestId'>, signal: AbortSignal): Promise<DevicePreviewOpenedResult>
  /**
   * @param request - separately permitted observation of the exact preview and device slot.
   * @param signal - caller lifetime.
   * @returns bounded PNG or layout data of the requested kind, rejecting refusal, invalid replies, channel loss or a 30-second deadline.
   */
  observe(request: Omit<DevicePreviewObserveRequest, 'type' | 'requestId'>, signal: AbortSignal): Promise<DevicePreviewObservation>
  /** @param message - untrusted Main IPC message.
   * @returns whether the device-preview response channel consumed it, including stale replies.
   */
  receive(message: unknown): boolean
  /** @param listener - forget the exact Main-retired observation occurrence.
   * @returns subscription disposer; retirement carries no launcher termination authority.
   */
  onRetired(listener: (previewId: DevicePreviewId) => void): () => void
  /** Reject outstanding requests, remove their timers/listeners and permanently stop admission without stopping launchers. */
  close(): void
}

// Fixed private-protocol security ceilings, not deployment preferences.
const MAX_PENDING = 64
const PNG_BYTES = 6 * 1024 * 1024
const BASE64_BYTES = 4 * Math.ceil(PNG_BYTES / 3)
const LAYOUT_BYTES = 32 * 1024
const ERROR_BYTES = 2048
const MAX_DIMENSION = 8192
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

type Pending = { finish: (packet: Record<string, unknown>) => void; reject: (error: Error) => void }
type Reply<T> = Extract<DevicePreviewResponse, { ok: false }>
  | (Omit<Extract<DevicePreviewResponse, { ok: true }>, 'result'> & { readonly result: T })

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  // IPC carries data properties only; accessors and inherited serializers must never execute here.
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return typeof key === 'string' && descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
  })
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit && Buffer.byteLength(value, 'utf8') <= limit
}

function dimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_DIMENSION
}

function pngHeader(bytes: Buffer): boolean {
  if (bytes[26] !== 0 || bytes[27] !== 0 || (bytes[28] !== 0 && bytes[28] !== 1)) return false
  const depth = bytes[24]
  switch (bytes[25]) {
    case 0: return depth === 1 || depth === 2 || depth === 4 || depth === 8 || depth === 16
    case 3: return depth === 1 || depth === 2 || depth === 4 || depth === 8
    case 2:
    case 4:
    case 6: return depth === 8 || depth === 16
    default: return false
  }
}

function observation(value: unknown, operation: DevicePreviewObserveRequest['operation']): value is DevicePreviewObservation {
  if (!record(value) || value.kind !== operation || !dimension(value.width) || !dimension(value.height)) return false
  if (operation === 'layout') return keys(value, ['kind', 'text', 'width', 'height']) && text(value.text, LAYOUT_BYTES)
  if (!keys(value, ['kind', 'base64', 'mimeType', 'width', 'height']) || value.mimeType !== 'image/png'
    || typeof value.base64 !== 'string' || value.base64.length === 0 || value.base64.length > BASE64_BYTES
    || value.base64.length % 4 !== 0 || !BASE64.test(value.base64)) return false
  const bytes = Buffer.from(value.base64, 'base64')
  return bytes.length >= 33 && bytes.length <= PNG_BYTES && bytes.toString('base64') === value.base64
    && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.readUInt32BE(8) === 13
    && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) === value.width && bytes.readUInt32BE(20) === value.height && pngHeader(bytes)
}

function response<T>(
  packet: Record<string, unknown>, accept: (value: unknown) => value is T, limit: number,
): packet is Record<string, unknown> & Reply<T> {
  if (packet.ok === true) {
    if (!keys(packet, ['type', 'requestId', 'ok', 'result']) || !accept(packet.result)) return false
  } else if (packet.ok !== false || !keys(packet, ['type', 'requestId', 'ok', 'error']) || !text(packet.error, ERROR_BYTES)) return false
  // Every field and nested record is admitted before serializing the complete escaped envelope.
  return Buffer.byteLength(JSON.stringify(packet), 'utf8') <= (packet.ok ? limit : 4096)
}

/**
 * @param ctx - Host effect owner; disposal permanently closes this channel.
 * @param send - private Main sender; synchronous and asynchronous delivery failures reject without disclosing transport details.
 * @returns a channel admitting at most 64 pending UUID-correlated requests, with best-effort cancellation on abort or timeout.
 * Local rejection does not confirm native completion. Permission checks belong to the caller and Main.
 */
export function installDevicePreviewParentChannel(ctx: Context, send: (message: object) => Promise<void>): DevicePreviewParentChannel {
  const pending = new Map<DevicePreviewRequestId, Pending>()
  let stopped = false
  const retirementListeners = new Set<(previewId: DevicePreviewId) => void>()

  function close(): void {
    if (stopped) return
    stopped = true
    retirementListeners.clear()
    for (const call of pending.values()) call.reject(new Error('Device preview Host is stopping'))
  }
  ctx.effect(() => close)

  function cancel(requestId: DevicePreviewRequestId): void {
    const message: DevicePreviewCancelRequest = { type: 'device-preview-cancel', requestId }
    try { void send(message).catch((_error: unknown) => { /* Local cancellation is final even when Main is unavailable. */ }) }
    catch (_error) { /* A disconnected sender cannot undo local cancellation. */ }
  }

  async function invoke<T>(
    message: DevicePreviewOpenRequest | DevicePreviewObserveRequest,
    accept: (value: unknown) => value is T, signal: AbortSignal, bounds: { deadline: number; envelopeBytes: number },
  ): Promise<T> {
    if (signal.aborted) throw new Error('Device preview request was canceled')
    if (stopped || pending.size >= MAX_PENDING) throw new Error('Device preview parent request is unavailable')
    const result = Promise.withResolvers<T>()
    let finished = false
    const cleanup = () => {
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      pending.delete(message.requestId)
    }
    const reject = (error: Error) => {
      if (finished) return
      cleanup()
      result.reject(error)
    }
    const abort = () => {
      if (finished) return
      reject(new Error('Device preview request was canceled'))
      cancel(message.requestId)
    }
    pending.set(message.requestId, {
      reject,
      finish(packet) {
        if (finished) return
        if (!response(packet, accept, bounds.envelopeBytes)) {
          reject(new Error('Device preview response is invalid'))
          cancel(message.requestId)
          return
        }
        cleanup()
        if (packet.ok) result.resolve(packet.result)
        else result.reject(new Error(packet.error))
      },
    })
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      reject(new Error('Device preview request timed out'))
      cancel(message.requestId)
    }, bounds.deadline)
    try { void send(message).catch((_error: unknown) => reject(new Error('Device preview request delivery failed'))) }
    catch (_error) { reject(new Error('Device preview request delivery failed')) }
    const value = await result.promise
    // An already queued success cannot escape caller cancellation or Host disposal.
    if (signal.aborted) throw new Error('Device preview request was canceled')
    if (stopped) throw new Error('Device preview Host is stopping')
    return value
  }

  return {
    open(request, signal) {
      const { previewId, sessionId, server } = request
      const message: DevicePreviewOpenRequest = {
        type: 'device-preview-open', requestId: randomUUID() as DevicePreviewRequestId, previewId, sessionId, server,
      }
      return invoke(message, (value): value is DevicePreviewOpenedResult => record(value)
        && keys(value, ['kind', 'previewId']) && value.kind === 'opened' && value.previewId === previewId
        && text(value.previewId, 2048), signal, { deadline: 60_000, envelopeBytes: 4096 })
    },
    observe(request, signal) {
      const { previewId, sessionId, slot, operation } = request
      const message: DevicePreviewObserveRequest = {
        type: 'device-preview-observe', requestId: randomUUID() as DevicePreviewRequestId, previewId, sessionId, slot, operation,
      }
      return invoke(message, (value): value is DevicePreviewObservation => observation(value, operation),
        signal, { deadline: 30_000, envelopeBytes: operation === 'screenshot' ? 8 * 1024 * 1024 : 32 * 1024 })
    },
    onRetired(listener) {
      if (stopped) throw new Error('Device preview Host is stopping')
      retirementListeners.add(listener)
      return () => { retirementListeners.delete(listener) }
    },
    receive(message) {
      if (!record(message)) return false
      if (message.type === 'device-preview-retired') {
        if (keys(message, ['type', 'previewId']) && typeof message.previewId === 'string' && UUID.test(message.previewId)) {
          for (const listener of retirementListeners) {
            try { listener(message.previewId as DevicePreviewId) }
            catch (error: unknown) { ctx.logger.error('Device preview retirement consumer failed', error) }
          }
        }
        return true
      }
      if (message.type !== 'device-preview-result') return false
      if (typeof message.requestId !== 'string' || !UUID.test(message.requestId)) return true
      pending.get(message.requestId as DevicePreviewRequestId)?.finish(message)
      return true
    },
    close,
  }
}
