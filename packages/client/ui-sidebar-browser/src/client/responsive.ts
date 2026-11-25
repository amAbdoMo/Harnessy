/** Browser-owned responsive presentation inputs; child integrations never receive saved-account pages. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { DesktopWebsiteProfileId } from '../types.ts'
import { parseBrowserAddress } from './browser/url.ts'

const openings = new Map<string, { readonly url: string; tabId?: SidebarRightTabInfo['tab']['id'] }>()

/** Temporary Browser presentation; no mode selection is persisted. */
export type BrowserMode = 'desktop' | 'mobile' | 'tablet'

/** Explicit tab-opening inputs; a restored preview identity never authorizes navigation. */
export interface BrowserTabParams {
  readonly openRequestId?: string
  readonly url?: string
  readonly profileId?: DesktopWebsiteProfileId
  readonly previewId?: Branded<'DevicePreviewId'>
  /** A fresh, user-requested responsive tab. Saved identities never start navigation. */
  readonly responsiveOpenId?: string
}

/**
 * Admit a validated address for a single transient responsive opening.
 * @param url - committed ordinary page address.
 * @param applicationOrigin - origin that preview navigation must exclude.
 * @returns validated tab parameters with a transient opening, or undefined for a rejected address.
 */
export function openResponsiveTabParams(url: string, applicationOrigin: string): BrowserTabParams | undefined {
  const parsed = parseBrowserAddress(url, applicationOrigin)
  if (!parsed.ok) return undefined
  const responsiveOpenId = randomUUID()
  if (openings.size >= 64) {
    const oldest = openings.keys().next().value
    if (oldest !== undefined) openings.delete(oldest)
  }
  openings.set(responsiveOpenId, { url: parsed.target.url })
  return { url: parsed.target.url, responsiveOpenId }
}

/**
 * Bind an unconsumed opening to its responsive tab.
 * @param tab - current responsive tab.
 * @returns a fresh navigation for this occurrence, when present.
 */
export function claimResponsiveOpening(tab: SidebarRightTabInfo['tab']): BrowserResponsiveOwner['navigation'] {
  const params = tab.navigation.params as BrowserTabParams | undefined
  if (params?.responsiveOpenId === undefined || params.profileId !== undefined || params.previewId !== undefined
    || params.url === undefined || tab.signal.aborted) return undefined
  const opening = openings.get(params.responsiveOpenId)
  if (opening === undefined || opening.url !== params.url
    || (opening.tabId !== undefined && opening.tabId !== tab.id)) return undefined
  const openingId = params.responsiveOpenId
  if (opening.tabId === undefined) {
    opening.tabId = tab.id
    tab.signal.addEventListener('abort', () => { openings.delete(openingId) }, { once: true })
  }
  return { url: opening.url, revision: 1 }
}

/**
 * Retire the opening so remounts keep the retained device pages.
 * @param tab - responsive tab whose device page received its initial URL.
 */
export function completeResponsiveOpening(tab: SidebarRightTabInfo['tab']): void {
  const params = tab.navigation.params as BrowserTabParams | undefined
  if (params?.responsiveOpenId === undefined) return
  const opening = openings.get(params.responsiveOpenId)
  if (opening?.tabId === tab.id) openings.delete(params.responsiveOpenId)
}

/** Current Browser occurrence and explicit responsive-navigation gesture. */
export interface BrowserResponsiveOwner {
  readonly tab: SidebarRightTabInfo['tab']
  readonly fullscreen: boolean
  readonly mode: BrowserMode
  readonly navigation: { readonly url: string; readonly revision: number } | undefined
  /** Mark a transient user opening as dispatched so a remount does not reload it. */
  readonly completeOpening?: () => void
  /** Select responsive presentation after admitting a fresh native opening. */
  readonly selectMobile: () => void
}

/** Live contribution availability, bound by the Slot renderer. */
export interface BrowserResponsiveInjected {
  readonly hooks: { readonly responsiveAvailable: HostObservable<boolean> }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Responsive rendering within an explicitly opened Browser occurrence. */
    'sidebar.right.pane.tab.browser.responsive': {
      kind: 'single'
      scope: 'session'
      owner: BrowserResponsiveOwner
    }
  }
}
