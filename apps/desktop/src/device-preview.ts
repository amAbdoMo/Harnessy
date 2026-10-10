/** Main-owned association between an explicit preview request and its displayed ordinary guests. */
import type { BrowserWindow, WebContents } from 'electron'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type {
  DevicePreviewBinding, DevicePreviewHostRequest, DevicePreviewId, DevicePreviewObserveRequest,
  DevicePreviewOpenAcknowledgement, DevicePreviewOpenRequest, DevicePreviewRequestId, DevicePreviewResponse,
} from '@deepseek-ai/dsh-client-ui-device-preview/types'
import { DESKTOP_IPC } from './ipc.ts'

// Unfinished display handshakes expire; receiving an event never reserves observation indefinitely.
const DISPLAY_HANDSHAKE_MS = 60_000
// Native work must be interrupted before the Host's 30-second request deadline.
const NATIVE_OBSERVATION_MS = 25_000
const MAX_PENDING_REQUESTS = 64
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const MAX_LAYOUT_BYTES = 32 * 1024
// Isolated from page-defined JavaScript globals; 999 is reserved for Electron's preload world.
const LAYOUT_WORLD_ID = 1001
const LAYOUT_SCRIPT = `(() => {
  const root = document.documentElement;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const overflow = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let scanned = 0;
  let element;
  while ((element = walker.nextNode()) && scanned < 2000 && overflow.length < 50) {
    scanned++;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || getComputedStyle(element).visibility === 'hidden') continue;
    if (rect.left < -1 || rect.right > width + 1) {
      overflow.push({tag: element.tagName.toLowerCase(), x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height)});
    }
  }
  return JSON.stringify({viewport: {width, height}, document: {width: root.scrollWidth, height: root.scrollHeight},
    horizontalOverflow: root.scrollWidth > width, truncated: scanned >= 2000 || overflow.length >= 50, overflow});
})()`

interface PreviewOccurrence {
  readonly host: object
  readonly request: DevicePreviewOpenRequest
  readonly owner: WebContents
  readonly frames: Map<'phone' | 'tablet', DevicePreviewBinding>
  opened: boolean
}
interface CapturedPreviewFrame {
  readonly occurrence: PreviewOccurrence
  readonly binding: DevicePreviewBinding
  readonly guest: WebContents
}
interface PreviewTransaction {
  readonly previewId: DevicePreviewId
  readonly host: object
  readonly controller: AbortController
  readonly settled: Promise<void>
  owner: WebContents | undefined
}
/** Native dependencies remain private; renderer and model inputs never choose a WebContents. */
export interface DesktopDevicePreviewOptions {
  readonly window: () => BrowserWindow | undefined
  readonly currentHost: () => object | undefined
  readonly guest: (owner: WebContents, lease: DesktopBrowserLeaseId) => WebContents | undefined
  /** Synchronously revokes and closes only this captured ordinary guest; never awaits registry drainage. */
  readonly cancelGuest: (owner: WebContents, lease: DesktopBrowserLeaseId, guest: WebContents) => void
  /** Runs once after occurrence authority is removed, before drainage; forgets the Host cache without stopping its server. */
  readonly retired?: (host: object, previewId: DevicePreviewId) => void
}

function layoutViewportMatches(text: string, width: number, height: number): boolean {
  let value: unknown
  try { value = JSON.parse(text) }
  catch (error: unknown) { void error; return false }
  if (typeof value !== 'object' || value === null || !('viewport' in value)) return false
  const viewport = value.viewport
  return typeof viewport === 'object' && viewport !== null && 'width' in viewport && 'height' in viewport
    && viewport.width === width && viewport.height === height
}

function failure(requestId: DevicePreviewRequestId, error: string): DevicePreviewResponse {
  return { type: 'device-preview-result', requestId, ok: false, error }
}

/** Owns exact display acknowledgements, guest registrations and request-only native observation. */
export class DesktopDevicePreviews {
  private readonly previews = new Map<DevicePreviewId, PreviewOccurrence>()
  private readonly pending = new Map<DevicePreviewRequestId, PreviewTransaction>()
  private readonly closing = new Map<DevicePreviewId, { readonly occurrence: PreviewOccurrence; readonly settled: Promise<void> }>()
  private readonly displays = new Map<DevicePreviewRequestId, {
    readonly preview: PreviewOccurrence
    readonly resolve: () => void
    readonly reject: (error: Error) => void
  }>()

  /** @param options - exact current Host, trusted window, ordinary-guest lookup and synchronous native cancellation. */
  constructor(private readonly options: DesktopDevicePreviewOptions) {}

