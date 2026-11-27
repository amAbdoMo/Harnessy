/** Carrier-neutral page navigation and observable state. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserTarget } from './url.ts'
import type { BrowserViewport, BrowserAnnotationCapture, BrowserPickedElement, BrowserTabStatus } from '../../types.ts'
import type { BrowserRecordingDocumentId, BrowserRecordingFrame, BrowserRecordingIndicators } from '../../types.ts'

/** A loading failure, optionally carrying the underlying browser's diagnostic. */
export interface BrowserLoadError {
  readonly code: number | undefined
  readonly description: string | undefined
}

/** Match count and active match for the current native page search. */
export interface BrowserFindResult {
  readonly active: number
  readonly matches: number
}

/** State consumed by common browser chrome, without DOM or carrier identifiers. */
export interface BrowserFrameState {
  readonly humanControl?: boolean
  /** Native page zoom. Absent on carriers and pages that do not offer zoom. */
  readonly zoomFactor?: number | undefined
  /** Whether the native carrier allows an ordinary page to open local developer tools. */
  readonly devToolsAvailable?: boolean | undefined
  readonly findResult?: BrowserFindResult | 'failed' | undefined
  readonly recordingSupported?: boolean
  readonly remoteShareSupported?: boolean
  readonly phoneShareSupported?: boolean
  readonly target: BrowserTarget | undefined
  readonly address: 'empty' | 'requested' | 'observed' | 'unknown'
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly error: BrowserLoadError | undefined
  /** Undefined when this provider does not expose a sandbox control. */
  readonly sandboxEnabled: boolean | undefined
}

/** Optional view link and operations for one active share. */
export interface BrowserRemoteShareControl {
  readonly url?: string
  readonly expiresAt: number
  /** @param listener - called when the viewer stops this share. @returns Unsubscribe callback. */
  onEnded?(listener: () => void): () => void
  /** @returns Acknowledgment that this receipt can no longer be used. */
  stop(): Promise<void>
}

/** Optional iframe policy control, not an Electron process-sandbox switch. */
export interface BrowserSandboxControl {
  /** @param enabled - whether the provider's embedding sandbox is enforced. */
  setEnabled(enabled: boolean): void
}

/** Navigation owns page lifetime; mounting and hiding belong to BrowserPresentation. */
export interface BrowserFrame extends HostObservable<BrowserFrameState> {
  /** @param query - text to find, or empty to clear. @param forward - match direction, absent for a new search. */
  readonly findInPage?: (query: string, forward?: boolean) => void
  /** @param factor - native Chromium zoom from 0.5 to 3. @returns after acknowledgement. */
  readonly setZoom?: (factor: number) => Promise<void>
  /** @returns after native inspector dispatch. */
  readonly openDevTools?: () => Promise<void>
  /** Cancel the currently loading native navigation. */
  readonly stopLoading?: () => void
  /** Reload a committed page while bypassing Chromium's HTTP cache. */
  readonly hardReload?: () => void
  readonly capture?: () => Promise<BrowserAnnotationCapture>
  readonly captureRecordingFrame?: (url: string, documentId?: BrowserRecordingDocumentId,
    indicators?: BrowserRecordingIndicators) => Promise<BrowserRecordingFrame>
  /** @param audience - native Android app or private Web viewer. @returns The share, or null when pairing or setup is needed. */
  readonly beginRemoteShare?: (audience: 'phone' | 'web') => Promise<BrowserRemoteShareControl | null>
  readonly pick?: (point: { readonly x: number; readonly y: number }) => Promise<BrowserPickedElement | null>
  readonly control?: (human: boolean) => Promise<void>
  readonly status?: () => Promise<BrowserTabStatus>
  readonly sandbox?: BrowserSandboxControl
  /**
   * Optional native fixed-layout preview, absent for saved-account pages and unsupported carriers.
   * @param viewport - integer CSS dimensions (1–8192) and finite positive visual fit at most one.
   * May be called before mounting; retained settings apply to replacement guests. Failures publish error state.
   * The presentation owner supplies a surface of width * scale by height * scale, without a CSS transform.
   */
  readonly setViewport?: (viewport: BrowserViewport) => void
  /** @param target - validated HTTP(S) address; loading failures are published in state. */
  loadUrl(target: BrowserTarget): void
  /** Move backward when the provider reports an available entry. */
  goBack(): void
  /** Move forward when the provider reports an available entry. */
  goForward(): void
  /** Reload the current address without creating a new history entry. */
  reload(): void
  /** @returns after the page, listeners and pending initialization have been released; repeated calls join disposal. */
  dispose(): Promise<void>
}

/**
 * Create idle navigation state without a page target.
 * @returns state before any page has been requested.
 */
export function emptyBrowserFrame(): BrowserFrameState {
  return { target: undefined, address: 'empty', loading: false, canGoBack: false, canGoForward: false,
    error: undefined, sandboxEnabled: undefined }
}
