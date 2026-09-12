/** Electron shell: desktop project ownership, custom protocol, windows, and lifecycle. */

import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import {
  CUSTOM_HARNESS_PRODUCT,
  resolveDevelopmentCustomHarnessDesktopState,
  resolvePackagedCustomHarnessDesktopState,
  type CustomHarnessDesktopState,
} from '../../../scripts/custom-harness-product.mjs'
import { resolveDesktopPaths } from './paths.ts'
import { DesktopProjectManager, type DesktopProjectHooks } from './project-manager.ts'
import { DesktopHostProcess } from './host-process.ts'
import { DESKTOP_IPC, type DesktopMenuSection, type DesktopUpdateState } from './ipc.ts'
import { formatDesktopMessage, resolveDesktopLocale } from './locale.ts'
import { claimDesktopSingleInstance } from './single-instance.ts'
import { DesktopUpdateCoordinator } from './update-coordinator.ts'

const SCHEME = 'dsh-app'
let focusPrimaryWindow = (): void => {}

function customHarnessDesktopState(): CustomHarnessDesktopState {
  const localApplicationData = process.env.LOCALAPPDATA ?? app.getPath('appData')
  const developmentData = join(localApplicationData, CUSTOM_HARNESS_PRODUCT.dataDirectoryName, 'Development')
  return app.isPackaged
    ? resolvePackagedCustomHarnessDesktopState(localApplicationData)
    : resolveDevelopmentCustomHarnessDesktopState(developmentData)
}

function configureCustomHarnessProductIdentity(state: CustomHarnessDesktopState): void {
  process.env.DSH_HOME = state.home
  process.env.DSH_AGENTS_HOME = state.agents
  process.env.CUSTOM_HARNESS_DATA_DIR = state.data
  process.env.CUSTOM_HARNESS_AGENTS_DIR = state.agents
  process.env.CUSTOM_HARNESS_LOG_DIR = state.logs
  process.env.CUSTOM_HARNESS_CACHE_DIR = state.cache
  app.setName(CUSTOM_HARNESS_PRODUCT.displayName)
  app.setAppUserModelId(CUSTOM_HARNESS_PRODUCT.windowsAppId)
  app.setPath('userData', state.userData)
}

function prepareCustomHarnessProductState(state: CustomHarnessDesktopState): void {
  for (const directory of [state.data, state.home, state.agents, state.logs, state.cache, state.userData]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  app.setAppLogsPath(state.logs)
}

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
    stream: true,
    codeCache: true,
  },
}])

const MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

interface RuntimeResources {
  readonly node: string
  readonly pnpm: string
  readonly seed: string
}

function runtimeResources(): RuntimeResources {
  const development = !app.isPackaged
  const node = (development ? process.env.DSH_DESKTOP_NODE_BINARY : undefined)
    ?? join(process.resourcesPath, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const pnpm = (development ? process.env.DSH_DESKTOP_PNPM_ENTRY : undefined)
    ?? join(process.resourcesPath, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  const seed = (development ? process.env.DSH_DESKTOP_SEED_DIR : undefined) ?? join(process.resourcesPath, 'seed')
  return { node, pnpm, seed }
}

function developmentProject(): string | undefined {
  const configured = process.env.DSH_DESKTOP_DEV_PROJECT_DIR
  if (configured === undefined || configured === '') return undefined
  if (app.isPackaged) throw new Error('dsh desktop: development project override is unavailable in packaged applications')
  return resolve(configured)
}

function developmentHostInspectPort(enabled: boolean): number | undefined {
  const configured = process.env.DSH_DESKTOP_HOST_INSPECT_PORT
  if (!enabled || configured === undefined || configured === '') return undefined
  const port = Number(configured)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('dsh desktop: DSH_DESKTOP_HOST_INSPECT_PORT must be an integer from 1 through 65535')
  }
  return port
}

function createWindow(preload: string, chrome: 'integrated' | 'native'): BrowserWindow {
  const integrated = chrome === 'integrated' && process.platform === 'win32'
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    show: false,
    ...(integrated
      ? {
        autoHideMenuBar: true,
        titleBarStyle: 'hidden' as const,
        titleBarOverlay: { color: '#171b1d', symbolColor: '#e8f3f5', height: 36 },
      }
      : {}),
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  if (integrated) window.setMenuBarVisibility(false)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).protocol !== `${SCHEME}:`) event.preventDefault()
  })
  return window
}

function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('dsh desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('dsh desktop: rejected IPC from an unowned renderer')
  }
}

