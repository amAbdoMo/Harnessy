/** Frame-wide announcement of every settled saved-profile action. */
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { WebsiteProfileNotice, WebsiteProfilesState } from '../browser/profiles.ts'

/** Full-opacity hold for a failed account or request action. */
const FAILURE_HOLD_MS = 6000

/** Notice overlay inject face: the shared state source plus its dismissal. */
export interface BrowserProfileNoticeInjected {
  hooks: { readonly websiteProfiles: HostObservable<WebsiteProfilesState> }
  /** Take the current notice down. */
  dismissWebsiteProfileNotice(): void
}

/** Props of the Browser saved-profile notice entry in `shell.overlay`. */
export type BrowserProfileNoticeProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<'sidebarBrowser'>
  & InjectFace<BrowserProfileNoticeInjected>

/** Sentence for one settled action. */
function noticeText(notice: WebsiteProfileNotice, t: BrowserProfileNoticeProps['t']): string {
  switch (notice.kind) {
    case 'created': return t('profiles.notice.created', { name: notice.name })
    case 'resumed': return t('profiles.notice.resumed', { name: notice.name })
    case 'human': return t('profiles.notice.human', { name: notice.name })
    case 'signedOut': return t('profiles.notice.signedOut', { name: notice.name })
    case 'forgotten': return t('profiles.notice.forgotten', { name: notice.name })
    case 'failed': return t('profiles.notice.failed')
    case 'requestFailed': return t('requests.notice.failed')
    /* v8 ignore next 2 -- closed-union backstop; only reached if a notice kind is forged */
    default: return assertNever(notice)
  }
}

/**
 * Announce the latest settled saved-profile action.
 *
 * This frame-wide entry outlives every tab body, so a notice survives the tab or
 * panel that asked for the action; the notice itself lives in the shared model,
 * and every occurrence reads the same one.
 * @param props - the notice hook, its dismissal, and the locale seat.
 * @returns the banner, or null while no notice is pending.
 */
export function BrowserProfileNotice({ useWebsiteProfiles, dismissWebsiteProfileNotice, t }: BrowserProfileNoticeProps): ReactNode {
  const notice = useWebsiteProfiles(current => current.notice)
  if (notice === null) return null
  // Keyed by the notice's own sequence, so a repeated result restarts the hold.
  const key = `profile-notice-${String(notice.seq)}`
  return notice.kind === 'failed' || notice.kind === 'requestFailed'
    ? <Toast key={key} text={noticeText(notice, t)} icon={<IconWarningOutlineRegular />}
      holdMs={FAILURE_HOLD_MS} onDone={dismissWebsiteProfileNotice} />
    : <Toast key={key} text={noticeText(notice, t)} tone="success" onDone={dismissWebsiteProfileNotice} />
}
