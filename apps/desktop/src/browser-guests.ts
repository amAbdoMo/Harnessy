/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { app, session, webContents, type BrowserWindow, type Event as ElectronEvent, type Session, type WebContents } from 'electron'
import type { BrowserViewport, DesktopBrowserLeaseId, DesktopBrowserOpenRequest, DesktopBrowserReacquireRequest, DesktopBrowserReservation, DesktopWebsiteProfileId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'
import { bindBrowserCertificateErrors, localBrowserDeviceOrigin, type ConfirmBrowserCertificate } from './browser-certificates.ts'
import { executeHumanBrowserCommand } from './browser-human-command.ts'
import { BrowserPreviewViewport } from './browser-preview-viewport.ts'
import { DesktopWebsiteProfiles, type DesktopWebsiteAccount, type DesktopWebsitePairing } from './website-profiles.ts'

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  readonly profile?: DesktopWebsiteProfileId
  readonly certificateOrigin?: string
  attached: boolean
  invalidated: boolean
  navigationRevision: number
  viewport?: BrowserPreviewViewport
  invalidation?: Promise<void>
  release?: Promise<void> | undefined
  attachment?: Promise<WebContents | null>
  resolveAttachment?: ((guest: WebContents | null) => void) | undefined
  guest?: WebContents
  closeGuest?: () => void
  releaseCertificates?: () => void
  releaseInput?: (() => void) | undefined
}

interface NativeGuestDrain {
  readonly settled: Promise<void>
  session?: Session
  bound: boolean
  close(retry?: boolean): void
}

