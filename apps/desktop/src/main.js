import { app, BrowserWindow, dialog, Menu, nativeTheme, session, shell } from 'electron'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDesktopConfig } from './config.js'
import { createDesktopLog } from './desktop-log.js'
import { acquireSingleInstance, openServiceInSystemBrowser } from './desktop-actions.js'
import { externalWebUrl, isAllowedNavigation } from './navigation.js'
import { startDshService } from './service.js'
import { createWindowOptions } from './window-options.js'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
let config
let mainWindow
let service
let quitting = false
let recoveryPending = false
let desktopLog

try {
  config = resolveDesktopConfig()
  app.setName(config.productName)
  app.setPath('userData', config.userData)
  app.setAppUserModelId(config.appId)
  desktopLog = createDesktopLog(config.logDirectory)
} catch (error) {
  dialog.showErrorBox('Harnessy could not start', error instanceof Error ? error.message : String(error))
  app.exit(1)
}

const primaryInstance = acquireSingleInstance(app, () => mainWindow)
if (!primaryInstance) app.exit(0)

function showMainWindow() {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  mainWindow.show()
  mainWindow.focus()
}

async function openServiceInBrowser() {
  try {
    await openServiceInSystemBrowser(service?.launchUrl, targetUrl => shell.openExternal(targetUrl))
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Could not open the browser',
      message: 'Harnessy is still running. You can retry from the File menu.',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

function installApplicationMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Open in Browser', accelerator: 'CommandOrControl+Shift+B', click: openServiceInBrowser },
        { type: 'separator' },
        { role: 'quit', label: 'Exit Harnessy' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ])
  Menu.setApplicationMenu(menu)
}

async function stopService() {
  const current = service
  service = undefined
  await current?.stop()
}

async function recoverFromFailure(message) {
  if (quitting || recoveryPending) return
  recoveryPending = true
  await stopService()
  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    recoveryPending = false
    if (!quitting) app.quit()
    return
  }
  await mainWindow.loadFile(`${sourceDirectory}/startup.html`)
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: 'Harnessy needs attention',
    message,
    buttons: ['Retry', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  recoveryPending = false
  if (response === 0) await startService()
  else app.quit()
}

async function startService() {
  try {
    await mainWindow.loadFile(`${sourceDirectory}/startup.html`)
    service = await startDshService(config, {
      onFailure: recoverFromFailure,
      onOutput: output => desktopLog.write(output),
    })
    await mainWindow.loadURL(service.launchUrl)
    showMainWindow()
  } catch (error) {
    await recoverFromFailure(error instanceof Error ? error.message : String(error))
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow(createWindowOptions({
    icon: config.icon,
    productName: config.productName,
    useDarkColors: nativeTheme.shouldUseDarkColors,
  }))
  mainWindow.once('ready-to-show', showMainWindow)
  mainWindow.on('closed', () => { mainWindow = undefined })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalWebUrl(url)
    if (external !== undefined) void shell.openExternal(external.href)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url, service?.origin)) return
    event.preventDefault()
    const external = externalWebUrl(url)
    if (external !== undefined) void shell.openExternal(external.href)
  })
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault())
}

if (primaryInstance) app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  createMainWindow()
  installApplicationMenu()
  await startService()
}).catch(error => {
  dialog.showErrorBox('Harnessy could not start', error instanceof Error ? error.message : String(error))
  app.exit(1)
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  showMainWindow()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void stopService().then(() => desktopLog?.flush()).finally(() => app.quit())
})
