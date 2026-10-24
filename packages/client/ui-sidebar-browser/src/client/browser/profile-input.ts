/** Field validation and address normalization for the human's saved-profile form. */
import type { DesktopWebsiteProfileInput } from '../../types.ts'
import { parseBrowserAddress } from './url.ts'

/** A field correction that contains no submitted account values. */
export interface WebsiteProfileInputIssue {
  readonly field: 'name' | 'accountLabel' | 'url' | 'mcpServerName'
  readonly reason: 'invalid-name' | 'invalid-account-label' | 'invalid-url' | 'unsafe-url' | 'invalid-mcp-name'
}

/**
 * Normalize browser-style addresses before passing a pairing to Main.
 * Main independently validates every IPC input.
 * @param input - Current user-entered form fields.
 * @returns Canonical input, or the first field requiring correction.
 */
export function resolveWebsiteProfileInput(input: DesktopWebsiteProfileInput):
  { readonly ok: true; readonly value: DesktopWebsiteProfileInput } | { readonly ok: false; readonly issue: WebsiteProfileInputIssue } {
  const name = input.name.trim()
  const accountLabel = input.accountLabel.trim()
  const mcpServerName = input.mcpServerName.trim()
  if (name === '' || name.length > 120 || /[\x00-\x1f\x7f]/u.test(input.name)) {
    return { ok: false, issue: { field: 'name', reason: 'invalid-name' } }
  }
  if (accountLabel.length > 120 || /[\x00-\x1f\x7f]/u.test(input.accountLabel)) {
    return { ok: false, issue: { field: 'accountLabel', reason: 'invalid-account-label' } }
  }
  const parsed = parseBrowserAddress(input.url)
  if (!parsed.ok || parsed.target.url.length > 2048) {
    return { ok: false, issue: { field: 'url', reason: !parsed.ok && parsed.reason === 'credentials' ? 'unsafe-url' : 'invalid-url' } }
  }
  const address = new URL(parsed.target.url)
  if (address.search !== '' || address.hash !== '') return { ok: false, issue: { field: 'url', reason: 'unsafe-url' } }
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(mcpServerName)) {
    return { ok: false, issue: { field: 'mcpServerName', reason: 'invalid-mcp-name' } }
  }
  return { ok: true, value: { ...input, name, accountLabel, url: address.href, mcpServerName } }
}
