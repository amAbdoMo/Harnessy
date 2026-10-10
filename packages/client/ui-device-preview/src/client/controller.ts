/** Retained preview pages, exact guest bindings and explicit URL navigation for one Client Session. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { NativeBrowser, BrowserPage } from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type { BrowserViewport, DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DesktopDevicePreviewBridge, DevicePreviewBinding, DevicePreviewId, DevicePreviewOpenRequest } from '../types.ts'
import type { DeviceLane } from './viewport.ts'
import type { DevicePreviewRuntime, DevicePreviewTabRuntime, DeviceSurfaceGeometry, DeviceSurfaceState } from './model.ts'

interface Lane {
  readonly page: BrowserPage
  readonly setViewport: (viewport: BrowserViewport) => void
  readonly unsubscribe: () => void
  geometry: DeviceSurfaceGeometry | undefined
  acknowledged: BrowserViewport | undefined
  lease: DesktopBrowserLeaseId | undefined
  visible: boolean
  host: HTMLElement | undefined
  detach: (() => void) | undefined
  binding: DevicePreviewBinding | undefined
  bindingTail: Promise<void>
  failure: 'address' | 'approval' | undefined
}
interface Tab {
  readonly id: TabId
  phone: Lane
  tablet: Lane
  request: DevicePreviewOpenRequest | undefined
  removeAbort: (() => void) | undefined
  disposed: boolean
  acknowledgement: 'pending' | 'sending' | 'done'
  stopping: boolean
  stopped: boolean
  stopFailed: boolean
}
/** Private dependencies captured by the apply closure; components see only plain callbacks and snapshots. */
export interface DevicePreviewControllerOptions {
  readonly sessionId: SessionId
  readonly native: NativeBrowser
  readonly bridge: DesktopDevicePreviewBridge
  readonly applicationOrigin: string
  readonly request: (id: DevicePreviewId) => DevicePreviewOpenRequest | undefined
  readonly openLink: (url: string) => void
  readonly closed: (id: TabId) => void
  readonly stopNotice: (success: boolean, url: string) => void
}

function target(value: string, applicationOrigin: string): { kind: 'http'; url: string; title: string } | undefined {
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === applicationOrigin) return undefined
    return { kind: 'http', url: url.href, title: url.host }
  } catch (error: unknown) { void error; return undefined }
}

/** Owns two independent pages until their tab occurrence closes, not until it hides. */
export class DevicePreviewControllers {
  /** Stable native facts consumed through the registration's framework-bound hook. */
  readonly source: SnapshotStore<DevicePreviewRuntime> = createSnapshotStore({ liveAvailable: true, byTab: {} })
  private readonly tabs = new Map<TabId, Tab>()
  private readonly draining = new Set<Promise<void>>()
  private disposed = false
  private disposal: Promise<void> | undefined

  /** @param options - captured Session, native page provider, exact preview transport and reporting callbacks. */
  constructor(private readonly options: DevicePreviewControllerOptions) {}

  private tab(id: TabId): Tab {
    const existing = this.tabs.get(id)
    if (existing !== undefined) return existing
    if (this.disposed) throw new Error('Device preview Session is closed')
    const pair = this.pair(id)
    const tab: Tab = { id, ...pair, request: undefined,
      removeAbort: undefined, disposed: false, acknowledgement: 'pending', stopping: false, stopped: false, stopFailed: false }
    this.tabs.set(id, tab)
    this.publish()
    return tab
  }

  private track(operation: Promise<void>): void {
    this.draining.add(operation)
    void operation.then(() => { this.draining.delete(operation) }, (error: unknown) => {
      console.error('Device preview retired occurrence could not drain', error)
    })
  }

  private pair(id: TabId): Pick<Tab, 'phone' | 'tablet'> {
    const phone = this.lane(id, 'phone')
    try { return { phone, tablet: this.lane(id, 'tablet') } }
    catch (error: unknown) {
      phone.unsubscribe()
      const rollback = phone.page.frame.dispose()
      this.draining.add(rollback)
      void rollback.catch((failure: unknown) => { console.error('Device preview page allocation rollback failed', failure) })
      throw error
    }
  }

