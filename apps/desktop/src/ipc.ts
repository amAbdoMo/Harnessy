/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopKeyboardApi, DesktopShortcutsApi } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DesktopBrowserBridge } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopDevicePreviewBridge } from '@deepseek-ai/dsh-client-ui-device-preview/types'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  shortcutsInput: 'dsh-desktop:shortcuts-input',
  shortcutsCloseWindow: 'dsh-desktop:shortcuts-close-window',
  shortcutsGet: 'dsh-desktop:shortcuts-get',
  shortcutsEdit: 'dsh-desktop:shortcuts-edit',
  shortcutsChanged: 'dsh-desktop:shortcuts-changed',
  shortcutsRecording: 'dsh-desktop:shortcuts-recording',
  boot: 'dsh-desktop:boot',
  enterWorkspace: 'dsh-desktop:enter-workspace',
  onboardingActive: 'dsh-desktop:onboarding-active',
  onboardingApiKey: 'dsh-desktop:onboarding-api-key',
  bootFailed: 'dsh-desktop:boot-failed',
  browserAcquire: 'dsh-desktop:browser-acquire',
  browserRelease: 'dsh-desktop:browser-release',
  browserCommand: 'dsh-desktop:browser-command',
  browserOpenRequested: 'dsh-desktop:browser-open-requested',
  browserReacquireRequested: 'dsh-desktop:browser-reacquire-requested',
  devicePreviewOpen: 'dsh-desktop:device-preview-open',
  devicePreviewAcknowledge: 'dsh-desktop:device-preview-acknowledge',
  devicePreviewBind: 'dsh-desktop:device-preview-bind',
  devicePreviewUnbind: 'dsh-desktop:device-preview-unbind',
  devicePreviewClose: 'dsh-desktop:device-preview-close',
  devicePreviewStop: 'dsh-desktop:device-preview-stop',
  websiteProfilesList: 'dsh-desktop:website-profiles-list',
  websiteProfilesCreate: 'dsh-desktop:website-profiles-create',
  websiteProfilesAcquire: 'dsh-desktop:website-profiles-acquire',
  websiteProfilesControl: 'dsh-desktop:website-profiles-control',
  websiteProfilesSignOut: 'dsh-desktop:website-profiles-sign-out',
  websiteProfilesForget: 'dsh-desktop:website-profiles-forget',
  websiteProfilesChanged: 'dsh-desktop:website-profiles-changed',
  websiteRequestsList: 'dsh-desktop:website-requests-list',
  websiteRequestsPrepare: 'dsh-desktop:website-requests-prepare',
  websiteRequestsVisible: 'dsh-desktop:website-requests-visible',
  websiteRequestsAcknowledge: 'dsh-desktop:website-requests-acknowledge',
  websiteRequestsResume: 'dsh-desktop:website-requests-resume',
  websiteRequestsTakeover: 'dsh-desktop:website-requests-takeover',
  websiteRequestsChanged: 'dsh-desktop:website-requests-changed',
  directoryPick: 'dsh-desktop:directory-pick',
  deviceInfo: 'dsh-desktop:device-info',
  taskbarDocument: 'dsh-desktop:taskbar-document',
  taskbarSetUnread: 'dsh-desktop:taskbar-set-unread',
  localeBootstrap: 'dsh-desktop:locale-bootstrap',
  localeChanged: 'dsh-desktop:locale-changed',
  updatesStatus: 'dsh-desktop:updates-status',
  updatesCheck: 'dsh-desktop:updates-check',
  updatesOpen: 'dsh-desktop:updates-open',
  updatesCancelRestart: 'dsh-desktop:updates-cancel-restart',
  updatesPresentation: 'dsh-desktop:updates-presentation',
  nativeThemeSet: 'dsh-desktop:native-theme-set',
  windowFullscreen: 'dsh-desktop:window-fullscreen',
  windowsAppearance: 'dsh-desktop:windows-appearance',
  windowsMenu: 'dsh-desktop:windows-menu',
  notificationsShow: 'dsh-desktop:notifications-show',
  notificationActivated: 'dsh-desktop:notification-activated',
} as const

/** Native menu groups opened from the integrated Windows title bar. */
export type DesktopMenuSection = 'file' | 'edit' | 'view' | 'help'

/** Narrow bridge exposed to the main application renderer. */
export interface DshDesktopAppApi {
  readonly protocolVersion: 1
  readonly titlebar: {
    openMenu(section: DesktopMenuSection): Promise<void>
  }
  readonly notifications: {
    show(payload: DesktopNotificationPayload): Promise<boolean>
    /** Subscribe to Session selection requested by a native notification click. */
    subscribe(listener: (sessionId: SessionId) => void): () => void
  }
}

