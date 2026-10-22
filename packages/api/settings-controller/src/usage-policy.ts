/** Scheduling policy for background Codex usage reads. */

/** Deployment limits supplied by the Settings Controller profile. */
export interface AccountUsagePolicy {
  /** Base active-account cache lifetime before quota tiers shorten it; zero disables caching. */
  readonly activeRefreshMs: number
  /** Minimum milliseconds between background reads of an inactive account. */
  readonly inactiveRefreshMs: number
  /** Maximum account reads running in one refresh cycle. */
  readonly concurrency: number
  /** Active-account pressure thresholds and their shorter cache lifetimes. */
  readonly activeRefreshTiers: readonly AccountUsageRefreshTier[]
  /** Cache lifetime for a failed active-account usage read. */
  readonly failureRefreshMs: number
  /** Upper bound for provider Retry-After cooldowns. */
  readonly maxRetryAfterMs: number
}

/** One active-account quota threshold and its refresh interval. */
export interface AccountUsageRefreshTier {
  /** Standard quota usage percentage, from zero through one hundred, that activates this tier. */
  readonly usedPercent: number
  /** Positive cache interval in milliseconds for this tier. */
  readonly refreshMs: number
}

/** Defaults shared by profile validation and direct controller construction. */
export const DEFAULT_ACCOUNT_USAGE_POLICY: AccountUsagePolicy = {
  activeRefreshMs: 60_000,
  inactiveRefreshMs: 300_000,
  concurrency: 3,
  activeRefreshTiers: [
    { usedPercent: 75, refreshMs: 30_000 },
    { usedPercent: 90, refreshMs: 15_000 },
    { usedPercent: 99, refreshMs: 5_000 },
  ],
  failureRefreshMs: 5_000,
  maxRetryAfterMs: 300_000,
}

/**
 * Resolve optional deployment overrides for direct controller construction.
 * @param policy - overrides already validated by the owning profile.
 * @returns the complete account usage policy.
 */
export function resolveAccountUsagePolicy(policy: Partial<AccountUsagePolicy> = {}): AccountUsagePolicy {
  return {
    activeRefreshMs: policy.activeRefreshMs ?? DEFAULT_ACCOUNT_USAGE_POLICY.activeRefreshMs,
    inactiveRefreshMs: policy.inactiveRefreshMs ?? DEFAULT_ACCOUNT_USAGE_POLICY.inactiveRefreshMs,
    concurrency: policy.concurrency ?? DEFAULT_ACCOUNT_USAGE_POLICY.concurrency,
    activeRefreshTiers: policy.activeRefreshTiers ?? DEFAULT_ACCOUNT_USAGE_POLICY.activeRefreshTiers,
    failureRefreshMs: policy.failureRefreshMs ?? DEFAULT_ACCOUNT_USAGE_POLICY.failureRefreshMs,
    maxRetryAfterMs: policy.maxRetryAfterMs ?? DEFAULT_ACCOUNT_USAGE_POLICY.maxRetryAfterMs,
  }
}

/**
 * Select the shortest configured interval reached by the active account.
 * @param policy - resolved deployment policy.
 * @param usedPercent - highest standard-window usage, absent when unknown.
 * @param failed - whether the latest usage read failed.
 * @returns milliseconds until the active snapshot becomes stale; zero disables caching.
 */
export function activeUsageRefreshMs(policy: AccountUsagePolicy, usedPercent: number | undefined, failed: boolean): number {
  if (policy.activeRefreshMs === 0) return 0
  if (failed) return Math.min(policy.activeRefreshMs, policy.failureRefreshMs)
  return policy.activeRefreshTiers.reduce((interval, tier) =>
    usedPercent !== undefined && usedPercent >= tier.usedPercent ? Math.min(interval, tier.refreshMs) : interval,
  policy.activeRefreshMs)
}

/**
 * Read the provider's bounded rate-limit cooldown.
 * @param response - failed usage response.
 * @param now - current wall time in milliseconds.
 * @param maximum - deployment cooldown ceiling in milliseconds.
 * @returns a retry delay for a valid HTTP 429 Retry-After header, otherwise undefined.
 */
export function usageRetryAfterMs(response: Response, now: number, maximum: number): number | undefined {
  if (response.status !== 429) return undefined
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, maximum) : undefined
}