  /** Replacement openings cannot share guests targeted by the previous opening's native cancellation. */
  private replacePages(tab: Tab, pair: Pick<Tab, 'phone' | 'tablet'>): void {
    const previousPair = { phone: tab.phone, tablet: tab.tablet }
    tab.phone = pair.phone
    tab.tablet = pair.tablet
    for (const name of ['phone', 'tablet'] as const) {
      const previous = previousPair[name]
      const next = pair[name]
      next.geometry = previous.geometry
      next.visible = previous.visible
      next.host = previous.host
      this.revokeBinding(previous)
      previous.unsubscribe()
      previous.detach?.()
      previous.detach = undefined
      previous.host = undefined
      this.track(previous.bindingTail)
      this.track(previous.page.frame.dispose())
      if (next.geometry !== undefined) next.setViewport(next.geometry)
      if (next.host !== undefined) next.detach = next.page.presentation.mount(next.host.id)
    }
  }

  private lane(id: TabId, name: DeviceLane): Lane {
    let lane: Lane | undefined = undefined
    const page = this.options.native.createPage({ sessionId: this.options.sessionId,
      options: { initial: undefined, profileId: undefined, persist: () => {}, openRequested: this.options.openLink },
      leaseChanged: (lease, viewport) => {
        const tab = this.tabs.get(id)
        if (this.disposed || tab === undefined || tab.disposed || lane === undefined || tab[name] !== lane) return
        const previous = lane.lease
        lane.lease = lease
        lane.acknowledged = viewport
        if (previous !== lease) lane.binding = undefined
        this.synchronize(id, name)
      },
    })
    const setViewport = page.frame.setViewport
    if (setViewport === undefined) {
      const disposal = page.frame.dispose()
      this.draining.add(disposal)
      void disposal.catch((error: unknown) => { console.error('Unsupported device preview page could not drain', error) })
      throw new Error('Device preview native provider does not support fixed CSS viewports')
    }
    lane = { page, setViewport: setViewport.bind(page.frame), lease: undefined, geometry: undefined,
      acknowledged: undefined, visible: false, host: undefined,
      detach: undefined, binding: undefined, bindingTail: Promise.resolve(), failure: undefined,
      unsubscribe: page.frame.subscribe(() => { this.publish() }) }
    return lane
  }

  /** Capture the tab lifetime and admit only a fresh explicit native opening.
   * @param id - current tab occurrence. @param signal - lifetime ending on tab closure, not hiding.
   * @param _url - initial editable URL, which never authorizes automatic restoration.
   * @param previewId - optional fresh native opening request; persisted stale identifiers grant nothing.
   * @returns whether a new live-web opening was admitted; the view selects Web only for that explicit action.
   */
  retainTab = (id: TabId, signal: AbortSignal, _url?: string, previewId?: DevicePreviewId): boolean => {
    const tab = this.tab(id)
    if (tab.removeAbort === undefined) {
      const abort = () => { this.retire(tab) }
      signal.addEventListener('abort', abort, { once: true })
      tab.removeAbort = () => { signal.removeEventListener('abort', abort) }
      if (signal.aborted) { abort(); return false }
    }
    if (previewId === undefined || tab.request?.previewId === previewId) return false
    const request = this.options.request(previewId)
    if (request === undefined || request.sessionId !== this.options.sessionId) return false
    const replacement = tab.request === undefined ? undefined : this.pair(id)
    if (tab.request !== undefined) {
      const previousId = tab.request.previewId
      this.track(Promise.resolve().then(() => this.options.bridge.close(previousId)))
    }
    tab.request = request
    tab.acknowledgement = 'pending'
    tab.stopping = false
    if (replacement !== undefined) this.replacePages(tab, replacement)
    tab.phone.binding = undefined
    tab.tablet.binding = undefined
    tab.stopped = false
    tab.stopFailed = false
    this.navigate(id, 'phone', request.server.url)
    this.navigate(id, 'tablet', request.server.url)
    this.synchronize(id, 'phone')
    this.synchronize(id, 'tablet')
    return true
  }

  /** Attach one retained page to its committed flat device screen.
   * @param id - tab occurrence. @param name - independent lane. @param host - committed flat screen.
   * @param geometry - initial unscaled CSS dimensions and physical display scale.
   * @returns cleanup for this DOM occurrence; orientation/fit updates do not invoke it.
   */
  mountSurface = (id: TabId, name: DeviceLane, host: HTMLElement, geometry: DeviceSurfaceGeometry): (() => void) => {
    const lane = this.tab(id)[name]
    if (lane.host !== undefined && lane.host !== host) throw new Error('Device preview screen is already attached')
    lane.geometry = geometry
    lane.setViewport(geometry)
    if (host.id === '') host.id = `device-preview-screen-${randomUUID()}`
    lane.host = host
    lane.detach = lane.page.presentation.mount(host.id)
    return () => {
      const current = this.tabs.get(id)?.[name]
      if (current?.host !== host) return
      current.visible = false
      this.revokeBinding(current)
      this.synchronize(id, name)
      current.detach?.()
      current.detach = undefined
      current.host = undefined
    }
  }

