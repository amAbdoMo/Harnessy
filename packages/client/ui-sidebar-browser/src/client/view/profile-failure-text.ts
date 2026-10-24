/** Locale-owned corrections for safe saved-profile failure categories. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopWebsiteProfileFailureReason } from '../../types.ts'

/**
 * Translate a known category without displaying its originating error message.
 * @param reason - Safe failure identifier.
 * @param t - Browser locale seat.
 * @returns Actionable correction or retry guidance.
 */
export function websiteProfileFailureText(reason: DesktopWebsiteProfileFailureReason, t: PropsLocale<'sidebarBrowser'>['t']): string {
  return t(`profiles.failure.${reason}`)
}
