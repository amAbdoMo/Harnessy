/** Private captured-child operation correlation; cancellation never substitutes for physical native settlement. */
import type {
  DesktopWebsiteHostSnapshot, DesktopWebsiteOperationCommand, DesktopWebsiteOperationId,
  DesktopWebsiteOperationResponse, DesktopWebsitePageInfo, DesktopWebsiteBrowserOperation, DesktopWebsiteBrowserResult,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { isWebsiteBrowserOperation } from './website-browser.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_PACKET_BYTES = 4096
const MAX_OPERATIONS = 64
const CONTROL = /[\p{Cc}\p{Cf}]/u

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param value - child IPC packet. @returns whether every operation field and the complete packet are bounded. */
export function isWebsiteOperationCommand(value: unknown): value is DesktopWebsiteOperationCommand {
  if (!record(value) || typeof value.operationId !== 'number'
    || !Number.isSafeInteger(value.operationId) || value.operationId <= 0) return false
  if (value.type === 'website-operation-cancel') {
    return Object.keys(value).every(key => ['type', 'operationId'].includes(key))
  }
  if (value.type !== 'website-operation' || (value.operation !== 'page-info' && !isWebsiteBrowserOperation(value.operation))
    || Object.keys(value).some(key => !['type', 'operationId', 'snapshot', 'operation'].includes(key))) return false
  const snapshot = value.snapshot
  if (!record(snapshot) || Object.keys(snapshot).some(key => !['id', 'profile', 'sessionId', 'epoch', 'status', 'terminal'].includes(key))
    || typeof snapshot.id !== 'string' || !UUID.test(snapshot.id)
    || typeof snapshot.profile !== 'string' || !UUID.test(snapshot.profile)
    || typeof snapshot.sessionId !== 'string' || snapshot.sessionId.length === 0
    || Buffer.byteLength(snapshot.sessionId) > 2048 || CONTROL.test(snapshot.sessionId)
    || typeof snapshot.epoch !== 'number' || !Number.isSafeInteger(snapshot.epoch) || snapshot.epoch <= 0
    || typeof snapshot.status !== 'string' || !['pending', 'granted', 'revoked'].includes(snapshot.status)
    || (snapshot.terminal !== undefined && (snapshot.terminal !== true || snapshot.status !== 'revoked'))) return false
  return Buffer.byteLength(JSON.stringify(value)) <= (value.operation === 'page-info' ? MAX_PACKET_BYTES : 64 * 1024)
    && Buffer.byteLength(JSON.stringify({ type: 'website-operation-result', operationId: value.operationId,
      snapshot, outcome: 'rejected' })) <= MAX_PACKET_BYTES
}

/** @param address - native URL or saved profile address. @returns credential-free normalized HTTP(S) origin only. */
export function websitePageOrigin(address: string): string {
  if (CONTROL.test(address)) throw new Error('Website observation rejected')
  const url = new URL(address)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || Buffer.byteLength(url.origin) > 2048) throw new Error('Website observation rejected')
  return url.origin
}

/** @param title - untrusted native title. @returns control-free, codepoint-safe UTF-8 title of at most 512 bytes. */
export function websitePageTitle(title: string): Pick<DesktopWebsitePageInfo, 'title' | 'titleTruncated'> {
  let result = ''
  let bytes = 0
  for (const point of title) {
    if (CONTROL.test(point)) continue
    const text = point.toWellFormed()
    const size = Buffer.byteLength(text)
    if (bytes + size > 512) return { title: result, titleTruncated: true }
    result += text
    bytes += size
  }
  return { title: result, titleTruncated: false }
}

interface NativeOperation {
  readonly controller: AbortController
  readonly settled: Promise<void>
}

/** One instance belongs to one concrete child; replacement children never receive its terminal answers. */
export class DesktopWebsiteOperations {
  private readonly operations = new Map<DesktopWebsiteOperationId, NativeOperation>()
  private lastId = 0
  private closed = false

  /**
   * @param pageInfo - captured authority callback, not a renderer/browser service.
   * @param publish - send only to the captured child; transport failure cannot undo native settlement.
   * @param check - synchronously reject lost native authority immediately before success publication.
   * @param browser - captured browser executor; absence refuses non-title operations.
   */
  constructor(private readonly pageInfo: (snapshot: DesktopWebsiteHostSnapshot, signal: AbortSignal) => Promise<DesktopWebsitePageInfo>,
    private readonly publish: (response: DesktopWebsiteOperationResponse) => void,
    private readonly check: (snapshot: DesktopWebsiteHostSnapshot) => void,
    private readonly browser?: (snapshot: DesktopWebsiteHostSnapshot, signal: AbortSignal,
      operation: DesktopWebsiteBrowserOperation) => Promise<DesktopWebsiteBrowserResult>) {}

  /** @param command - validated private child packet. Starts/cancels without forgetting physically pending work. */
  receive(command: DesktopWebsiteOperationCommand): void {
    if (this.closed) return
    if (command.type === 'website-operation-cancel') {
      this.operations.get(command.operationId)?.controller.abort()
      return
    }
    if (command.operationId <= this.lastId) return
    this.lastId = command.operationId
    const operationId = command.operationId
    const operation: 'page-info' | DesktopWebsiteBrowserOperation = command.operation === 'page-info' ? 'page-info'
      : command.operation.kind === 'screenshot' ? { ...command.operation, clip: { ...command.operation.clip } } : { ...command.operation }
    const snapshot = { ...command.snapshot }
    const rejected: DesktopWebsiteOperationResponse = { type: 'website-operation-result',
      operationId, snapshot, outcome: 'rejected' }
    if (this.operations.size >= MAX_OPERATIONS) {
      this.send(rejected)
      return
    }
    const controller = new AbortController()
    const settled = Promise.resolve().then((): Promise<DesktopWebsitePageInfo | DesktopWebsiteBrowserResult> => {
      controller.signal.throwIfAborted()
      if (operation === 'page-info') return this.pageInfo(snapshot, controller.signal)
      if (this.browser === undefined) throw new Error('Website browser operation is unavailable')
      return this.browser(snapshot, controller.signal, operation)
    }).then((value): DesktopWebsiteOperationResponse => {
      if (controller.signal.aborted) return rejected
      const response: DesktopWebsiteOperationResponse = { ...rejected, outcome: 'success', value }
      const limit = operation === 'page-info' ? MAX_PACKET_BYTES
        : operation.kind === 'screenshot' ? 2 * 1024 * 1024 : 64 * 1024
      return Buffer.byteLength(JSON.stringify(response)) <= limit ? response : rejected
    }, (_error: unknown) => rejected).then((response) => {
      this.operations.delete(operationId)
      // Revocation/cancellation can arrive after native settlement but before this publication microtask.
      let terminal = controller.signal.aborted ? rejected : response
      if (terminal.outcome === 'success') {
        try { this.check(snapshot) }
        catch (_error: unknown) { terminal = rejected }
      }
      this.send(terminal)
    })
    this.operations.set(operationId, { controller, settled })
  }

  /**
   * Stop admission/success immediately.
   * @returns quiescence after native settlement and bounded rejection replies for captured operations.
   */
  close(): Promise<void> {
    this.closed = true
    for (const operation of this.operations.values()) operation.controller.abort()
    return Promise.all([...this.operations.values()].map(operation => operation.settled)).then(() => {})
  }

  private send(response: DesktopWebsiteOperationResponse): void {
    if (this.closed && response.outcome === 'success') return
    try { this.publish(response) }
    catch (_error: unknown) { /* The child is unavailable; the native terminal remains physically settled. */ }
  }
}