  /** Change responsive dimensions or inspection visibility without replacing the page.
   * @param id - tab occurrence. @param name - independent lane. @param geometry - requested CSS viewport and visual fit.
   * @param visible - committed tab and lane visibility; hidden pages retain their DOM/history but cannot be inspected.
   */
  updateSurface = (id: TabId, name: DeviceLane, geometry: DeviceSurfaceGeometry, visible: boolean): void => {
    const lane = this.tab(id)[name]
    const previous = lane.geometry
    const changed = previous === undefined || previous.width !== geometry.width
      || previous.height !== geometry.height || previous.scale !== geometry.scale
    lane.geometry = geometry
    lane.visible = visible
    if (changed || !visible) this.revokeBinding(lane)
    if (changed) lane.setViewport(geometry)
    this.synchronize(id, name)
  }

  /** Navigate only the requested device after credential-free URL validation.
   * @param id - tab occurrence. @param name - target lane only. @param value - explicit user or fresh native-request URL. */
  navigate = (id: TabId, name: DeviceLane, value: string): void => {
    const lane = this.tab(id)[name]
    const next = target(value, this.options.applicationOrigin)
    if (next === undefined) { lane.failure = 'address'; this.publish(); return }
    lane.failure = undefined
    lane.page.frame.loadUrl(next)
    this.publish()
  }
  /** Retry or refresh the requested device's current native page.
   * @param id - tab occurrence. @param name - target lane only. */
  reload = (id: TabId, name: DeviceLane): void => { this.tab(id)[name].page.frame.reload() }
  /** Move backward in this device's independent native history.
   * @param id - tab occurrence. @param name - target lane only. */
  goBack = (id: TabId, name: DeviceLane): void => { this.tab(id)[name].page.frame.goBack() }
  /** Move forward in this device's independent native history.
   * @param id - tab occurrence. @param name - target lane only. */
  goForward = (id: TabId, name: DeviceLane): void => { this.tab(id)[name].page.frame.goForward() }

  private revokeBinding(lane: Lane): void {
    const binding = lane.binding
    if (binding === undefined) return
    lane.binding = undefined
    let revocation: Promise<void>
    const { previewId, slot, lease } = binding
    try { revocation = this.options.bridge.unbind({ previewId, slot, lease }) }
    catch (error: unknown) { revocation = Promise.reject(error) }
    lane.bindingTail = Promise.all([lane.bindingTail, revocation]).then(() => {}).catch((error: unknown) => {
      lane.failure = 'approval'
      if (!this.disposed) this.publish()
      console.error('Device preview geometry revocation failed', error)
    })
  }

  private synchronize(id: TabId, name: DeviceLane): void {
    const tab = this.tabs.get(id)
    if (tab === undefined || tab.disposed || tab.request === undefined
      || this.options.request(tab.request.previewId) !== tab.request) return
    const lane = tab[name]
    const geometry = lane.geometry
    const acknowledged = lane.acknowledged
    if (lane.lease === undefined || geometry === undefined || acknowledged === undefined
      || geometry.width !== acknowledged.width || geometry.height !== acknowledged.height || geometry.scale !== acknowledged.scale) return
    const binding: DevicePreviewBinding = { previewId: tab.request.previewId, slot: name, lease: lane.lease,
      width: geometry.width, height: geometry.height, visible: lane.visible && lane.host !== undefined }
    const old = lane.binding
    if (old?.lease === binding.lease && old.width === binding.width && old.height === binding.height
      && old.visible === binding.visible) return
    lane.binding = binding
    lane.bindingTail = lane.bindingTail.then(async () => {
      if (tab.disposed || lane.binding !== binding || this.options.request(binding.previewId) !== tab.request) return
      await this.options.bridge.bind(binding)
      if (tab.disposed || lane.binding !== binding || this.options.request(binding.previewId) !== tab.request) return
      if (lane.failure === 'approval') lane.failure = undefined
      this.publish()
      await this.acknowledge(tab, binding)
    }).catch((error: unknown) => {
      if (!tab.disposed && lane.binding === binding) {
        lane.binding = undefined
        lane.failure = 'approval'
        this.publish()
      }
      console.error('Device preview guest binding failed', error)
    })
  }

