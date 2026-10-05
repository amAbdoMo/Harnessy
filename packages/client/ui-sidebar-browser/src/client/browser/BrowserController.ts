/** Carrier-independent tab commands and renderer-facing state. */
import { createSnapshotStore, type BoundActions, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopWebsiteProfileId, DesktopWebsiteRequestId } from '../../types.ts'
import type { WebsiteRequestPageState } from './WebsiteRequestPage.ts'
import type { BrowserFrameState } from './BrowserFrame.ts'
import type { BrowserPage, BrowserPageFactory } from './BrowserPage.ts'
import { currentBrowserTarget, type BrowserTabState } from './BrowserPersistence.ts'
import type { WebsiteProfileCommands, WebsiteProfilesState } from './profiles.ts'
import type { BrowserStore } from './store.ts'
import { parseBrowserAddress, type BrowserAddressFailure, type BrowserTarget } from './url.ts'

/** Live tab state; navigation comes from its provider and draft validation stays local. */
export interface BrowserControllerState {
  readonly frame: BrowserFrameState
  /** Saved address offered for explicit restoration before any page has been requested. */
  readonly restoreTarget: BrowserTarget | undefined
  readonly addressFailure: BrowserAddressFailure | undefined
  readonly addressRevision: number
}

/** Construction inputs for one tab occurrence. */
export interface BrowserControllerOptions {
  readonly tabId: TabId
  readonly signal: AbortSignal
  readonly applicationOrigin: string
  readonly initial: BrowserTabState | undefined
  readonly profileId: DesktopWebsiteProfileId | undefined
  /** Live Main-projected inventory; absent carriers cannot authorize saved-account commands. */
  readonly websiteProfiles?: (() => WebsiteProfilesState) | undefined
  readonly actions: BoundActions<BrowserStore>
  readonly createPage: BrowserPageFactory
  readonly openTab: (url: string) => void
}

/** Owns input validation and page lifetime without inspecting the carrier type. */
export class BrowserController implements HostObservable<BrowserControllerState> {
  private readonly page: BrowserPage
  private readonly store: SnapshotStore<BrowserControllerState>
  private readonly unsubscribe: () => void
  private actions: BoundActions<BrowserStore>
  private checkpoint: BrowserTabState | undefined
  private started = false
  private disposed = false
  private disposal: Promise<void> | undefined
  private readonly abort = (): void => { void this.dispose() }

  /** @param options - identity, persistence, page factory and source-tab navigation. */
  constructor(private readonly options: BrowserControllerOptions) {
    this.actions = options.actions
    // A saved-profile page carries no restorable address: every observed URL and
    // title stays out of storage, because a signed-in page's address can hold a
    // one-time token. Its first page comes from the tab's own open parameters.
    this.checkpoint = options.profileId === undefined ? options.initial : undefined
    const checkpoint = this.checkpoint
    this.page = options.createPage({
      initial: checkpoint,
      profileId: options.profileId,
      persist: (state) => {
        if (this.disposed || options.profileId !== undefined) return
        this.checkpoint = state
        this.actions.replace(options.tabId, state)
      },
      openRequested: (value) => {
        if (this.disposed) return
        const result = parseBrowserAddress(value, options.applicationOrigin)
        if (!result.ok) { this.addressFailed(result.reason); return }
        options.openTab(result.target.url)
      },
    })
    this.store = createSnapshotStore({ frame: this.page.frame.getSnapshot(),
      restoreTarget: currentBrowserTarget(this.checkpoint), addressFailure: undefined, addressRevision: 0 })
    this.unsubscribe = this.page.frame.subscribe(() => {
      if (this.disposed) return
      const current = this.store.getSnapshot()
      const frame = this.page.frame.getSnapshot()
      const changed = frame.target?.url !== current.frame.target?.url
      this.store.set({ frame, restoreTarget: frame.target === undefined ? currentBrowserTarget(this.checkpoint) : undefined,
        addressFailure: changed ? undefined : current.addressFailure,
        addressRevision: current.addressRevision + Number(changed) })
    })
    options.signal.addEventListener('abort', this.abort, { once: true })
  }

