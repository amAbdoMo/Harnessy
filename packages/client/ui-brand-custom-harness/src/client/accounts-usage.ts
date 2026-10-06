/** Shared browser lifecycle for Harnessy's account and quota snapshot. */

import type { AccountsState } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AccountsManagerOperations } from './AccountsManagerCard.tsx'

const USAGE_REFRESH_INTERVAL_MS = 60_000

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
    followup: boolean
  } | undefined
  private publication = 0
  private requestSequence = 0
  private appliedRequest = 0

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
    }
    void this.load(lifecycle)
    const timer = window.setInterval(refreshWhenVisible, USAGE_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => { this.stop(lifecycle, timer, refreshWhenVisible) }
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
      if (freshAfterCurrent || accountIds.some(id => !pending.accountIds.includes(id))) pending.followup = true
      return pending.result
    }
    const operation = this.requestUsage(lifecycle).finally(() => {
      if (this.refreshInFlight?.result !== operation) return
      const followup = this.refreshInFlight.followup
      this.refreshInFlight = undefined
      if (followup) void this.refresh()
    })
    this.refreshInFlight = { result: operation, accountIds, followup: false }
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

  private async requestUsage(lifecycle: AbortController): Promise<AccountUsageResult> {
    const refreshed = await this.request(() => this.operations.refreshUsage(lifecycle.signal))
    if (this.lifecycle !== lifecycle || lifecycle.signal.aborted) return {}
    return refreshed
  }

  private stop(lifecycle: AbortController, timer: number, refreshWhenVisible: () => void): void {
    if (this.lifecycle !== lifecycle) return
    this.lifecycle = undefined
    this.refreshInFlight = undefined
    lifecycle.abort()
    window.clearInterval(timer)
    window.removeEventListener('focus', refreshWhenVisible)
    document.removeEventListener('visibilitychange', refreshWhenVisible)
  }
}
