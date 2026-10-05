// @vitest-environment jsdom
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import type { DesktopShortcutInput, ShortcutBinding, ShortcutCommandId, ShortcutConfigSnapshot,
  ShortcutDefinition, ShortcutSaveResult } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { ShortcutRegistry } from '@deepseek-ai/dsh-client-shortcuts/src/client/registry.ts'
import { installKeyboard } from '@deepseek-ai/dsh-client-shortcuts/src/client/dom.ts'
import { installNativeKeyboard } from '@deepseek-ai/dsh-client-shortcuts/src/client/native.ts'
import type { DesktopBrowserLeaseId, DesktopBrowserReservation, DesktopWebsiteProfileId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopWebsiteProfiles } from '../src/website-profiles.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

const ipc = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
const storage = vi.hoisted(() => ({ clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}),
  clearAuthCache: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}) }))
const storageOverrides = vi.hoisted(() => new Map<typeof nativeCleanupMethods[number], () => Promise<void>>())
const overlays = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    private destroyed = false
    readonly webContents = { setWindowOpenHandler: vi.fn() }
    readonly focus = vi.fn()
    readonly show = vi.fn()
    readonly setBounds = vi.fn()
    setMenu() {}
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  return { Window, application: Object.assign(new EventEmitter(), { isPackaged: true }) }
})
const nativeSessions = vi.hoisted(() => new Map<string, ReturnType<typeof createNativeSession>>())
function createNativeSession() {
  return { ...storage, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(), on: vi.fn(), webRequest: { onBeforeRequest: vi.fn() } }
}
function nativeSession(partition: string) {
  let value = nativeSessions.get(partition)
  if (value === undefined) { value = createNativeSession(); nativeSessions.set(partition, value) }
  Object.assign(value, storage, Object.fromEntries(storageOverrides))
  return value
}
const nativeContents = vi.hoisted(() => new Set<object>())
vi.mock('electron', () => ({ ipcMain: ipc, BrowserWindow: overlays.Window, app: overlays.application,
  webContents: { getAllWebContents: () => [...nativeContents] }, session: { fromPartition: nativeSession } }))
const { installDesktopShortcuts } = await import('../src/keyboard.ts')
const { DesktopBrowserGuests } = await import('../src/browser-guests.ts')
const { DesktopUpdateOverlays } = await import('../src/update-overlay.ts')
afterEach(() => { vi.clearAllMocks() })

type FrameFixture = { url: WebFrameMain['url']; name: WebFrameMain['name']; parent: FrameFixture | null }
type ContentsFixture = EventEmitter & Pick<WebContents,
  'isDestroyed' | 'isFocused' | 'send' | 'setIgnoreMenuShortcuts' | 'focus' | 'sendInputEvent'> & {
    mainFrame: FrameFixture
    focusedFrame: FrameFixture | null
  }
type WindowFixture = EventEmitter & Pick<BrowserWindow, 'isDestroyed' | 'isFocused' | 'isEnabled' | 'close'> & {
  webContents: ContentsFixture
}
type InvokeFixture = { sender: object; senderFrame: object | null }
type KeyboardFixture = Omit<ReturnType<typeof installDesktopShortcuts>, 'attach' | 'attachGuest'> & {
  attach(window: WindowFixture): void
  attachGuest(window: WindowFixture, guest: ContentsFixture, name: DesktopBrowserLeaseId): () => void
}
// Electron is substituted at module load; fixtures implement the native members exercised by this installer.
const installFixture = installDesktopShortcuts as (
  getWindow: () => WindowFixture | undefined, userData: string,
  platform: Parameters<typeof installDesktopShortcuts>[2], updateMenu: () => void,
  overlayInput: (window: WindowFixture) => { readonly revision: number; readonly blocked: boolean },
) => KeyboardFixture
type GuestsFixture = {
  createProfiles(...args: Parameters<InstanceType<typeof DesktopBrowserGuests>['createProfiles']>): DesktopWebsiteProfiles
  acquireProfile(owner: ContentsFixture, profile: DesktopWebsiteProfileId): DesktopBrowserReservation
  acquire(owner: ContentsFixture, workspace: unknown): DesktopBrowserReservation
  release(owner: ContentsFixture, id: unknown): Promise<void>
  inspectWebsite(owner: ContentsFixture, id: DesktopBrowserLeaseId): {
    owner: ContentsFixture
    guest: ContentsFixture
    profile: DesktopWebsiteProfileId
  } | undefined
  onInvalidated(listener: (owner: ContentsFixture, lease: DesktopBrowserLeaseId) => void | Promise<void>): () => void
  bind(window: WindowFixture, attachInput: (guest: ContentsFixture, name: DesktopBrowserLeaseId) => () => void): void
}

function desktopDefaults(binding: ShortcutBinding): ShortcutDefinition['defaults'] {
  return { 'desktop:macos': binding, 'desktop:windows': binding, 'desktop:linux': binding }
}

function browserGuest(reservation: DesktopBrowserReservation, owner: ContentsFixture) {
  const frame: FrameFixture = { url: `about:blank#${reservation.lease}`, name: '', parent: null }
  let destroyed = false
  const guest = Object.assign(new EventEmitter(), { mainFrame: frame, focusedFrame: frame,
    hostWebContents: owner, session: nativeSession(reservation.partition), getURL: () => frame.url, getType: () => 'webview',
    isDestroyed: () => destroyed, isFocused: vi.fn(() => true),
    setWindowOpenHandler: vi.fn(), setIgnoreMenuShortcuts: vi.fn(), send: vi.fn(), close: vi.fn(),
    focus: vi.fn(), sendInputEvent: vi.fn() })
  nativeContents.add(guest)
  guest.once('destroyed', () => { destroyed = true; nativeContents.delete(guest) })
  onTestFinished(() => { guest.emit('destroyed') })
  return { frame, guest }
}

async function fixture(platform: 'macos' | 'windows' | 'linux' = 'macos') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-keyboard-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const frame: FrameFixture = { url: 'dsh-app://app/', name: '', parent: null }
  let destroyed = false
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, focusedFrame: frame,
    isDestroyed: () => destroyed, isFocused: () => true, send: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(), focus: vi.fn(), sendInputEvent: vi.fn() })
  contents.once('destroyed', () => { destroyed = true })
  onTestFinished(async () => { contents.emit('destroyed'); await setImmediate() })
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => true), isEnabled: vi.fn(() => true), close: vi.fn() })
  let current: WindowFixture | undefined = window
  const updateMenu = vi.fn()
  const updateOverlays = new DesktopUpdateOverlays()
  const keyboard = installFixture(() => current, root, platform, updateMenu, window => updateOverlays.input(window as BrowserWindow))
  keyboard.attach(current)
  onTestFinished(() => { keyboard.dispose() })
  const handlers = new Map<string, (event: InvokeFixture, ...args: unknown[]) => unknown>(
    ipc.handle.mock.calls.map(([channel, handler]) => [channel, handler]))
  const event: InvokeFixture = { sender: contents, senderFrame: frame }
  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => await handlers.get(channel)!(event, ...args) as T
  const definitions: readonly ShortcutDefinition[] = [
    { id: 'sidebar.left.toggle' as ShortcutCommandId, defaults: desktopDefaults({ code: 'KeyB', modifiers: ['primary'] }) },
  ]
  return { keyboard, window, updateOverlays, contents, frame, event, handlers, call, definitions, updateMenu,
    detach: () => { current = undefined } }
}

const nativeCleanupMethods = ['clearStorageData', 'clearCache', 'clearAuthCache', 'closeAllConnections'] as const

async function websiteCleanupFixture() {
  const f = await fixture()
  const root = await mkdtemp(join(tmpdir(), 'dsh-website-native-cache-'))
  const filename = join(root, 'profiles.json')
  const pending: Promise<unknown>[] = []
  const releaseOnFinish: (() => void)[] = []
  const native: Array<typeof nativeCleanupMethods[number]> = []
  onTestFinished(async () => {
    for (const release of releaseOnFinish) release()
    await Promise.allSettled(pending)
    for (const method of nativeCleanupMethods) storage[method].mockReset().mockImplementation(async () => {})
    await rm(root, { recursive: true, force: true })
  })
  for (const method of nativeCleanupMethods) storage[method].mockImplementation(async () => { native.push(method) })
  const guests = new DesktopBrowserGuests(() => undefined) as GuestsFixture
  const profiles = guests.createProfiles(filename, {
    inspect: async () => ({ identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/mcp' }),
    confirm: async () => {}, enroll: async () => {},
  }, async () => {})
  const profile = await profiles.create({ name: 'Portal', accountLabel: 'operator',
    url: 'https://portal.example.test/', mcpServerName: 'portal' })
  const alias = await profiles.create({ name: 'Portal alias', accountLabel: 'operator',
    url: 'https://portal.example.test/alias', mcpServerName: 'portal' })
  await profiles.setControl(profile.id, 'agent')
  const attach = vi.fn(() => () => {})
  guests.bind(f.window, attach)
  const reservation = guests.acquireProfile(f.contents, profile.id)
  const { frame, guest } = browserGuest(reservation, f.contents)
  let attached = false
  const attachGuest = () => { attached = true; f.contents.emit('did-attach-webview', {}, guest) }
  releaseOnFinish.push(() => {
    guest.close.mockImplementation(() => { guest.emit('destroyed') })
    if (!attached) attachGuest()
    guest.emit('destroyed')
  })
  const saved = async () => {
    const document = JSON.parse(await readFile(filename, 'utf8')) as {
      profiles: Array<{ id: string; cleanupPending: boolean; loginConfirmed: boolean }>
    }
    return document.profiles.find(candidate => candidate.id === profile.id)
  }
  const assertFenced = async () => {
    for (const id of [profile.id, alias.id]) {
      expect(() => profiles.assertAvailable(id)).toThrow('must be cleared successfully')
      await expect(profiles.acquire(id)).rejects.toThrow('must be cleared successfully')
    }
  }
  const assertFinished = async (operation: 'signOut' | 'forget') => {
    expect(profiles.assertAvailable(alias.id).control).toBe('human')
    await expect(profiles.acquire(alias.id)).resolves.toMatchObject({ id: alias.id })
    if (operation === 'forget') {
      expect(await saved()).toBeUndefined()
      expect(() => profiles.assertAvailable(profile.id)).toThrow('unavailable')
      await expect(profiles.acquire(profile.id)).rejects.toThrow('unavailable')
    } else {
      expect(await saved()).toMatchObject({ cleanupPending: false, loginConfirmed: false })
      expect(profiles.assertAvailable(profile.id).control).toBe('human')
      await expect(profiles.acquire(profile.id)).resolves.toMatchObject({ id: profile.id })
    }
  }
  return { ...f, guests, profiles, profile, reservation, frame, guest, attach, attachGuest, pending, releaseOnFinish,
    native, saved, assertFenced, assertFinished }
}

function updateOverlayFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  onTestFinished(() => { platform.mockRestore() })
  const parent: WindowFixture & Pick<BrowserWindow, 'getContentBounds'> = Object.assign(f.window, {
    getContentBounds: () => ({ x: 0, y: 0, width: 900, height: 650 }),
  })
  Object.assign(f.contents, { insertCSS: vi.fn(async () => 'blur'), removeInsertedCSS: vi.fn(async () => {}) })
  return () => {
    const overlay = f.updateOverlays.create(parent as BrowserWindow, 'test-overlay-preload', 'Update', false)
    onTestFinished(() => { if (!overlay.isDestroyed()) overlay.destroy() })
    expect(vi.spyOn(overlay, 'show')).not.toHaveBeenCalled()
    return overlay
  }
}

it('mirrors only successful bindings, suppresses recording menus, and invalidates pre-navigation drafts', async () => {
  const f = await fixture()
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  const press = (code: string) => f.contents.emit('before-input-event', { preventDefault: vi.fn() },
    { type: 'keyDown', modifiers: [], code, key: code.replace('Key', ''), meta: true, control: false, alt: false, shift: false })
  press('KeyB'); expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  press('KeyJ'); expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit, { type: 'set', id: 'sidebar.left.toggle', binding: { code: 'KeyJ', modifiers: ['primary'] } }, initial.revision)
  expect(saved.status).toBe('saved')
  press('KeyB'); expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
  press('KeyJ'); expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  expect((await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit, { type: 'reset-all' }, initial.revision)).status).toBe('stale')
  await f.call(DESKTOP_IPC.shortcutsRecording, true)
  press('KeyW'); expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  f.window.isFocused.mockReturnValue(false)
  press('KeyW'); expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, 'dsh-app://app/', false, true)
  expect((await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit, { type: 'reset-all' }, saved.snapshot.revision)).status).toBe('not-ready')
  await f.call(DESKTOP_IPC.shortcutsGet, f.definitions)
  expect((await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit, { type: 'reset-all' }, saved.snapshot.revision)).status).toBe('stale')
})

