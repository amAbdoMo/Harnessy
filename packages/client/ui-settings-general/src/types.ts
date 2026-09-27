/** Type-only Electron update declarations shared by the settings UI and Desktop compatibility checks. */

/** Classified failure copy selected by the Web locale without exposing raw updater diagnostics. */
export type DesktopUpdateFailureKind =
  | 'check'
  | 'check-network'
  | 'download'
  | 'download-network'
  | 'verify'
  | 'disk'
  | 'revoked'
  | 'install'
  | 'install-network'
  | 'stop-failed'
  | 'tasks-changed'
  | 'tasks-unavailable'

/**
 * Shell-owned update lifecycle. `waiting` holds a downloaded release until the
 * running tasks finish; the shell moves it to `installing` on its own.
 */
export type DesktopUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'waiting'
  | 'installing'
  | 'error'

/** Public semantic preload fields consumed by the sidebar controls and the General row. */
export interface DesktopUpdatePresentation {
  readonly phase: DesktopUpdatePhase
  readonly version?: string
  readonly percent?: number
  readonly transferredBytes?: number
  readonly totalBytes?: number
  readonly failure?: DesktopUpdateFailureKind
}

/** Optional carrier API; it cannot select artifacts or authorize installation. */
export interface DesktopUpdateBridge {
  status(): Promise<DesktopUpdatePresentation>
  check?(): Promise<void>
  open(): Promise<void>
  cancelRestart?(): Promise<void>
  subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
}

/** Shared carrier status for the sidebar header control, the collapsed badge, and the General row. */
export interface DesktopUpdateView {
  readonly presentation?: DesktopUpdatePresentation
  /** No status arrived, or the last shell action rejected; the surfaces stay retryable. */
  readonly failed: boolean
  /** A shell-owned action is in flight; further requests join it instead of repeating it. */
  readonly busy: boolean
}
