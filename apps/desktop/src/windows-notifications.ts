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
    /** Arguments that reopen the target application, present for unpackaged executables. */
    readonly args?: string
  }
}

/** Packaged application values used to resolve the Windows notification shortcut. */
export interface WindowsNotificationShortcutRequest {
  readonly platform: NodeJS.Platform
  readonly packaged: boolean
  readonly roamingApplicationData: string
  readonly executable: string
  /** Icon Windows shows for the taskbar group and toasts; an .ico for unpackaged runs. */
  readonly icon: string
  readonly displayName: string
  readonly applicationId: string
  /** Arguments that reopen an unpackaged executable from a toast click. */
  readonly launchArguments?: string
}

/**
 * Resolve the Windows shortcut that registers the notification application id.
 * Without this shortcut Windows brands the executable's toasts with its own
 * fallback identity and routes toast clicks to a bare executable launch.
 * @param request - application identity and paths.
 * @returns the shortcut plan, or undefined outside Windows builds.
 */
export function windowsNotificationShortcut(
  request: WindowsNotificationShortcutRequest,
): WindowsNotificationShortcut | undefined {
  if (request.platform !== 'win32') return undefined
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
      icon: request.icon,
      iconIndex: 0,
      description: request.displayName,
      appUserModelId: request.applicationId,
      ...(request.launchArguments === undefined ? {} : { args: request.launchArguments }),
    },
  }
}
