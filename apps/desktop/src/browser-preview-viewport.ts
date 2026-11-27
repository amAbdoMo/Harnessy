/** Lease-private Chromium viewport and page color scheme overrides. */
import type { BrowserViewport, DesktopBrowserDefaults } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

type EmulationValue = number | boolean | readonly { name: string; value: string }[]

interface MetricsGuest {
  isDestroyed(): boolean
  isDevToolsOpened(): boolean
  readonly debugger: {
    attach(version: string): void
    isAttached(): boolean
    detach(): void
    sendCommand(method: string, parameters: Readonly<Record<string, EmulationValue>>): Promise<object>
    on(event: 'detach', listener: () => void): void
    removeListener(event: 'detach', listener: () => void): void
  }
}

/** Internal guest-owned metrics controller; the lease owner destroys the guest after drainage. */
export class BrowserPreviewViewport {
  private viewport: BrowserViewport | undefined
  private tail: Promise<void> = Promise.resolve()
  private owned = false
  private detached = false
  private disposed = false
  private failure: Error | undefined
  private appearance: Promise<void> | undefined
  private readonly onDetached = (): void => {
    this.detached = true
    if (!this.disposed && this.usable()) this.ownershipLost()
  }

  /**
   * @param guest - exact ordinary native guest; no page observation is performed.
   * @param usable - current owner and lease admission, rechecked before every native command.
   * @param ownershipLost - synchronously fences or releases the guest when DevTools takes the debugger.
   */
  constructor(private readonly guest: MetricsGuest,
    private readonly usable: () => boolean, private readonly ownershipLost: () => void) {}

  /** Whether viewport metrics are managed independently of the native window size. */
  get hasViewport(): boolean { return this.viewport !== undefined }

  /** @param viewport - IPC-validated dimensions and fit. @returns after ordered Chromium acknowledgement. */
  set(viewport: BrowserViewport): Promise<void> {
    this.viewport = viewport
    return this.applyViewport(viewport)
  }

  /** @returns after the retained metrics are reapplied; unused guests never acquire a debugger. */
  reapply(): Promise<void> {
    return this.viewport === undefined ? Promise.resolve() : this.applyViewport(this.viewport)
  }

  /** @param appearance - page color scheme override. @returns after Chromium acknowledges the preference. */
  setAppearance(appearance: Exclude<DesktopBrowserDefaults['appearance'], 'system'>): Promise<void> {
    if (this.appearance !== undefined) return this.appearance
    const operation = this.enqueue(async () => {
      await this.guest.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: appearance }],
      })
    })
    this.appearance = operation
    void operation.catch((_error: unknown) => {
      if (this.appearance === operation) this.appearance = undefined
    })
    return operation
  }

  /** Relinquish the color scheme connection before the local inspector takes ownership. */
  suspendAppearance(): void {
    if (this.hasViewport) return
    this.appearance = undefined
    if (!this.owned || !this.guest.debugger.isAttached()) return
    this.owned = false
    this.guest.debugger.removeListener('detach', this.onDetached)
    this.guest.debugger.detach()
  }

  /** @returns after preceding metrics settle; navigation must check its lease again before dispatch. */
  settled(): Promise<void> {
    return this.tail.then(() => { if (this.failure !== undefined) throw this.failure })
  }

  /** @returns after admitted metrics settle; never detaches another debugger owner. */
  dispose(): Promise<void> {
    this.disposed = true
    if (this.owned) this.guest.debugger.removeListener('detach', this.onDetached)
    return this.tail
  }

  private applyViewport(viewport: BrowserViewport): Promise<void> {
    return this.enqueue(async () => {
      await this.guest.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
        scale: viewport.scale, screenWidth: viewport.width, screenHeight: viewport.height,
        positionX: 0, positionY: 0, dontSetVisibleSize: true,
      })
    })
  }

  private enqueue(send: () => Promise<void>): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.disposed || !this.usable() || this.guest.isDestroyed()) throw new Error('Desktop browser viewport guest unavailable')
      this.attachDebugger()
      await send()
    })
    // Each caller observes its own rejection; the ordering barrier permits a subsequent explicit retry.
    this.tail = operation.then(() => { this.failure = undefined }, (error: unknown) => {
      this.failure = new Error('Desktop browser viewport native command failed', { cause: error })
    })
    return operation
  }

  private attachDebugger(): void {
    const debuggerApi = this.guest.debugger
    if (this.guest.isDevToolsOpened()) throw new Error('Desktop browser viewport DevTools already open')
    if (this.detached) throw new Error('Desktop browser viewport debugger ownership lost')
    if (this.owned) {
      if (!debuggerApi.isAttached()) throw new Error('Desktop browser viewport debugger ownership lost')
      return
    }
    if (debuggerApi.isAttached()) throw new Error('Desktop browser viewport debugger already owned')
    debuggerApi.attach('1.3')
    this.owned = true
    debuggerApi.on('detach', this.onDetached)
  }
}