it('blocks macOS shortcuts while an update overlay loads and clears held and consumed keys before dismissal', async () => {
  const f = await fixture()
  const open = updateOverlayFixture(f)
  const snapshot = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, [
    { id: 'page.close', defaults: { 'desktop:macos': { code: 'KeyA', secondCode: 'KeyB', modifiers: [] } } },
    { id: 'sidebar.left.toggle', defaults: desktopDefaults({ code: 'KeyK', modifiers: ['primary'] }) },
  ])
  const menu = f.keyboard.fileMenu({ fileMenu: 'File', closePage: 'Close' }).submenu as Electron.MenuItemConstructorOptions[]
  const closeMenu = menu[0]!.click as () => void
  const press = (code: string, type = 'keyDown', meta = false) => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    f.contents.emit('before-input-event', event, { type, code, key: code.slice(3), modifiers: meta ? ['meta'] : [],
      meta, control: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
    return event.defaultPrevented
  }
  f.contents.send.mockClear()
  expect(press('KeyA')).toBe(false)
  const first = open()
  expect(press('KeyB')).toBe(true)
  expect(press('KeyK', 'keyDown', true)).toBe(true)
  closeMenu()
  await f.call(DESKTOP_IPC.shortcutsCloseWindow, snapshot.revision)
  f.keyboard.sendEditingKey('C', ['control'])
  expect(f.window.close).not.toHaveBeenCalled()
  expect(f.contents.sendInputEvent).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()
  first.destroy()
  expect(press('KeyB')).toBe(false)
  expect(press('KeyB', 'keyUp')).toBe(false)
  expect(f.contents.send).not.toHaveBeenCalled()
  expect(press('KeyA')).toBe(false)
  expect(press('KeyB')).toBe(true)
  expect(f.contents.send).toHaveBeenCalledOnce()
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ code: 'KeyA', secondCode: 'KeyB' }))
  const second = open()
  expect(press('KeyB', 'keyUp')).toBe(true)
  second.destroy()
  expect(press('KeyB', 'keyUp')).toBe(false)
  expect(press('KeyK', 'keyDown', true)).toBe(true)
  expect(f.contents.send).toHaveBeenCalledTimes(2)
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ code: 'KeyK', meta: true }))
  closeMenu()
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput, expect.objectContaining({ kind: 'menu' }))
  await f.call(DESKTOP_IPC.shortcutsCloseWindow, snapshot.revision)
  expect(f.window.close).toHaveBeenCalledOnce()
  f.keyboard.sendEditingKey('C', ['control'])
  expect(f.contents.sendInputEvent).toHaveBeenCalledTimes(2)
})

it.each([false, true])('blocks approved browser guest input across update overlays, including guests attached while blocked: %s', async (attachWhileBlocked) => {
  const f = await fixture()
  const open = updateOverlayFixture(f)
  await f.call(DESKTOP_IPC.shortcutsGet, [
    { id: 'page.close', defaults: { 'desktop:macos': { code: 'KeyA', secondCode: 'KeyB', modifiers: [] } } },
    { id: 'sidebar.left.toggle', defaults: desktopDefaults({ code: 'KeyK', modifiers: ['primary'] }) },
  ])
  const guests = new DesktopBrowserGuests(() => undefined) as GuestsFixture
  guests.bind(f.window, (guest, name) => f.keyboard.attachGuest(f.window, guest, name))
  const reservation = guests.acquire(f.contents, 'session:test')
  const { frame, guest } = browserGuest(reservation, f.contents)
  const attach = () => {
    const event = { preventDefault: vi.fn() }
    f.contents.emit('will-attach-webview', event, {}, { src: frame.url, partition: reservation.partition })
    expect(event.preventDefault).not.toHaveBeenCalled()
    f.contents.emit('did-attach-webview', {}, guest)
    guest.emit('dom-ready')
  }
  if (!attachWhileBlocked) attach()
  const first = open()
  if (attachWhileBlocked) attach()
  const press = (code: string, type = 'keyDown', meta = false) => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    guest.emit('before-input-event', event, { type, code, key: code.slice(3), modifiers: meta ? ['meta'] : [],
      meta, control: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
    return event.defaultPrevented
  }
  f.contents.send.mockClear()
  expect(press('KeyK', 'keyDown', true)).toBe(true)
  f.keyboard.sendEditingKey('C', ['control'])
  expect(guest.sendInputEvent).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()
  const second = open()
  first.destroy()
  expect(press('KeyA')).toBe(true)
  expect(press('KeyB')).toBe(true)
  expect(f.contents.send).not.toHaveBeenCalled()
  second.destroy()
  expect(press('KeyB')).toBe(false)
  expect(press('KeyB', 'keyUp')).toBe(false)
  expect(press('KeyA')).toBe(false)
  open().destroy()
  expect(press('KeyB')).toBe(false)
  expect(press('KeyB', 'keyUp')).toBe(false)
  expect(f.contents.send).not.toHaveBeenCalled()
  expect(press('KeyA')).toBe(false)
  expect(press('KeyB')).toBe(true)
  expect(f.contents.send).toHaveBeenCalledOnce()
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ kind: 'webview', frameName: reservation.lease, code: 'KeyA', secondCode: 'KeyB' }))
  open().destroy()
  expect(press('KeyB', 'keyUp')).toBe(false)
  expect(press('KeyK', 'keyDown', true)).toBe(true)
  expect(f.contents.send).toHaveBeenCalledTimes(2)
  f.keyboard.sendEditingKey('C', ['control'])
  expect(guest.sendInputEvent).toHaveBeenCalledTimes(2)
})

it('rejects other windows, subframes, remote/shell pages, and malformed edits', async () => {
  const f = await fixture()
  const get = f.handlers.get(DESKTOP_IPC.shortcutsGet)!
  for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: null }, { ...f.event, senderFrame: {} }]) {
    await expect(get(event, f.definitions)).rejects.toThrow('rejected sender')
  }
  for (const url of ['dsh-app://shell/', 'https://example.com/', 'http://localhost/']) {
    f.frame.url = url
    await expect(get(f.event, f.definitions)).rejects.toThrow('unowned renderer')
  }
  f.frame.url = 'dsh-app://app/'
  const ready = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  await expect(f.call(DESKTOP_IPC.shortcutsEdit, { type: 'reset-all', path: '/tmp' }, ready.revision)).rejects.toThrow('Invalid')
  await expect(f.call(DESKTOP_IPC.shortcutsEdit, { type: 'reset-all' }, 1)).rejects.toThrow('revision')
  await expect(f.call(DESKTOP_IPC.shortcutsRecording, 'true')).rejects.toThrow('recording')
  f.window.isDestroyed.mockReturnValue(true)
  await expect(get(f.event, f.definitions)).rejects.toThrow('rejected sender')
  f.detach(); await expect(get(f.event, f.definitions)).rejects.toThrow('rejected sender')
})