/** Secret-free copy accepted by the native operating-system notification surface. */
export interface DesktopNotificationPayload {
  readonly title: string
  readonly body: string
  /** Opaque Session address delivered to the product renderer, never rendered in the operating-system toast. */
  readonly sessionId?: SessionId
}

/**
 * Validate notification copy crossing the renderer-to-main process boundary.
 * @param value - untrusted IPC argument.
 * @returns bounded native notification copy.
 */
export function parseDesktopNotificationPayload(value: unknown): DesktopNotificationPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('dsh desktop: notification payload must be an object')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.title !== 'string' || typeof candidate.body !== 'string') {
    throw new Error('dsh desktop: notification title and body must be strings')
  }
  const title = candidate.title.trim()
  const body = candidate.body.trim()
  if (title.length === 0 || title.length > 120 || body.length === 0 || body.length > 500) {
    throw new Error('dsh desktop: notification title or body has an invalid length')
  }
  const sessionId = candidate.sessionId
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200
    || /\s|[\x00-\x1f\x7f-\x9f]/u.test(sessionId))) {
    throw new Error('dsh desktop: notification session id is invalid')
  }
  return { title, body, ...sessionId === undefined ? {} : { sessionId: SessionId(sessionId) } }
}

/** Desktop release update state rendered by desktop-owned UI. */
export type DesktopUpdatePreparationFailureKind = 'stop-failed' | 'tasks-changed' | 'tasks-unavailable'

export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'ready' | 'waiting' | 'installing' | 'error'
  readonly version?: string
  readonly message?: string
  /** Main-owned diagnostics without subprocess output or credentials; hidden until expanded. */
  readonly technicalDetails?: string
  readonly percent?: number
  readonly transferredBytes?: number
  readonly totalBytes?: number
  readonly failedOperation?: 'check' | 'download' | 'verify' | 'install'
  /** Main-owned preparation cause; UI wording is selected by the active locale. */
  readonly preparationFailure?: DesktopUpdatePreparationFailureKind
}

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

/** Semantic status content; actions open main-process confirmation dialogs only. */
export interface DesktopUpdatePresentation {
  readonly phase: DesktopUpdateState['phase']
  readonly version?: string
  readonly percent?: number
  readonly transferredBytes?: number
  readonly totalBytes?: number
  readonly failure?: DesktopUpdateFailureKind
}

/** Product documents cannot supply update versions, package URLs, or installation authorization. */
export interface DshDesktopProductApi {
  readonly protocolVersion: 1
  /** Windows-only taskbar app-icon overlay; no counts or app-navigation badges. */
  readonly taskbar?: {
    /**
     * Publish current ordinary-Session unread state; false clears the overlay.
     * Dispatch waits for the private document ticket and renderer load; stale document calls reject.
     * Main-document replacement, renderer loss and native owner teardown also clear it.
     * Native accent and overlay failures are diagnosed without rejecting accepted state; a later repaint retries unread state.
     * @param unread - whether any non-subagent Session has an unread completion.
     * @returns completion of state acceptance and best-effort native painting, not evidence of Windows presentation.
     */
    setUnread(unread: boolean): Promise<void>
  }
  readonly browser: DesktopBrowserBridge
  readonly preview: DesktopDevicePreviewBridge
  readonly keyboard: DesktopKeyboardApi
  readonly shortcuts: DesktopShortcutsApi
  readonly notifications: {
    show(payload: DesktopNotificationPayload): Promise<boolean>
    /** Subscribe to Session selection requested by a native notification click. */
    subscribe(listener: (sessionId: SessionId) => void): () => void
  }
  /**
   * Local machine description for the feedback questionnaire.
   * @returns `name=value` fields separated by `; `, with no hostname, user name, or serial number.
   */
  deviceInfo(): Promise<string>
  readonly updates: {
    status(): Promise<DesktopUpdatePresentation>
    check(): Promise<void>
    open(): Promise<void>
    cancelRestart(): Promise<void>
    subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
  }
}

/** Scheme of Desktop-owned application documents. */
export const SCHEME = 'dsh-app'

/**
 * Reject IPC outside the allowed Desktop document origins.
 * @param event - IPC caller whose frame URL supplies the origin.
 * @param hostnames - Desktop document hosts allowed for this operation.
 */
export function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('dsh desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('dsh desktop: rejected IPC from an unowned renderer')
  }
}
