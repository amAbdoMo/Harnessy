import { externalWebUrl } from './navigation.js'

/** Open the authenticated local service in the system browser. */
export async function openServiceInSystemBrowser(launchUrl, openExternal) {
  const url = externalWebUrl(launchUrl)
  if (url === undefined) throw new Error('The local Harnessy service is not ready.')
  await openExternal(url.href)
  return url.href
}

/** Acquire Electron's process lock and focus the existing native window on relaunch. */
export function acquireSingleInstance(app, currentWindow) {
  if (!app.requestSingleInstanceLock()) return false
  app.on('second-instance', () => {
    const window = currentWindow()
    if (window?.isMinimized()) window.restore()
    window?.show()
    window?.focus()
  })
  return true
}