  /**
   * Expose request controls without publishing native guest identities.
   * @returns this page's request-only source.
   */
  get requests(): BrowserPage['requests'] { return this.page.requests }

  /** @returns immutable state for the common toolbar. */
  getSnapshot = (): BrowserControllerState => this.store.getSnapshot()
  /** @param listener - state invalidation. @returns unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /**
   * Attach the page without transferring ownership of its tab occurrence.
   * @param viewportId - mounted content container.
   * @returns physical attachment cleanup only.
   */
  mount(viewportId: string): () => void {
    this.publishSaved()
    return this.page.presentation.mount(viewportId)
  }

  /**
   * Consume initial navigation once; a saved checkpoint alone never starts a page.
   * @param initialUrl - explicit typed-open address, or absence.
   */
  start(initialUrl: string | undefined): void {
    if (this.started || this.disposed) return
    this.started = true
    if (initialUrl !== undefined) this.loadUrl(initialUrl)
  }

  /** Load the saved address only after an explicit restore action. */
  restore(): void {
    const target = this.store.getSnapshot().restoreTarget
    if (target !== undefined) this.loadUrl(target.url)
  }

  /**
   * Validate an address before navigation, publishing invalid input for correction.
   * @param value - address-bar or typed-open input.
   */
  loadUrl(value: string): void {
    if (this.disposed) return
    const parsed = parseBrowserAddress(value, this.options.applicationOrigin)
    if (!parsed.ok) { this.addressFailed(parsed.reason); return }
    this.command(() => { this.page.frame.loadUrl(parsed.target) })
  }

  /** Delegate Back to the page's navigation provider. */
  goBack(): void { this.command(() => { this.page.frame.goBack() }) }
  /** Delegate Forward to the page's navigation provider. */
  goForward(): void { this.command(() => { this.page.frame.goForward() }) }
  /** Restore a saved address, or reload the already requested page. */
  reload(): void {
    if (this.store.getSnapshot().restoreTarget !== undefined) this.restore()
    else this.command(() => { this.page.frame.reload() })
  }

  /**
   * Apply the optional embedding-sandbox control; unsupported providers remain unchanged.
   * @param enabled - whether to enforce the provider's embedding sandbox.
   */
  setSandbox(enabled: boolean): void {
    const sandbox = this.page.frame.sandbox
    if (sandbox !== undefined) this.command(() => { sandbox.setEnabled(enabled) })
  }

  /**
   * Redirect future checkpoint writes to a replacement Session binding.
   * @param actions - replacement persistence writer.
   */
  rebind(actions: BoundActions<BrowserStore>): void { this.actions = actions }

  /**
   * Release the page and detach occurrence and state listeners.
   * @returns after page teardown; repeated callers join the same disposal.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.options.signal.removeEventListener('abort', this.abort)
    this.unsubscribe()
    const requests = this.page.requests?.dispose()
    this.disposal = Promise.allSettled([requests, this.page.frame.dispose()]).then((results) => {
      const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (failures.length !== 0) throw new AggregateError(failures, 'Browser page failed to drain')
    })
    void this.disposal.catch((error: unknown) => {
      // Lifecycle owners still receive this rejection; close callbacks must not expose transport diagnostics.
      void error
    })
    return this.disposal
  }

  private publishSaved(): void {
    if (this.checkpoint !== undefined) this.actions.replace(this.options.tabId, this.checkpoint)
  }

  private addressFailed(reason: BrowserAddressFailure): void {
    this.store.set({ ...this.store.getSnapshot(), addressFailure: reason })
  }

  /**
   * Resume the selected request only while its account is available for Human control.
   * @returns after request admission, or immediately when this account remains reserved.
   */
  resumeRequest(): Promise<void> {
    if (this.disposed || !this.humanAccount()) return Promise.resolve()
    return this.page.requests?.resume() ?? Promise.resolve()
  }