/** Exact live native identity of an attached, non-releasing website guest. */
export interface DesktopWebsiteGuestInspection {
  readonly owner: WebContents
  readonly guest: WebContents
  readonly profile: DesktopWebsiteProfileId
}

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly partitions = new Map<string, string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()
  private readonly nativeGuests = new Set<NativeGuestDrain>()
  private readonly nativeRecords = new WeakSet<WebContents>()
  private readonly invalidationListeners = new Set<(owner: WebContents, lease: DesktopBrowserLeaseId) => void | Promise<void>>()

  private readonly profilePartitions = new Set<DesktopWebsiteProfileId>()

  /**
   * @param hostUrl - current authenticated DSH Host, which guests cannot request.
   * @param websiteNavigation - request-owner policy through admission and drainage; omitted only for guests without request authority.
   * @param confirmCertificate - unsafe human consent for local-device AUTHORITY_INVALID, which can include date/name failures;
   * shared and saved-account Sessions remain ineligible.
   */
  constructor(private readonly hostUrl: () => string | undefined,
    private readonly websiteNavigation?: (owner: WebContents, lease: DesktopBrowserLeaseId, address?: string) => boolean,
    private readonly confirmCertificate?: ConfirmBrowserCertificate) {}

  /**
   * Sign-out and forgetting join every related guest release; any failure retains authentication storage.
   * @param filename - metadata path.
   * @param pairing - Host inspection and human endpoint confirmation.
   * @param drainAccount - synchronously revokes account aliases and joins native/Host work before storage deletion.
   * @returns profiles whose cleanup revokes all related guests before clearing authentication.
   */
  createProfiles(filename: string, pairing: DesktopWebsitePairing,
    drainAccount: (account: DesktopWebsiteAccount) => Promise<void>): DesktopWebsiteProfiles {
    return new DesktopWebsiteProfiles(filename, async (id) => {
      const releases = [...this.leases].filter(([, lease]) => lease.profile === id)
        .map(([lease, held]) => this.release(held.owner, lease))
      const results = await Promise.allSettled(releases)
      const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (failures.length === 1) throw failures[0]
      if (failures.length !== 0) throw new AggregateError(failures, 'Desktop website guests failed to drain')
      const storage = session.fromPartition(`persist:dsh-website-${id}`)
      await this.drainNativeGuests([...this.nativeGuests].filter(native => native.session === storage))
      await storage.clearStorageData()
      await storage.clearCache()
      await storage.clearAuthCache()
      await storage.closeAllConnections()
    }, pairing, drainAccount)
  }

  /** @param owner - authenticated primary renderer. @param profile - approved site/account. @returns persistent guest reservation. */
  acquireProfile(owner: WebContents, profile: DesktopWebsiteProfileId): DesktopBrowserReservation {
    const partition = `persist:dsh-website-${profile}`
    if (!this.profilePartitions.has(profile)) {
      this.configureSession(session.fromPartition(partition))
      this.profilePartitions.add(profile)
    }
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, { owner, partition, profile, attached: false, invalidated: false, navigationRevision: 0 })
    return { lease, partition }
  }

  /**
   * Reserve a workspace guest or a lease-exclusive local-device guest.
   * @param owner - authenticated primary application WebContents.
   * @param workspace - workspace identity received over IPC.
   * @param addressHint - optional initial address; local HTTPS devices receive a lease-exclusive Session.
   * @returns opaque lease and the partition approved for it.
   */
  acquire(owner: WebContents, workspace: unknown, addressHint?: unknown): DesktopBrowserReservation {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    if (addressHint !== undefined && (typeof addressHint !== 'string' || Buffer.byteLength(addressHint, 'utf8') > 4096
      || !this.allowedNavigation(addressHint))) throw new Error('desktop browser: initial address rejected')
    const certificateOrigin = typeof addressHint === 'string' ? localBrowserDeviceOrigin(addressHint) : undefined
    if (certificateOrigin !== undefined) {
      const partition = `dsh-sidebar-local-${randomUUID()}`
      const browserSession = session.fromPartition(partition)
      const lease = randomUUID() as DesktopBrowserLeaseId
      const entry: GuestLease = { owner, partition, certificateOrigin, attached: false, invalidated: false, navigationRevision: 0 }
      this.leases.set(lease, entry)
      this.configureSession(browserSession, entry)
      return { lease, partition }
    }
    let partition = this.partitions.get(workspace)
    if (partition === undefined) {
      partition = `dsh-sidebar-browser-${randomUUID()}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(workspace, partition)
    }
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, { owner, partition, attached: false, invalidated: false, navigationRevision: 0 })
    return { lease, partition }
  }

  /**
   * @param listener - synchronously revoke authority and return its drainage; failed settlement blocks profile cleanup.
   * @returns registration disposer.
   */
  onInvalidated(listener: (owner: WebContents, lease: DesktopBrowserLeaseId) => void | Promise<void>): () => void {
    this.invalidationListeners.add(listener)
    return () => { this.invalidationListeners.delete(listener) }
  }

  /** @param owner - authenticated application renderer. @param id - exact ordinary preview lease.
   * @returns its attached viewport-controlled guest, never a saved-account guest; undefined after invalidation.
   */
  inspectPreview(owner: WebContents, id: DesktopBrowserLeaseId): WebContents | undefined {
    const lease = this.leases.get(id)
    if (lease === undefined || lease.owner !== owner || lease.profile !== undefined || lease.viewport === undefined
      || !lease.attached || lease.invalidated || lease.release !== undefined || lease.guest === undefined
      || owner.isDestroyed() || lease.guest.isDestroyed()) return undefined
    return lease.guest
  }

  /** Revoke and close only a captured ordinary preview guest, including an invalidated lease awaiting metrics drainage.
   * Native observations reject on guest destruction; active inspection admission is not a cancellation prerequisite.
   * @param owner - authenticated application renderer.
   * @param id - exact viewport-controlled lease.
   * @param expected - captured native guest; replacement guests must survive stale cancellation.
   */
  cancelPreview(owner: WebContents, id: DesktopBrowserLeaseId, expected: WebContents): void {
    const lease = this.leases.get(id)
    if (lease === undefined || lease.owner !== owner || lease.profile !== undefined || lease.viewport === undefined
      || lease.guest !== expected || expected.isDestroyed()) return
    this.invalidate(id, lease)
    this.releaseInput(lease)
    if (lease.closeGuest !== undefined) lease.closeGuest()
    else expected.close({ waitForBeforeUnload: false })
  }

  /** @param owner - authenticated IPC sender. @param id - exact lease. @returns attached website guest, or undefined after invalidation. */
  inspectWebsite(owner: WebContents, id: DesktopBrowserLeaseId): DesktopWebsiteGuestInspection | undefined {
    const lease = this.leases.get(id)
    if (lease === undefined || lease.owner !== owner || lease.profile === undefined || !lease.attached
      || lease.invalidated || lease.release !== undefined || lease.guest === undefined
      || owner.isDestroyed() || lease.guest.isDestroyed()) return undefined
    return { owner, guest: lease.guest, profile: lease.profile }
  }

  /**
   * @param owner - authenticated primary renderer, not a website guest.
   * @param id - native lease received over IPC.
   * @param input - bounded Human navigation or ordinary-guest viewport command, including deferred initial loads.
   * @returns after native load settlement, metrics acknowledgement or command dispatch; ownership is checked in Main.
   */
  command(owner: WebContents, id: unknown, input: unknown): Promise<void> {
    if (typeof id !== 'string' || id.length > 128) throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined || lease.owner !== owner || !lease.attached || lease.invalidated
      || lease.release !== undefined || lease.guest === undefined || owner.isDestroyed() || lease.guest.isDestroyed()) {
      throw new Error('desktop browser: guest is unavailable')
    }
    let command = input
    let revision: number | undefined
    if (typeof input === 'object' && input !== null && !Array.isArray(input) && 'revision' in input) {
      const { revision: candidate, ...nativeCommand } = input
      if (!Object.hasOwn(input, 'revision') || typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0
        || candidate < lease.navigationRevision) throw new Error('desktop browser: navigation revision rejected')
      revision = candidate
      command = nativeCommand
    }
    const guest = lease.guest
    const viewport = lease.viewport
    return executeHumanBrowserCommand({
      navigationHistory: guest.navigationHistory,
      ...(viewport === undefined ? {} : { navigationReady: () => viewport.settled() }),
      ...(lease.profile !== undefined ? {} : { setViewport: (viewport: BrowserViewport) => {
        lease.viewport ??= new BrowserPreviewViewport(guest, () => this.leases.get(key) === lease
          && !lease.invalidated && lease.release === undefined && lease.guest === guest && !owner.isDestroyed(), () => {
          console.error('Desktop browser viewport debugger ownership lost')
          void this.release(owner, key).catch((error: unknown) => { console.error('Desktop browser viewport release failed', error) })
        })
        return lease.viewport.set(viewport)
      } }),
      reload: () => { guest.reload() },
      loadURL: (url) => {
        if (this.reacquireForAddress(key, lease, url, 'GET')) return Promise.resolve()
        return guest.loadURL(url)
      },
    }, command, url => this.allowedNavigation(url), () => {
      const allowed = !lease.invalidated && lease.release === undefined && lease.guest === guest
        && !owner.isDestroyed() && !guest.isDestroyed()
        && (revision === undefined || revision >= lease.navigationRevision)
        && (lease.profile === undefined || this.websiteNavigation?.(owner, key) !== false)
      if (allowed && revision !== undefined) lease.navigationRevision = revision
      return allowed
    })
  }

  /**
   * Release an owned lease after joining native closure and authority drainage; either failure retains it and workspace storage survives.
   * @param owner - authenticated IPC sender.
   * @param id - lease received over IPC.
   */
  async release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    if (lease.release !== undefined) return lease.release
    const nativeClose = Promise.resolve().then(async () => {
      const viewportDrain = lease.viewport?.dispose()
      let guest = lease.guest
      if (guest === undefined && lease.attachment !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          guest = await Promise.race([
            lease.attachment.then(value => value ?? undefined),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => { reject(new Error('desktop browser: guest attachment did not finish; cleanup remains blocked')) }, 5_000)
            }),
          ])
        } finally { clearTimeout(timer) }
      }
      if (guest !== undefined) {
        const closing = guest
        let timer: ReturnType<typeof setTimeout> | undefined
        let onDestroyed: (() => void) | undefined
        try {
          const destroyed = closing.isDestroyed() ? Promise.resolve() : new Promise<void>((resolve) => {
            onDestroyed = resolve
            closing.once('destroyed', onDestroyed)
          })
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { reject(new Error('desktop browser: guest destruction did not finish; cleanup remains blocked')) }, 5_000)
          })
          if (!closing.isDestroyed()) {
            if (lease.closeGuest !== undefined) lease.closeGuest()
            else closing.close({ waitForBeforeUnload: false })
          }
          await Promise.race([Promise.all([destroyed, viewportDrain]), deadline])
        } finally {
          clearTimeout(timer)
          if (onDestroyed !== undefined) closing.removeListener('destroyed', onDestroyed)
        }
      }
    })
    const pending = Promise.resolve().then(async () => {
      const outcomes = await Promise.allSettled([nativeClose, lease.invalidation])
      const failures = outcomes.filter(outcome => outcome.status === 'rejected').map((outcome): unknown => outcome.reason)
      if (failures.length === 1) throw failures[0]
      if (failures.length !== 0) throw new AggregateError(failures, 'Desktop browser guest failed to drain')
      if (lease.certificateOrigin !== undefined) {
        const browserSession = session.fromPartition(lease.partition)
        await Promise.all([browserSession.clearStorageData(), browserSession.clearCache(), browserSession.clearAuthCache()])
        await browserSession.closeAllConnections()
      }
      this.leases.delete(key)
    })
    lease.release = pending
    this.invalidate(key, lease)
    this.releaseInput(lease)
    try { await pending }
    finally { lease.release = undefined }
  }

  /**
   * Install attachment checks before the application document can create a webview.
   * @param window - primary application window.
   * @param attachInput - attaches native input after guest ownership is verified and returns its disposer.
   */
  bind(window: BrowserWindow, attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void): void {
    const owner = window.webContents
    let cancellations = 0
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
        ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id as DesktopBrowserLeaseId)
      if (cancellations !== 0 || owner.isDestroyed() || lease === undefined || lease.owner !== owner || lease.attached || lease.invalidated
        || lease.release !== undefined || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      lease.attachment = new Promise((resolve) => { lease.resolveAttachment = resolve })
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    const nativeGuests = new Set<NativeGuestDrain>()
    const inventory = (guest: WebContents): void => {
      if (!guest.isDestroyed() && guest.getType() === 'webview' && guest.hostWebContents === owner) {
        this.attachGuest(owner, guest, attachInput, nativeGuests)
      }
    }
    const created = (_event: ElectronEvent, guest: WebContents): void => { inventory(guest) }
    app.on('web-contents-created', created)
    owner.on('did-attach-webview', (_event, guest) => { this.attachGuest(owner, guest, attachInput, nativeGuests) })
    const releaseAll = (): void => {
      cancellations++
      const canceled = [...this.leases].filter(([, lease]) => lease.owner === owner)
      for (const [id] of canceled) void this.release(owner, id).catch((_error: unknown) => {
        /* Failed drainage remains joinable without logging private native diagnostics. */
      })
      for (const native of nativeGuests) if (!native.bound) native.close()
      void (async () => {
        // Electron 44 creates the native guest synchronously after approval; seal after that call stack completes.
        await setImmediate()
        for (const guest of webContents.getAllWebContents()) inventory(guest)
        if (owner.isDestroyed()) app.removeListener('web-contents-created', created)
        const draining = [...nativeGuests]
        for (const native of draining) if (!native.bound) native.close()
        await Promise.all(draining.map(native => native.settled))
        for (const [id, lease] of canceled) {
          if (this.leases.get(id) === lease && lease.guest === undefined) {
            lease.resolveAttachment?.(null)
            lease.resolveAttachment = undefined
          }
        }
        cancellations--
      })().catch((_error: unknown) => { /* Unknown native settlement retains attachment and admission fences. */ })
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  /** Unidentified native guests remain in owner drainage until physical destruction. */
  private attachGuest(owner: WebContents, guest: WebContents,
    attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void,
    nativeGuests: Set<NativeGuestDrain>): void {
    if (this.nativeRecords.has(guest)) return
    this.nativeRecords.add(guest)
    if (guest.isDestroyed()) return
    let bound: { id: DesktopBrowserLeaseId; lease: GuestLease } | undefined
    let closing = false
    let closeIssued = false
    let bootstrapFinished = false
    let resolveDestroyed!: () => void
    const settled = new Promise<void>((resolve) => { resolveDestroyed = resolve })
    const stopBootstrap = (): void => {
      bootstrapFinished = true
      clearTimeout(timer)
      guest.removeListener('did-start-navigation', onStart)
      guest.removeListener('did-navigate', onCommit)
      guest.removeListener('did-navigate-in-page', onFragment)
    }
    const requestClose = (): void => {
      closing = true
      releaseCertificates()
      stopBootstrap()
      if (closeIssued || guest.isDestroyed()) return
      guest.close({ waitForBeforeUnload: false })
      closeIssued = true
    }
    const close = (retry = false): void => {
      if (retry) closeIssued = false
      try { requestClose() }
      catch (_error: unknown) { /* Physical destruction remains unconfirmed and blocks cleanup. */ }
    }
    const native: NativeGuestDrain = { settled, close, bound: false }
    nativeGuests.add(native)
    this.nativeGuests.add(native)
    const timer = setTimeout(close, 5_000)
    const usable = (): boolean => bound !== undefined && !closing && !owner.isDestroyed() && !guest.isDestroyed()
      && this.leases.get(bound.id) === bound.lease && bound.lease.guest === guest
      && !bound.lease.invalidated && bound.lease.release === undefined
    const invalidate = (): void => {
      if (bound === undefined) return
      this.invalidate(bound.id, bound.lease)
      this.releaseInput(bound.lease)
    }
    const destroyed = (): void => {
      stopBootstrap()
      nativeGuests.delete(native)
      this.nativeGuests.delete(native)
      resolveDestroyed()
      invalidate()
      if (bound !== undefined && bound.lease.release === undefined) {
        const { id, lease } = bound
        if (lease.certificateOrigin !== undefined) {
          void this.release(lease.owner, id).catch((_error: unknown) => { /* Failed device cleanup stays joinable. */ })
        }
        else {
          void lease.invalidation?.then(() => {
            if (this.leases.get(id) === lease) this.leases.delete(id)
          }).catch((_error: unknown) => { /* Failed drainage retains this lease for profile cleanup. */ })
        }
      }
    }
    guest.once('destroyed', destroyed)
    const reapplyViewport = (): void => {
      const viewport = bound?.lease.viewport
      if (viewport === undefined || !usable()) return
      void viewport.reapply().catch((error: unknown) => {
        if (!usable()) return
        console.error('Desktop browser viewport reapplication failed', error)
        invalidate()
        close()
      })
    }
    guest.on('dom-ready', reapplyViewport)
    guest.on('did-navigate', reapplyViewport)
    guest.on('render-process-gone', () => { invalidate(); close() })
    const humanInputAllowed = (): boolean => bound === undefined || bound.lease.profile === undefined
      || this.websiteNavigation?.(owner, bound.id) !== false
    guest.on('before-input-event', (event) => { if (!humanInputAllowed()) event.preventDefault() })
    guest.on('before-mouse-event', (event) => { if (!humanInputAllowed()) event.preventDefault() })
    guest.setWindowOpenHandler(({ url, postBody }) => {
      if (usable() && bound !== undefined && postBody === undefined && this.allowedNavigation(url)
        && (bound.lease.profile === undefined || this.websiteNavigation?.(owner, bound.id) !== false)) {
        const request: DesktopBrowserOpenRequest = { lease: bound.id, url: new URL(url).href }
        owner.send(DESKTOP_IPC.browserOpenRequested, request)
      }
      return { action: 'deny' }
    })
    const navigationAllowed = (url: string): boolean => {
      if (closing) return false
      if (bound !== undefined) return (!bootstrapFinished && url === `about:blank#${bound.id}`)
        || (usable() && this.allowedNavigation(url)
          && (bound.lease.profile === undefined || this.websiteNavigation?.(owner, bound.id, url) !== false))
      return url === 'about:blank' || this.bootstrapLease(owner, guest, url) !== undefined
    }
    const releaseCertificates = bindBrowserCertificateErrors(guest, owner,
      url => bound !== undefined && usable() && bound.lease.profile === undefined && bound.lease.certificateOrigin !== undefined
        && new URL(url).origin === bound.lease.certificateOrigin && this.allowedNavigation(url), this.confirmCertificate)
    guest.on('will-frame-navigate', (event) => {
      if (event.isMainFrame && !navigationAllowed(event.url)) { event.preventDefault(); if (bound === undefined) close() }
    })
    guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
      if (mainFrame && !navigationAllowed(url)) { event.preventDefault(); if (bound === undefined) close() }
    })
    guest.on('will-attach-webview', (event) => { event.preventDefault() })
    guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    const identify = (url: string): void => {
      if (bootstrapFinished || guest.isDestroyed()) return
      if (url === '' || url === 'about:blank') return
      const match = this.bootstrapLease(owner, guest, url)
      if (match === undefined) { close(); return }
      bound = match
      native.bound = true
      match.lease.guest = guest
      match.lease.releaseCertificates = () => { releaseCertificates() }
      match.lease.closeGuest = () => { closeIssued = false; requestClose() }
      stopBootstrap()
      match.lease.resolveAttachment?.(guest)
      match.lease.resolveAttachment = undefined
      if (!usable()) { if (match.lease.release === undefined) close(); return }
      let disposeInput: () => void
      try { disposeInput = attachInput(guest, match.id) }
      catch (_error: unknown) { invalidate(); close(); return }
      if (usable()) match.lease.releaseInput = disposeInput
      else this.disposeInput(disposeInput)
    }
    function onStart(event: { isMainFrame: boolean; url: string }): void {
      if (event.isMainFrame) identify(event.url)
    }
    function onCommit(_event: ElectronEvent, url: string): void { identify(url) }
    function onFragment(_event: ElectronEvent, url: string, mainFrame: boolean): void {
      if (mainFrame) identify(url)
    }
    guest.on('did-start-navigation', onStart)
    guest.on('did-navigate', onCommit)
    guest.on('did-navigate-in-page', onFragment)
    if (guest.isDestroyed()) { destroyed(); return }
    native.session = guest.session
    if (owner.isDestroyed()) { close(); return }
    let url: string
    try { url = guest.getURL() }
    catch (_error: unknown) { close(); return }
    identify(url)
  }

  private bootstrapLease(owner: WebContents, guest: WebContents, url: string):
    { id: DesktopBrowserLeaseId; lease: GuestLease } | undefined {
    if (!url.startsWith('about:blank#')) return undefined
    const id = url.slice('about:blank#'.length) as DesktopBrowserLeaseId
    const lease = this.leases.get(id)
    if (lease === undefined || lease.owner !== owner || !lease.attached || lease.guest !== undefined
      || guest.hostWebContents !== owner || guest.session !== session.fromPartition(lease.partition)) return undefined
    return { id, lease }
  }

  private releaseInput(lease: GuestLease): void {
    const dispose = lease.releaseInput
    lease.releaseInput = undefined
    this.disposeInput(dispose)
  }

  private disposeInput(dispose: (() => void) | undefined): void {
    try { dispose?.() }
    catch (_error: unknown) { /* Revoked input cannot prevent physical guest drainage. */ }
  }

  private async drainNativeGuests(natives: readonly NativeGuestDrain[]): Promise<void> {
    if (natives.length === 0) return
    for (const native of natives) native.close(true)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.all(natives.map(native => native.settled)), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('Desktop website native guest drainage did not finish')) }, 5_000)
      })])
    } finally { clearTimeout(timer) }
  }

  private invalidate(id: DesktopBrowserLeaseId, lease: GuestLease): void {
    if (lease.invalidated) return
    lease.invalidated = true
    lease.releaseCertificates?.()
    delete lease.releaseCertificates
    const settlements: Promise<void>[] = []
    // Publish shared settlement before listeners can reenter release or destruction.
    lease.invalidation = Promise.resolve().then(async () => {
      const outcomes = await Promise.allSettled(settlements)
      const failures = outcomes.filter(outcome => outcome.status === 'rejected').map((outcome): unknown => outcome.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Website guest authority drainage failed')
    })
    void lease.invalidation.catch((_error: unknown) => { /* Release/profile cleanup observes the retained failure. */ })
    for (const listener of this.invalidationListeners) {
      try { settlements.push(Promise.resolve(listener(lease.owner, id))) }
      catch (error) { settlements.push(Promise.reject(new AggregateError([error], 'Website authority invalidation failed'))) }
    }
  }

  private reacquireForAddress(id: DesktopBrowserLeaseId, lease: GuestLease, url: string, method: string): boolean {
    if (lease.profile !== undefined || localBrowserDeviceOrigin(url) === lease.certificateOrigin) return false
    if (method === 'GET' && !lease.invalidated && lease.release === undefined && this.leases.get(id) === lease
      && !lease.owner.isDestroyed() && lease.guest !== undefined && !lease.guest.isDestroyed()
      && Buffer.byteLength(url, 'utf8') <= 4096 && this.allowedNavigation(url)) {
      lease.owner.send(DESKTOP_IPC.browserReacquireRequested,
        { lease: id, url, revision: lease.navigationRevision } satisfies DesktopBrowserReacquireRequest)
    }
    return true
  }

  private configureSession(browserSession: Session, isolated?: GuestLease): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event) => { event.preventDefault() })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      let cancel = network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol)
      if (isolated !== undefined && (isolated.invalidated || isolated.release !== undefined)) cancel = true
      if (!cancel && network && details.resourceType === 'mainFrame') {
        const match = [...this.leases].find(([, lease]) => lease.guest?.id === details.webContentsId)
        if (match !== undefined) cancel = this.reacquireForAddress(match[0], match[1], details.url, details.method)
      }
      if (!cancel && network && isolated?.certificateOrigin !== undefined) {
        const tlsAddress = new URL(details.url)
        if (tlsAddress.protocol === 'wss:') tlsAddress.protocol = 'https:'
        const device = localBrowserDeviceOrigin(tlsAddress.href)
        if (device !== undefined && device !== isolated.certificateOrigin) cancel = true
      }
      callback({ cancel })
    })
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  private isApplicationHost(url: URL): boolean {
    const value = this.hostUrl()
    if (value === undefined) return false
    const host = new URL(value)
    return url.port === host.port
      && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  }
}
