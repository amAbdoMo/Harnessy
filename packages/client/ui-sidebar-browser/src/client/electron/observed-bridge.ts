/** Ordinary guest association follows Main acknowledgement and is revoked before native release. */
import type { BrowserViewport, DesktopBrowserBridge, DesktopBrowserLeaseId } from '../../types.ts'

/** Report acknowledged ordinary guest metrics without exposing the native transport to a consumer.
 * @param bridge - Desktop-owned operations.
 * @param changed - captured page's guest association consumer.
 * @returns a page-local bridge without exposing Electron or accepting model authority.
 */
export function observeBrowserBridge(bridge: DesktopBrowserBridge,
  changed: (lease: DesktopBrowserLeaseId | undefined, viewport?: BrowserViewport) => void): DesktopBrowserBridge {
  let current: DesktopBrowserLeaseId | undefined
  let viewport: BrowserViewport | undefined
  const publish = (lease: DesktopBrowserLeaseId | undefined): void => {
    try { changed(lease, viewport) }
    catch (error: unknown) { console.error('Browser guest association consumer failed', error) }
  }
  return {
    ...bridge,
    acquire: async (workspace, address) => {
      const reservation = await bridge.acquire(workspace, address)
      current = reservation.lease
      viewport = undefined
      return reservation
    },
    command: async (lease, command) => {
      await bridge.command(lease, command)
      if (current === lease) {
        if (command.kind === 'preview-viewport') viewport = command.viewport
        publish(lease)
      }
    },
    release: async (lease) => {
      if (current === lease) { current = undefined; viewport = undefined; publish(undefined) }
      await bridge.release(lease)
    },
  }
}