  private humanAccount(): boolean {
    if (this.options.profileId === undefined) return true
    const profiles = this.options.websiteProfiles?.()
    return profiles?.phase === 'ready'
      && profiles.profiles.find(profile => profile.id === this.options.profileId)?.control === 'human'
  }

  private command(run: () => void): void {
    if (this.disposed || !this.humanAccount()) return
    const requests = this.page.requests?.getSnapshot()
    if (requests !== undefined && (requests.granted || requests.busy !== undefined || requests.blocked
      || requests.requests.some(request => request.status === 'granted'))) return
    const current = this.store.getSnapshot()
    this.store.set({ ...current, addressFailure: undefined, addressRevision: current.addressRevision + 1 })
    run()
  }
}

/** Values available once a Sidebar body has committed its content container. */
export interface BrowserMountRequest {
  readonly tabId: TabId
  readonly signal: AbortSignal
  readonly viewportId: string
  readonly applicationOrigin: string
  readonly initial: BrowserTabState | undefined
  readonly initialUrl: string | undefined
  /** Saved website/account opened in this tab, from the tab's own open parameters. */
  readonly profileId: DesktopWebsiteProfileId | undefined
  readonly openTab: (url: string) => void
}

/** Tab-occurrence callbacks and the framework-bound state source of one Session. */
export interface BrowserTabControllers {
  readonly keyedHooks: {
    readonly browserState: (key: string) => HostObservable<BrowserControllerState> | undefined
    readonly websiteRequests: (key: string) => HostObservable<WebsiteRequestPageState> | undefined
  }
  /** @param request - committed tab and container. @returns ends physical attachment without closing the tab. */
  mount(request: BrowserMountRequest): () => void
  /** @param tabId - page occurrence. @param visible - logical visibility, independent of physical mount. */
  setVisible(tabId: TabId, visible: boolean): void
  /** @param tabId - page occurrence. @param id - explicit request selection. */
  selectRequest(tabId: TabId, id: DesktopWebsiteRequestId | undefined): void
  /** @param tabId - page occurrence. @returns after explicit request admission. */
  resumeRequest(tabId: TabId): Promise<void>
  /** @param tabId - page occurrence. @returns after immediate revocation and drainage. */
  takeoverRequest(tabId: TabId): Promise<void>
  /** @param tabId - page occurrence. @returns after a request roster reread. */
  reloadRequests(tabId: TabId): Promise<void>
  /** @returns after active and retired pages drain; repeated callers retain the same failure. */
  dispose(): Promise<void>
  /** @param actions - writer from a recreated Session binding. */
  rebind(actions: BoundActions<BrowserStore>): void
  /** @param tabId - owning tab. @param value - address input. */
  loadUrl(tabId: TabId, value: string): void
  /** @param tabId - tab whose saved address the user requested to restore. */
  restore(tabId: TabId): void
  /** @param tabId - owning tab. */
  goBack(tabId: TabId): void
  /** @param tabId - owning tab. */
  goForward(tabId: TabId): void
  /** Restore a saved address or reload its page. @param tabId - owning tab. */
  reload(tabId: TabId): void
  /** @param tabId - owning tab. @param enabled - provider's optional sandbox control. */
  setSandbox(tabId: TabId, enabled: boolean): void
}

/** Plain Slot callbacks and framework-bound state sources, not a desktop protocol. */
export interface BrowserInjected extends BrowserTabControllers {
  /** Saved-profile operations; undefined in a carrier without the desktop bridge. */
  readonly profiles: WebsiteProfileCommands | undefined
  hooks: { readonly websiteProfiles: HostObservable<WebsiteProfilesState> }
}

