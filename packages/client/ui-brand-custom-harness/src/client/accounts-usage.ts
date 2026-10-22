/** Shared browser lifecycle for Harnessy's account and quota snapshot. */

import type { AccountsState } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AccountsManagerOperations } from './AccountsManagerCard.tsx'

const USAGE_REFRESH_INTERVAL_MS = 60_000
// Browser timers use a signed 32-bit delay; longer deployment intervals must not wrap to one millisecond.
const MAX_TIMER_DELAY_MS = 2_147_483_647

type AccountUsageOperations = Pick<AccountsManagerOperations, 'describe' | 'refreshUsage'>
type AccountUsageResult = Awaited<ReturnType<AccountUsageOperations['refreshUsage']>>

/** Owns the live account snapshot and bounded automatic usage refreshes. */
export class AccountsUsageController {
  /** Latest public account state shared by every Harnessy account surface. */
  readonly state: SnapshotStore<AccountsState | undefined> = createSnapshotStore<AccountsState | undefined>(undefined)

  private lifecycle: AbortController | undefined
  private refreshInFlight: {
    readonly result: Promise<AccountUsageResult>
    readonly accountIds: readonly string[]
    followup: 'fresh' | 'cached' | undefined
  } | undefined
  private publication = 0
  private requestSequence = 0
  private appliedRequest = 0
  private timer: number | undefined

  /** @param operations - Host-backed redacted account reads. */
  constructor(private readonly operations: AccountUsageOperations) {}

  /**
   * Start the page-owned startup, visible-window, and foreground refresh lifecycle.
   * @returns a disposer that aborts the active read and removes every browser listener.
   */
  start(): () => void {
    if (this.lifecycle !== undefined) throw new Error('accounts usage controller is already started')
    const lifecycle = new AbortController()
    this.lifecycle = lifecycle
    const refreshWhenVisible = (): void => {
      if (document.visibilityState !== 'hidden') void this.refresh()
      else this.schedule(lifecycle)
    }
    void this.load(lifecycle)
    const unsubscribe = this.state.subscribe(() => { this.schedule(lifecycle) })
    this.schedule(lifecycle)
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => { this.stop(lifecycle, unsubscribe, refreshWhenVisible) }
  }

  /**
   * Share the active quota read, retaining a follow-up for newly added Codex accounts.
   * @param freshAfterCurrent - retain a fresh check after an existing read, for manager and sign-in actions.
   * @returns the shared Host response after the refresh settles, or an empty result when stopped.
   */
  refresh(freshAfterCurrent = false): Promise<AccountUsageResult> {
    const lifecycle = this.lifecycle
    if (lifecycle === undefined || lifecycle.signal.aborted) return Promise.resolve({})
    const accountIds = this.state.getSnapshot()?.accounts.filter(account => account.provider === 'openai-codex')
      .map(account => account.id) ?? []
    const pending = this.refreshInFlight
    if (pending !== undefined) {
      if (freshAfterCurrent) pending.followup = 'fresh'
      else if (pending.followup === undefined && accountIds.some(id => !pending.accountIds.includes(id))) pending.followup = 'cached'
      return pending.result
    }
    const operation = this.requestUsage(lifecycle, freshAfterCurrent ? 'fresh' : 'cached').finally(() => {
      if (this.refreshInFlight?.result !== operation) return
      const followup = this.refreshInFlight.followup
      this.refreshInFlight = undefined
      if (followup !== undefined) void this.refresh(followup === 'fresh')
      else this.schedule(lifecycle)
    })
    this.refreshInFlight = { result: operation, accountIds, followup: undefined }
    return operation
  }

  /**
   * Publish the redacted Host snapshot shared by the sidebar and manager.
   * @param state - redacted Host state, or undefined after a failed request.
   */
  publish(state: AccountsState | undefined): void {
    if (state === undefined) return
    const before = this.state.getSnapshot()
    this.publication += 1
    this.state.set(state)
    if (before !== undefined && state.accounts.some(account => account.provider === 'openai-codex'
      && !before.accounts.some(previous => previous.id === account.id && previous.provider === account.provider))) {
      void this.refresh()
    }
  }

  /**
   * Publish a response unless superseded by a Host event or a later-started request's response.
   * @param request - Host read or mutation returning a redacted snapshot.
   * @returns the operation result, including its error when available.
   */
  async request<T extends { readonly state?: AccountsState }>(request: () => Promise<T>): Promise<T> {
    const publication = this.publication
    const sequence = ++this.requestSequence
    const lifecycle = this.lifecycle
    const result = await request()
    if (result.state !== undefined && this.lifecycle === lifecycle && !lifecycle?.signal.aborted
      && this.publication === publication && sequence > this.appliedRequest) {
      this.appliedRequest = sequence
      this.state.set(result.state)
    }
    return result
  }

  private async load(lifecycle: AbortController): Promise<void> {
    await this.request(() => this.operations.describe())
    if (this.lifecycle !== lifecycle || lifecycle.signal.aborted) return
    await this.refresh()
  }

  private async requestUsage(lifecycle: AbortController, freshness: 'fresh' | 'cached'): Promise<AccountUsageResult> {
    const refreshed = await this.request(() => this.operations.refreshUsage(lifecycle.signal, freshness))
    if (this.lifecycle !== lifecycle || lifecycle.signal.aborted) return {}
    return refreshed
  }

  private schedule(lifecycle: AbortController): void {
    if (this.lifecycle !== lifecycle || lifecycle.signal.aborted) return
    window.clearTimeout(this.timer)
    if (document.visibilityState === 'hidden') return
    const interval = this.state.getSnapshot()?.usageRefreshIntervalMs ?? USAGE_REFRESH_INTERVAL_MS
    this.timer = window.setTimeout(() => {
      if (document.visibilityState !== 'hidden') void this.refresh()
      else this.schedule(lifecycle)
    }, Math.min(interval, MAX_TIMER_DELAY_MS))
  }

  private stop(lifecycle: AbortController, unsubscribe: () => void, refreshWhenVisible: () => void): void {
    if (this.lifecycle !== lifecycle) return
    this.lifecycle = undefined
    this.refreshInFlight = undefined
    lifecycle.abort()
    window.clearTimeout(this.timer)
    this.timer = undefined
    unsubscribe()
    window.removeEventListener('focus', refreshWhenVisible)
    document.removeEventListener('visibilitychange', refreshWhenVisible)
  }
}