it('routes embedded input once, follows rebindings, and guards native window closure by revision and focus', async () => {
  const f = await fixture()
  const closeItem = () => (f.keyboard.fileMenu({ fileMenu: 'File', closePage: 'Close' }).submenu as Electron.MenuItemConstructorOptions[])[0]!
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, [
    { id: 'page.close', defaults: desktopDefaults({ code: 'KeyW', modifiers: ['primary'] }) },
    { id: 'page.refresh', defaults: desktopDefaults({ code: 'KeyR', modifiers: ['primary'] }) },
  ])
  expect(closeItem().accelerator).toBe('Command+W')
  const preventDefault = vi.fn()
  const input = { modifiers: [], type: 'keyDown', code: 'KeyW', key: 'w', meta: true, control: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false }
  f.contents.send.mockClear()
  f.contents.emit('before-input-event', { preventDefault }, input)
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ kind: 'keyboard', code: 'KeyW' }))
  preventDefault.mockClear(); f.contents.send.mockClear()
  Object.assign(f.contents, { focusedFrame: { name: 'embedded', parent: f.frame } })
  f.contents.emit('before-input-event', { preventDefault }, input)
  expect(preventDefault).toHaveBeenCalledTimes(1)
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput, expect.objectContaining({ kind: 'iframe', revision: initial.revision, frameName: 'embedded', code: 'KeyW' }))
  f.contents.emit('before-input-event', { preventDefault }, { ...input, type: 'keyUp' })
  expect(f.contents.send).toHaveBeenCalledTimes(1)
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'page.close', binding: { code: 'KeyJ', modifiers: ['primary'] } }, initial.revision)
  expect(closeItem().accelerator).toBe('Command+J')
  f.contents.send.mockClear()
  f.contents.emit('before-input-event', { preventDefault }, input)
  expect(f.contents.send).not.toHaveBeenCalled()
  f.contents.emit('before-input-event', { preventDefault }, { ...input, code: 'KeyZ', key: 'j' })
  expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  expect(f.contents.send).not.toHaveBeenCalled()
  await f.call(DESKTOP_IPC.shortcutsCloseWindow, initial.revision)
  expect(f.window.close).not.toHaveBeenCalled()
  f.window.isEnabled.mockReturnValue(false)
  await f.call(DESKTOP_IPC.shortcutsCloseWindow, saved.snapshot.revision)
  expect(f.window.close).not.toHaveBeenCalled()
  f.window.isEnabled.mockReturnValue(true)
  await f.call(DESKTOP_IPC.shortcutsCloseWindow, saved.snapshot.revision)
  expect(f.window.close).toHaveBeenCalledTimes(1)
  await f.call(DESKTOP_IPC.shortcutsEdit, { type: 'set', id: 'page.close', binding: null }, saved.snapshot.revision)
  expect(closeItem().accelerator).toBeUndefined()
  f.keyboard.dispose()
  expect(f.contents.listenerCount('before-input-event')).toBe(0)
})

it.each([
  ['browser.new', 'KeyT'], ['session.new', 'KeyN'],
])('forwards Linux %s from embedded frames while leaving main-document input to the DOM', async (id, code) => {
  const f = await fixture('linux')
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet,
    [{ id, defaults: desktopDefaults({ code, modifiers: ['primary'] }) }])
  const input = { modifiers: ['control'], type: 'keyDown', code, key: code.slice(3).toLowerCase(),
    control: true, meta: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false }
  const preventDefault = vi.fn()
  f.contents.send.mockClear()
  f.contents.emit('before-input-event', { preventDefault }, input)
  expect(preventDefault).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()

  Object.assign(f.contents, { focusedFrame: { name: 'browser', parent: f.frame } })
  f.contents.emit('before-input-event', { preventDefault }, input)
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ kind: 'iframe', frameName: 'browser', code, revision: initial.revision }))
  f.contents.emit('before-input-event', { preventDefault }, { ...input, type: 'keyUp' })
  expect(f.contents.send).toHaveBeenCalledOnce()

  const cleared = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id, binding: null }, initial.revision)
  expect(cleared.status).toBe('saved')
  preventDefault.mockClear(); f.contents.send.mockClear()
  f.contents.emit('before-input-event', { preventDefault }, input)
  expect(preventDefault).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()
})

it.each([
  ['ArrowUp', 'Command+Up'], ['ArrowDown', 'Command+Down'],
  ['ArrowLeft', 'Command+Left'], ['ArrowRight', 'Command+Right'],
])('uses the Electron accelerator for a saved %s binding', async (code, accelerator) => {
  const f = await fixture()
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet,
    [{ id: 'page.close', defaults: desktopDefaults({ code: 'KeyW', modifiers: ['primary'] }) }])
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'page.close', binding: { code, modifiers: ['primary'] } }, initial.revision)
  expect(saved.status).toBe('saved')
  const menu = f.keyboard.fileMenu({ fileMenu: 'File', closePage: 'Close' }).submenu as Electron.MenuItemConstructorOptions[]
  expect(menu[0]?.accelerator).toBe(accelerator)
})

it('refreshes the native menu only when its accelerator or availability changes', async () => {
  const f = await fixture()
  const close = { id: 'page.close', defaults: desktopDefaults({ code: 'KeyW', modifiers: ['primary'] }) }
  expect(f.updateMenu).not.toHaveBeenCalled()
  await f.call(DESKTOP_IPC.shortcutsGet, [close])
  expect(f.updateMenu).toHaveBeenCalledOnce()
  const menu = f.keyboard.fileMenu({ fileMenu: 'File', closePage: 'Close' }).submenu as Electron.MenuItemConstructorOptions[]
  const registered = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, [close, ...f.definitions])
  const edited = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'sidebar.left.toggle', binding: { code: 'KeyJ', modifiers: ['primary'] } }, registered.revision)
  expect(edited.status).toBe('saved')
  expect(f.updateMenu).toHaveBeenCalledOnce()
  f.contents.send.mockClear()
  const click = menu[0]!.click as () => void
  click()
  expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.shortcutsInput,
    { kind: 'menu', commandId: 'page.close', revision: edited.snapshot.revision })
  await f.call(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'page.close', binding: { code: 'KeyQ', modifiers: ['primary'] } }, edited.snapshot.revision)
  expect(f.updateMenu).toHaveBeenCalledTimes(2)
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(f.updateMenu).toHaveBeenCalledTimes(3)
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(f.updateMenu).toHaveBeenCalledTimes(3)
})

it.each(['macos', 'windows'] as const)('prioritizes %s custom editing bindings before both main and embedded frame handlers', async (platform) => {
  const f = await fixture(platform)
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet,
    [{ id: 'session.new', defaults: desktopDefaults({ code: 'KeyN', modifiers: ['primary'] }) }])
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'session.new', binding: { code: 'KeyC', modifiers: ['primary'] } }, initial.revision)
  expect(saved.status).toBe('saved')
  const input = { modifiers: [], type: 'keyDown', code: 'KeyC', key: 'c', meta: platform === 'macos',
    control: platform === 'windows', alt: false, shift: false, isAutoRepeat: false, isComposing: false }
  const preventDefault = vi.fn()
  const press = (changes = {}) => f.contents.emit('before-input-event', { preventDefault }, { ...input, ...changes })
  f.contents.send.mockClear()
  press()
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput, expect.objectContaining({ kind: 'keyboard', code: 'KeyC' }))
  press({ type: 'keyUp' })
  expect(preventDefault).toHaveBeenCalledTimes(2)
  expect(f.contents.send).toHaveBeenCalledOnce()
  Object.assign(f.contents, { focusedFrame: { name: 'embedded', parent: f.frame } })
  press()
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput, expect.objectContaining({ kind: 'iframe', frameName: 'embedded' }))
  await f.call(DESKTOP_IPC.shortcutsRecording, true)
  preventDefault.mockClear(); f.contents.send.mockClear()
  press()
  expect(preventDefault).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()
  await f.call(DESKTOP_IPC.shortcutsRecording, false)
  press({ isComposing: true })
  press({ modifiers: ['altgr'] })
  press({ key: 'Dead' })
  press()
  expect(preventDefault).not.toHaveBeenCalled()
  await f.call(DESKTOP_IPC.shortcutsEdit, { type: 'set', id: 'session.new', binding: null }, saved.snapshot.revision)
  f.contents.send.mockClear()
  press()
  expect(preventDefault).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()
  expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
})

it.each(['macos', 'windows'] as const)('intercepts complete %s chords once and leaves their first key untouched', async (platform) => {
  const f = await fixture(platform)
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet,
    [{ id: 'page.close', defaults: desktopDefaults({ code: 'KeyW', modifiers: ['primary'] }) }])
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'page.close', binding: { code: 'KeyA', secondCode: 'KeyB', modifiers: [] } }, initial.revision)
  expect(saved.status).toBe('saved')
  const menu = f.keyboard.fileMenu({ fileMenu: 'File', closePage: 'Close' }).submenu as Electron.MenuItemConstructorOptions[]
  expect(menu[0]?.accelerator).toBeUndefined()
  const preventDefault = vi.fn()
  const press = (code: string, type = 'keyDown', isAutoRepeat = false) => {
    f.contents.emit('before-input-event', { preventDefault }, { code, key: code.slice(3), type, modifiers: [],
      control: false, alt: false, shift: false, meta: false, isAutoRepeat, isComposing: false })
  }
  for (const embedded of [false, true]) {
    Object.assign(f.contents, { focusedFrame: embedded ? { name: 'browser', parent: f.frame } : f.frame })
    f.contents.send.mockClear(); preventDefault.mockClear()
    press('KeyA'); press('KeyA', 'keyUp'); press('KeyB'); press('KeyB', 'keyUp')
    expect(preventDefault).not.toHaveBeenCalled()
    expect(f.contents.send).not.toHaveBeenCalled()
    press('KeyB')
    expect(preventDefault).not.toHaveBeenCalled()
    press('KeyA')
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
      expect.objectContaining({ kind: embedded ? 'iframe' : 'keyboard', code: 'KeyA', secondCode: 'KeyB', repeat: false }))
    press('KeyA', 'keyUp'); press('KeyB', 'keyUp')
  }
  for (const reset of [() => { f.window.emit('blur') },
    () => { press('MetaLeft', 'keyUp') },
    () => { Object.assign(f.contents, { focusedFrame: f.frame }) }]) {
    press('KeyA'); reset(); f.contents.send.mockClear(); press('KeyB')
    expect(f.contents.send).not.toHaveBeenCalled()
    press('KeyA', 'keyUp'); press('KeyB', 'keyUp')
  }
  f.contents.send.mockClear()
  press('KeyC'); press('KeyA'); press('KeyB')
  expect(f.contents.send).not.toHaveBeenCalled()
})

