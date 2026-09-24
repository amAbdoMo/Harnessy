/** Shared browser lifecycle for Harnessy's account and quota snapshot. */

import type { AccountsState } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AccountsManagerOperations } from './AccountsManagerCard.tsx'

const USAGE_REFRESH_INTERVAL_MS = 60_000

type AccountUsageOperations = Pick<AccountsManagerOperations, 'describe' | 'refreshUsage'>

/** Owns the live account snapshot and bounded automatic usage refreshes. */
export class AccountsUsageController {
  /** Latest public account state shared by every Harnessy account surface. */
  readonly state: SnapshotStore<AccountsState | undefined> = createSnapshotStore<AccountsState | undefined>(undefined)

  private lifecycle: AbortController | undefined
  private refreshInFlight: Promise<void> | undefined

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
   * Refresh the public quota snapshot, sharing any active automatic request.
   * @returns after the current or newly started refresh settles.
   */
  refresh(): Promise<void> {
    const lifecycle = this.lifecycle
    if (lifecycle === undefined || lifecycle.signal.aborted) return Promise.resolve()
    if (this.refreshInFlight !== undefined) return this.refreshInFlight
    const operation = this.requestUsage(lifecycle).finally(() => {
      if (this.refreshInFlight === operation) this.refreshInFlight = undefined
    })
    this.refreshInFlight = operation
    return operation
  }

  /**
   * Publish a mutation response so account surfaces converge before the next timer.
   * @param state - redacted Host state, or undefined after a failed request.
   */
  publish(state: AccountsState | undefined): void {
    if (state !== undefined) this.state.set(state)
  }

  private async load(lifecycle: AbortController): Promise<void> {
    const described = await this.operations.describe()
    if (this.lifecycle !== lifecycle || lifecycle.signal.aborted) return
    this.publish(described.state)
    await this.refresh()
  }

  private async requestUsage(lifecycle: AbortController): Promise<void> {
    const refreshed = await this.operations.refreshUsage(lifecycle.signal)
    if (this.lifecycle !== lifecycle || lifecycle.signal.aborted) return
    this.publish(refreshed.state)
  }

  private stop(lifecycle: AbortController, timer: number, refreshWhenVisible: () => void): void {
    if (this.lifecycle !== lifecycle) return
    this.lifecycle = undefined
    lifecycle.abort()
    window.clearInterval(timer)
    window.removeEventListener('focus', refreshWhenVisible)
    document.removeEventListener('visibilitychange', refreshWhenVisible)
  }
}
