/** Inert replacement for Electron's external guest carrier; controller and snapshot stores remain real. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { BrowserFrameState, BrowserPage, NativeBrowser, NativeBrowserPageRequest } from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type { BrowserViewport, DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { BrowserTarget } from '@deepseek-ai/dsh-client-ui-sidebar-browser/src/client/browser/url.ts'
import type { DesktopDevicePreviewBridge, DevicePreviewBinding, DevicePreviewId, DevicePreviewOpenAcknowledgement, DevicePreviewOpenRequest, DevicePreviewProjectId } from '../src/types.ts'

/** Physical guest/history fixture: no Electron process, network, timers, or controller internals. */
export class InertGuest {
  readonly state = createSnapshotStore<BrowserFrameState>({ target: undefined, address: 'empty', loading: false,
    canGoBack: false, canGoForward: false, error: undefined, sandboxEnabled: undefined })
  readonly history: BrowserTarget[] = []
  readonly viewports: BrowserViewport[] = []
  readonly mounts: string[] = []
  readonly disposalStarted = Promise.withResolvers<undefined>()
  disposalGate: Promise<void> = Promise.resolve()
  reloads = 0
  detached = 0
  disposed = false
  private position = -1
  private disposal: Promise<void> | undefined
  readonly page: BrowserPage

  constructor(readonly request: NativeBrowserPageRequest) {
    this.page = {
      frame: {
        getSnapshot: this.state.getSnapshot, subscribe: this.state.subscribe,
        setViewport: (viewport) => { this.viewports.push({ ...viewport }) },
        loadUrl: (target) => {
          this.history.splice(this.position + 1)
          this.history.push(target)
          this.position = this.history.length - 1
          this.publish()
        },
        reload: () => { this.reloads += 1; this.publish() },
        goBack: () => { if (this.position > 0) { this.position -= 1; this.publish() } },
        goForward: () => { if (this.position + 1 < this.history.length) { this.position += 1; this.publish() } },
        dispose: () => {
          if (this.disposal === undefined) {
            this.disposed = true
            this.disposalStarted.resolve(undefined)
            this.disposal = this.disposalGate
          }
          return this.disposal
        },
      },
      presentation: { mount: (host) => {
        this.mounts.push(host)
        return () => { this.detached += 1 }
      } },
    }
  }

  /** @param lease - native reservation or revocation. @param viewport - acknowledged, not merely requested, geometry. */
  acknowledge(lease: DesktopBrowserLeaseId | undefined, viewport?: BrowserViewport): void {
    this.request.leaseChanged?.(lease, viewport)
  }

  /** @param description - external guest's load diagnostic. */
  failLoad(description: string): void {
    this.state.set({ ...this.state.getSnapshot(), loading: false, error: { code: -1, description } })
  }

  private publish(): void {
    this.state.set({ target: this.history[this.position], address: 'observed', loading: false,
      canGoBack: this.position > 0, canGoForward: this.position + 1 < this.history.length,
      error: undefined, sandboxEnabled: undefined })
  }
}

/** Native service replacement at the external Electron page-carrier seam. */
export class InertNativeBrowser implements NativeBrowser {
  readonly guests: InertGuest[] = []
  createPage(request: NativeBrowserPageRequest): BrowserPage {
    const guest = new InertGuest(request)
    this.guests.push(guest)
    return guest.page
  }
}

/** Renderer-to-Main IPC fixture; request authority and physical page lifetime are separate. */
export class InertPreviewBridge implements DesktopDevicePreviewBridge {
  readonly listeners = new Set<(request: DevicePreviewOpenRequest) => void>()
  readonly bindings: DevicePreviewBinding[] = []
  readonly acknowledgements: DevicePreviewOpenAcknowledgement[] = []
  readonly closes: DevicePreviewId[] = []
  readonly stops: DevicePreviewProjectId[] = []
  readonly unbindings: Pick<DevicePreviewBinding, 'previewId' | 'slot' | 'lease'>[] = []
  stopGate: (projectId: DevicePreviewProjectId) => Promise<void> = () => Promise.resolve()
  readonly closeStarted = Promise.withResolvers<undefined>()
  bindGate: (binding: DevicePreviewBinding) => Promise<void> = () => Promise.resolve()
  acknowledgementGate: (acknowledgement: DevicePreviewOpenAcknowledgement) => Promise<void> = () => Promise.resolve()
  closeGate: Promise<void> = Promise.resolve()
  private readonly bindingWaiters: { count: number; resolve: () => void }[] = []

  onOpenRequested(listener: (request: DevicePreviewOpenRequest) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  async bind(binding: DevicePreviewBinding): Promise<void> {
    this.bindings.push(binding)
    for (const waiter of this.bindingWaiters) if (this.bindings.length >= waiter.count) waiter.resolve()
    await this.bindGate(binding)
  }
  async unbind(binding: Pick<DevicePreviewBinding, 'previewId' | 'slot' | 'lease'>): Promise<void> {
    this.unbindings.push(binding)
  }
  async acknowledge(acknowledgement: DevicePreviewOpenAcknowledgement): Promise<void> {
    this.acknowledgements.push(acknowledgement)
    await this.acknowledgementGate(acknowledgement)
  }
  async close(id: DevicePreviewId): Promise<void> {
    this.closes.push(id)
    this.closeStarted.resolve(undefined)
    await this.closeGate
  }
  async stop(id: DevicePreviewProjectId): Promise<void> { this.stops.push(id); await this.stopGate(id) }

  /** @param count - number of IPC binds dispatched. @returns once those binds enter the external carrier. */
  bound(count: number): Promise<void> {
    if (this.bindings.length >= count) return Promise.resolve()
    return new Promise((resolve) => { this.bindingWaiters.push({ count, resolve }) })
  }
  /** @param request - Main-issued request delivered to current listeners. */
  open(request: DevicePreviewOpenRequest): void { for (const listener of this.listeners) listener(request) }
}

/** @returns after the currently queued binding-dispatch microtask, without a wall-clock delay. */
export function dispatchBarrier(): Promise<void> { return new Promise((resolve) => { queueMicrotask(resolve) }) }
