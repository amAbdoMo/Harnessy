/** Main-owned, request-specific website authority; native visibility never implicitly resumes an agent. */
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type {
  DesktopBrowserLeaseId, DesktopWebsiteProfileId, DesktopWebsiteRequestId, DesktopWebsiteRequestReceipt, DesktopWebsiteVisibilityId,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
export type { DesktopWebsiteRequestId, DesktopWebsiteRequestReceipt, DesktopWebsiteVisibilityId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopHostProcess } from './host-process.ts'
import { websiteAccountKeys as accountKeys } from './website-profiles.ts'
import type { DesktopWebsiteAccount, DesktopWebsiteMcpBinding } from './website-profiles.ts'

/** Trusted preparation fields. Agent/Session strings route messages; Host callbacks must retain exact live objects. */
export interface DesktopWebsiteRequestInput {
  readonly requestId: DesktopWebsiteRequestId
  readonly host: DesktopHostProcess
  readonly agentId: string
  readonly sessionId: string
  readonly profile: DesktopWebsiteProfileId
  readonly url: string
  readonly mcpServerName: string
  readonly mcpBinding: DesktopWebsiteMcpBinding
  readonly owner: WebContents
  readonly lease: DesktopBrowserLeaseId
}

/** A receipt returned only after explicit Resume commits; every operation still checks current authority. */
export type DesktopWebsiteRequestGrant = DesktopWebsiteRequestReceipt

/** Native inspection of the exact lease, not renderer-supplied visibility or guest metadata. */
export interface DesktopWebsiteRequestGuest {
  readonly owner: WebContents
  readonly guest: WebContents
  readonly profile: DesktopWebsiteProfileId
  readonly attached: boolean
  readonly releasing: boolean
  readonly ownerAuthenticated: boolean
  readonly windowVisible: boolean
  readonly windowMinimized: boolean
}

/** Main-only captured identities supplied unchanged to the captured Host's callbacks. */
export interface DesktopWebsiteRequestBinding extends DesktopWebsiteRequestInput, DesktopWebsiteRequestReceipt {
  readonly guest: WebContents
}

/** Native/Host adapters; all callbacks must target binding.host, never a later current Host. */
export interface DesktopWebsiteRequestDependencies {
  /** @returns the currently running Host object, or undefined during replacement/shutdown. */
  currentHost(): DesktopHostProcess | undefined
  /** Notify renderer inventory after reservation acquisition or physical release; grants no authority. */
  reservationChanged?(): void
  /**
   * @param owner - authenticated IPC sender. @param lease - captured reservation.
   * @returns native state, or undefined for a missing guest.
   */
  inspectGuest(owner: WebContents, lease: DesktopBrowserLeaseId): DesktopWebsiteRequestGuest | undefined
  /** Reject removed/clearing profiles or changed saved pairings synchronously. @param input - captured association. */
  assertProfile(input: DesktopWebsiteRequestInput): void
  /**
   * Grants nothing. Retain and check exact live Agent and Session objects, MCP configuration, and request membership.
   * @param binding - captured Main identities. @param signal - cancellation of this grant transaction.
   */
  validate(binding: DesktopWebsiteRequestBinding, signal: AbortSignal): Promise<void>
  /**
   * Commit on the captured Host and await acknowledgement; recheck exact Agent/Session identities before publication.
   * A queued Host receiver revalidates its own generation before admitting work; native and Host epochs are independent.
   * @param binding - validated request. @param signal - already-aborted transactions must reject.
   */
  commit(binding: DesktopWebsiteRequestBinding, signal: AbortSignal): void | Promise<void>
  /** Stop Host admission synchronously, including a pending validation. @param binding - revoked transaction. */
  revoke(binding: DesktopWebsiteRequestBinding): void
  /**
   * Await Host-side admitted work, including MCP operations. Failure permanently retains account locks.
   * @param binding - revoked transaction.
   */
  drain(binding: DesktopWebsiteRequestBinding): Promise<void>
}

interface GrantTransaction {
  readonly binding: DesktopWebsiteRequestBinding
  readonly controller: AbortController
  readonly keys: readonly string[]
  readonly operations: Set<Promise<unknown>>
  admission: Promise<void>
  committed: boolean
  drain: Promise<void> | undefined
}

interface WebsiteRequest {
  readonly id: DesktopWebsiteRequestId
  readonly input: DesktopWebsiteRequestInput
  readonly guest: WebContents
  readonly keys: readonly string[]
  epoch: number
  visibility: DesktopWebsiteVisibilityId | undefined
  acknowledgedGuest: WebContents | undefined
  transaction: GrantTransaction | undefined
  closed: boolean
}

const STALE = 'Website request is stale or not acknowledged'
const UNAVAILABLE = 'Website request requires its live visible native guest and captured Host'
const LOCKED = 'Website account is controlled by another request or still draining'

/**
 * One coordinator per Main process, shared by all profiles and windows. Prepare and acknowledgement grant nothing.
 * Main must call setVisible(false) or revoke before native hide/minimize, guest release, profile cleanup, renderer
 * loss, Host replacement, or Agent/Session invalidation; call close when the Host request ends. This module does
 * not install IPC handlers or intercept alternate browser/MCP executors: those consumers must enforce its grants.
 */
export class DesktopWebsiteRequests {
  private readonly requests = new Map<DesktopWebsiteRequestId, WebsiteRequest>()
  private readonly accounts = new Map<string, GrantTransaction>()

  /** @param dependencies - trusted native inspection and exact-Host validation/admission/teardown callbacks. */
  constructor(private readonly dependencies: DesktopWebsiteRequestDependencies) {}

  /**
   * Capture the exact attached guest, including before a hidden-window acknowledgement fails.
   * Revoked requests may renew only the original association and visible guest after successful drainage.
   * @param input - captured Host's existing domain request and Main-owned profile/lease.
   * @returns adopted request identity; renewal invalidates old receipts and grants no guest access.
   */
  prepare(input: DesktopWebsiteRequestInput): DesktopWebsiteRequestId {
    if (this.dependencies.currentHost() !== input.host) throw new Error(UNAVAILABLE)
    this.dependencies.assertProfile(input)
    const id = input.requestId
    const request = this.requests.get(id)
    if (request !== undefined) {
      const original = request.input
      if (request.closed || original.host !== input.host || original.owner !== input.owner
        || original.agentId !== input.agentId || original.sessionId !== input.sessionId || original.profile !== input.profile
        || original.url !== input.url || original.mcpServerName !== input.mcpServerName || original.lease !== input.lease
        || original.mcpBinding.identity !== input.mcpBinding.identity || original.mcpBinding.endpoint !== input.mcpBinding.endpoint) {
        throw new Error(STALE)
      }
      if (request.transaction !== undefined || request.keys.some(key => this.accounts.has(key))) throw new Error(LOCKED)
      if (request.epoch === 0) throw new Error('Website request identity is already prepared')
      this.nativeGuest(request)
      request.epoch += 1
      request.visibility = undefined
      request.acknowledgedGuest = undefined
      return id
    }
    const guest = this.attachedGuest(input).guest
    const captured = Object.freeze({ ...input, mcpBinding: Object.freeze({ ...input.mcpBinding }) })
    const keys = accountKeys(input)
    this.requests.set(id, { id, input: captured, guest, keys, epoch: 0, visibility: undefined,
      acknowledgedGuest: undefined, transaction: undefined, closed: false })
    return id
  }

  /**
   * @param owner - authenticated IPC sender. @param id - request owned by that sender. @param visible - logical tab selection.
   * @returns receipt for the current visible occurrence, or undefined after synchronous revocation on hide.
   * Native window visibility is checked separately. Showing again requires a fresh acknowledgement and explicit Resume.
   * Hide contains teardown rejection for event dispatch; revoke returns the same drainage promise for cleanup callers.
   */
  setVisible(owner: WebContents, id: DesktopWebsiteRequestId, visible: boolean): DesktopWebsiteRequestReceipt | undefined {
    const request = this.owned(owner, id)
    if (!visible) {
      request.visibility = undefined
      void this.revoke(id).catch((_error: unknown) => { /* The retained transaction rejects subsequent Resume/cleanup. */ })
      return undefined
    }
    request.visibility ??= randomUUID() as DesktopWebsiteVisibilityId
    return this.receipt(request)
  }

  /**
   * @param owner - authenticated sender.
   * @param receipt - exact current request/lease/occurrence/epoch; native attachment and visibility must also match.
   */
  acknowledge(owner: WebContents, receipt: DesktopWebsiteRequestReceipt): void {
    const request = this.owned(owner, receipt.requestId)
    this.assertReceipt(request, receipt)
    request.acknowledgedGuest = this.nativeGuest(request)
  }

  /**
   * @param owner - authenticated sender making an explicit human Resume. @param receipt - acknowledged visible occurrence.
   * @returns request-specific grant after validation and acknowledged Host commit; races, locks and teardown failures reject.
   */
  async resume(owner: WebContents, receipt: DesktopWebsiteRequestReceipt): Promise<DesktopWebsiteRequestGrant> {
    const request = this.owned(owner, receipt.requestId)
    const guest = this.assertAcknowledged(request, receipt)
    if (request.transaction !== undefined || request.keys.some(key => this.accounts.has(key))) throw new Error(LOCKED)
    const binding = Object.freeze({ ...request.input, ...this.receipt(request), guest })
    const transaction: GrantTransaction = { binding, controller: new AbortController(), keys: request.keys,
      operations: new Set(), admission: Promise.resolve(), committed: false, drain: undefined }
    request.transaction = transaction
    for (const key of transaction.keys) this.accounts.set(key, transaction)
    transaction.admission = Promise.resolve().then(async () => {
      transaction.controller.signal.throwIfAborted()
      await this.dependencies.validate(binding, transaction.controller.signal)
      this.assertTransaction(request, transaction, receipt)
      await this.dependencies.commit(binding, transaction.controller.signal)
      this.assertTransaction(request, transaction, receipt)
      transaction.committed = true
    })
    this.notifyReservation()
    try {
      await transaction.admission
      this.assertTransaction(request, transaction, receipt)
      return Object.freeze({ ...receipt })
    } catch (error) {
      // Even a failed commit can have reached Host admission; only drainage releases the reservation.
      await this.revoke(request.id)
      throw error
    }
  }

  /**
   * Rejects any lost native authority synchronously.
   * @param host - captured Host requesting admission. @param id - existing domain request.
   */
  assertGranted(host: DesktopHostProcess, id: DesktopWebsiteRequestId): void {
    const request = this.require(id)
    const transaction = request.transaction
    if (host !== request.input.host || transaction === undefined || !transaction.committed) throw new Error(STALE)
    this.assertTransaction(request, transaction, transaction.binding)
  }

  /** @param account - saved pairing. @returns whether any alias remains reserved, including validation and drainage. */
  isAccountReserved(account: DesktopWebsiteAccount): boolean {
    return accountKeys(account).some(key => this.accounts.has(key))
  }

  private notifyReservation(): void {
    try { this.dependencies.reservationChanged?.() }
    catch (_error: unknown) { /* Renderer invalidation cannot affect native reservation lifetime. */ }
  }

  /**
   * Enforce same-origin navigation and deny popup forwarding for a reserved guest until drainage finishes.
   * @param owner - native guest owner. @param lease - native guest reservation.
   * @param address - validated HTTP(S) destination; absence requests popup forwarding or Human input.
   * @param account - inspected saved pairing; aliases share the origin, namespace, binding or endpoint reservation.
   * @returns whether Human browsing or the exact captured guest's same-origin navigation permits the action.
   */
  allowsNativeNavigation(owner: WebContents, lease: DesktopBrowserLeaseId, address?: string, account?: DesktopWebsiteAccount): boolean {
    const keys = account === undefined ? [] : accountKeys(account)
    for (const request of this.requests.values()) {
      const transaction = request.transaction
      if (transaction === undefined) continue
      const binding = transaction.binding
      const capturedGuest = binding.owner === owner && binding.lease === lease
      if (capturedGuest || keys.some(key => transaction.keys.includes(key))) {
        return capturedGuest && address !== undefined && URL.canParse(address)
          && new URL(address).origin === new URL(binding.url).origin
      }
    }
    return true
  }

  /**
   * A private request ID selects the exact native transaction receipt; a Host epoch never becomes a native grant.
   * @param host - exact captured Host dispatching work. @param id - private request selecting its committed native transaction.
   * @param signal - private operation cancellation, independent of request revocation.
   * @param operation - admitted native work; settle only after its effects are quiescent, even after abort.
   * @returns its result, or rejection if revoked/cancelled before publication. Account locks outlive abort until settlement.
   */
  async run<T>(host: DesktopHostProcess, id: DesktopWebsiteRequestId, signal: AbortSignal,
    operation: (guest: WebContents, signal: AbortSignal) => Promise<T>): Promise<T> {
    const request = this.require(id)
    const transaction = request.transaction
    if (host !== request.input.host || transaction === undefined || !transaction.committed) throw new Error(STALE)
    const grant = transaction.binding
    const cancellation = AbortSignal.any([transaction.controller.signal, signal])
    cancellation.throwIfAborted()
    this.assertTransaction(request, transaction, grant)
    const pending = Promise.resolve().then(async () => {
      cancellation.throwIfAborted()
      this.assertTransaction(request, transaction, grant)
      const result = await operation(transaction.binding.guest, cancellation)
      cancellation.throwIfAborted()
      this.assertTransaction(request, transaction, grant)
      return result
    })
    transaction.operations.add(pending)
    try {
      const result = await pending
      cancellation.throwIfAborted()
      this.assertTransaction(request, transaction, grant)
      return result
    } finally { transaction.operations.delete(pending) }
  }

  /**
   * Revoke before awaiting: abort local work and stop Host admission, then retain locks until both sides settle.
   * @param id - Main-owned request affected by takeover, hide, destruction, cleanup or invalidation.
   * @returns shared drainage promise; failure retains locks permanently rather than permitting an unsafe new grant.
   */
  revoke(id: DesktopWebsiteRequestId): Promise<void> {
    const request = this.requests.get(id)
    if (request === undefined) return Promise.resolve()
    request.epoch += 1
    request.acknowledgedGuest = undefined
    const transaction = request.transaction
    if (transaction === undefined) return Promise.resolve()
    if (transaction.drain !== undefined) return transaction.drain
    transaction.committed = false
    const failures: unknown[] = []
    // Abort listeners and Host callbacks can reenter; both must observe the same installed drainage.
    transaction.drain = Promise.resolve().then(async () => {
      await Promise.allSettled([transaction.admission, ...transaction.operations])
      try { await this.dependencies.drain(transaction.binding) }
      catch (error) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'Website request drainage failed; account remains locked')
      for (const key of transaction.keys) {
        if (this.accounts.get(key) === transaction) this.accounts.delete(key)
      }
      if (request.transaction === transaction) request.transaction = undefined
      this.notifyReservation()
    })
    transaction.controller.abort(new Error(STALE))
    try { this.dependencies.revoke(transaction.binding) }
    catch (error) { failures.push(error) }
    // Native event dispatch need not await cleanup; callers still receive the original rejecting promise.
    void transaction.drain.catch((_error: unknown) => { /* Failure stays attached to the request and account locks. */ })
    return transaction.drain
  }

  /** @param owner - hidden, minimized or disconnected native owner. @returns drainage after synchronous revocation of all its requests. */
  revokeOwner(owner: WebContents): Promise<void> {
    return this.revokeMatching(request => request.input.owner === owner)
  }

  /**
   * @param owner - authenticated native owner. @param lease - released or destroyed guest.
   * @returns drainage after synchronous revocation.
   */
  revokeLease(owner: WebContents, lease: DesktopBrowserLeaseId): Promise<void> {
    return this.revokeMatching(request => request.input.owner === owner && request.input.lease === lease)
  }

  /** @param host - stopped or replaced captured Host. @returns drainage after synchronous revocation. */
  revokeHost(host: DesktopHostProcess): Promise<void> {
    return this.revokeMatching(request => request.input.host === host)
  }

  /**
   * @param account - saved pairing entering human takeover, including an alias without a prepared request.
   * @returns drainage after synchronously revoking this profile and any shared origin, namespace, configuration or endpoint.
   * Admission and takeover use the same account keys; unrelated requests retain their authority.
   */
  revokeAccount(account: DesktopWebsiteAccount): Promise<void> {
    const keys = new Set(accountKeys(account))
    return this.revokeMatching(request => request.input.profile === account.profile || request.keys.some(key => keys.has(key)))
  }

  private revokeMatching(matches: (request: WebsiteRequest) => boolean): Promise<void> {
    const settlements = [...this.requests.values()].filter(matches).map((request) => {
      request.visibility = undefined
      return this.revoke(request.id)
    })
    return Promise.allSettled(settlements).then((outcomes) => {
      const failures = outcomes.filter(outcome => outcome.status === 'rejected').map((outcome): unknown => outcome.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Website authority drainage failed')
    })
  }

  /**
   * Failed cleanup stays closed and locked.
   * @param id - completed/cancelled Host request.
   * @returns whether a native grant transaction settled its captured Host; otherwise the caller must settle the Host separately.
   */
  async close(id: DesktopWebsiteRequestId): Promise<boolean> {
    const request = this.requests.get(id)
    if (request === undefined) return false
    request.closed = true
    const hadTransaction = request.transaction !== undefined
    await this.revoke(id)
    this.requests.delete(id)
    return hadTransaction
  }

  private require(id: DesktopWebsiteRequestId): WebsiteRequest {
    const request = this.requests.get(id)
    if (request === undefined || request.closed) throw new Error(STALE)
    return request
  }

  private owned(owner: WebContents, id: DesktopWebsiteRequestId): WebsiteRequest {
    const request = this.require(id)
    if (request.input.owner !== owner) throw new Error(STALE)
    return request
  }

  private receipt(request: WebsiteRequest): DesktopWebsiteRequestReceipt {
    if (request.visibility === undefined) throw new Error(STALE)
    return Object.freeze({ requestId: request.id, epoch: request.epoch, visibility: request.visibility, lease: request.input.lease })
  }

  private assertReceipt(request: WebsiteRequest, receipt: DesktopWebsiteRequestReceipt): void {
    if (request.closed || request.id !== receipt.requestId || request.epoch !== receipt.epoch
      || request.visibility === undefined || request.visibility !== receipt.visibility || request.input.lease !== receipt.lease) {
      throw new Error(STALE)
    }
  }

  private attachedGuest(input: DesktopWebsiteRequestInput): DesktopWebsiteRequestGuest {
    const native = this.dependencies.inspectGuest(input.owner, input.lease)
    if (native === undefined || native.owner !== input.owner || native.profile !== input.profile
      || !native.attached || native.releasing || !native.ownerAuthenticated
      || native.owner.isDestroyed() || native.guest.isDestroyed()) throw new Error(UNAVAILABLE)
    return native
  }

  private nativeGuest(request: WebsiteRequest): WebContents {
    const { input } = request
    try {
      if (this.dependencies.currentHost() !== input.host) throw new Error(UNAVAILABLE)
      this.dependencies.assertProfile(input)
      const native = this.attachedGuest(input)
      if (native.guest !== request.guest || !native.windowVisible || native.windowMinimized) throw new Error(UNAVAILABLE)
      return native.guest
    } catch (error) {
      void this.revoke(request.id)
      throw error
    }
  }

  private assertAcknowledged(request: WebsiteRequest, receipt: DesktopWebsiteRequestReceipt): WebContents {
    this.assertReceipt(request, receipt)
    if (request.acknowledgedGuest === undefined) throw new Error(STALE)
    if (this.nativeGuest(request) !== request.acknowledgedGuest) {
      void this.revoke(request.id)
      throw new Error(UNAVAILABLE)
    }
    return request.acknowledgedGuest
  }

  private assertTransaction(request: WebsiteRequest, transaction: GrantTransaction, receipt: DesktopWebsiteRequestReceipt): void {
    transaction.controller.signal.throwIfAborted()
    if (request.transaction !== transaction) throw new Error(STALE)
    this.assertAcknowledged(request, receipt)
    if (request.acknowledgedGuest !== transaction.binding.guest) throw new Error(STALE)
  }
}
