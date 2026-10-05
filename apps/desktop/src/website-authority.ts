/** Native/Host request coordination; renderer request IDs route only to already captured Host owners. */
import type { BrowserWindow, WebContents } from 'electron'
import type {
  DesktopBrowserLeaseId, DesktopWebsiteHostSnapshot, DesktopWebsitePageInfo, DesktopWebsiteProfileId,
  DesktopWebsiteBrowserOperation, DesktopWebsiteBrowserResult, DesktopWebsiteProfile,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopBrowserGuests } from './browser-guests.ts'
import type { DesktopHostProcess } from './host-process.ts'
import type { DesktopWebsiteProfiles } from './website-profiles.ts'
import { DesktopWebsiteRequests } from './website-requests.ts'
import { websitePageOrigin, websitePageTitle } from './website-operations.ts'
import { executeWebsiteBrowserOperation } from './website-browser.ts'
import type { DesktopWebsiteRequestBinding, DesktopWebsiteRequestId, DesktopWebsiteRequestReceipt } from './website-requests.ts'

interface CapturedRequest {
  readonly host: DesktopHostProcess
  snapshot: DesktopWebsiteHostSnapshot
  retirement?: Promise<void>
}

/** Trusted Main adapters; native objects never cross renderer or Host IPC. */
export interface DesktopWebsiteAuthorityDependencies {
  currentHost(this: void): DesktopHostProcess | undefined
  window(): Pick<BrowserWindow, 'webContents' | 'isDestroyed' | 'isVisible' | 'isMinimized'> | undefined
  readonly applicationUrl: string
  readonly profiles: Pick<DesktopWebsiteProfiles, 'assertAvailable' | 'binding' | 'hostInventory'>
  readonly guests: Pick<DesktopBrowserGuests, 'inspectWebsite' | 'onInvalidated'>
}

/** Owns native request receipts and their immutable captured Host identities for one Main process. */
export class DesktopWebsiteAuthority {
  readonly requests: DesktopWebsiteRequests
  private readonly captured = new Map<DesktopWebsiteRequestId, CapturedRequest>()
  private readonly closingHosts = new WeakSet<DesktopHostProcess>()
  private readonly revocations = new WeakMap<DesktopWebsiteRequestBinding, Promise<void>>()
  private readonly detachGuests: () => void
  private synchronization: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  /** @param dependencies - primary native window, profile metadata, guest ownership and captured Host routing. */
  constructor(private readonly dependencies: DesktopWebsiteAuthorityDependencies) {
    this.requests = new DesktopWebsiteRequests({
      currentHost: dependencies.currentHost,
      reservationChanged: () => { this.notify() },
      inspectGuest: (owner, lease) => {
        const native = dependencies.guests.inspectWebsite(owner, lease)
        const window = dependencies.window()
        if (native === undefined || window === undefined || window.isDestroyed()) return undefined
        return { ...native, attached: true, releasing: false,
          ownerAuthenticated: owner === window.webContents && owner.getURL().startsWith(dependencies.applicationUrl),
          windowVisible: window.isVisible(), windowMinimized: window.isMinimized() }
      },
      assertProfile: (input) => {
        const profile = dependencies.profiles.assertAvailable(input.profile)
        const binding = dependencies.profiles.binding(input.profile)
        if (profile.mcpServerName !== input.mcpServerName || profile.url !== input.url
          || binding.identity !== input.mcpBinding.identity || binding.endpoint !== input.mcpBinding.endpoint) {
          throw new Error('Website account pairing changed')
        }
      },
      validate: (binding, signal) => this.control(binding, 'validate', signal),
      commit: (binding, signal) => this.control(binding, 'commit', signal),
      revoke: (binding) => {
        const entry = this.domain(binding.requestId, binding.host)
        const pending = binding.host.websiteControl({ action: 'revoke', id: binding.requestId }).then((snapshot) => {
          if (snapshot === undefined) throw new Error('Website revocation returned no request')
          this.updateRevocation(entry, snapshot)
        })
        this.revocations.set(binding, pending)
        void pending.catch((_error: unknown) => { /* Drainage retains this failed delivery and native account locks. */ })
      },
      drain: async (binding) => {
        await this.revocations.get(binding)
        await binding.host.websiteControl({ action: 'drain', id: binding.requestId })
        this.revocations.delete(binding)
      },
    })
    this.detachGuests = dependencies.guests.onInvalidated((owner, lease) => this.requests.revokeLease(owner, lease))
  }

