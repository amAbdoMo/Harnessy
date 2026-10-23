/** Request admission for one saved-profile page; receipts and native lifetimes never enter render state. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DesktopBrowserLeaseId, DesktopWebsiteAccess, DesktopWebsiteHostSnapshot, DesktopWebsiteProfileId,
  DesktopWebsiteRequestId, DesktopWebsiteRequestsBridge,
} from '../../types.ts'

/** JSON-compatible request controls for one tab, with no authentication observations. */
export interface WebsiteRequestPageState {
  readonly phase: 'loading' | 'ready' | 'failed'
  readonly requests: readonly DesktopWebsiteHostSnapshot[]
  readonly selected: DesktopWebsiteRequestId | undefined
  readonly busy: 'resuming' | 'draining' | undefined
  readonly granted: boolean
  readonly blocked: boolean
  readonly paused: boolean
  readonly canResume: boolean
  readonly canTakeover: boolean
}

/** The actual attached guest; abort ends this guest occurrence, not merely its DOM container. */
export interface WebsitePageBinding {
  readonly lease: DesktopBrowserLeaseId
  readonly signal: AbortSignal
}

/** Session-owned roster and request claims, shared by its saved-profile tabs. */
export interface WebsiteRequestPageOwner {
  readonly sessionId: Branded<'SessionId'>
  readonly bridge: DesktopWebsiteRequestsBridge
  claim(id: DesktopWebsiteRequestId, page: WebsiteRequestPage): boolean
  unclaim(id: DesktopWebsiteRequestId, page: WebsiteRequestPage): void
  release(page: WebsiteRequestPage): void
  reload(): Promise<void>
  report(profile: DesktopWebsiteProfileId, outcome: 'resumed' | 'human' | 'requestFailed'): void
}

interface Admission {
  readonly id: DesktopWebsiteRequestId
  readonly binding: WebsitePageBinding
  readonly hostEpoch: number
  readonly automatic: boolean
  readonly lifetime: AbortController
  readonly settled: Promise<void>
  drain?: Promise<void>
  readonly failures: unknown[]
}

/** Owns a single page's explicit human admission and immediate revocation. */
export class WebsiteRequestPage implements HostObservable<WebsiteRequestPageState> {
  private readonly store = createSnapshotStore<WebsiteRequestPageState>({
    phase: 'loading', requests: [], selected: undefined, busy: undefined,
    granted: false, blocked: false, paused: false, canResume: false, canTakeover: false,
  })
  private binding: WebsitePageBinding | undefined
  private visible = false
  private paused = false
  private scheduled = false
  private readonly attempted = new Set<DesktopWebsiteRequestId>()
  private closed = false
  private admission: Admission | undefined
  private disposal: Promise<void> | undefined
  private readonly lostGuest = (): void => { this.bind(undefined) }

  /** @param owner - initiating Session roster. @param profile - this page's immutable saved account. */
  constructor(private readonly owner: WebsiteRequestPageOwner, private readonly profile: DesktopWebsiteProfileId,
    private readonly access: () => DesktopWebsiteAccess = () => 'ask') {}

  /** @returns stable request-only render state. */
  getSnapshot: () => WebsiteRequestPageState = () => this.store.getSnapshot()
  /** @param listener - render invalidation. @returns unsubscribe callback. */
  subscribe: (listener: () => void) => () => void = listener => this.store.subscribe(listener)

  /**
   * Refresh this page's requests and revoke admissions absent from the usable Session roster.
   * @param phase - Session roster query state.
   * @param rows - current Session requests, never a global selection.
   */
  update(phase: WebsiteRequestPageState['phase'], rows: readonly DesktopWebsiteHostSnapshot[]): void {
    if (this.closed) return
    const requests = rows.filter(row => row.profile === this.profile)
    this.publish({ phase, requests })
    const selected = this.store.getSnapshot().selected
    const admission = this.admission
    if (admission !== undefined && (phase !== 'ready'
      || !requests.some(row => row.id === admission.id && !row.terminal && row.epoch === admission.hostEpoch))) this.cancel()
    if (this.access() === 'disabled') this.cancel()
    if (phase === 'ready' && selected !== undefined && !requests.some(row => row.id === selected && !row.terminal)) {
      this.publish({ selected: undefined })
      if (admission?.id !== selected) this.owner.unclaim(selected, this)
    }
    this.scheduleAutomatic()
  }

