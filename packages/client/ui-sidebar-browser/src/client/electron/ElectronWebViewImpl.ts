/** Electron navigation and guest lifetime, independent from DOM placement. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId, DesktopBrowserReservation } from '../../types.ts'
import type { ElectronWebviewPresentation, WebviewElement } from './ElectronWebviewPresentation.ts'
import { emptyBrowserFrame, type BrowserFrame, type BrowserFrameState, type BrowserLoadError } from '../browser/BrowserFrame.ts'
import type { BrowserPageOptions } from '../browser/BrowserPage.ts'
import type { WebsiteRequestPage } from '../browser/WebsiteRequestPage.ts'
import { browserAddressCheckpoint, currentBrowserTarget } from '../browser/BrowserPersistence.ts'
import { parseBrowserAddress, type BrowserTarget } from '../browser/url.ts'

interface NavigationEvent extends Event { readonly isMainFrame: boolean }
interface LoadFailureEvent extends NavigationEvent {
  readonly errorCode: number
  readonly errorDescription: string
}

/** Owns native history and translates Electron observations into common frame state. */
export class ElectronWebViewImpl implements BrowserFrame {
  private readonly store: SnapshotStore<BrowserFrameState>
  private readonly lifetime = new AbortController()
  private guestLifetime: AbortController | undefined
  private element: WebviewElement | undefined
  private lease: DesktopBrowserLeaseId | undefined
  private workspaceKey: string | undefined
  private initializing: Promise<void> | undefined
  private ready = false
  private pending: BrowserTarget | undefined
  private revision = 0
  private firstDocument = true
  private checkpoint: BrowserTarget | undefined
  private disposal: Promise<void> | undefined
  private attachment: AbortController | undefined
  private readonly releases = new Set<Promise<void>>()

  /**
   * @param options - saved address, persistence and source-tab opening callback.
   * @param bridge - main-process guest operations.
   * @param workspace - resolves the storage account once for this frame lifetime.
   * @param presentation - tag and Sidebar placement adapter.
   * @param requests - page-local admission control for its actual native guest.
   */
  constructor(private readonly options: BrowserPageOptions, private readonly bridge: DesktopBrowserBridge,
    private readonly workspace: (signal: AbortSignal) => Promise<string>,
    private readonly presentation: ElectronWebviewPresentation,
    private readonly requests?: WebsiteRequestPage) {
    // A saved-profile page has no restorable address: a signed-in address can
    // carry a one-time token, so its navigation is never written.
    this.checkpoint = options.profileId === undefined ? currentBrowserTarget(options.initial) : undefined
    this.store = createSnapshotStore(emptyBrowserFrame())
  }

  /** @returns immutable carrier-neutral navigation state. */
  getSnapshot = (): BrowserFrameState => this.store.getSnapshot()
  /** @param listener - state invalidation. @returns unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** A physical mount may recreate a lost guest; ordinary Sidebar hiding never calls this. */
  attach(): void {
    if (this.lifetime.signal.aborted) return
    this.attachment = new AbortController()
    this.pending ??= this.store.getSnapshot().target
    if (this.pending !== undefined) {
      this.store.set({ ...this.store.getSnapshot(), address: 'requested', loading: true,
        canGoBack: false, canGoForward: false, error: undefined })
      this.initialize()
    }
  }

  /** Invalidate pending attachment before the containing DOM is removed. */
  detach(): void {
    this.attachment?.abort()
    this.attachment = undefined
    this.pending = this.store.getSnapshot().target
    void this.dropGuest()
  }

  /** @param target - validated address, loaded without replacing the guest. */
  loadUrl(target: BrowserTarget): void {
    if (this.lifetime.signal.aborted) return
    const current = this.store.getSnapshot()
    if (this.ready && current.address === 'observed' && current.target?.url === target.url) {
      this.reload()
      return
    }
    this.revision++
    this.pending = target
    this.store.set({ ...current, target, address: 'requested', loading: true, error: undefined })
    this.persist(target)
    if (this.ready) this.loadPending()
    else this.initialize()
  }

  /** Move backward through Chromium history. */
  goBack(): void {
    if (this.store.getSnapshot().canGoBack) this.navigate('back')
  }

  /** Move forward through Chromium history. */
  goForward(): void {
    if (this.store.getSnapshot().canGoForward) this.navigate('forward')
  }

  /** Reload the actual current page, or retry failed guest creation. */
  reload(): void {
    const current = this.store.getSnapshot()
    if (this.lifetime.signal.aborted || current.target === undefined) return
    if (!this.ready || current.error !== undefined) {
      this.revision++
      this.pending = current.target
      this.store.set({ ...current, loading: true, error: undefined })
      if (this.ready) this.loadPending()
      else this.initialize()
    } else this.navigate('reload')
  }