  private async acknowledge(tab: Tab, binding: DevicePreviewBinding): Promise<void> {
    const request = tab.request
    if (request === undefined || this.options.request(request.previewId) !== request
      || !binding.visible || tab.acknowledgement !== 'pending') return
    tab.acknowledgement = 'sending'
    try {
      await this.options.bridge.acknowledge({ requestId: request.requestId, previewId: request.previewId, opened: true })
      if (tab.request === request) tab.acknowledgement = 'done'
    } catch (error: unknown) {
      if (tab.request === request) tab.acknowledgement = 'pending'
      throw error
    }
  }

  /** Request explicit physical Stop for a recorded owned launcher, never an external endpoint.
   * @param id - preview tab whose opening request records its owned launcher. */
  stopProject = (id: TabId): void => {
    const tab = this.tab(id)
    const request = tab.request
    const projectId = request?.server.projectId
    if (request === undefined || projectId === undefined || request.server.ownership !== 'owned' || tab.stopping || tab.stopped) return
    tab.stopping = true
    this.publish()
    const stopping = this.options.bridge.stop(projectId).then(() => {
      if (tab.request === request) { tab.stopped = true; tab.stopFailed = false }
      if (!this.disposed) this.options.stopNotice(true, request.server.url)
    }, (error: unknown) => {
      if (tab.request === request) tab.stopFailed = true
      if (!this.disposed) this.options.stopNotice(false, request.server.url)
      console.error('Device preview owned launcher stop failed', error)
    }).finally(() => {
      if (tab.request === request) { tab.stopping = false; if (!tab.disposed) this.publish() }
    })
    this.draining.add(stopping)
    void stopping.then(() => { this.draining.delete(stopping) }, (error: unknown) => { console.error('Device preview Stop feedback failed', error) })
  }

  private state(lane: Lane): DeviceSurfaceState {
    const frame = lane.page.frame.getSnapshot()
    return { phase: lane.failure !== undefined || frame.error !== undefined ? 'error'
      : frame.loading ? 'loading' : frame.target === undefined ? 'idle' : 'ready',
    ...(frame.target === undefined ? {} : { url: frame.target.url }), canGoBack: frame.canGoBack, canGoForward: frame.canGoForward,
    ...(lane.failure !== undefined ? { failure: lane.failure } : frame.error !== undefined ? { failure: 'load' as const } : {}) }
  }

  private publish(): void {
    if (this.disposed) return
    const byTab: Partial<Record<TabId, DevicePreviewTabRuntime>> = {}
    for (const tab of this.tabs.values()) {
      if (tab.disposed) continue
      const server = tab.request?.server
      byTab[tab.id] = { phone: this.state(tab.phone), tablet: this.state(tab.tablet),
        ...(server === undefined ? {} : { project: {
          phase: server.ownership === 'external' ? 'external' as const : tab.stopFailed ? 'error' as const : tab.stopping ? 'stopping' as const : tab.stopped ? 'idle' as const
            : server.status === 'failed' ? 'error' as const : server.status === 'stopped' ? 'idle' as const
              : server.status === 'starting' ? 'starting' as const : 'running' as const,
          url: server.url, canStop: server.ownership === 'owned' && !tab.stopped && !tab.stopping,
        } }),
      }
    }
    this.source.set({ liveAvailable: true, byTab })
  }

  private retire(tab: Tab): void {
    if (tab.disposed) return
    tab.disposed = true
    this.tabs.delete(tab.id)
    tab.removeAbort?.()
    tab.phone.unsubscribe()
    tab.tablet.unsubscribe()
    this.options.closed(tab.id)
    this.publish()
    const closure = Promise.allSettled([
      ...(tab.request === undefined ? [] : [this.options.bridge.close(tab.request.previewId)]),
      tab.phone.page.frame.dispose(), tab.tablet.page.frame.dispose(), tab.phone.bindingTail, tab.tablet.bindingTail,
    ]).then((results) => {
      const errors = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (errors.length !== 0) throw new AggregateError(errors, 'Device preview pages failed to drain')
    })
    this.draining.add(closure)
    void closure.then(() => { this.draining.delete(closure) }, (error: unknown) => { console.error('Device preview tab cleanup failed', error) })
  }

  /** Fence new pages and join all tab drainage, including concurrent disposal callers.
   * @returns after every retained or retired page drains; no development server is stopped.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    for (const tab of this.tabs.values()) this.retire(tab)
    this.disposal = Promise.allSettled(this.draining).then((results) => {
      const errors = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (errors.length !== 0) throw new AggregateError(errors, 'Device preview Session failed to drain')
    })
    return this.disposal
  }
}