  /**
   * Bind the attached guest occurrence; replacement or loss revokes its admission.
   * @param binding - actual attached native lease and its lifetime, or absence after loss.
   */
  bind(binding: WebsitePageBinding | undefined): void {
    if (this.closed || this.binding === binding) return
    this.binding?.signal.removeEventListener('abort', this.lostGuest)
    this.binding = binding?.signal.aborted === false ? binding : undefined
    this.binding?.signal.addEventListener('abort', this.lostGuest, { once: true })
    if (this.admission !== undefined && this.binding !== this.admission.binding) this.cancel()
    this.publish({})
    this.scheduleAutomatic()
  }

  /**
   * Revoke Ask access on hiding; Automatic work retains its attached guest and admission.
   * @param visible - committed logical tab visibility.
   */
  setVisible(visible: boolean): void {
    this.visible = !this.closed && visible
    if (!this.visible && this.admission?.automatic !== true) this.cancel()
    this.publish({})
    this.scheduleAutomatic()
  }

  /**
   * Claim an explicit request selection and revoke the previous admission.
   * @param id - explicit human selection; no sole-row or latest-request fallback.
   */
  select(id: DesktopWebsiteRequestId | undefined): void {
    if (this.closed || id === this.store.getSnapshot().selected) return
    const row = this.store.getSnapshot().requests.find(candidate => candidate.id === id && !candidate.terminal)
    if (id !== undefined && (row === undefined || !this.owner.claim(id, this))) return
    const previous = this.store.getSnapshot().selected
    this.cancel()
    this.publish({ selected: id, granted: false })
    if (previous !== undefined && this.admission?.id !== previous) this.owner.unclaim(previous, this)
  }

  /** Read the Session roster again; failed reads retain their rows but cannot admit work. */
  reload(): Promise<void> { return this.owner.reload() }

  /**
   * Continue a waiting request from this page's Session and profile on its attached guest.
   * @returns after admission settles; preparation and acknowledgement alone grant nothing.
   */
  async resume(): Promise<void> {
    this.paused = false
    await this.owner.reload()
    this.selectFirst()
    const selected = this.store.getSnapshot().selected
    if (selected !== undefined) this.attempted.delete(selected)
    this.publish({})
    await this.admitSelected()
  }

  private admitSelected(): Promise<void> {
    const state = this.store.getSnapshot()
    const binding = this.binding
    if (!state.canResume || state.selected === undefined || binding === undefined) return Promise.resolve()
    const row = state.requests.find(candidate => candidate.id === state.selected)
    if (row === undefined) return Promise.resolve()
    const completion = Promise.withResolvers<void>()
    const admission: Admission = { id: state.selected, binding, hostEpoch: row.epoch,
      automatic: this.access() === 'automatic', lifetime: new AbortController(), settled: completion.promise, failures: [] }
    this.admission = admission
    this.publish({ busy: 'resuming', granted: false })
    void this.admit(admission).then(completion.resolve, completion.reject)
    return admission.settled
  }

  /**
   * Revoke immediately for human takeover, retaining failed drainage without an unhandled rejection.
   * @returns after revocation and physical drainage, even during pending admission.
   */
  async takeover(): Promise<void> {
    this.paused = true
    this.publish({})
    const admission = this.admission
    if (admission === undefined) return
    try {
      await this.revoke(admission)
      this.report('human')
    } catch (error) {
      // revoke retains the failed admission and reports its failure; user handlers receive no unhandled rejection.
      void error
    }
  }

