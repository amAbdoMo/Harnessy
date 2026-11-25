/** Bounded in-memory address suggestions for one Browser tab. */
import type { BrowserTarget } from './url.ts'

/** Maximum number of recent addresses retained by one live tab controller. */
export const MAX_RECENT_BROWSER_ADDRESSES = 10

/**
 * Add one committed address to the front of a tab's recent list.
 * @param recent - the current tab's in-memory entries, newest first.
 * @param target - the committed HTTP(S) target.
 * @returns deduplicated entries with the newest target first.
 */
export function rememberBrowserAddress(recent: readonly BrowserTarget[], target: BrowserTarget): readonly BrowserTarget[] {
  return [target, ...recent.filter(entry => entry.url !== target.url)].slice(0, MAX_RECENT_BROWSER_ADDRESSES)
}

/**
 * Filter a tab's recent addresses for the current address-bar query.
 * @param recent - one tab's in-memory entries, newest first.
 * @param query - the current address-bar text, or an empty string to show all entries.
 * @returns at most the newest ten matching targets.
 */
export function filterBrowserAddresses(recent: readonly BrowserTarget[], query: string): readonly BrowserTarget[] {
  const needle = query.trim().toLowerCase()
  return recent.filter(entry => entry.url.toLowerCase().includes(needle)).slice(0, MAX_RECENT_BROWSER_ADDRESSES)
}
