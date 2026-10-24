/** Stable, non-secret failure identifiers carried by Electron's error-message serialization. */
import type { DesktopWebsiteProfileFailureReason } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

/** Known profile failure whose identifier survives Electron IPC serialization. */
export class WebsiteProfileError extends Error {
  /**
   * @param reason - Public failure category.
   * @param diagnostic - Static Main-process diagnostic; never displayed by the renderer.
   * @param options - Optional private cause retained for diagnostics.
   */
  constructor(reason: Exclude<DesktopWebsiteProfileFailureReason, 'unknown'>, diagnostic: string, options?: ErrorOptions) {
    super(`[website-profile/${reason}] ${diagnostic}`, options)
    this.name = 'WebsiteProfileError'
  }
}