  /**
   * Close the page and release its owner only after successful request drainage.
   * @returns after the page's requests drain; failed cleanup retains the Session claim.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.visible = false
    this.binding?.signal.removeEventListener('abort', this.lostGuest)
    this.binding = undefined
    const admission = this.admission
    this.disposal = (admission === undefined ? Promise.resolve() : this.revoke(admission)).then(() => { this.owner.release(this) })
    return this.disposal
  }

  private publish(change: Partial<WebsiteRequestPageState>): void {
    if (this.closed) return
    const state = { ...this.store.getSnapshot(), ...change }
    const eligible = state.requests.some(row => (state.selected === undefined || row.id === state.selected) && !row.terminal && row.status !== 'granted')
    this.store.set({ ...state,
      paused: this.paused,
      canResume: this.access() !== 'disabled' && (this.visible || this.access() === 'automatic') && this.binding !== undefined && !this.binding.signal.aborted
        && state.phase === 'ready' && eligible && this.admission === undefined && !state.blocked,
      canTakeover: this.admission !== undefined && this.admission.drain === undefined,
    })
  }

  private selectFirst(): void {
    const state = this.store.getSnapshot()
    if (state.requests.some(row => row.id === state.selected && !row.terminal && row.status !== 'granted')) return
    for (const row of state.requests) {
      if (row.terminal || row.status === 'granted' || !this.owner.claim(row.id, this)) continue
      if (state.selected !== undefined) this.owner.unclaim(state.selected, this)
      this.publish({ selected: row.id })
      return
    }
  }

  private scheduleAutomatic(): void {
    if (this.closed || this.scheduled || this.paused || this.access() !== 'automatic'
      || this.binding === undefined || this.admission !== undefined || this.store.getSnapshot().phase !== 'ready') return
    this.selectFirst()
    const id = this.store.getSnapshot().selected
    if (id === undefined || this.attempted.has(id)) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.closed || this.paused || this.access() !== 'automatic' || this.admission !== undefined) return
      if (this.store.getSnapshot().selected !== id || !this.store.getSnapshot().canResume) return
      this.attempted.add(id)
      void this.admitSelected().catch((_error: unknown) => { /* Admission publishes its own bounded failure notice. */ })
    })
  }

  private current(admission: Admission): void {
    const state = this.store.getSnapshot()
    if (this.closed || (!this.visible && !admission.automatic) || this.admission !== admission || admission.lifetime.signal.aborted
      || this.binding !== admission.binding || admission.binding.signal.aborted || state.selected !== admission.id
      || state.phase !== 'ready' || !state.requests.some(row => row.id === admission.id && !row.terminal && row.epoch === admission.hostEpoch)) {
      throw new Error('Website request is no longer current')
    }
  }

  private async admit(admission: Admission): Promise<void> {
    try {
      this.current(admission)
      const receipt = await this.owner.bridge.prepare({
        requestId: admission.id, sessionId: this.owner.sessionId, lease: admission.binding.lease,
      })
      this.current(admission)
      await this.owner.bridge.acknowledge(receipt)
      this.current(admission)
      await this.owner.bridge.resume(receipt)
      this.current(admission)
      this.publish({ granted: true })
      this.report('resumed')
    } catch (error) {
      if (!admission.lifetime.signal.aborted) this.report('requestFailed')
      admission.lifetime.abort()
      // A late preparation/commit must be revoked again after its reply; an earlier Takeover is not settlement.
      try { await this.owner.bridge.takeover(admission.id) }
      catch (failure) { admission.failures.push(failure) }
      void error
    } finally {
      if (admission.lifetime.signal.aborted && admission.drain === undefined) {
        if (admission.failures.length === 0) this.finish(admission)
        else this.report('requestFailed')
      }
      this.publish({ busy: admission.drain === undefined ? undefined : 'draining', blocked: admission.failures.length !== 0 })
    }
  }

  private finish(admission: Admission): void {
    if (this.admission === admission) this.admission = undefined
    if (this.store.getSnapshot().selected !== admission.id) this.owner.unclaim(admission.id, this)
    this.scheduleAutomatic()
  }

  private report(outcome: 'resumed' | 'human' | 'requestFailed'): void {
    try { this.owner.report(this.profile, outcome) }
    catch (error) {
      // Feedback cannot interrupt revocation or retain an otherwise drained request.
      void error
    }
  }

  private cancel(): void {
    if (this.admission === undefined) return
    void this.revoke(this.admission).catch((error: unknown) => {
      // Failed drainage remains blocked in the page and its Session owner; revoke already announces it.
      void error
    })
  }

  private revoke(admission: Admission): Promise<void> {
    if (admission.drain !== undefined) return admission.drain
    const completion = Promise.withResolvers<void>()
    admission.drain = completion.promise
    admission.lifetime.abort()
    this.publish({ granted: false, busy: 'draining' })
    // Dispatch immediately, not behind the in-flight prepare/Resume call.
    const immediate = this.owner.bridge.takeover(admission.id).catch((failure: unknown) => { admission.failures.push(failure) })
    void Promise.all([immediate, admission.settled]).then(() => {
      if (admission.failures.length !== 0) {
        this.publish({ busy: undefined, blocked: true })
        this.report('requestFailed')
        completion.reject(new AggregateError(admission.failures, 'Website request failed to drain'))
      } else {
        this.finish(admission)
        this.publish({ busy: undefined, granted: false })
        completion.resolve()
      }
    }, completion.reject)
    return completion.promise
  }
}
