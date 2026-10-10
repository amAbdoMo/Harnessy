/** Type-only Desktop page creation service shared by Browser and Device Preview presentation. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BrowserViewport, DesktopBrowserLeaseId } from '../../types.ts'
import type { BrowserPage, BrowserPageOptions } from './BrowserPage.ts'

/** One retained page and an optional ordinary-guest association consumer. */
export interface NativeBrowserPageRequest {
  readonly sessionId: SessionId
  readonly options: BrowserPageOptions
  /** Notifications follow successful native commands; undefined revokes the old guest before its release. */
  readonly leaseChanged?: (lease: DesktopBrowserLeaseId | undefined, viewport?: BrowserViewport) => void
}
/** Desktop-only provider; consumers own returned page disposal, not native transport objects. */
export interface NativeBrowser {
  /** @param request - captured Session, page options and exact guest notifications. @returns an idle page awaiting explicit navigation. */
  createPage(request: NativeBrowserPageRequest): BrowserPage
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Desktop Browser owns page construction; presentation consumers own individual pages. */
    nativeBrowser: NativeBrowser
  }
}