it.each(['C', 'V', 'Z'])('delivers Windows Edit %s to the editor and physical input to its shortcut', async (keyCode) => {
  const f = await fixture('windows')
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'sidebar.left.toggle', binding: { code: `Key${keyCode}`, modifiers: ['control'] } }, initial.revision)
  const registry = new ShortcutRegistry('desktop', 'windows', saved.snapshot)
  const run = vi.fn()
  registry.register({ ...f.definitions[0]!, label: () => 'Toggle sidebar', aliases: [], regions: ['page', 'editable'], modals: [],
    resolve: () => ({ status: 'handled', run }) })
  let nativeInput: (input: DesktopShortcutInput) => void = () => {}
  onTestFinished(installNativeKeyboard(window, {
    closeWindow: vi.fn(), subscribe: (listener) => { nativeInput = listener; return () => {} },
  }, registry, () => registry.config.getSnapshot()))
  onTestFinished(installKeyboard(window, registry, undefined, true))
  f.contents.send.mockImplementation((channel: string, input: DesktopShortcutInput) => {
    if (channel === DESKTOP_IPC.shortcutsInput) nativeInput(input)
  })
  const editorInput: string[] = []
  const deliver = (type: 'keyDown' | 'keyUp'): void => {
    const preventDefault = vi.fn()
    f.contents.emit('before-input-event', { preventDefault }, { type, code: `Key${keyCode}`, key: keyCode.toLowerCase(),
      modifiers: ['control'], control: true, meta: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
    if (!preventDefault.mock.calls.length) {
      editorInput.push(type)
      document.body.dispatchEvent(new KeyboardEvent(type === 'keyDown' ? 'keydown' : 'keyup',
        { code: `Key${keyCode}`, key: keyCode.toLowerCase(), ctrlKey: true, bubbles: true, cancelable: true }))
    }
  }
  f.contents.sendInputEvent.mockImplementation((input: { type: 'keyDown' | 'keyUp' }) => { deliver(input.type) })
  f.contents.send.mockClear()

  f.keyboard.sendEditingKey(keyCode, ['control'])

  expect(f.contents.focus).toHaveBeenCalledOnce()
  expect(editorInput).toEqual(['keyDown', 'keyUp'])
  expect(f.contents.send).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  expect(f.contents.sendInputEvent.mock.calls).toEqual([
    [{ type: 'keyDown', keyCode, modifiers: ['control'] }],
    [{ type: 'keyUp', keyCode, modifiers: ['control'] }],
  ])
  editorInput.length = 0
  deliver('keyDown')
  deliver('keyUp')
  expect(editorInput).toEqual([])
  expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ kind: 'keyboard', code: `Key${keyCode}` }))
  expect(run).toHaveBeenCalledOnce()
})

it('restores shortcut interception after native Edit delivery fails', async () => {
  const f = await fixture('windows')
  await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  f.contents.sendInputEvent.mockImplementationOnce(() => { throw new Error('editor unavailable') })
  expect(() => { f.keyboard.sendEditingKey('C', ['control']) }).toThrow('editor unavailable')
  const preventDefault = vi.fn()
  f.contents.emit('before-input-event', { preventDefault }, { type: 'keyDown', code: 'KeyB', key: 'b', modifiers: ['control'],
    control: true, meta: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
  expect(preventDefault).toHaveBeenCalledOnce()
  f.window.isDestroyed.mockReturnValue(true)
  expect(() => { f.keyboard.sendEditingKey('C', ['control']) }).not.toThrow()
  f.detach()
  expect(() => { f.keyboard.sendEditingKey('C', ['control']) }).not.toThrow()
  expect(f.contents.sendInputEvent).toHaveBeenCalledOnce()
})

it.each(['macos', 'windows'] as const)('intercepts %s standalone custom keys and clears held state when preferences change', async (platform) => {
  const f = await fixture(platform)
  let snapshot = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  for (const code of ['KeyA', 'F1', 'ArrowLeft', 'Escape', 'Tab', 'Enter']) {
    const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
      { type: 'set', id: 'sidebar.left.toggle', binding: { code, modifiers: [] } }, snapshot.revision)
    expect(saved.status).toBe('saved'); snapshot = saved.snapshot
    const preventDefault = vi.fn()
    f.contents.send.mockClear()
    f.contents.emit('before-input-event', { preventDefault }, { type: 'keyDown', code, key: code, modifiers: [],
      control: false, alt: false, shift: false, meta: false, isAutoRepeat: false, isComposing: false })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
      expect.objectContaining({ code, revision: snapshot.revision }))
  }
})

it.each(['macos', 'windows'] as const)('keeps %s native interception identical for inherited, saved and reset bindings', async (platform) => {
  const f = await fixture(platform)
  let snapshot = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  for (const operation of [null,
    { type: 'set', id: 'sidebar.left.toggle', binding: { code: 'KeyB', modifiers: ['primary'] } },
    { type: 'reset', id: 'sidebar.left.toggle' }]) {
    if (operation !== null) {
      const result = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit, operation, snapshot.revision)
      expect(result.status).toBe('saved'); snapshot = result.snapshot
    }
    for (const embedded of [false, true]) {
      Object.assign(f.contents, { focusedFrame: embedded ? { name: 'browser', parent: f.frame } : f.frame })
      const preventDefault = vi.fn()
      f.contents.send.mockClear()
      f.contents.emit('before-input-event', { preventDefault }, { type: 'keyDown', code: 'KeyB', key: 'b', modifiers: [],
        control: platform === 'windows', meta: platform === 'macos', alt: false, shift: false, isAutoRepeat: false, isComposing: false })
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
        expect.objectContaining({ kind: embedded ? 'iframe' : 'keyboard', code: 'KeyB', revision: snapshot.revision }))
    }
  }
})

it('consumes a held single-key repeat after focus reset without treating it as a fresh press', async () => {
  const f = await fixture('macos')
  await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  const preventDefault = vi.fn()
  const input = { type: 'keyDown', code: 'KeyB', key: 'b', modifiers: [],
    control: false, meta: true, alt: false, shift: false, isAutoRepeat: false, isComposing: false }
  f.contents.emit('before-input-event', { preventDefault }, input)
  f.window.emit('blur')
  f.contents.send.mockClear(); preventDefault.mockClear()
  f.contents.emit('before-input-event', { preventDefault }, { ...input, isAutoRepeat: true })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput, expect.objectContaining({ code: 'KeyB', repeat: true }))
})

it('delivers a fresh unbound key release after macOS omitted the previous Command character release', async () => {
  const f = await fixture('macos')
  await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  const preventDefault = vi.fn()
  const press = (code: string, type: string, meta: boolean): void => {
    f.contents.emit('before-input-event', { preventDefault }, { type, code, key: code, modifiers: [],
      control: false, meta, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
  }
  press('KeyB', 'keyDown', true)
  expect(preventDefault).toHaveBeenCalledOnce()
  press('MetaLeft', 'keyUp', false)
  preventDefault.mockClear()
  press('KeyB', 'keyDown', false); press('KeyB', 'keyUp', false)
  expect(preventDefault).not.toHaveBeenCalled()
})

it.each(['macos', 'windows'] as const)('releases %s native input when a saved binding overlaps a mounted fixed action', async (platform) => {
  const f = await fixture(platform)
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'sidebar.left.toggle', binding: { code: 'Escape', modifiers: [] } }, initial.revision)
  expect(saved.status).toBe('saved')
  await f.call(DESKTOP_IPC.shortcutsGet, [...f.definitions,
    { id: 'menu.dismiss', defaults: {}, fixed: [{ code: 'Escape', modifiers: [] }] }])
  const preventDefault = vi.fn()
  f.contents.send.mockClear()
  f.contents.emit('before-input-event', { preventDefault }, { type: 'keyDown', code: 'Escape', key: 'Escape', modifiers: [],
    control: false, meta: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
  expect(preventDefault).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()
})

it.each(['macos', 'windows'] as const)('keeps %s chord presses singular across native interception and renderer key delivery', async (platform) => {
  const f = await fixture(platform)
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'sidebar.left.toggle', binding: { code: 'KeyF', secondCode: 'KeyG', modifiers: [] } }, initial.revision)
  const registry = new ShortcutRegistry('desktop', platform, saved.snapshot)
  const run = vi.fn()
  registry.register({ ...f.definitions[0]!, label: () => 'Toggle sidebar', aliases: [], regions: ['page'], modals: [],
    resolve: () => ({ status: 'handled', run }) })
  let deliver: (input: DesktopShortcutInput) => void = () => {}
  onTestFinished(installNativeKeyboard(window, { closeWindow: vi.fn(), subscribe: (listener) => { deliver = listener; return () => {} } },
    registry, () => registry.config.getSnapshot()))
  onTestFinished(installKeyboard(window, registry, undefined, true))
  f.contents.send.mockImplementation((channel: string, input: DesktopShortcutInput) => {
    if (channel === DESKTOP_IPC.shortcutsInput) deliver(input)
  })
  const rendererReleases: string[] = []
  const press = (code: string, type: 'keyDown' | 'keyUp', repeat = false): void => {
    const preventDefault = vi.fn()
    f.contents.emit('before-input-event', { preventDefault }, { code, key: code.slice(3).toLowerCase(), type, modifiers: [],
      control: false, meta: false, alt: false, shift: false, isAutoRepeat: repeat, isComposing: false })
    // Electron only delivers input to the document when the main process did not intercept it.
    if (!preventDefault.mock.calls.length) {
      if (type === 'keyUp') rendererReleases.push(code)
      document.body.dispatchEvent(new KeyboardEvent(type === 'keyDown' ? 'keydown' : 'keyup',
        { code, key: code.slice(3).toLowerCase(), repeat, bubbles: true, cancelable: true }))
    }
  }
  for (const [index, [first, second]] of ([['KeyF', 'KeyG'], ['KeyG', 'KeyF']] as const).entries()) {
    press(first, 'keyDown'); press(first, 'keyUp'); press(second, 'keyDown'); press(second, 'keyUp')
    expect(run).toHaveBeenCalledTimes(index)
    press(first, 'keyDown'); press(second, 'keyDown'); press(second, 'keyDown', true); press(first, 'keyDown', true)
    expect(run).toHaveBeenCalledTimes(index + 1)
    if (index === 0) { press(first, 'keyUp'); press(second, 'keyUp') }
    else { press(second, 'keyUp'); press(first, 'keyUp') }
    press(second, 'keyDown'); press(second, 'keyUp'); press(first, 'keyDown'); press(first, 'keyUp')
    expect(run).toHaveBeenCalledTimes(index + 1)
  }
  expect(rendererReleases.filter(code => code === 'KeyF')).toHaveLength(5)
  expect(rendererReleases.filter(code => code === 'KeyG')).toHaveLength(5)
})

