/** Product-owned toast URIs carry only an opaque Session selection, never executable actions. */

import { pathToFileURL } from 'node:url'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DesktopNotificationPayload } from './ipc.ts'

/** OS activation scheme owned by the installed Harnessy application, not shared dsh launchers. */
export const NOTIFICATION_ACTIVATION_SCHEME = 'harnessy'

/** A generic app activation or a Session selection in the current product workspace. */
export interface DesktopNotificationAction {
  readonly sessionId?: SessionId
}

/**
 * Encode only the product's generic-open or opaque-Session activation.
 * @param action - trusted app activation metadata.
 * @returns the URI used by the Windows protocol toast.
 */
export function notificationActivationUri(action: DesktopNotificationAction): string {
  return action.sessionId === undefined
    ? `${NOTIFICATION_ACTIVATION_SCHEME}://open`
    : `${NOTIFICATION_ACTIVATION_SCHEME}://session/${encodeURIComponent(action.sessionId)}`
}

/**
 * Accept only exact, canonical product toast URIs at the OS input boundary.
 * @param uri - untrusted OS URI; malformed or unrelated inputs are ignored.
 * @returns a branded Session selection or generic activation, otherwise undefined.
 */
export function parseNotificationActivationUri(uri: string): DesktopNotificationAction | undefined {
  if (uri === `${NOTIFICATION_ACTIVATION_SCHEME}://open`) return {}
  const match = /^harnessy:\/\/session\/([^/?#]+)$/u.exec(uri)
  const encodedId = match?.[1]
  if (encodedId === undefined || encodedId.length > 2_400) return undefined
  let sessionId: string
  try { sessionId = decodeURIComponent(encodedId) }
  catch (error) {
    if (error instanceof URIError) return undefined
    throw error
  }
  if (sessionId.length === 0 || sessionId.length > 200 || /\s|[\x00-\x1f\x7f-\x9f]/u.test(sessionId)) return undefined
  if (encodeURIComponent(sessionId) !== encodedId) return undefined
  return { sessionId: SessionId(sessionId) }
}

/**
 * Read the latest recognized toast URI without interpreting flags or other argv values.
 * @param argv - untrusted startup or second-instance arguments.
 * @returns the last valid product activation, otherwise undefined.
 */
export function parseNotificationActivationArguments(argv: readonly string[]): DesktopNotificationAction | undefined {
  let latest: DesktopNotificationAction | undefined
  for (const argument of argv) {
    const action = parseNotificationActivationUri(argument)
    if (action !== undefined) latest = action
  }
  return latest
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function toastText(text: string, limit: number): string {
  // XML 1.0 excludes controls, unpaired surrogates, and these two noncharacters.
  const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]/gu, '\ufffd')
  const bounded = clean.slice(0, limit)
  return escapeXml(/[\ud800-\udbff]$/u.test(bounded) ? bounded.slice(0, -1) : bounded)
}

/**
 * Build a bounded ToastGeneric with a disk product logo and protocol-only activation.
 * @param payload - trusted notification copy and optional branded Session metadata.
 * @param iconPath - bundled disk icon.png, outside the ASAR archive.
 * @returns Windows toast XML; the Session address occurs only in launch metadata.
 */
export function windowsNotificationToastXml(payload: DesktopNotificationPayload, iconPath: string): string {
  const launch = escapeXml(notificationActivationUri(payload))
  const image = escapeXml(pathToFileURL(iconPath).href)
  return `<toast launch="${launch}" activationType="protocol"><visual><binding template="ToastGeneric">`
    + `<text>${toastText(payload.title, 120)}</text><text>${toastText(payload.body, 500)}</text>`
    + `<image placement="appLogoOverride" src="${image}"/></binding></visual></toast>`
}

/** Main-window activation operations; selection returns false until safe delivery is possible. */
export interface DesktopNotificationActivationTarget {
  focus(): void
  selectSession(sessionId: SessionId): boolean
}

/** Latest pending selection survives startup, welcome, and renderer loading without document navigation. */
export class DesktopNotificationActivation {
  private target: DesktopNotificationActivationTarget | undefined
  private pendingFocus = false
  private pendingSession: SessionId | undefined

  /**
   * Queue an activation; newer Session selections replace pending ones, generic opens retain them.
   * @param action - validated OS URI or trusted native-click metadata.
   */
  activate(action: DesktopNotificationAction): void {
    this.pendingFocus = true
    if (action.sessionId !== undefined) this.pendingSession = action.sessionId
    this.flush()
  }

  /**
   * Attach the main lifecycle after its focus and trusted-renderer operations exist.
   * @param target - operations owned by the main product window.
   */
  connect(target: DesktopNotificationActivationTarget): void {
    this.target = target
    this.flush()
  }

  /** Retry pending delivery when workspace entry or main-document loading completes. */
  flush(): void {
    const target = this.target
    if (target === undefined) return
    if (this.pendingFocus) {
      this.pendingFocus = false
      target.focus()
    }
    const sessionId = this.pendingSession
    if (sessionId !== undefined && target.selectSession(sessionId)) this.pendingSession = undefined
  }
}
