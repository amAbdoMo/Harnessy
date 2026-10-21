/** Browser-owned responsive presentation inputs; child integrations never receive saved-account pages. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopWebsiteProfileId } from '../types.ts'

/** Temporary Browser presentation; no mode selection is persisted. */
export type BrowserMode = 'desktop' | 'mobile' | 'tablet'

/** Explicit tab-opening inputs; a restored preview identity never authorizes navigation. */
export interface BrowserTabParams {
  readonly url?: string
  readonly profileId?: DesktopWebsiteProfileId
  readonly previewId?: Branded<'DevicePreviewId'>
}

/** Current Browser occurrence and explicit responsive-navigation gesture. */
export interface BrowserResponsiveOwner {
  readonly tab: SidebarRightTabInfo['tab']
  readonly fullscreen: boolean
  readonly mode: BrowserMode
  readonly navigation: { readonly url: string; readonly revision: number } | undefined
  /** Select responsive presentation after admitting a fresh native opening. */
  readonly selectMobile: () => void
}

/** Live contribution availability, bound by the Slot renderer. */
export interface BrowserResponsiveInjected {
  readonly hooks: { readonly responsiveAvailable: HostObservable<boolean> }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Optional responsive rendering retained inside an ordinary Browser occurrence. */
    'sidebar.right.pane.tab.browser.responsive': {
      kind: 'single'
      scope: 'session'
      owner: BrowserResponsiveOwner
    }
  }
}
