/** Installation-local preferences for ordinary Desktop Browser tabs. */
import type { DesktopBrowserDefaults, DesktopWebsiteProfileId } from '../../types.ts'

/** Page zoom choices shared by Settings and Page actions. */
export const ZOOM_PRESETS = [50, 75, 90, 100, 110, 125, 150, 200, 300] as const

/** Page color scheme choices supported by the native browser. */
export const BROWSER_APPEARANCES = ['system', 'light', 'dark'] as const

/** Native page dimensions in desktop pixels at 100% page zoom. */
export const BROWSER_VIEWPORTS = {
  fill: undefined,
  phone: { width: 390, height: 844 },
  phoneLandscape: { width: 844, height: 390 },
  tablet: { width: 768, height: 1024 },
  tabletLandscape: { width: 1024, height: 768 },
} as const

/** Browser defaults saved by Settings and captured when a tab is created. */
export interface BrowserDefaults extends DesktopBrowserDefaults {
  readonly viewport: keyof typeof BROWSER_VIEWPORTS
  readonly profileId: DesktopWebsiteProfileId | undefined
}

const STORAGE_KEY = 'dsh.browser.defaults'
const INITIAL_DEFAULTS: BrowserDefaults = { zoomFactor: 1, viewport: 'fill', appearance: 'system', profileId: undefined }
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Read the current installation's browser settings.
 * @returns validated preferences, with factory defaults for unavailable or invalid values.
 */
export function readBrowserDefaults(): BrowserDefaults {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (typeof stored !== 'object' || stored === null) return INITIAL_DEFAULTS
    const zoom = 'zoomFactor' in stored ? ZOOM_PRESETS.find(percent => percent / 100 === stored.zoomFactor) : undefined
    const appearance = 'appearance' in stored ? BROWSER_APPEARANCES.find(value => value === stored.appearance) : undefined
    const viewport = 'viewport' in stored ? Object.keys(BROWSER_VIEWPORTS).find(value => value === stored.viewport) : undefined
    const profileId = 'profileId' in stored && typeof stored.profileId === 'string' && PROFILE_ID.test(stored.profileId)
      ? stored.profileId as DesktopWebsiteProfileId : undefined
    return {
      zoomFactor: zoom === undefined ? INITIAL_DEFAULTS.zoomFactor : zoom / 100,
      appearance: appearance ?? INITIAL_DEFAULTS.appearance,
      viewport: (viewport as BrowserDefaults['viewport'] | undefined) ?? INITIAL_DEFAULTS.viewport,
      profileId,
    }
  } catch (_error: unknown) { /* Unreadable preferences must not prevent opening a browser tab. */ }
  return INITIAL_DEFAULTS
}

/**
 * Replace the current installation's browser settings. Throws if local storage rejects the write.
 * @param defaults - selected browser preferences.
 */
export function saveBrowserDefaults(defaults: BrowserDefaults): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults))
}