it.each(['macos', 'windows'] as const)('requires fresh %s chord presses when Electron omits intercepted key releases', async (platform) => {
  const f = await fixture(platform)
  const bindings = [
    { id: 'sidebar.left.toggle', binding: { code: 'KeyJ', secondCode: 'KeyK', modifiers: [] } },
    { id: 'sidebar.right.toggle', binding: { code: 'KeyF', secondCode: 'KeyG', modifiers: [] } },
    { id: 'shortcuts.open', binding: { code: 'KeyV', modifiers: [] } },
  ]
  let snapshot = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet,
    bindings.map(({ id }) => ({ id, defaults: {} })))
  for (const binding of bindings) {
    const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit, { type: 'set', ...binding }, snapshot.revision)
    expect(saved.status).toBe('saved')
    snapshot = saved.snapshot
  }
  const press = (code: string, type = 'keyDown', repeat = false): boolean => {
    const preventDefault = vi.fn()
    f.contents.emit('before-input-event', { preventDefault }, { code, key: code.slice(3).toLowerCase(), type, modifiers: [],
      control: false, meta: false, alt: false, shift: false, isAutoRepeat: repeat, isComposing: false })
    return preventDefault.mock.calls.length > 0
  }
  for (const embedded of [false, true]) {
    Object.assign(f.contents, { focusedFrame: embedded ? { name: 'browser', parent: f.frame } : f.frame })
    f.contents.send.mockClear()
    expect(press('KeyJ')).toBe(false)
    expect(press('KeyK')).toBe(true)
    expect(f.contents.send).toHaveBeenCalledOnce()
    // Electron on macOS can omit both releases after intercepting the second keydown.
    for (const code of ['KeyJ', 'KeyK']) {
      expect(press(code)).toBe(false)
      expect(press(code, 'keyUp')).toBe(false)
    }
    expect(f.contents.send).toHaveBeenCalledOnce()
    expect(press('KeyK')).toBe(false)
    expect(press('KeyJ')).toBe(true)
    expect(f.contents.send).toHaveBeenCalledTimes(2)
    expect(press('KeyJ', 'keyDown', true)).toBe(true)
    expect(press('KeyK', 'keyDown', true)).toBe(true)
    expect(f.contents.send).toHaveBeenCalledTimes(2)
    expect(press('KeyF')).toBe(false)
    expect(press('KeyG')).toBe(true)
    expect(f.contents.send).toHaveBeenCalledTimes(3)
    expect(press('KeyV')).toBe(true)
    expect(press('KeyJ')).toBe(false)
    expect(press('KeyK')).toBe(true)
    expect(f.contents.send).toHaveBeenCalledTimes(5)
  }
})

async function bootstrapFixture() {
  const f = await fixture()
  const guests = new DesktopBrowserGuests(() => undefined) as GuestsFixture
  const disposeInput = vi.fn()
  const attachInput = vi.fn(() => disposeInput)
  guests.bind(f.window, attachInput)
  const reservation = guests.acquire(f.contents, 'bootstrap:test')
  const approve = (value = reservation): void => {
    const event = { preventDefault: vi.fn() }
    f.contents.emit('will-attach-webview', event, {}, { src: `about:blank#${value.lease}`, partition: value.partition })
    expect(event.preventDefault).not.toHaveBeenCalled()
  }
  approve()
  return { ...f, guests, reservation, approve, attachInput, disposeInput }
}

it.each(['start', 'commit', 'fragment'] as const)('binds a delayed exact native bootstrap through main-frame %s, not a subframe', async (event) => {
  const f = await bootstrapFixture()
  const { guest, frame } = browserGuest(f.reservation, f.contents)
  frame.url = 'about:blank'
  f.contents.emit('did-attach-webview', {}, guest)
  const marker = `about:blank#${f.reservation.lease}`
  guest.emit('did-start-navigation', { isMainFrame: false, url: marker })
  guest.emit('did-navigate-in-page', {}, marker, false)
  expect(f.attachInput).not.toHaveBeenCalled()
  if (event === 'start') guest.emit('did-start-navigation', { isMainFrame: true, url: marker })
  else if (event === 'commit') guest.emit('did-navigate', {}, marker, 200, 'OK')
  else guest.emit('did-navigate-in-page', {}, marker, true)
  expect(f.attachInput).toHaveBeenCalledExactlyOnceWith(guest, f.reservation.lease)
  expect(guest.close).not.toHaveBeenCalled()
  for (const name of ['did-start-navigation', 'did-navigate', 'did-navigate-in-page']) expect(guest.listenerCount(name)).toBe(0)
  guest.emit('did-navigate', {}, 'https://portal.example.test/', 200, 'OK')
  expect(guest.close).not.toHaveBeenCalled()
})

it('correlates out-of-order guests by exact approved marker when native Sessions are shared', async () => {
  const f = await bootstrapFixture()
  const second = f.guests.acquire(f.contents, 'bootstrap:test')
  f.approve(second)
  const firstGuest = browserGuest(f.reservation, f.contents).guest
  const secondGuest = browserGuest(second, f.contents).guest
  expect(firstGuest.session).toBe(secondGuest.session)
  f.contents.emit('did-attach-webview', {}, secondGuest)
  f.contents.emit('did-attach-webview', {}, firstGuest)
  expect(f.attachInput.mock.calls).toEqual([[secondGuest, second.lease], [firstGuest, f.reservation.lease]])
})

it.each(['unapproved', 'owner', 'session', 'duplicate'] as const)('closes a native guest with %s identity without attaching input', async (reason) => {
  const f = await bootstrapFixture()
  const { guest } = browserGuest(f.reservation, f.contents)
  if (reason === 'unapproved') guest.getURL = () => 'about:blank#unknown'
  if (reason === 'owner') guest.hostWebContents = (await fixture()).contents
  if (reason === 'session') guest.session = nativeSession('wrong-native-partition')
  if (reason === 'duplicate') {
    const first = browserGuest(f.reservation, f.contents).guest
    f.contents.emit('did-attach-webview', {}, first)
    f.attachInput.mockClear()
  }
  f.contents.emit('did-attach-webview', {}, guest)
  expect(f.attachInput).not.toHaveBeenCalled()
  expect(guest.close).toHaveBeenCalledOnce()
  for (const name of ['did-start-navigation', 'did-navigate', 'did-navigate-in-page']) expect(guest.listenerCount(name)).toBe(0)
})

it.each(['release', 'destroy', 'throw'] as const)('never publishes an input disposer after reentrant attachment %s', async (operation) => {
  const f = await bootstrapFixture()
  const { guest } = browserGuest(f.reservation, f.contents)
  const pending: Promise<void>[] = []
  onTestFinished(async () => { guest.emit('destroyed'); await Promise.allSettled(pending) })
  f.attachInput.mockImplementation(() => {
    if (operation === 'release') pending.push(f.guests.release(f.contents, f.reservation.lease))
    else if (operation === 'destroy') guest.emit('destroyed')
    else throw new Error('Native input binding failed')
    return f.disposeInput
  })
  expect(() => f.contents.emit('did-attach-webview', {}, guest)).not.toThrow()
  if (operation === 'throw') expect(guest.close).toHaveBeenCalledOnce()
  else expect(f.disposeInput).toHaveBeenCalledOnce()
  guest.emit('destroyed')
  await Promise.all(pending)
  expect(f.disposeInput).toHaveBeenCalledTimes(operation === 'throw' ? 0 : 1)
})

it('releases a pending exact guest without restoring input and waits for physical destruction', async () => {
  const f = await bootstrapFixture()
  const { guest, frame } = browserGuest(f.reservation, f.contents)
  frame.url = ''
  f.contents.emit('did-attach-webview', {}, guest)
  let settled = false
  const released = f.guests.release(f.contents, f.reservation.lease).then(() => { settled = true })
  onTestFinished(async () => { guest.emit('destroyed'); await released })
  guest.emit('did-navigate-in-page', {}, `about:blank#${f.reservation.lease}`, true)
  await setImmediate()
  expect(f.attachInput).not.toHaveBeenCalled()
  expect(guest.close).toHaveBeenCalledOnce()
  expect(settled).toBe(false)
  guest.emit('destroyed')
  await released
  expect(settled).toBe(true)
})

it.each(['deadline', 'crash'] as const)('keeps owner release waiting for an unidentified native guest after %s', async (failure) => {
  const f = await bootstrapFixture()
  const { guest, frame } = browserGuest(f.reservation, f.contents)
  frame.url = 'about:blank'
  if (failure === 'deadline') {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
  }
  f.contents.emit('did-attach-webview', {}, guest)
  if (failure === 'deadline') await vi.advanceTimersByTimeAsync(5_000)
  else guest.emit('render-process-gone', {}, { reason: 'crashed' })
  expect(guest.close).toHaveBeenCalledOnce()
  f.contents.emit('destroyed')
  let settled = false
  const released = f.guests.release(f.contents, f.reservation.lease).then(() => { settled = true })
  onTestFinished(async () => { guest.emit('destroyed'); await released })
  guest.emit('did-navigate', {}, `about:blank#${f.reservation.lease}`, 200, 'OK')
  await Promise.resolve()
  await Promise.resolve()
  expect(f.attachInput).not.toHaveBeenCalled()
  expect(settled).toBe(false)
  guest.emit('destroyed')
  await released
  expect(settled).toBe(true)
  for (const name of ['did-start-navigation', 'did-navigate', 'did-navigate-in-page']) expect(guest.listenerCount(name)).toBe(0)
})

it.each(['reload', 'crash', 'destroy'] as const)('joins early native creation across owner %s and ignores late attachment delivery', async (operation) => {
  const f = await bootstrapFixture()
  const { guest, frame } = browserGuest(f.reservation, f.contents)
  const marker = frame.url
  frame.url = ''
  overlays.application.emit('web-contents-created', {}, guest)
  expect(f.attachInput).not.toHaveBeenCalled()
  if (operation === 'reload') f.contents.emit('did-start-navigation', {}, 'dsh-app://app/', false, true)
  else f.contents.emit(operation === 'crash' ? 'render-process-gone' : 'destroyed')
  let settled = false
  const release = f.guests.release(f.contents, f.reservation.lease).then(() => { settled = true })
  onTestFinished(async () => { guest.emit('destroyed'); await release })
  await setImmediate()
  expect(guest.close).toHaveBeenCalledOnce()
  expect(settled).toBe(false)
  frame.url = marker
  f.contents.emit('did-attach-webview', {}, guest)
  expect(f.attachInput).not.toHaveBeenCalled()
  expect(guest.listenerCount('did-navigate-in-page')).toBe(0)
  guest.emit('destroyed')
  await release
  expect(settled).toBe(true)
  f.contents.emit('did-attach-webview', {}, guest)
  expect(f.attachInput).not.toHaveBeenCalled()
  if (operation !== 'destroy') {
    const next = f.guests.acquire(f.contents, 'replacement-document')
    const replacement = browserGuest(next, f.contents)
    const denied = vi.fn()
    f.contents.emit('will-attach-webview', { preventDefault: denied }, {}, { src: replacement.frame.url, partition: next.partition })
    expect(denied).not.toHaveBeenCalled()
    overlays.application.emit('web-contents-created', {}, replacement.guest)
    f.contents.emit('did-attach-webview', {}, replacement.guest)
    expect(f.attachInput).toHaveBeenCalledOnce()
  }
})