  /** @param rows - saved registry. @returns transient account reservation status, never persisted or used to grant page access. */
  projectProfiles(rows: readonly DesktopWebsiteProfile[]): readonly DesktopWebsiteProfile[] {
    return rows.map((profile) => {
      if (profile.control !== 'human') return profile
      const reserved = this.requests.isAccountReserved({ profile: profile.id, url: profile.url,
        mcpServerName: profile.mcpServerName, mcpBinding: this.dependencies.profiles.binding(profile.id) })
      return reserved ? { ...profile, control: 'agent' } : profile
    })
  }

  /**
   * Preserve request navigation and Human-input limits through physical drainage.
   * @param owner - authenticated native owner. @param lease - exact guest reservation.
   * @param address - validated HTTP(S) destination; absence requests popup forwarding.
   * @returns whether the captured native guest can perform the action.
   */
  allowsNativeNavigation(owner: WebContents, lease: DesktopBrowserLeaseId, address?: string): boolean {
    const native = this.dependencies.guests.inspectWebsite(owner, lease)
    if (native === undefined) return false
    try {
      const profile = this.dependencies.profiles.assertAvailable(native.profile)
      const mcpBinding = this.dependencies.profiles.binding(native.profile)
      return this.requests.allowsNativeNavigation(owner, lease, address, {
        profile: profile.id, url: profile.url, mcpServerName: profile.mcpServerName, mcpBinding,
      })
    } catch (_error: unknown) {
      // Missing enrollment or pending cleanup cannot authorize Human input or navigation.
      return false
    }
  }

  /**
   * @param host - exact private child being started.
   * @returns disposer that fences requests synchronously, settles and retires them before detaching listeners; failures retain locks.
   */
  attachHost(host: DesktopHostProcess): () => Promise<void> {
    const prepared = host.onWebsitePrepared((snapshot) => {
      if (this.dependencies.currentHost() !== host || this.closingHosts.has(host)) throw new Error('Website request belongs to an unavailable Host')
      this.dependencies.profiles.assertAvailable(snapshot.profile)
      if (this.captured.has(snapshot.id)) throw new Error('Website request identity was already captured')
      if ([...this.captured.values()].filter(entry => entry.host === host).length >= 64) {
        throw new Error('Website pending request limit reached')
      }
      this.captured.set(snapshot.id, { host, snapshot: { ...snapshot } })
      this.notify()
    })
    const check = host.onWebsiteCheck((snapshot) => {
      const entry = this.domain(snapshot.id, host)
      if (this.dependencies.currentHost() !== host || this.closingHosts.has(host) || snapshot.profile !== entry.snapshot.profile
        || snapshot.sessionId !== entry.snapshot.sessionId || snapshot.epoch !== entry.snapshot.epoch
        || entry.retirement !== undefined || snapshot.status !== 'granted' || entry.snapshot.status !== 'granted') {
        throw new Error('Website native admission request is stale')
      }
      this.requests.assertGranted(host, snapshot.id)
    })
    const pageInfo = host.onWebsitePageInfo((snapshot, signal) => this.pageInfo(host, snapshot, signal),
      snapshot => this.assertPageInfo(host, snapshot),
      (snapshot, signal, operation) => this.browser(host, snapshot, signal, operation))
    const revoked = host.onWebsiteRevoked((snapshot) => {
      let entry = this.captured.get(snapshot.id)
      if (entry === undefined) {
        if (this.dependencies.currentHost() !== host || snapshot.terminal !== true || snapshot.status !== 'revoked') return
        // A refused or cancelled private handoff still owns Host cleanup, but never native permission.
        if ([...this.captured.values()].filter(capture => capture.host === host).length >= 128) {
          throw new Error('Website retirement request limit reached')
        }
        entry = { host, snapshot: { ...snapshot } }
        this.captured.set(snapshot.id, entry)
      }
      if (entry.host !== host) return
      this.assign(entry, snapshot)
      const settlement = snapshot.terminal === true ? this.retire(entry) : this.requests.revoke(snapshot.id)
      void settlement.catch((_error: unknown) => { /* Failed drainage remains attached to its captured request. */ })
      this.notify()
    })
    return () => this.retireHost(host, async () => {
      prepared()
      revoked()
      check()
      await pageInfo()
      this.notify()
    })
  }