/**
 * Own tab-occurrence controllers behind Session-scoped callbacks.
 * @param actions - persisted view-state writer.
 * @param createPage - composition-selected provider.
 * @param isTabOpen - authoritative layout membership, independent of mounted bodies and plugin lifetime.
 * @param websiteProfiles - live Main-projected saved-account status, absent outside Desktop.
 * @returns tab callbacks.
 */
export function createBrowserControllers(actions: BoundActions<BrowserStore>, createPage: BrowserPageFactory,
  isTabOpen: (tabId: TabId) => boolean, websiteProfiles?: () => WebsiteProfilesState): BrowserTabControllers {
  let currentActions = actions
  const controllers = new Map<TabId, {
    readonly signal: AbortSignal
    readonly controller: BrowserController
    readonly forget: () => void
  }>()
  const retiring = new Set<Promise<void>>()
  let disposal: Promise<void> | undefined
  const retire = (page: BrowserController): void => {
    const pending = page.dispose()
    if (retiring.has(pending)) return
    retiring.add(pending)
    void pending.then(() => { retiring.delete(pending) }, (error: unknown) => {
      // Failed owners stay joinable by Session teardown, without publishing private diagnostics.
      void error
    })
  }
  const controller = (id: TabId): BrowserController | undefined => controllers.get(id)?.controller
  return {
    keyedHooks: {
      browserState: key => controller(key as TabId),
      websiteRequests: key => controller(key as TabId)?.requests,
    },
    setVisible: (id, visible) => { controller(id)?.requests?.setVisible(visible) },
    selectRequest: (id, request) => { controller(id)?.requests?.select(request) },
    resumeRequest: id => controller(id)?.resumeRequest() ?? Promise.resolve(),
    takeoverRequest: id => controller(id)?.requests?.takeover() ?? Promise.resolve(),
    reloadRequests: id => controller(id)?.requests?.reload() ?? Promise.resolve(),
    mount(request) {
      const { tabId, signal } = request
      if (disposal !== undefined || signal.aborted) return () => {}
      let held = controllers.get(tabId)
      if (held?.signal !== signal) {
        if (held !== undefined) {
          held.signal.removeEventListener('abort', held.forget)
          retire(held.controller)
        }
        const created = new BrowserController({ ...request, websiteProfiles, actions: currentActions, createPage })
        const forget = (): void => {
          retire(created)
          controllers.delete(tabId)
          // Plugin unload also aborts occurrences; only layout removal deletes saved navigation.
          if (!isTabOpen(tabId)) currentActions.forget(tabId)
        }
        held = { signal, controller: created, forget }
        controllers.set(tabId, held)
        signal.addEventListener('abort', forget, { once: true })
      }
      const hide = held.controller.mount(request.viewportId)
      held.controller.start(request.initialUrl)
      return hide
    },
    dispose: () => {
      if (disposal !== undefined) return disposal
      const completion = Promise.withResolvers<void>()
      disposal = completion.promise
      for (const { signal, controller, forget } of controllers.values()) {
        signal.removeEventListener('abort', forget)
        retire(controller)
      }
      controllers.clear()
      void Promise.allSettled([...retiring]).then((results) => {
        const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
        if (failures.length !== 0) completion.reject(new AggregateError(failures, 'Browser tabs failed to drain'))
        else completion.resolve()
      }, completion.reject)
      return disposal
    },
    rebind: (actions) => {
      currentActions = actions
      for (const { controller } of controllers.values()) controller.rebind(actions)
    },
    loadUrl: (id, value) => { controller(id)?.loadUrl(value) },
    restore: (id) => { controller(id)?.restore() },
    goBack: (id) => { controller(id)?.goBack() },
    goForward: (id) => { controller(id)?.goForward() },
    reload: (id) => { controller(id)?.reload() },
    setSandbox: (id, enabled) => { controller(id)?.setSandbox(enabled) },
  }
}
