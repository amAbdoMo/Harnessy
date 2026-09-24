/** Windows Start-menu identity needed for reliable native toast delivery. */

import { join } from 'node:path'

/** Shortcut values written through Electron's shell API. */
export interface WindowsNotificationShortcut {
  /** Absolute Start-menu shortcut path. */
  readonly path: string
  /** Identity Windows associates with native notifications from the executable. */
  readonly details: {
    readonly target: string
    readonly icon: string
    readonly iconIndex: number
    readonly description: string
    readonly appUserModelId: string
  }
}

/** Packaged application values used to resolve the Windows notification shortcut. */
export interface WindowsNotificationShortcutRequest {
  readonly platform: NodeJS.Platform
  readonly packaged: boolean
  readonly roamingApplicationData: string
  readonly executable: string
  readonly displayName: string
  readonly applicationId: string
}

/**
 * Resolve the packaged Windows shortcut that registers the notification application id.
 * @param request - packaged application identity and paths.
 * @returns the shortcut plan, or undefined outside packaged Windows builds.
 */
export function windowsNotificationShortcut(
  request: WindowsNotificationShortcutRequest,
): WindowsNotificationShortcut | undefined {
  if (request.platform !== 'win32' || !request.packaged) return undefined
  return {
    path: join(
      request.roamingApplicationData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      `${request.displayName}.lnk`,
    ),
    details: {
      target: request.executable,
      icon: request.executable,
      iconIndex: 0,
      description: request.displayName,
      appUserModelId: request.applicationId,
    },
  }
}