it.each(['release', 'crash', 'reentrant'] as const)('contains a throwing native input disposer during %s and still closes the guest', async (operation) => {
  const f = await bootstrapFixture()
  const { guest } = browserGuest(f.reservation, f.contents)
  const pending: Promise<void>[] = []
  f.disposeInput.mockImplementation(() => { throw new Error('Native input disposal failed') })
  onTestFinished(async () => { guest.emit('destroyed'); await Promise.allSettled(pending) })
  if (operation === 'reentrant') f.attachInput.mockImplementation(() => {
    pending.push(f.guests.release(f.contents, f.reservation.lease))
    return f.disposeInput
  })
  expect(() => f.contents.emit('did-attach-webview', {}, guest)).not.toThrow()
  if (operation === 'release') pending.push(f.guests.release(f.contents, f.reservation.lease))
  if (operation === 'crash') expect(() => guest.emit('render-process-gone')).not.toThrow()
  await setImmediate()
  expect(guest.close).toHaveBeenCalledOnce()
  expect(f.disposeInput).toHaveBeenCalledOnce()
  guest.emit('destroyed')
  await Promise.all(pending)
})

it.each([false, true])('profile cleanup waits for destruction of an unidentified duplicate in the actual native Session (close throws: %s)', async (throws) => {
  const f = await websiteCleanupFixture()
  f.contents.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { src: f.frame.url, partition: f.reservation.partition })
  f.attachGuest()
  const duplicate = browserGuest(f.reservation, f.contents).guest
  f.releaseOnFinish.push(() => { duplicate.emit('destroyed') })
  if (throws) duplicate.close.mockImplementation(() => { throw new Error('Native duplicate close failed') })
  f.contents.emit('did-attach-webview', {}, duplicate)
  expect(duplicate.close).toHaveBeenCalledOnce()
  expect(f.attach).toHaveBeenCalledOnce()
  const originalClosed = Promise.withResolvers<undefined>()
  f.guest.close.mockImplementation(() => { f.guest.emit('destroyed'); originalClosed.resolve(undefined) })
  let finished = false
  const cleanup = f.profiles.signOut(f.profile.id).then(() => { finished = true })
  f.pending.push(cleanup)
  await originalClosed.promise
  expect(f.guest.isDestroyed()).toBe(true)
  expect(f.native).toEqual([])
  expect(finished).toBe(false)
  await f.assertFenced()
  duplicate.emit('destroyed')
  await cleanup
  expect(finished).toBe(true)
  expect(f.native).toContain('clearStorageData')
  await f.assertFinished('signOut')
})

it('retries an unidentified native closure after physical drainage times out without clearing authentication early', async () => {
  const f = await websiteCleanupFixture()
  f.contents.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { src: f.frame.url, partition: f.reservation.partition })
  f.attachGuest()
  f.guest.close.mockImplementation(() => { f.guest.emit('destroyed') })
  const duplicate = browserGuest(f.reservation, f.contents).guest
  f.releaseOnFinish.push(() => { duplicate.emit('destroyed') })
  f.contents.emit('did-attach-webview', {}, duplicate)
  expect(duplicate.close).toHaveBeenCalledOnce()
  const draining = Promise.withResolvers<undefined>()
  duplicate.close.mockImplementation(() => { draining.resolve(undefined) })
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  try {
    const failed = f.profiles.signOut(f.profile.id)
    f.pending.push(failed)
    const failure = expect(failed).rejects.toThrow('Desktop website native guest drainage did not finish')
    await draining.promise
    await vi.advanceTimersByTimeAsync(5_000)
    await failure
    expect(duplicate.close).toHaveBeenCalledTimes(2)
    expect(duplicate.isDestroyed()).toBe(false)
    expect(f.native).toEqual([])
    await f.assertFenced()
    duplicate.close.mockImplementation(() => { duplicate.emit('destroyed') })
    await f.profiles.signOut(f.profile.id)
    expect(duplicate.close).toHaveBeenCalledTimes(3)
    expect(duplicate.isDestroyed()).toBe(true)
    expect(f.native).toContain('clearStorageData')
    await f.assertFinished('signOut')
  } finally { vi.useRealTimers() }
})

it('closes unbound guests that attempt external navigation before native identification', async () => {
  const f = await bootstrapFixture()
  const { guest, frame } = browserGuest(f.reservation, f.contents)
  frame.url = 'about:blank'
  f.contents.emit('did-attach-webview', {}, guest)
  const event = { isMainFrame: true, url: 'https://portal.example.test/', preventDefault: vi.fn() }
  guest.emit('will-frame-navigate', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(guest.close).toHaveBeenCalledOnce()
  expect(f.attachInput).not.toHaveBeenCalled()
})

it.each(['macos', 'windows', 'linux'] as const)('routes approved %s browser guest input to its owner and stops delivery before guest destruction', async (platform) => {
  const f = await fixture(platform)
  const snapshot = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet,
    [{ id: 'browser.new', defaults: desktopDefaults({ code: 'KeyT', modifiers: ['primary'] }) }])
  const guests = new DesktopBrowserGuests(() => undefined) as GuestsFixture
  const detach = vi.fn<() => void>()
  const attach = vi.fn((guest: ContentsFixture, name: DesktopBrowserLeaseId) => {
    detach.mockImplementation(f.keyboard.attachGuest(f.window, guest, name))
    return detach
  })
  guests.bind(f.window, attach)
  const reservation = guests.acquire(f.contents, 'session:test')
  const { frame, guest } = browserGuest(reservation, f.contents)
  const rejected = { preventDefault: vi.fn() }
  f.contents.emit('will-attach-webview', rejected, {}, { src: 'about:blank#unknown', partition: reservation.partition })
  expect(rejected.preventDefault).toHaveBeenCalledOnce()
  const invalid = browserGuest(reservation, f.contents).guest
  invalid.getURL = () => 'about:blank#unknown'
  f.contents.emit('did-attach-webview', {}, invalid)
  invalid.emit('dom-ready')
  expect(invalid.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false })
  expect(attach).not.toHaveBeenCalled()

  const approved = { preventDefault: vi.fn() }
  f.contents.emit('will-attach-webview', approved, {}, { src: frame.url, partition: reservation.partition })
  expect(approved.preventDefault).not.toHaveBeenCalled()
  f.contents.emit('did-attach-webview', {}, guest)
  guest.emit('dom-ready')
  expect(attach).toHaveBeenCalledExactlyOnceWith(guest, reservation.lease)
  const input = { modifiers: [], type: 'keyDown', code: 'KeyT', key: 't', meta: platform === 'macos',
    control: platform !== 'macos', alt: false, shift: false, isAutoRepeat: false, isComposing: false }
  const preventDefault = vi.fn()
  f.contents.send.mockClear()
  guest.emit('before-input-event', { preventDefault }, input)
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(guest.send).not.toHaveBeenCalled()
  expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.shortcutsInput, {
    kind: 'webview', frameName: reservation.lease, revision: snapshot.revision, code: 'KeyT',
    meta: platform === 'macos', control: platform !== 'macos', alt: false, shift: false, repeat: false,
  })
  guest.isFocused.mockReturnValue(false)
  guest.emit('before-input-event', { preventDefault }, input)
  expect(f.contents.send).toHaveBeenCalledOnce()
  guest.isFocused.mockReturnValue(true)
  const release = guests.release(f.contents, reservation.lease)
  expect(detach).toHaveBeenCalledOnce()
  await Promise.resolve()
  expect(guest.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false })
  guest.emit('before-input-event', { preventDefault }, input)
  expect(f.contents.send).toHaveBeenCalledOnce()
  guest.emit('destroyed')
  await release
})

it.each(['release', 'destruction', 'crash'] as const)('invalidates exact website guest authority synchronously on %s', async (cause) => {
  const f = await fixture()
  const guests = new DesktopBrowserGuests(() => undefined) as GuestsFixture
  guests.bind(f.window, () => () => {})
  const profile = 'cd1b6493-c881-4967-a544-b0a49f2d847f' as DesktopWebsiteProfileId
  const reservation = guests.acquireProfile(f.contents, profile)
  const ordinary = guests.acquire(f.contents, 'ordinary')
  expect(guests.inspectWebsite(f.contents, ordinary.lease)).toBeUndefined()
  expect(guests.inspectWebsite(f.contents, reservation.lease)).toBeUndefined()
  const { frame, guest } = browserGuest(reservation, f.contents)
  f.contents.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { src: frame.url, partition: reservation.partition })
  f.contents.emit('did-attach-webview', {}, guest)
  expect(guests.inspectWebsite(f.contents, reservation.lease)).toEqual({ owner: f.contents, guest, profile })
  const other = await fixture()
  expect(guests.inspectWebsite(other.contents, reservation.lease)).toBeUndefined()
  const removed = vi.fn()
  const unsubscribe = guests.onInvalidated(removed)
  unsubscribe()
  const revoked = vi.fn((owner: ContentsFixture, lease: DesktopBrowserLeaseId) => {
    expect(owner).toBe(f.contents)
    expect(lease).toBe(reservation.lease)
    expect(guests.inspectWebsite(owner, lease)).toBeUndefined()
    expect(guest.close).not.toHaveBeenCalled()
  })
  const dispose = guests.onInvalidated(revoked)
  onTestFinished(dispose)
  if (cause === 'release') {
    const release = guests.release(f.contents, reservation.lease)
    expect(revoked).toHaveBeenCalledOnce()
    const repeated = guests.release(f.contents, reservation.lease)
    await Promise.resolve()
    guest.emit('destroyed')
    await Promise.all([release, repeated])
  } else guest.emit(cause === 'crash' ? 'render-process-gone' : 'destroyed')
  expect(revoked).toHaveBeenCalledOnce()
  expect(removed).not.toHaveBeenCalled()
  expect(guests.inspectWebsite(f.contents, reservation.lease)).toBeUndefined()
})