  /**
   * Observe only the exact committed native guest; Host and native request generations are independent.
   * Saved profile control metadata grants no permission; the committed request authorizes observation.
   * @param host - captured private child. @param snapshot - current granted Host generation.
   * @param signal - operation cancellation; native correlation remains until physical settlement.
   * @returns bounded title and origin, never URL paths or errors containing page data.
   */
  async pageInfo(host: DesktopHostProcess, snapshot: DesktopWebsiteHostSnapshot, signal: AbortSignal): Promise<DesktopWebsitePageInfo> {
    try {
      const origin = this.assertPageInfo(host, snapshot)
      const result = await this.requests.run(host, snapshot.id, signal, (guest, cancellation) => {
        cancellation.throwIfAborted()
        if (this.assertPageInfo(host, snapshot) !== origin || websitePageOrigin(guest.getURL()) !== origin) {
          throw new Error('Website observation rejected')
        }
        cancellation.throwIfAborted()
        if (this.assertPageInfo(host, snapshot) !== origin) throw new Error('Website observation rejected')
        const title = websitePageTitle(guest.getTitle())
        cancellation.throwIfAborted()
        if (websitePageOrigin(guest.getURL()) !== origin) throw new Error('Website observation rejected')
        return Promise.resolve({ origin, ...title })
      })
      signal.throwIfAborted()
      if (this.assertPageInfo(host, snapshot) !== origin) throw new Error('Website observation rejected')
      return result
    } catch (_error: unknown) { throw new Error('Website observation rejected') }
  }

  private async browser(host: DesktopHostProcess, snapshot: DesktopWebsiteHostSnapshot,
    signal: AbortSignal, operation: DesktopWebsiteBrowserOperation): Promise<DesktopWebsiteBrowserResult> {
    try {
      const origin = this.assertPageInfo(host, snapshot)
      const result = await this.requests.run(host, snapshot.id, signal,
        async (guest, cancellation): Promise<DesktopWebsiteBrowserResult> => {
          const value = await executeWebsiteBrowserOperation({ guest, signal: cancellation, approvedOrigin: origin,
            assertAuthority: () => {
              if (this.assertPageInfo(host, snapshot) !== origin) throw new Error('Website browser authority rejected')
            } }, operation)
          return value.kind === 'screenshot' ? { ...value, png: Buffer.from(value.png).toString('base64') } : value
        })
      signal.throwIfAborted()
      if (this.assertPageInfo(host, snapshot) !== origin) throw new Error('Website browser authority rejected')
      return result
    } catch (_error: unknown) { throw new Error('Website browser operation rejected') }
  }

  private assertPageInfo(host: DesktopHostProcess, snapshot: DesktopWebsiteHostSnapshot): string {
    const entry = this.domain(snapshot.id, host)
    if (this.dependencies.currentHost() !== host || this.closingHosts.has(host) || entry.retirement !== undefined
      || snapshot.profile !== entry.snapshot.profile || snapshot.sessionId !== entry.snapshot.sessionId
      || snapshot.epoch !== entry.snapshot.epoch || snapshot.status !== 'granted' || entry.snapshot.status !== 'granted') {
      throw new Error('Website observation rejected')
    }
    this.requests.assertGranted(host, snapshot.id)
    const profile = this.dependencies.profiles.assertAvailable(snapshot.profile)
    return websitePageOrigin(profile.url)
  }

