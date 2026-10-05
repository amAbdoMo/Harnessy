/** Composition of one navigation provider and its presentation. */
import type { DesktopWebsiteProfileId } from '../../types.ts'
import type { BrowserPresentation } from '../view/BrowserPresentation.ts'
import type { BrowserFrame } from './BrowserFrame.ts'
import type { BrowserTabState } from './BrowserPersistence.ts'
import type { WebsiteRequestPage } from './WebsiteRequestPage.ts'

/** Provider construction inputs; persistence does not enter the live navigation interface. */
export interface BrowserPageOptions {
  readonly initial: BrowserTabState | undefined
  /**
   * Saved website/account this page belongs to, or undefined for an ephemeral
   * workspace page. A profile page loads into the account's persistent partition
   * and never reports its navigation for storage.
   */
  readonly profileId: DesktopWebsiteProfileId | undefined
  readonly persist: (state: BrowserTabState) => void
  readonly openRequested: (url: string) => void
}

/** The owning controller disposes frame; UI mounts only presentation. */
export interface BrowserPage {
  readonly frame: BrowserFrame
  readonly presentation: BrowserPresentation
  /** Request authority for this profile page, absent on ordinary browser pages. */
  readonly requests?: WebsiteRequestPage
}

/** Construct an idle provider without attaching DOM; saved navigation waits for an explicit frame command. */
export type BrowserPageFactory = (options: BrowserPageOptions) => BrowserPage