  /** @param host - captured Host generation. @param request - validated private request.
   * @returns native result after settlement, or undefined for an explicit cancellation notification.
   * At most 64 requests remain admitted; observations close their exact guest on abort or after 25 seconds and join native settlement.
   */
  async request(host: object, request: DevicePreviewHostRequest): Promise<DevicePreviewResponse | undefined> {
    if (request.type === 'device-preview-cancel') {
      const operation = this.pending.get(request.requestId)
      if (operation?.host === host) operation.controller.abort(new Error('Device preview request cancelled'))
      return undefined
    }
    if (this.options.currentHost() !== host) return failure(request.requestId, 'Device preview Host is unavailable')
    if (this.pending.has(request.requestId)) return failure(request.requestId, 'Device preview request is already pending')
    if (this.pending.size >= MAX_PENDING_REQUESTS) return failure(request.requestId, 'Device preview request limit reached')
    const controller = new AbortController()
    const settlement = Promise.withResolvers<void>()
    const transaction: PreviewTransaction = { previewId: request.previewId, host, controller, settled: settlement.promise,
      owner: this.previews.get(request.previewId)?.owner }
    this.pending.set(request.requestId, transaction)
    try {
      const result = request.type === 'device-preview-open'
        ? await this.open(host, request, transaction)
        : await this.observe(host, request, transaction)
      controller.signal.throwIfAborted()
      if (this.options.currentHost() !== host) throw new Error('Device preview Host changed')
      const response: DevicePreviewResponse = { type: 'device-preview-result', requestId: request.requestId, ok: true, result }
      const maximum = result.kind === 'screenshot' ? MAX_CAPTURE_BYTES : MAX_LAYOUT_BYTES
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > maximum) throw new Error('Device preview response exceeded its complete limit')
      return response
    } catch (error: unknown) {
      console.error('Device preview native request failed', error)
      return failure(request.requestId, request.type === 'device-preview-open'
        ? 'Device preview could not be opened. Keep its chat selected and try again.'
        : 'Device preview inspection is unavailable. Select its visible live device and try again.')
    } finally {
      this.pending.delete(request.requestId)
      settlement.resolve()
    }
  }

  private async open(host: object, request: DevicePreviewOpenRequest, transaction: PreviewTransaction): Promise<{ kind: 'opened'; previewId: DevicePreviewId }> {
    const signal = transaction.controller.signal
    const window = this.options.window()
    if (window === undefined || window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('Device preview window is unavailable')
    transaction.owner = window.webContents
    if (this.previews.has(request.previewId) || this.closing.has(request.previewId)) throw new Error('Device preview identity is already in use')
    const occurrence: PreviewOccurrence = { host, request, owner: window.webContents, frames: new Map(), opened: false }
    this.previews.set(request.previewId, occurrence)
    const display = Promise.withResolvers<void>()
    this.displays.set(request.requestId, { preview: occurrence, resolve: display.resolve, reject: display.reject })
    const abort = () => { display.reject(new Error('Device preview opening cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { display.reject(new Error('Device preview display acknowledgement expired')) }, DISPLAY_HANDSHAKE_MS)
    try {
      signal.throwIfAborted()
      window.webContents.send(DESKTOP_IPC.devicePreviewOpen, request)
      await display.promise
      signal.throwIfAborted()
      if (this.previews.get(request.previewId) !== occurrence) throw new Error('Device preview occurrence changed')
      occurrence.opened = true
      return { kind: 'opened', previewId: request.previewId }
    } catch (error: unknown) {
      this.previews.delete(request.previewId)
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      this.displays.delete(request.requestId)
    }
  }

  /** @param owner - authenticated application renderer. @param acknowledgement - exact committed opening. */
  acknowledge(owner: WebContents, acknowledgement: DevicePreviewOpenAcknowledgement): void {
    const display = this.displays.get(acknowledgement.requestId)
    if (display === undefined || display.preview.owner !== owner
      || display.preview.request.previewId !== acknowledgement.previewId
      || display.preview.host !== this.options.currentHost()) throw new Error('Device preview opening is stale')
    if (!acknowledgement.opened) { display.reject(new Error('Device preview UI declined opening')); return }
    if (![...display.preview.frames.values()].some(frame => frame.visible && this.options.guest(owner, frame.lease) !== undefined)) {
      throw new Error('Device preview has no committed visible device')
    }
    display.resolve()
  }

  /** @param owner - authenticated application renderer. @param binding - exact displayed device and viewport. */
  bind(owner: WebContents, binding: DevicePreviewBinding): void {
    const occurrence = this.previews.get(binding.previewId)
    if (occurrence === undefined || occurrence.owner !== owner || occurrence.host !== this.options.currentHost()
      || this.options.guest(owner, binding.lease) === undefined) throw new Error('Device preview guest is unavailable')
    for (const preview of this.previews.values()) {
      for (const frame of preview.frames.values()) {
        if (frame.lease === binding.lease && (preview !== occurrence || frame.slot !== binding.slot)) {
          throw new Error('Device preview guest already belongs to another frame')
        }
      }
    }
    occurrence.frames.set(binding.slot, binding)
  }

  /** @param owner - authenticated application renderer. @param binding - exact retired device registration. */
  unbind(owner: WebContents, binding: Pick<DevicePreviewBinding, 'previewId' | 'slot' | 'lease'>): void {
    const occurrence = this.previews.get(binding.previewId)
    if (occurrence === undefined) return
    if (occurrence.owner !== owner) throw new Error('Device preview belongs to another window')
    if (occurrence.frames.get(binding.slot)?.lease === binding.lease) occurrence.frames.delete(binding.slot)
  }

  /** @param owner - guest owner. @param lease - invalidated native reservation. */
  invalidate(owner: WebContents, lease: DesktopBrowserLeaseId): void {
    for (const occurrence of this.previews.values()) {
      if (occurrence.owner !== owner) continue
      for (const [slot, binding] of occurrence.frames) if (binding.lease === lease) occurrence.frames.delete(slot)
    }
  }

  /** @param owner - window whose visibility or renderer ownership ended.
   * @param retire - discard occurrences after renderer loss; hiding retains occurrences and never stops launchers.
   * @returns after its admitted native observations settle.
   */
  async revokeOwner(owner: WebContents, retire = false): Promise<void> {
    if (retire) {
      for (const [id, occurrence] of this.previews) if (occurrence.owner === owner) this.close(owner, id)
    }
    const operations = [...this.pending.values()].filter(operation => operation.owner === owner)
    const closures = [...this.closing.values()].filter(closing => closing.occurrence.owner === owner)
    for (const operation of operations) operation.controller.abort(new Error('Device preview window is unavailable'))
    await Promise.all([...operations.map(operation => operation.settled), ...closures.map(closing => closing.settled)])
  }

  /** @param owner - authenticated application renderer. @param previewId - closed tab occurrence.
   * @returns the same pending drainage promise to concurrent callers; its development server is not affected.
   * Rejects another renderer even while the occurrence is closing.
   */
  close(owner: WebContents, previewId: DevicePreviewId): Promise<void> {
    const previous = this.closing.get(previewId)
    const occurrence = previous?.occurrence ?? this.previews.get(previewId)
    if (occurrence === undefined) return Promise.resolve()
    if (occurrence.owner !== owner) return Promise.reject(new Error('Device preview belongs to another window'))
    if (previous !== undefined) return previous.settled
    const operations = [...this.pending.values()].filter(operation => operation.previewId === previewId
      && operation.host === occurrence.host && operation.owner === owner)
    const closing = { occurrence, settled: Promise.all(operations.map(operation => operation.settled)).then(() => {
      this.closing.delete(previewId)
    }) }
    this.closing.set(previewId, closing)
    this.previews.delete(previewId)
    try { this.options.retired?.(occurrence.host, previewId) }
    catch (error: unknown) { console.error('Device preview retirement callback failed', error) }
    for (const operation of operations) operation.controller.abort(new Error('Device preview closed'))
    return closing.settled
  }

  /** @param owner - authenticated application renderer. @param projectId - proposed owned launcher Stop target.
   * @returns whether that project belongs to a preview owned by the current renderer and Host.
   */
  canStop(owner: WebContents, projectId: string): boolean {
    return [...this.previews.values()].some(occurrence => occurrence.owner === owner
      && occurrence.host === this.options.currentHost() && occurrence.request.server.projectId === projectId
      && occurrence.request.server.ownership === 'owned')
  }

  /** @param host - exact retired Host. @returns after its native observations settle; launchers are owned by the Host. */
  async retireHost(host: object): Promise<void> {
    for (const [id, occurrence] of this.previews) if (occurrence.host === host) this.close(occurrence.owner, id)
    const operations = [...this.pending.values()].filter(operation => operation.host === host)
    const closures = [...this.closing.values()].filter(closing => closing.occurrence.host === host)
    for (const operation of operations) operation.controller.abort(new Error('Device preview Host retired'))
    await Promise.all([...operations.map(operation => operation.settled), ...closures.map(closing => closing.settled)])
  }

  private captureFrame(host: object, request: DevicePreviewObserveRequest): CapturedPreviewFrame {
    const occurrence = this.previews.get(request.previewId)
    const window = this.options.window()
    const binding = occurrence?.frames.get(request.slot)
    if (occurrence === undefined || !occurrence.opened || occurrence.host !== host || occurrence.request.sessionId !== request.sessionId
      || binding === undefined || !binding.visible || window === undefined
      || window.isDestroyed() || !window.isVisible() || window.isMinimized()
      || window.webContents !== occurrence.owner || occurrence.owner.isDestroyed()) throw new Error('Device preview is not displayed')
    const guest = this.options.guest(occurrence.owner, binding.lease)
    if (guest === undefined || new URL(guest.getURL()).origin !== new URL(occurrence.request.server.url).origin) {
      throw new Error('Device preview target changed')
    }
    if (guest.isLoadingMainFrame()) throw new Error('Device preview page is loading; wait before requesting inspection')
    return { occurrence, binding, guest }
  }

  private async nativeObservation<T>(transaction: PreviewTransaction, captured: CapturedPreviewFrame, run: () => Promise<T>): Promise<T> {
    const signal = transaction.controller.signal
    signal.throwIfAborted()
    const cancel = () => {
      try { this.options.cancelGuest(captured.occurrence.owner, captured.binding.lease, captured.guest) }
      catch (error: unknown) { console.error('Device preview guest cancellation failed', error) }
    }
    signal.addEventListener('abort', cancel, { once: true })
    const deadline = setTimeout(() => {
      transaction.controller.abort(new Error('Device preview native observation expired'))
    }, NATIVE_OBSERVATION_MS)
    try {
      // Closing interrupts Electron; settlement still belongs to the native promise, not an abort race.
      return await run()
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', cancel)
    }
  }

  private async observe(host: object, request: DevicePreviewObserveRequest, transaction: PreviewTransaction): Promise<
    | { kind: 'layout'; text: string; width: number; height: number }
    | { kind: 'screenshot'; base64: string; mimeType: 'image/png'; width: number; height: number }
  > {
    const signal = transaction.controller.signal
    signal.throwIfAborted()
    const captured = this.captureFrame(host, request)
    transaction.owner = captured.occurrence.owner
    const { width, height } = captured.binding
    if (request.operation === 'layout') {
      const layout: unknown = await this.nativeObservation(transaction, captured,
        () => captured.guest.executeJavaScriptInIsolatedWorld(LAYOUT_WORLD_ID, [{ code: LAYOUT_SCRIPT }], false))
      this.recheck(host, request, captured, signal)
      if (typeof layout !== 'string' || Buffer.byteLength(layout, 'utf8') > MAX_LAYOUT_BYTES
        || !layoutViewportMatches(layout, width, height)) throw new Error('Device preview layout did not match its viewport or limit')
      return { kind: 'layout', text: layout, width, height }
    }
    // Viewport owns this debugger attachment; observation must never attach or detach an unrelated debugger.
    if (!captured.guest.debugger.isAttached()) throw new Error('Device preview viewport is unavailable')
    const screenshot: unknown = await this.nativeObservation(transaction, captured,
      () => captured.guest.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      }))
    this.recheck(host, request, captured, signal)
    if (typeof screenshot !== 'object' || screenshot === null || !('data' in screenshot)
      || typeof screenshot.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(screenshot.data)
      || Buffer.byteLength(JSON.stringify({ kind: 'screenshot', base64: screenshot.data, mimeType: 'image/png', width, height }), 'utf8') > MAX_CAPTURE_BYTES) {
      throw new Error('Device preview screenshot exceeded its limit')
    }
    const png = Buffer.from(screenshot.data, 'base64')
    if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a
      || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) throw new Error('Device preview screenshot dimensions did not match')
    return { kind: 'screenshot', base64: screenshot.data, mimeType: 'image/png', width, height }
  }

  private recheck(host: object, request: DevicePreviewObserveRequest,
    captured: CapturedPreviewFrame, signal: AbortSignal): void {
    signal.throwIfAborted()
    const current = this.captureFrame(host, request)
    if (this.options.currentHost() !== host || current.occurrence !== captured.occurrence
      || current.binding !== captured.binding || current.guest !== captured.guest) throw new Error('Device preview changed during inspection')
  }
}
