/** Scheduling policy for background Codex usage reads. */

/** Deployment limits supplied by the Settings Controller profile. */
export interface AccountUsagePolicy {
  /** Minimum milliseconds between background reads of the active account. */
  readonly activeRefreshMs: number
  /** Minimum milliseconds between background reads of an inactive account. */
  readonly inactiveRefreshMs: number
  /** Maximum account reads running in one refresh cycle. */
  readonly concurrency: number
}

/** Defaults shared by profile validation and direct controller construction. */
export const DEFAULT_ACCOUNT_USAGE_POLICY: AccountUsagePolicy = {
  activeRefreshMs: 30_000,
  inactiveRefreshMs: 300_000,
  concurrency: 3,
}
