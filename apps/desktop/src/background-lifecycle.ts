/** Windows tray lifecycle state for keeping the Desktop Host alive without a visible window. */

/** Mutable state shared by window-close, application-quit, and tray setup handlers. */
export class DesktopBackgroundLifecycle {
  private trayReady = false
  private quitRequested = false

  /**
   * @param platform - host platform that decides whether tray-backed background mode is supported.
   */
  constructor(private readonly platform: NodeJS.Platform) {}

  /** Record that the Windows tray icon provides a reliable reopen path. */
  markTrayReady(): void {
    if (this.platform === 'win32') this.trayReady = true
  }

  /** Record an explicit application shutdown before Electron starts closing windows. */
  requestQuit(): void {
    this.quitRequested = true
  }

  /**
   * Decide whether closing the primary window hides it instead of destroying it.
   * @returns true only while a Windows tray icon can reopen the application and no quit is pending.
   */
  shouldHidePrimaryWindow(): boolean {
    return this.trayReady && !this.quitRequested
  }

  /**
   * Decide whether Electron stays alive with no visible windows.
   * @returns true under the same tray-backed state used by the primary close handler.
   */
  shouldKeepRunningWithoutWindows(): boolean {
    return this.shouldHidePrimaryWindow()
  }
}

/**
 * Resolve the tray image from source assets or packaged resources.
 * @param packaged - whether Electron runs from an installed application.
 * @param applicationPath - root returned by `app.getAppPath()`.
 * @param resourcesPath - packaged resources directory.
 * @returns absolute path to Harnessy's tray image.
 */
export function desktopTrayImagePath(
  packaged: boolean,
  applicationPath: string,
  resourcesPath: string,
): string {
  return packaged
    ? `${resourcesPath}\\harnessy.png`
    : `${applicationPath}\\assets\\harnessy.png`
}
