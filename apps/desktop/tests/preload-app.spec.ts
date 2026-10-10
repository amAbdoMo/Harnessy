// @vitest-environment jsdom
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MANDATORY_IPC } from '../src/mandatory-update-ipc.ts'
import { DESKTOP_IPC, type DshDesktopProductApi } from '../src/ipc.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), send: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}))
vi.mock('electron', () => electron)

const responses = new Map<string, unknown>()

beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'win32', isMainFrame: true })
  // Preload runs before the parser completes; automatic jsdom load must not install unrelated native caption rendering.
  vi.stubGlobal('window', new EventTarget())
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading')
  responses.clear()
  responses.set(DESKTOP_IPC.taskbarDocument, 0)
  electron.ipcRenderer.invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel === MANDATORY_IPC.status) throw new Error('No mandatory policy configured')
    return responses.get(channel)
  })
})
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  document.body.replaceChildren()
  delete document.documentElement.dataset.platform
  delete document.documentElement.dataset.windowsTitlebar
  document.documentElement.style.removeProperty('--dsh-windows-titlebar-height')
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.resetModules()
})

it.each(['win32', 'darwin', 'linux'] as const)('reads channel-specific login presence without consuming it for the taskbar ticket (%s)', async (platform) => {
  vi.stubGlobal('process', { ...process, platform })
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  responses.set(DESKTOP_IPC.onboardingApiKey, true)
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshOnboarding')?.[1] as { hasApiKey(): Promise<boolean> }
  expect(await api.hasApiKey()).toBe(true)
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    ...(platform === 'win32' ? [[MANDATORY_IPC.status], [DESKTOP_IPC.taskbarDocument]] : []), [DESKTOP_IPC.onboardingApiKey],
  ])
  const product = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  expect(product.taskbar === undefined).toBe(platform !== 'win32')
})

it('exposes onboarding size activation to the application document', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshOnboarding')?.[1] as { setActive(active: boolean): void }
  api.setActive(true)
  api.setActive(false)
  expect(electron.ipcRenderer.send.mock.calls).toEqual([[DESKTOP_IPC.onboardingActive, true], [DESKTOP_IPC.onboardingActive, false]])
})

it('exposes update controls and native notifications only to the product document', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/index.html'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  await api.updates.status()
  await api.updates.open()
  await api.notifications.show({ title: 'Task finished', body: 'The task completed.' })
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    [MANDATORY_IPC.status], [DESKTOP_IPC.taskbarDocument], [DESKTOP_IPC.updatesStatus], [DESKTOP_IPC.updatesOpen],
    [DESKTOP_IPC.notificationsShow, { title: 'Task finished', body: 'The task completed.' }],
  ])
  expect(api).not.toHaveProperty('plugins')
  expect(api).not.toHaveProperty('backend')
  expect(api.updates).not.toHaveProperty('install')
  const listener = vi.fn()
  const dispose = api.updates.subscribe(listener)
  const handler = electron.ipcRenderer.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.updatesPresentation)?.[1] as
    (event: unknown, state: unknown) => void
  handler({}, { visible: false })
  expect(listener).toHaveBeenCalledWith({ visible: false })
  dispose()
  expect(electron.ipcRenderer.off).toHaveBeenCalledWith(DESKTOP_IPC.updatesPresentation, handler)
})

it('buffers the latest native selection until subscription and disposes listeners without replaying consumed clicks', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  const activate = electron.ipcRenderer.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.notificationActivated)?.[1] as
    (event: unknown, sessionId: SessionId) => void
  activate({}, SessionId('old'))
  activate({}, SessionId('latest'))
  const first = vi.fn<(sessionId: SessionId) => void>()
  const dispose = api.notifications.subscribe(first)
  expect(first.mock.calls).toEqual([[SessionId('latest')]])
  activate({}, SessionId('live'))
  expect(first).toHaveBeenLastCalledWith(SessionId('live'))
  dispose()
  activate({}, SessionId('after-disposal'))
  expect(first).toHaveBeenCalledTimes(2)
  const second = vi.fn<(sessionId: SessionId) => void>()
  const stopSecond = api.notifications.subscribe(second)
  expect(second.mock.calls).toEqual([[SessionId('after-disposal')]])
  const third = vi.fn<(sessionId: SessionId) => void>()
  const stopThird = api.notifications.subscribe(third)
  expect(third).not.toHaveBeenCalled()
  stopSecond()
  stopThird()
})