  /** @returns after initialization and every guest release settle; rejects if any release failed. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.lifetime.abort()
    this.pending = undefined
    this.disposal = Promise.allSettled([this.dropGuest(), this.initializing]).then(async () => {
      const results = await Promise.allSettled(this.releases)
      const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (failures.length !== 0) throw new AggregateError(failures, 'Desktop browser guests failed to drain')
    })
    this.presentation.dispose()
    return this.disposal
  }

  private navigate(kind: 'back' | 'forward' | 'reload'): void {
    const element = this.element
    const lease = this.lease
    if (this.lifetime.signal.aborted || !this.ready || element === undefined || lease === undefined) return
    const revision = ++this.revision
    this.pending = undefined
    this.store.set({ ...this.store.getSnapshot(), loading: true, error: undefined })
    void this.bridge.command(lease, { kind, revision }).catch((error: unknown) => {
      if (this.element === element && !this.lifetime.signal.aborted && this.revision === revision) this.commandFailed(error)
    })
  }

  private initialize(): void {
    const attachment = this.attachment
    if (attachment === undefined || this.initializing !== undefined || this.element !== undefined || this.lifetime.signal.aborted) return
    const signal = AbortSignal.any([this.lifetime.signal, attachment.signal])
    let failed = false
    const initializing = this.createGuest(signal).catch(async (error: unknown) => {
      failed = true
      // Release failures stay in the owned inventory for terminal disposal.
      await Promise.allSettled([this.dropGuest()])
      if (!signal.aborted) this.commandFailed(error)
    }).finally(() => {
      if (this.initializing !== initializing) return
      this.initializing = undefined
      if ((!failed || this.attachment !== attachment) && this.element === undefined && this.pending !== undefined) this.initialize()
    })
    this.initializing = initializing
  }

  private async createGuest(attachmentSignal: AbortSignal): Promise<void> {
    // A failed native release blocks all replacement and retry acquisitions.
    await Promise.all(this.releases)
    if (attachmentSignal.aborted) return
    const reservation = await this.reserve(attachmentSignal)
    if (reservation === undefined) return
    // Cancellation can change while Main processes the reservation.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (attachmentSignal.aborted) { await this.release(reservation.lease); return }
    this.lease = reservation.lease
    this.guestLifetime = new AbortController()
    const signal = AbortSignal.any([attachmentSignal, this.guestLifetime.signal])
    const element = this.presentation.createElement(reservation)
    this.element = element
    const unsubscribeOpen = this.bridge.onOpenRequested(reservation.lease, (url) => {
      if (this.element === element && !signal.aborted) this.options.openRequested(url)
    })
    signal.addEventListener('abort', unsubscribeOpen, { once: true })
    if (this.options.profileId === undefined) {
      const unsubscribeReacquire = this.bridge.onReacquireRequested(reservation.lease, (url, revision) => {
        if (this.element !== element || this.lease !== reservation.lease || signal.aborted || revision !== this.revision) return
        const parsed = parseBrowserAddress(url)
        if (!parsed.ok) return
        this.revision++
        this.pending = parsed.target
        this.store.set({ ...this.store.getSnapshot(), target: parsed.target, address: 'requested', loading: true,
          canGoBack: false, canGoForward: false, error: undefined })
        this.persist(parsed.target)
        void this.dropGuest()
        this.initialize()
      })
      signal.addEventListener('abort', unsubscribeReacquire, { once: true })
    }
    const binding = { lease: reservation.lease, signal }
    element.addEventListener('dom-ready', () => {
      this.requests?.bind(binding)
      this.ready = true
      this.observe(this.store.getSnapshot().address !== 'requested')
      this.loadPending()
    }, { signal })
    element.addEventListener('did-navigate', () => { this.observe(true) }, { signal })
    element.addEventListener('did-navigate-in-page', (event) => {
      if ((event as NavigationEvent).isMainFrame) this.observe(true)
    }, { signal })
    element.addEventListener('did-start-navigation', (event) => {
      if ((event as NavigationEvent).isMainFrame) {
        this.store.set({ ...this.store.getSnapshot(), loading: true, error: undefined })
      }
    }, { signal })
    for (const name of ['did-start-loading', 'did-stop-loading', 'page-title-updated']) {
      element.addEventListener(name, () => {
        this.observe(name === 'page-title-updated' && this.store.getSnapshot().address === 'observed')
      }, { signal })
    }
    element.addEventListener('did-fail-load', (event) => {
      const failure = event as LoadFailureEvent
      if (failure.isMainFrame && failure.errorCode !== -3) {
        this.failed({ code: failure.errorCode, description: failure.errorDescription })
      }
    }, { signal })
    for (const name of ['render-process-gone', 'destroyed']) {
      element.addEventListener(name, () => { void this.dropGuest(); this.failed() }, { signal })
    }
    this.presentation.present(element)
  }

  /**
   * Reserve the guest this frame loads into.
   * @param attachmentSignal - current physical attachment lifetime.
   * @returns the approved reservation, or undefined when the lifetime ended first.
   */
  private async reserve(attachmentSignal: AbortSignal): Promise<DesktopBrowserReservation | undefined> {
    const profile = this.options.profileId
    // A saved-profile page uses that account's persistent partition instead of
    // the Workspace-keyed one, so its sign-in survives until the user clears it.
    if (profile !== undefined) return this.bridge.profiles.acquire(profile)
    this.workspaceKey ??= await this.workspace(attachmentSignal)
    while (!attachmentSignal.aborted) {
      const addressHint = this.pending?.url
      const reservation = await this.bridge.acquire(this.workspaceKey, addressHint)
      // The awaited reservation does not preserve the signal's earlier state.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (attachmentSignal.aborted || addressHint === this.pending?.url) return reservation
      // An acquisition selected for a superseded target never reaches the DOM.
      await this.release(reservation.lease)
    }
    return undefined
  }

