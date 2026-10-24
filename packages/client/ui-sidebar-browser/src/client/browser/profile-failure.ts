/** Decode only public profile error identifiers; Main diagnostics never reach UI state. */
import type { DesktopWebsiteProfileFailureReason } from '../../types.ts'

/**
 * Read an allowlisted identifier from Electron's serialized error message.
 * @param error - Rejected desktop operation, possibly wrapped by Electron.
 * @returns A safe reason; unexpected errors retain no diagnostic data.
 */
export function websiteProfileFailureReason(error: unknown): DesktopWebsiteProfileFailureReason {
  if (typeof error !== 'object' || error === null || !('message' in error) || typeof error.message !== 'string') return 'unknown'
  const reason = /\[website-profile\/([a-z-]+)\]/u.exec(error.message)?.[1]
  switch (reason) {
    case 'invalid-name': case 'invalid-account-label': case 'invalid-url': case 'unsafe-url': case 'invalid-mcp-name':
    case 'mcp-unavailable': case 'host-unavailable': case 'cancelled': case 'profile-limit': case 'pairing-changed': case 'save-failed':
      return reason
    default: return 'unknown'
  }
}