it.each([
  { operation: 'signOut', last: 'destruction' },
  { operation: 'forget', last: 'authority' },
] as const)('native website cleanup $operation waits for in-flight attachment, destruction and authority (last: $last)', async ({ operation, last }) => {
  const f = await websiteCleanupFixture()
  const { guests, profiles, profile, reservation, frame, guest } = f
  const drainage = Promise.withResolvers<undefined>()
  f.releaseOnFinish.push(() => { drainage.resolve(undefined) })
  onTestFinished(guests.onInvalidated(() => drainage.promise))
  const event = { preventDefault: vi.fn() }
  const preferences: Electron.WebPreferences = {}
  f.contents.emit('will-attach-webview', event, preferences, { src: frame.url, partition: reservation.partition })
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(preferences.additionalArguments).toBeUndefined()

  const closing = Promise.withResolvers<undefined>()
  guest.close.mockImplementation(() => { closing.resolve(undefined) })
  const released = guests.release(f.contents, reservation.lease)
  const cleanup = profiles[operation](profile.id)
  f.pending.push(released, cleanup)
  await f.assertFenced()
  expect(f.native).toEqual([])
  f.attachGuest()
  await closing.promise
  await vi.waitFor(async () => { expect(await f.saved()).toMatchObject({ cleanupPending: true, loginConfirmed: false }) })
  expect(f.attach).not.toHaveBeenCalled()
  expect(f.native).toEqual([])
  if (last === 'destruction') drainage.resolve(undefined)
  else guest.emit('destroyed')
  await setImmediate()
  expect(f.native).toEqual([])
  await f.assertFenced()
  expect((await profiles.list())[0]?.control).toBe('clearing')
  if (last === 'destruction') guest.emit('destroyed')
  else drainage.resolve(undefined)
  await Promise.all([released, cleanup])
  expect(f.native).toEqual(nativeCleanupMethods)
  await f.assertFinished(operation)
})

const heldNativeCleanupCases = [
  { operation: 'signOut', method: 'clearCache' },
  { operation: 'forget', method: 'closeAllConnections' },
] as const

it.each(heldNativeCleanupCases)('native website cleanup $operation keeps profile aliases fenced while $method is held', async ({ operation, method }) => {
  const f = await websiteCleanupFixture()
  const { profiles, profile, reservation, frame, guest } = f
  f.contents.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { src: frame.url, partition: reservation.partition })
  f.attachGuest()
  guest.close.mockImplementation(() => { guest.emit('destroyed') })
  const joined = Promise.withResolvers<undefined>()
  const held = Promise.withResolvers<undefined>()
  // A Promise subclass exposes subscription to the held Electron result. Caller completion
  // includes the real atomic save, so this race detects early release regardless of I/O latency.
  class NativeCleanup extends Promise<undefined> {
    override then<TResult1 = undefined, TResult2 = never>(
      onfulfilled?: ((value: undefined) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      joined.resolve(undefined)
      return super.then(onfulfilled, onrejected)
    }
  }
  const nativeResult = new NativeCleanup((resolve) => { void held.promise.then(resolve) })
  f.releaseOnFinish.push(() => { held.resolve(undefined); storageOverrides.delete(method) })
  f.pending.push(nativeResult)
  // vi.fn subscribes to returned Promises for settled-result tracking; keep this Session
  // response outside that instrumentation so only the caller can join it before teardown.
  storageOverrides.set(method, () => { f.native.push(method); return nativeResult })
  const cleanup = profiles[operation](profile.id)
  f.pending.push(cleanup)
  let settled = false
  const completed = cleanup.then(() => { settled = true; return 'completed' as const },
    () => { settled = true; return 'rejected' as const })
  f.pending.push(completed)
  expect(await Promise.race([joined.promise.then(() => 'joined' as const), completed])).toBe('joined')
  await f.assertFenced()
  expect(settled).toBe(false)
  expect((await profiles.list())[0]?.control).toBe('clearing')
  expect(await f.saved()).toMatchObject({ cleanupPending: true, loginConfirmed: false })
  expect(f.native).toEqual(nativeCleanupMethods.slice(0, nativeCleanupMethods.indexOf(method) + 1))
  held.resolve(undefined)
  await cleanup
  expect(f.native).toEqual(nativeCleanupMethods)
  await f.assertFinished(operation)
})

it.each(heldNativeCleanupCases)('native website cleanup $operation retains failed cleanup and account fence after $method rejects, then retries', async ({ operation, method }) => {
  const f = await websiteCleanupFixture()
  const { guests, profiles, profile, reservation, frame, guest } = f
  f.contents.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { src: frame.url, partition: reservation.partition })
  f.attachGuest()
  guest.close.mockImplementation(() => { guest.emit('destroyed') })
  const failure = new Error(`Native ${method} failed`)
  storage[method].mockImplementationOnce(async () => { f.native.push(method); throw failure })
  const cleanup = profiles[operation](profile.id)
  const observed = expect(cleanup).rejects.toBe(failure)
  f.pending.push(cleanup, observed)
  await observed
  expect((await profiles.list())[0]?.control).toBe('cleanup-failed')
  await f.assertFenced()
  expect(await f.saved()).toMatchObject({ cleanupPending: true, loginConfirmed: false })
  expect(f.native).toEqual(nativeCleanupMethods.slice(0, nativeCleanupMethods.indexOf(method) + 1))
  expect(guests.inspectWebsite(f.contents, reservation.lease)).toBeUndefined()
  await guests.release(f.contents, reservation.lease)
  expect(guest.close).toHaveBeenCalledOnce()
  const retry = profiles[operation](profile.id)
  f.pending.push(retry)
  await retry
  expect(guest.close).toHaveBeenCalledOnce()
  expect(f.native).toEqual([...nativeCleanupMethods.slice(0, nativeCleanupMethods.indexOf(method) + 1), ...nativeCleanupMethods])
  await f.assertFinished(operation)
})