  /** @param host - captured private child. @returns after its serialized complete pairing inventory is installed. */
  synchronize(host: DesktopHostProcess): Promise<void> {
    const pending = this.synchronization.then(async () => {
      const profiles = await this.dependencies.profiles.hostInventory()
      await host.websiteControl({ action: 'sync', profiles })
    })
    this.synchronization = pending.catch((_error: unknown) => { /* A later explicit synchronization can recover availability. */ })
    return pending
  }

  /** Revoke removed, clearing or changed associations before asynchronous Host inventory publication. */
  profilesChanged(): void {
    for (const [id, entry] of this.captured) {
      try { this.dependencies.profiles.assertAvailable(entry.snapshot.profile) }
      catch (_error) {
        void this.requests.revoke(id).catch((_failure: unknown) => { /* Cleanup joins retained drainage separately. */ })
      }
    }
  }

  /**
   * @param owner - authenticated primary renderer.
   * @param id - already captured Host request.
   * @param lease - native guest in its approved profile.
   * @returns ungranted visible receipt.
   */
  prepare(owner: WebContents, id: DesktopWebsiteRequestId, lease: DesktopBrowserLeaseId): DesktopWebsiteRequestReceipt {
    const entry = this.domain(id)
    if (entry.retirement !== undefined || this.closingHosts.has(entry.host) || entry.snapshot.terminal === true
      || (entry.snapshot.status !== 'pending' && entry.snapshot.status !== 'revoked')) {
      throw new Error('Website request is not pending')
    }
    const native = this.dependencies.guests.inspectWebsite(owner, lease)
    if (native === undefined || native.profile !== entry.snapshot.profile) throw new Error('Website request requires its approved attached account guest')
    const profile = this.dependencies.profiles.assertAvailable(entry.snapshot.profile)
    this.requests.prepare({ requestId: id, host: entry.host, agentId: entry.snapshot.sessionId,
      sessionId: entry.snapshot.sessionId, profile: profile.id, url: profile.url, mcpServerName: profile.mcpServerName,
      mcpBinding: this.dependencies.profiles.binding(profile.id), owner, lease })
    const receipt = this.requests.setVisible(owner, id, true)
    if (receipt === undefined) throw new Error('Website request has no visible occurrence')
    this.requests.acknowledge(owner, receipt)
    return receipt
  }

  /**
   * @param sessionId - initiating Session identity.
   * @returns a bounded, copied inventory from the current captured Host, without granting authority.
   */
  list(sessionId: DesktopWebsiteHostSnapshot['sessionId']): readonly DesktopWebsiteHostSnapshot[] {
    const host = this.dependencies.currentHost()
    return [...this.captured.values()].filter(entry => entry.host === host && entry.snapshot.sessionId === sessionId)
      .map(entry => ({ ...entry.snapshot }))
  }

  /** @param id - captured Host request. @param sessionId - initiating Session; copying another request ID cannot change its owner. */
  assertSession(id: DesktopWebsiteRequestId, sessionId: DesktopWebsiteHostSnapshot['sessionId']): void {
    if (this.domain(id).snapshot.sessionId !== sessionId) throw new Error('Website request belongs to another Session')
  }

  /** @param listener - committed request-state invalidation; no native objects or auth data are published. @returns listener disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener() }
      catch (error) { console.error('Website request state listener failed', error) }
    }
  }

  /**
   * @param id - available saved account entering human takeover; no prepared request is required.
   * @returns after synchronous revocation of overlapping account aliases and settlement of their native and Host work.
   */
  takeover(id: DesktopWebsiteProfileId): Promise<void> {
    const profile = this.dependencies.profiles.assertAvailable(id)
    const mcpBinding = this.dependencies.profiles.binding(id)
    return this.requests.revokeAccount({ profile: id, url: profile.url, mcpServerName: profile.mcpServerName, mcpBinding })
  }

  /** @returns after guest subscriptions detach and captured requests settle and retire; failures remain captured and locked. */
  async dispose(): Promise<void> {
    this.detachGuests()
    const hosts = new Set([...this.captured.values()].map(entry => entry.host))
    const current = this.dependencies.currentHost()
    if (current !== undefined) hosts.add(current)
    const outcomes = await Promise.allSettled([...hosts].map(host => this.retireHost(host)))
    const failures = outcomes.filter(outcome => outcome.status === 'rejected').map((outcome): unknown => outcome.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'Website native authority teardown failed')
  }

