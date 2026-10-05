/** Windows Start-menu identity needed for reliable native toast delivery. */

import { win32 } from 'node:path'

/**
 * Separate unpackaged notifications from the installed application's Windows identity.
 * @param applicationId - installed product identifier.
 * @param packaged - whether the executable contains the installed application.
 * @returns the application id used by the process and its notification shortcut.
 */
export function windowsNotificationApplicationId(applicationId: string, packaged: boolean): string {
  return packaged ? applicationId : `${applicationId}.development`
}

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
    /** Empty for installed executables, explicitly clearing any development arguments. */
    readonly args: string
    readonly cwd: string
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
  const args = request.packaged ? '' : request.launchArguments
  if (args === undefined || (!request.packaged && args.trim() === '')) {
    throw new Error('Harnessy development notifications require application launch arguments')
  }
  const displayName = request.packaged ? request.displayName : `${request.displayName} Development`
  return {
    path: win32.join(
      request.roamingApplicationData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      `${displayName}.lnk`,
    ),
    details: {
      target: request.executable,
      icon: request.icon,
      iconIndex: 0,
      description: displayName,
      appUserModelId: windowsNotificationApplicationId(request.applicationId, request.packaged),
      args,
      cwd: win32.dirname(request.executable),
    },
  }
}