it.each(['dsh-app://shell/plugin-manager.html', 'dsh-app://other/index.html', 'https://shell/startup.html', 'http://example.com/'])('exposes only the carrier marker to %s', async (url) => {
  vi.stubGlobal('location', new URL(url))
  await import('../src/preload-app.ts')
  expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('dshDesktop', { protocolVersion: 1 })
  expect(electron.ipcRenderer.on.mock.calls.some(([channel]) => channel === DESKTOP_IPC.browserOpenRequested)).toBe(false)
  expect(electron.ipcRenderer.on.mock.calls.some(([channel]) => channel === DESKTOP_IPC.notificationActivated)).toBe(false)
})

it('reads the local machine description only from the application main frame', async () => {
  const description = 'platform=darwin; os=15.6; app_arch=arm64; cpu=Apple M4; memory_gib=32.0'
  vi.stubGlobal('location', new URL('dsh-app://app/index.html'))
  responses.set(DESKTOP_IPC.deviceInfo, description)
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  await expect(api.deviceInfo()).resolves.toBe(description)
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([[MANDATORY_IPC.status], [DESKTOP_IPC.taskbarDocument], [DESKTOP_IPC.deviceInfo]])
  vi.resetModules()
  electron.contextBridge.exposeInMainWorld.mockClear()
  vi.stubGlobal('process', { ...process, isMainFrame: false })
  await import('../src/preload-app.ts')
  expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('dshDesktop', { protocolVersion: 1 })
})

it('exposes asynchronous boot only to the local application document', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktopBoot')?.[1] as { ready(): Promise<unknown>; failed(message: string): Promise<void> }
  await api.ready()
  await api.failed('client mount failed')
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC.bootFailed, 'client mount failed')
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC.boot)
  vi.resetModules()
  electron.contextBridge.exposeInMainWorld.mockClear()
  vi.stubGlobal('location', new URL('https://other.example/'))
  await import('../src/preload-app.ts')
  expect(electron.contextBridge.exposeInMainWorld.mock.calls.some(([name]) => name === 'dshDesktopBoot')).toBe(false)
})

it('exposes a directory picker only to the local application document', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === '__DSH_DIRECTORY_PICKER__')?.[1] as { pick(): Promise<string | null> }
  responses.set(DESKTOP_IPC.directoryPick, '/workspace')
  await expect(api.pick()).resolves.toBe('/workspace')
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    [MANDATORY_IPC.status], [DESKTOP_IPC.taskbarDocument], [DESKTOP_IPC.directoryPick],
  ])
  for (const url of ['dsh-app://shell/startup.html', 'https://example.com/']) {
    vi.resetModules()
    electron.contextBridge.exposeInMainWorld.mockClear()
    vi.stubGlobal('location', new URL(url))
    await import('../src/preload-app.ts')
    expect(electron.contextBridge.exposeInMainWorld.mock.calls.some(([name]) => name === '__DSH_DIRECTORY_PICKER__')).toBe(false)
  }
})

it('reports host paths of picked files only to the local application document', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === '__DSH_HOST_PATHS__')?.[1] as { pathFor(file: File): string }
  const picked = new File(['x'], 'notes.md')
  electron.webUtils.getPathForFile.mockReturnValue('/Users/me/notes.md')
  expect(api.pathFor(picked)).toBe('/Users/me/notes.md')
  expect(electron.webUtils.getPathForFile).toHaveBeenCalledExactlyOnceWith(picked)
  for (const url of ['dsh-app://shell/startup.html', 'https://example.com/']) {
    vi.resetModules()
    electron.contextBridge.exposeInMainWorld.mockClear()
    vi.stubGlobal('location', new URL(url))
    await import('../src/preload-app.ts')
    expect(electron.contextBridge.exposeInMainWorld.mock.calls.some(([name]) => name === '__DSH_HOST_PATHS__')).toBe(false)
  }
})

it.each(['dsh-app://app/', 'dsh-app://shell/plugin-manager.html', 'https://example.com/'])(
  'installs Windows appearance only for the application document (%s)', async (url) => {
    vi.stubGlobal('location', new URL(url))
    await import('../src/preload-app.ts')
    expect(document.documentElement.dataset.windowsTitlebar === '').toBe(url === 'dsh-app://app/')
  },
)

it('moves welcome-entry focus to the document without changing keyboard tab order', async () => {
  const dom = new JSDOM('<body><button>Sidebar</button><input></body>')
  try {
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('location', new URL('dsh-app://app/'))
    await import('../src/preload-app.ts')
    const enter = electron.ipcRenderer.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.enterWorkspace)![1] as () => void
    const button = dom.window.document.querySelector('button')!
    button.focus()
    enter()
    expect(dom.window.document.activeElement).toBe(dom.window.document.body)
    expect(dom.window.document.body.hasAttribute('tabindex')).toBe(false)
    expect(button.tabIndex).toBe(0)
    dom.window.document.body.setAttribute('tabindex', '-1')
    button.focus()
    enter()
    expect(dom.window.document.body.getAttribute('tabindex')).toBe('-1')
  } finally { dom.window.close() }
})

