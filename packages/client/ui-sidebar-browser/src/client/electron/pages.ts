/** Assemble Electron navigation and presentation behind the shared BrowserPage interface. */
import type { DesktopBrowserBridge } from '../../types.ts'
import type { BrowserPage, BrowserPageOptions } from '../browser/BrowserPage.ts'
import type { WebsiteRequestSession } from '../browser/WebsiteRequestSession.ts'
import { ElectronWebViewImpl } from './ElectronWebViewImpl.ts'
import { ElectronWebviewPresentation } from './ElectronWebviewPresentation.ts'
import { BROWSER_VIEWPORTS, type BrowserDefaults } from '../browser/defaults.ts'

/**
 * Assemble an idle Electron provider; guest creation waits for mounting and navigation.
 * @param options - checkpoint and source-tab callbacks.
 * @param bridge - desktop-only transport.
 * @param workspace - storage account resolver.
 * @param requests - captured Session's request roster, absent for non-profile consumers.
 * @param defaults - preferences captured when an ordinary tab is created.
 * @returns separate navigation, presentation and request faces.
 */
export function createElectronPage(options: BrowserPageOptions, bridge: DesktopBrowserBridge,
  workspace: (signal: AbortSignal) => Promise<string>, requests?: WebsiteRequestSession, defaults?: BrowserDefaults): BrowserPage {
  const presentation = new ElectronWebviewPresentation({
    mounted: () => { frame.attach() },
    unmounted: () => { frame.detach() },
  }, defaults === undefined ? undefined : BROWSER_VIEWPORTS[defaults.viewport])
  const pageRequests = options.profileId === undefined || options.sessionId !== undefined
    ? undefined : requests?.createPage(options.profileId)
  const native = defaults === undefined ? undefined : { appearance: defaults.appearance, zoomFactor: defaults.zoomFactor }
  const frame = new ElectronWebViewImpl(options, bridge, workspace, presentation, pageRequests, native)
  return { frame, presentation, ...(pageRequests === undefined ? {} : { requests: pageRequests }) }
}