  private async retireHost(host: DesktopHostProcess, detach?: () => void | Promise<void>): Promise<void> {
    this.closingHosts.add(host)
    const joined = new Set<CapturedRequest>()
    const failures: unknown[] = []
    try {
      while (true) {
        const entries = [...this.captured.values()].filter(entry => entry.host === host && !joined.has(entry))
        if (entries.length === 0) break
        for (const entry of entries) joined.add(entry)
        const outcomes = await Promise.allSettled(entries.map(entry => this.retire(entry)))
        failures.push(...outcomes.filter(outcome => outcome.status === 'rejected').map((outcome): unknown => outcome.reason))
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Website Host request retirement failed')
    } finally {
      // Detach in the same turn as the final inventory check; every accepted terminal notification has been joined.
      await detach?.()
    }
  }

  private retire(entry: CapturedRequest): Promise<void> {
    if (entry.retirement !== undefined) return entry.retirement
    const settlement: PromiseWithResolvers<void> = Promise.withResolvers()
    entry.retirement = settlement.promise
    void this.requests.close(entry.snapshot.id).then(async (nativeDrained) => {
      if (!nativeDrained) {
        const snapshot = await entry.host.websiteControl({ action: 'revoke', id: entry.snapshot.id })
        if (snapshot === undefined) throw new Error('Website retirement returned no revoked request')
        this.updateRevocation(entry, snapshot)
        await entry.host.websiteControl({ action: 'drain', id: entry.snapshot.id })
      }
      await entry.host.websiteControl({ action: 'remove', id: entry.snapshot.id })
      this.captured.delete(entry.snapshot.id)
      this.notify()
    }).then(settlement.resolve, settlement.reject)
    return settlement.promise
  }

  private domain(id: DesktopWebsiteRequestId, host?: DesktopHostProcess): CapturedRequest {
    const entry = this.captured.get(id)
    if (entry === undefined || (host === undefined ? this.dependencies.currentHost() !== entry.host : entry.host !== host)) {
      throw new Error('Website request belongs to a different captured Host')
    }
    return entry
  }

  private assign(entry: CapturedRequest, snapshot: DesktopWebsiteHostSnapshot): void {
    if (snapshot.id !== entry.snapshot.id || snapshot.profile !== entry.snapshot.profile
      || snapshot.sessionId !== entry.snapshot.sessionId) {
      throw new Error('Website Host response changed its captured request owner or generation')
    }
    // An older revoke acknowledgement confirms no authority; retain the newer revoked generation and terminal flag.
    if (snapshot.epoch < entry.snapshot.epoch && snapshot.status === 'revoked' && entry.snapshot.status === 'revoked'
      && (snapshot.terminal !== true || entry.snapshot.terminal === true)) return
    if (snapshot.epoch < entry.snapshot.epoch || (entry.snapshot.terminal === true && snapshot.terminal !== true)) {
      throw new Error('Website Host response changed its captured request owner or generation')
    }
    entry.snapshot = { ...snapshot }
  }

  private updateRevocation(entry: CapturedRequest, snapshot: DesktopWebsiteHostSnapshot): void {
    if (snapshot.status !== 'revoked') throw new Error('Website revocation returned an active request')
    this.update(entry, snapshot)
  }

  private update(entry: CapturedRequest, snapshot: DesktopWebsiteHostSnapshot): void {
    this.assign(entry, snapshot)
    this.notify()
  }

  private async control(binding: DesktopWebsiteRequestBinding, action: 'validate' | 'commit', signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const entry = this.domain(binding.requestId, binding.host)
    const epoch = entry.snapshot.epoch
    const snapshot = await binding.host.websiteControl({ action, id: binding.requestId, epoch })
    signal.throwIfAborted()
    if (this.dependencies.currentHost() !== binding.host || snapshot === undefined || entry.snapshot.epoch !== epoch) {
      throw new Error('Website request changed during Host admission')
    }
    this.update(entry, snapshot)
  }
}