it.each(['win32', 'darwin'] as const)('installs the embedded mandatory UI only in the Windows app document (%s)', async (platform) => {
  vi.stubGlobal('process', { ...process, platform })
  for (const url of ['dsh-app://app/', 'dsh-app://shell/mandatory-update.html', 'https://example.com/']) {
    vi.resetModules()
    electron.ipcRenderer.on.mockClear()
    electron.ipcRenderer.invoke.mockClear()
    vi.stubGlobal('location', new URL(url))
    await import('../src/preload-app.ts')
    expect(electron.ipcRenderer.on.mock.calls.filter(([channel]) => channel === MANDATORY_IPC.state)).toHaveLength(
      platform === 'win32' && url === 'dsh-app://app/' ? 1 : 0,
    )
    expect(electron.ipcRenderer.invoke.mock.calls.filter(([channel]) => channel === MANDATORY_IPC.status)).toEqual(
      platform === 'win32' && url === 'dsh-app://app/' ? [[MANDATORY_IPC.status]] : [],
    )
  }
})

it('exposes constrained shortcut operations and releases configuration subscriptions', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  await api.shortcuts.get([])
  expect(api.shortcuts).not.toHaveProperty('reload')
  await api.shortcuts.recording(true)
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC.shortcutsGet, [])
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC.shortcutsRecording, true)
  const listener = vi.fn()
  const off = api.shortcuts.subscribe(listener)
  const handler = electron.ipcRenderer.on.mock.calls.find(([name]) => name === DESKTOP_IPC.shortcutsChanged)![1] as
    (event: unknown, state: unknown) => void
  handler({}, { status: 'ready' })
  expect(listener).toHaveBeenCalledWith({ status: 'ready' })
  off(); expect(electron.ipcRenderer.off).toHaveBeenCalledWith(DESKTOP_IPC.shortcutsChanged, handler)
})

it('withholds the product API from same-origin child frames', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  vi.stubGlobal('process', { ...process, isMainFrame: false })
  await import('../src/preload-app.ts')
  expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('dshDesktop', { protocolVersion: 1 })
})

it('forwards only the focused product iframe and releases native input subscriptions', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  const listener = vi.fn()
  const off = api.keyboard.subscribe(listener)
  const handler = electron.ipcRenderer.on.mock.calls.find(([name]) => name === DESKTOP_IPC.shortcutsInput)![1] as
    (event: unknown, state: unknown) => void
  const input = { kind: 'iframe', frameName: 'preview', revision: 'current' }
  handler({}, input)
  const frame = document.createElement('iframe')
  document.body.append(frame)
  frame.name = 'preview'
  frame.focus()
  handler({}, input)
  expect(listener).not.toHaveBeenCalled()
  frame.setAttribute('data-html-preview', '')
  handler({}, { ...input, frameName: 'stale' })
  handler({}, { ...input, frameName: '' })
  expect(listener).not.toHaveBeenCalled()
  handler({}, input)
  expect(listener).toHaveBeenCalledExactlyOnceWith(input)
  frame.remove()
  handler({}, input)
  expect(listener).toHaveBeenCalledTimes(1)
  const menu = { kind: 'menu', commandId: 'page.close', revision: 'current' }
  handler({}, menu)
  expect(listener).toHaveBeenLastCalledWith(menu)
  off()
  expect(electron.ipcRenderer.off).toHaveBeenCalledWith(DESKTOP_IPC.shortcutsInput, handler)
})

it('forwards browser guest input only for the focused live webview lease', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  const listener = vi.fn()
  const off = api.keyboard.subscribe(listener)
  const handler = electron.ipcRenderer.on.mock.calls.find(([name]) => name === DESKTOP_IPC.shortcutsInput)![1] as
    (event: unknown, state: unknown) => void
  const input = { kind: 'webview', frameName: 'guest', revision: 'current' }
  const frame = document.createElement('webview')
  frame.tabIndex = 0
  frame.setAttribute('name', 'guest')
  document.body.append(frame)
  frame.focus()
  handler({}, input)
  expect(listener).not.toHaveBeenCalled()
  frame.setAttribute('data-sidebar-browser-frame', 'webview')
  handler({}, { ...input, frameName: '' })
  handler({}, { ...input, frameName: 'old' })
  expect(listener).not.toHaveBeenCalled()
  handler({}, input)
  expect(listener).toHaveBeenCalledExactlyOnceWith(input)
  const other = document.createElement('input')
  document.body.append(other)
  other.focus()
  handler({}, input)
  frame.remove()
  handler({}, input)
  expect(listener).toHaveBeenCalledOnce()
  off()
})