it.each(['settled', 'failed'] as const)('retains website authentication until invalidated authority is %s', async (outcome) => {
  const f = await fixture()
  const root = await mkdtemp(join(tmpdir(), 'dsh-guest-drain-'))
  const drainage = Promise.withResolvers<undefined>()
  const pending: Promise<unknown>[] = []
  onTestFinished(async () => {
    drainage.resolve(undefined)
    await Promise.allSettled(pending)
    await rm(root, { recursive: true, force: true })
  })
  const guests = new DesktopBrowserGuests(() => undefined) as GuestsFixture
  const profiles = guests.createProfiles(join(root, 'profiles.json'), {
    inspect: async () => ({ identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/mcp' }), confirm: async () => {}, enroll: async () => {},
  }, async () => {})
  const profile = await profiles.create({ name: 'Portal', accountLabel: '', url: 'https://portal.example.test/', mcpServerName: 'portal' })
  guests.bind(f.window, () => () => {})
  const reservation = guests.acquireProfile(f.contents, profile.id)
  const { frame, guest } = browserGuest(reservation, f.contents)
  f.contents.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { src: frame.url, partition: reservation.partition })
  f.contents.emit('did-attach-webview', {}, guest)
  const disposed = guests.onInvalidated(() => drainage.promise)
  onTestFinished(disposed)
  const closing = Promise.withResolvers<undefined>()
  guest.close.mockImplementation(() => { guest.emit('destroyed'); closing.resolve(undefined) })
  const cleanup = profiles.signOut(profile.id)
  const checked = outcome === 'failed' ? expect(cleanup).rejects.toThrow('authority drainage failed') : expect(cleanup).resolves.toBeUndefined()
  pending.push(cleanup, checked)
  await closing.promise
  expect(storage.clearAuthCache).not.toHaveBeenCalled()
  expect(guests.inspectWebsite(f.contents, reservation.lease)).toBeUndefined()
  if (outcome === 'failed') drainage.reject(new Error('Upstream outcome unknown'))
  else drainage.resolve(undefined)
  await checked
  if (outcome === 'failed') {
    expect(storage.clearAuthCache).not.toHaveBeenCalled()
    await expect(profiles.signOut(profile.id)).rejects.toThrow('authority drainage failed')
    expect((await profiles.list())[0]?.control).toBe('cleanup-failed')
  } else expect(storage.clearAuthCache).toHaveBeenCalledOnce()
})

it('contains private invalidation diagnostics during native owner teardown and retains failed cleanup', async () => {
  const f = await fixture()
  const root = await mkdtemp(join(tmpdir(), 'dsh-guest-owner-teardown-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { consoleError.mockRestore() })
  const guests = new DesktopBrowserGuests(() => undefined) as GuestsFixture
  const profiles = guests.createProfiles(join(root, 'profiles.json'), {
    inspect: async () => ({ identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/mcp' }), confirm: async () => {}, enroll: async () => {},
  }, async () => {})
  const profile = await profiles.create({ name: 'Portal', accountLabel: '', url: 'https://portal.example.test/', mcpServerName: 'portal' })
  guests.bind(f.window, () => () => {})
  const reservation = guests.acquireProfile(f.contents, profile.id)
  const { frame, guest } = browserGuest(reservation, f.contents)
  f.contents.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { src: frame.url, partition: reservation.partition })
  f.contents.emit('did-attach-webview', {}, guest)
  const diagnostic = new Error('private native account token')
  onTestFinished(guests.onInvalidated(() => { throw diagnostic }))
  guest.close.mockImplementation(() => { guest.emit('destroyed') })
  f.contents.emit('render-process-gone')
  expect(guests.inspectWebsite(f.contents, reservation.lease)).toBeUndefined()
  await expect(guests.release(f.contents, reservation.lease)).rejects.toMatchObject({
    errors: [{ errors: [diagnostic] }],
  })
  await expect(profiles.signOut(profile.id)).rejects.toThrow('authority drainage failed')
  expect((await profiles.list())[0]?.control).toBe('cleanup-failed')
  expect(storage.clearStorageData).not.toHaveBeenCalled()
  expect(consoleError).not.toHaveBeenCalled()
})

it.each(['settled', 'failed'] as const)('joins held authority drainage after native guest close throws (drainage: %s)', async (outcome) => {
  const f = await fixture()
  const root = await mkdtemp(join(tmpdir(), 'dsh-guest-close-drain-'))
  const drainage = Promise.withResolvers<undefined>()
  const pending: Promise<unknown>[] = []
  onTestFinished(async () => {
    drainage.resolve(undefined)
    await Promise.allSettled(pending)
    await rm(root, { recursive: true, force: true })
  })
  const guests = new DesktopBrowserGuests(() => undefined) as GuestsFixture
  const profiles = guests.createProfiles(join(root, 'profiles.json'), {
    inspect: async () => ({ identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/mcp' }), confirm: async () => {}, enroll: async () => {},
  }, async () => {})
  const profile = await profiles.create({ name: 'Portal', accountLabel: '', url: 'https://portal.example.test/', mcpServerName: 'portal' })
  guests.bind(f.window, () => () => {})
  const reservation = guests.acquireProfile(f.contents, profile.id)
  const { frame, guest } = browserGuest(reservation, f.contents)
  f.contents.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { src: frame.url, partition: reservation.partition })
  f.contents.emit('did-attach-webview', {}, guest)
  onTestFinished(guests.onInvalidated(() => drainage.promise))
  const closing = Promise.withResolvers<undefined>()
  const nativeFailure = new Error('Native guest close failed')
  guest.close.mockImplementation(() => { closing.resolve(undefined); throw nativeFailure })
  const cleanup = profiles.signOut(profile.id)
  const observed = cleanup.then(() => undefined, (error: unknown) => error)
  pending.push(observed)
  await closing.promise
  await setImmediate()
  expect(guests.inspectWebsite(f.contents, reservation.lease)).toBeUndefined()
  expect((await profiles.list())[0]?.control).toBe('clearing')
  expect(storage.clearStorageData).not.toHaveBeenCalled()
  if (outcome === 'failed') drainage.reject(new Error('Remote request outcome unknown'))
  else drainage.resolve(undefined)
  const error = await observed
  if (outcome === 'failed') {
    expect(error).toMatchObject({ errors: [nativeFailure, expect.any(AggregateError)] })
    await expect(profiles.signOut(profile.id)).rejects.toThrow('failed to drain')
  } else {
    expect(error).toBe(nativeFailure)
    expect((await profiles.list())[0]?.control).toBe('cleanup-failed')
    expect(storage.clearAuthCache).not.toHaveBeenCalled()
    guest.close.mockImplementation(() => { guest.emit('destroyed') })
    await profiles.signOut(profile.id)
    expect(storage.clearAuthCache).toHaveBeenCalledOnce()
  }
})

it.each(['settled', 'failed'] as const)('joins every website guest after a sibling release fails (last guest: %s)', async (outcome) => {
  const f = await fixture()
  const root = await mkdtemp(join(tmpdir(), 'dsh-guest-sibling-drain-'))
  const first = Promise.withResolvers<undefined>()
  const last = Promise.withResolvers<undefined>()
  const pending: Promise<unknown>[] = []
  onTestFinished(async () => {
    first.resolve(undefined)
    last.resolve(undefined)
    await Promise.allSettled(pending)
    await rm(root, { recursive: true, force: true })
  })
  const guests = new DesktopBrowserGuests(() => undefined) as GuestsFixture
  const profiles = guests.createProfiles(join(root, 'profiles.json'), {
    inspect: async () => ({ identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/mcp' }), confirm: async () => {}, enroll: async () => {},
  }, async () => {})
  const profile = await profiles.create({ name: 'Portal', accountLabel: '', url: 'https://portal.example.test/', mcpServerName: 'portal' })
  guests.bind(f.window, () => () => {})
  const firstReservation = guests.acquireProfile(f.contents, profile.id)
  const reservations = [firstReservation, guests.acquireProfile(f.contents, profile.id)]
  const closing = reservations.map((reservation) => {
    const { frame, guest } = browserGuest(reservation, f.contents)
    f.contents.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { src: frame.url, partition: reservation.partition })
    f.contents.emit('did-attach-webview', {}, guest)
    const entered = Promise.withResolvers<undefined>()
    guest.close.mockImplementation(() => { guest.emit('destroyed'); entered.resolve(undefined) })
    return entered.promise
  })
  const dispose = guests.onInvalidated((_owner, lease) => lease === firstReservation.lease ? first.promise : last.promise)
  onTestFinished(dispose)
  const cleanup = profiles.signOut(profile.id)
  const observed = cleanup.then(() => undefined, (error: unknown) => error)
  pending.push(observed)
  await Promise.all(closing)
  first.reject(new Error('First request outcome unknown'))
  await expect(guests.release(f.contents, firstReservation.lease)).rejects.toThrow('authority drainage failed')
  expect((await profiles.list())[0]?.control).toBe('clearing')
  expect(storage.clearStorageData).not.toHaveBeenCalled()
  expect(storage.clearAuthCache).not.toHaveBeenCalled()
  for (const reservation of reservations) expect(guests.inspectWebsite(f.contents, reservation.lease)).toBeUndefined()
  if (outcome === 'failed') last.reject(new Error('Last request outcome unknown'))
  else last.resolve(undefined)
  const error = await observed
  expect(error).toBeInstanceOf(AggregateError)
  if (outcome === 'failed') expect(error).toMatchObject({ errors: [expect.any(AggregateError), expect.any(AggregateError)] })
  expect((await profiles.list())[0]?.control).toBe('cleanup-failed')
  expect(storage.clearStorageData).not.toHaveBeenCalled()
  expect(storage.clearAuthCache).not.toHaveBeenCalled()
})

it('bounds stalled guest destruction, retains authentication, and permits cleanup retry', async () => {
  const f = await fixture()
  const root = await mkdtemp(join(tmpdir(), 'dsh-website-guest-timeout-'))
  onTestFinished(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) })
  const guests = new DesktopBrowserGuests(() => undefined) as GuestsFixture
  const profiles = guests.createProfiles(join(root, 'profiles.json'), {
    inspect: async () => ({ identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/mcp' }), confirm: async () => {}, enroll: async () => {},
  }, async () => {})
  const profile = await profiles.create({ name: 'Portal', accountLabel: '', url: 'https://portal.example.test/', mcpServerName: 'portal' })
  guests.bind(f.window, () => () => {})
  const reservation = guests.acquireProfile(f.contents, profile.id)
  const { frame, guest } = browserGuest(reservation, f.contents)
  f.contents.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { src: frame.url, partition: reservation.partition })
  f.contents.emit('did-attach-webview', {}, guest)
  const listeners = guest.listenerCount('destroyed')
  const closing = new Promise<void>((resolve) => { guest.close.mockImplementation(() => { resolve() }) })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const cleanup = profiles.signOut(profile.id)
  const rejected = expect(cleanup).rejects.toThrow('guest destruction did not finish')
  await closing
  await vi.advanceTimersByTimeAsync(5_000)
  await rejected
  expect(storage.clearStorageData).not.toHaveBeenCalled()
  expect(storage.clearAuthCache).not.toHaveBeenCalled()
  expect(guest.listenerCount('destroyed')).toBe(listeners)
  expect((await profiles.list())[0]?.control).toBe('cleanup-failed')
  expect(guests.inspectWebsite(f.contents, reservation.lease)).toBeUndefined()
  const rejectedAttachment = { preventDefault: vi.fn() }
  f.contents.emit('will-attach-webview', rejectedAttachment, {}, { src: frame.url, partition: reservation.partition })
  expect(rejectedAttachment.preventDefault).toHaveBeenCalledOnce()
  vi.useRealTimers()
  guest.close.mockImplementation(() => { guest.emit('destroyed') })
  await profiles.signOut(profile.id)
  expect(storage.clearAuthCache).toHaveBeenCalledOnce()
  expect((await profiles.list())[0]?.control).toBe('human')
})

it('keeps browser guest chord state local and leaves accepted bindings active through guest navigation', async () => {
  const f = await fixture('macos')
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  await f.call(DESKTOP_IPC.shortcutsEdit, { type: 'set', id: 'sidebar.left.toggle',
    binding: { code: 'KeyF', secondCode: 'KeyG', modifiers: [] } }, initial.revision)
  const frame: FrameFixture = { url: 'https://example.test/', name: '', parent: null }
  const guest = Object.assign(new EventEmitter(), { mainFrame: frame, focusedFrame: frame,
    isDestroyed: () => false, isFocused: () => true, setIgnoreMenuShortcuts: vi.fn(),
    send: vi.fn(), focus: vi.fn(), sendInputEvent: vi.fn() })
  const blurListeners = f.window.listenerCount('blur')
  const closedListeners = f.window.listenerCount('closed')
  const dispose = f.keyboard.attachGuest(f.window, guest, 'guest' as DesktopBrowserLeaseId)
  onTestFinished(dispose)
  expect(f.window.listenerCount('blur')).toBe(blurListeners)
  expect(f.window.listenerCount('closed')).toBe(closedListeners)
  const press = (contents: EventEmitter, code: string): void => {
    contents.emit('before-input-event', { preventDefault: vi.fn() }, { modifiers: [], type: 'keyDown', code, key: code,
      meta: false, control: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
  }
  f.contents.send.mockClear()
  press(guest, 'KeyF')
  guest.emit('blur')
  press(guest, 'KeyG')
  expect(f.contents.send).not.toHaveBeenCalled()
  f.window.emit('blur')
  press(guest, 'KeyF')
  expect(f.contents.send).not.toHaveBeenCalled()
  guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  press(guest, 'KeyF')
  press(f.contents, 'KeyG')
  expect(f.contents.send).not.toHaveBeenCalled()
  press(guest, 'KeyG')
  expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ kind: 'webview', frameName: 'guest', code: 'KeyF', secondCode: 'KeyG' }))
  guest.emit('destroyed')
  press(f.contents, 'KeyF')
  expect(f.contents.send).toHaveBeenCalledTimes(2)
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ kind: 'keyboard', code: 'KeyF', secondCode: 'KeyG' }))
})

it('delivers Windows Edit actions to the focused browser guest without invoking its custom shortcut', async () => {
  const f = await fixture('windows')
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  await f.call(DESKTOP_IPC.shortcutsEdit, { type: 'set', id: 'sidebar.left.toggle',
    binding: { code: 'KeyC', modifiers: ['control'] } }, initial.revision)
  const frame: FrameFixture = { url: 'https://example.test/', name: '', parent: null }
  const guest = Object.assign(new EventEmitter(), { mainFrame: frame, focusedFrame: frame,
    isDestroyed: () => false, isFocused: () => true, setIgnoreMenuShortcuts: vi.fn(),
    send: vi.fn(), focus: vi.fn(), sendInputEvent: vi.fn() })
  const dispose = f.keyboard.attachGuest(f.window, guest, 'guest' as DesktopBrowserLeaseId)
  onTestFinished(dispose)
  const events: string[] = []
  guest.sendInputEvent.mockImplementation((input: { type: 'keyDown' | 'keyUp' }) => {
    const preventDefault = vi.fn()
    guest.emit('before-input-event', { preventDefault }, { ...input, code: 'KeyC', key: 'c', modifiers: ['control'],
      control: true, meta: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
    if (!preventDefault.mock.calls.length) events.push(input.type)
  })
  f.contents.send.mockClear()
  f.keyboard.sendEditingKey('C', ['control'])
  expect(guest.focus).toHaveBeenCalledOnce()
  expect(events).toEqual(['keyDown', 'keyUp'])
  expect(f.contents.send).not.toHaveBeenCalled()
  expect(f.contents.sendInputEvent).not.toHaveBeenCalled()
  dispose()
  f.keyboard.sendEditingKey('C', ['control'])
  expect(f.contents.sendInputEvent).toHaveBeenCalledTimes(2)
})