  private loadPending(): void {
    const target = this.pending
    const element = this.element
    const lease = this.lease
    if (!this.ready || target === undefined || element === undefined || lease === undefined) return
    const revision = this.revision
    this.pending = undefined
    void this.bridge.command(lease, { kind: 'navigate', url: target.url, revision }).catch((error: unknown) => {
      if (this.element !== element || this.lifetime.signal.aborted || this.revision !== revision) return
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_ABORTED') return
      if (this.store.getSnapshot().error === undefined) this.commandFailed(error)
    })
  }

  private observe(committed: boolean): void {
    if (!this.ready || this.element === undefined || this.lifetime.signal.aborted) return
    try { this.observeReady(this.element, committed) }
    catch (error) { this.commandFailed(error) }
  }

  private observeReady(element: WebviewElement, committed: boolean): void {
    const current = this.store.getSnapshot()
    const parsed = committed ? parseBrowserAddress(element.getURL()) : undefined
    if (parsed?.ok && this.firstDocument) {
      // The lease-bearing bootstrap document is not a user history entry.
      element.clearHistory()
      this.firstDocument = false
    }
    let target = current.target
    let address = current.address
    if (parsed?.ok) {
      target = { ...parsed.target, title: element.getTitle() || parsed.target.title }
      address = 'observed'
      this.presentation.show(target.title)
    }
    const loading = current.error === undefined && element.isLoading()
    const canGoBack = element.canGoBack()
    const canGoForward = element.canGoForward()
    if (target?.url !== current.target?.url || target?.title !== current.target?.title || address !== current.address
      || loading !== current.loading || canGoBack !== current.canGoBack || canGoForward !== current.canGoForward) {
      this.store.set({ ...current, target, address, loading, canGoBack, canGoForward })
    }
    if (parsed?.ok && target !== undefined) this.persist(target)
  }

  private persist(target: BrowserTarget): void {
    // Observed and signed-in addresses, with their queries and titles, stay out
    // of storage for a saved-profile page; only the ephemeral workspace page
    // reports where it went.
    if (this.options.profileId !== undefined) return
    if (target.url === this.checkpoint?.url && target.title === this.checkpoint.title) return
    this.checkpoint = target
    this.options.persist(browserAddressCheckpoint(target, this.revision))
  }

  private failed(error: BrowserLoadError = { code: undefined, description: undefined }): void {
    if (this.lifetime.signal.aborted) return
    const current = this.store.getSnapshot()
    this.store.set({ ...current, loading: false, error,
      canGoBack: this.ready && current.canGoBack, canGoForward: this.ready && current.canGoForward })
  }

  private commandFailed(error: unknown): void {
    if (this.options.profileId === undefined) console.error('Desktop browser operation failed', error)
    this.failed()
  }

  private dropGuest(): Promise<void> {
    this.guestLifetime?.abort()
    this.guestLifetime = undefined
    this.presentation.clear()
    this.element = undefined
    this.ready = false
    this.firstDocument = true
    const lease = this.lease
    this.lease = undefined
    return lease === undefined ? Promise.resolve() : this.release(lease)
  }

  private release(lease: DesktopBrowserLeaseId): Promise<void> {
    const released = (async () => this.bridge.release(lease))()
    this.releases.add(released)
    void released.then(() => { this.releases.delete(released) }, (error: unknown) => {
      // Failed releases remain joinable; private guest diagnostics are not published.
      void error
    })
    return released
  }
}