async function serveShellAsset(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  const root = resolve(app.getAppPath(), 'renderer')
  const url = new URL(request.url)
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return new Response(null, { status: 400 })
  }
  const target = resolve(normalize(join(root, pathname)))
  if (target !== root && !target.startsWith(root + sep)) return new Response(null, { status: 403 })
  try {
    const body = request.method === 'HEAD' ? null : await readFile(target)
    return new Response(body, { headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' } })
  } catch {
    return new Response(null, { status: 404 })
  }
}

async function main(): Promise<void> {
  const resources = runtimeResources()
  const paths = resolveDesktopPaths(desktopProductState.home)
  const development = developmentProject()
  const activeProject = development ?? paths.profile
  const hostInspectPort = developmentHostInspectPort(development !== undefined)
  const manager = new DesktopProjectManager(paths, resources)
  if (development === undefined) manager.recover()
  let host: DesktopHostProcess | undefined
  let mainWindow: BrowserWindow | undefined
  let pluginWindow: BrowserWindow | undefined
  let shellInstallerOwnsQuit = false
  let updateState: DesktopUpdateState = { phase: 'idle' }
  const locale = resolveDesktopLocale(app.getLocale())
  const messages = locale.messages
  const appPreload = fileURLToPath(new URL('./preload-app.cjs', import.meta.url))
  const managementPreload = fileURLToPath(new URL('./preload.cjs', import.meta.url))

  const publishUpdate = (state: DesktopUpdateState): DesktopUpdateState => {
    updateState = state
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.updatesState, state)
    }
    return state
  }

  const startHost = async (projectDir = activeProject): Promise<DesktopHostProcess> => {
    const next = new DesktopHostProcess(resources.node, projectDir, hostInspectPort)
    await next.start()
    return next
  }
  const hooks: DesktopProjectHooks = {
    healthCheck: async (projectDir) => {
      const active = host
      host = undefined
      await active?.stop()
      let healthFailure: unknown
      let probe: DesktopHostProcess | undefined
      try {
        probe = await startHost(projectDir)
        await probe.stop()
      } catch (error) {
        healthFailure = error
        await probe?.stop().catch(() => undefined)
      }
      let restartFailure: unknown
      if (active !== undefined) {
        try {
          host = await startHost()
        } catch (error) {
          restartFailure = error
        }
      }
      if (healthFailure !== undefined && restartFailure !== undefined) {
        throw new AggregateError([
          errorOf(healthFailure, 'desktop project: staged health check failed'),
          errorOf(restartFailure, 'desktop project: active backend restart failed'),
        ], 'desktop project: staged health check and active backend restart failed')
      }
      if (healthFailure !== undefined) throw errorOf(healthFailure, 'desktop project: staged health check failed')
      if (restartFailure !== undefined) throw errorOf(restartFailure, 'desktop project: active backend restart failed')
    },
    beforeActivate: async () => {
      const active = host
      host = undefined
      await active?.stop()
    },
    afterActivate: async () => {
      host = await startHost()
    },
  }

  if (development === undefined) {
    await manager.applyRelease(resources.seed, app.getVersion(), {
      ...hooks,
      beforeActivate: async () => {},
      afterActivate: async () => {},
    })
  }
  host = await startHost()

  const updates = new DesktopUpdateCoordinator(
    publishUpdate,
    async () => {
      shellInstallerOwnsQuit = true
      const active = host
      host = undefined
      await active?.stop()
    },
    undefined,
    () => CUSTOM_HARNESS_PRODUCT.automaticUpdates,
  )

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'shell') return serveShellAsset(request)
    if (url.hostname !== 'app') return Promise.resolve(new Response(null, { status: 404 }))
    const active = host
    if (active === undefined) return Promise.resolve(new Response('backend unavailable', { status: 503 }))
    return active.fetch(request)
  })

  const mutate = async (event: IpcMainInvokeEvent, mutation: Parameters<DesktopProjectManager['mutate']>[0]): Promise<void> => {
    assertDesktopSender(event, ['shell'])
    if (development !== undefined) {
      throw new Error('dsh desktop: plugin package changes require a packaged application')
    }
    await manager.mutate(mutation, hooks)
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
  }
  ipcMain.handle(DESKTOP_IPC.localeGet, (event) => {
    assertDesktopSender(event, ['shell'])
    return locale
  })
  ipcMain.handle(DESKTOP_IPC.pluginsList, (event) => {
    assertDesktopSender(event, ['shell'])
    if (development !== undefined) return []
    return manager.listPlugins()
  })
  ipcMain.handle(DESKTOP_IPC.pluginsAdd, (event, spec: unknown) => {
    if (typeof spec !== 'string') throw new Error('dsh desktop: plugin spec must be a string')
    return mutate(event, { type: 'plugin-add', spec })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsRemove, (event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('dsh desktop: plugin name must be a string')
    return mutate(event, { type: 'plugin-remove', name })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsUpdate, (event, name: unknown, version: unknown) => {
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new Error('dsh desktop: plugin name and version must be strings')
    }
    return mutate(event, { type: 'plugin-update', name, version })
  })
  ipcMain.handle(DESKTOP_IPC.updatesCheck, async (event) => {
    assertDesktopSender(event, ['shell'])
    return updates.check()
  })
  ipcMain.handle(DESKTOP_IPC.updatesInstall, async (event) => {
    assertDesktopSender(event, ['shell'])
    await updates.install()
  })

  const openPluginWindow = (): void => {
    if (pluginWindow !== undefined && !pluginWindow.isDestroyed()) {
      pluginWindow.focus()
      return
    }
    pluginWindow = createWindow(managementPreload, 'native')
    pluginWindow.setSize(900, 620)
    pluginWindow.setTitle(messages.pluginWindowTitle)
    pluginWindow.once('ready-to-show', () => { pluginWindow?.show() })
    pluginWindow.once('closed', () => { pluginWindow = undefined })
    void pluginWindow.loadURL(`${SCHEME}://shell/plugin-manager.html`)
  }

  const fileMenu: MenuItemConstructorOptions[] = [
    {
      label: development === undefined ? messages.pluginsMenu : messages.pluginsMenuPackagedOnly,
      accelerator: 'CmdOrCtrl+,',
      enabled: development === undefined,
      click: openPluginWindow,
    },
    { type: 'separator' },
    { role: 'close' },
    { type: 'separator' },
    { role: 'quit' },
  ]
  const editMenu: MenuItemConstructorOptions[] = [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'selectAll' },
  ]
  const viewMenu: MenuItemConstructorOptions[] = [
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ]
  const helpMenu: MenuItemConstructorOptions[] = [
    {
      label: messages.aboutMenu,
      click: (): void => {
        void dialog.showMessageBox({
          type: 'info',
          title: messages.aboutMenu,
          message: formatDesktopMessage(messages.aboutDetail, { version: app.getVersion() }),
        })
      },
    },
  ]
  const menuTemplates: Record<DesktopMenuSection, readonly MenuItemConstructorOptions[]> = {
    file: fileMenu,
    edit: editMenu,
    view: viewMenu,
    help: helpMenu,
  }
  const nativeMenus = Object.fromEntries(Object.entries(menuTemplates)
    .map(([id, template]) => [id, Menu.buildFromTemplate([...template])])) as Record<DesktopMenuSection, Menu>
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: messages.fileMenu, submenu: fileMenu },
    { label: messages.editMenu, submenu: editMenu },
    { label: messages.viewMenu, submenu: viewMenu },
    { label: messages.helpMenu, submenu: helpMenu },
  ]))
  ipcMain.handle(DESKTOP_IPC.menuOpen, (event, section: unknown) => {
    assertDesktopSender(event, ['app'])
    if (section !== 'file' && section !== 'edit' && section !== 'view' && section !== 'help') {
      throw new Error('dsh desktop: invalid native menu section')
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner === null || owner.isDestroyed()) return
    nativeMenus[section].popup({ window: owner })
  })

  const createMainWindow = (): BrowserWindow => {
    const window = createWindow(appPreload, 'integrated')
    mainWindow = window
    window.once('ready-to-show', () => {
      if (window.isDestroyed()) return
      window.maximize()
      window.show()
    })
    window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
    return window
  }
  focusPrimaryWindow = () => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed()) {
      const replacement = createMainWindow()
      void replacement.loadURL(`${SCHEME}://app/index.html`)
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  mainWindow = createMainWindow()
  await mainWindow.loadURL(`${SCHEME}://app/index.html`)
  if (development !== undefined && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== '0') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
  publishUpdate(updateState)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) focusPrimaryWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', (event) => {
    if (shellInstallerOwnsQuit) return
    if (host === undefined) return
    event.preventDefault()
    const active = host
    host = undefined
    void active.stop().finally(() => { app.quit() })
  })
}

const desktopProductState = customHarnessDesktopState()
configureCustomHarnessProductIdentity(desktopProductState)
// Electron stores its instance lock under userData, so the directory must exist before the claim.
prepareCustomHarnessProductState(desktopProductState)
const ownsDesktopInstance = claimDesktopSingleInstance(app, () => { focusPrimaryWindow() })

if (ownsDesktopInstance) {
  void app.whenReady().then(main).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(error)
    const diagnosticFile = process.env.DSH_DESKTOP_DIAGNOSTIC_FILE
    if (diagnosticFile !== undefined) {
      await writeFile(diagnosticFile, `${error instanceof Error ? error.stack ?? message : message}\n`).catch(() => undefined)
    }
    dialog.showErrorBox(resolveDesktopLocale(app.getLocale()).messages.startupFailed, message)
    app.exit(1)
  })
}
