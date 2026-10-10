/** Native calls are mocked; these cases do not qualify actual Windows taskbar presentation. */
import { EventEmitter } from 'node:events'
import { nativeImage, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent,
  type NativeImage, type WebContents, type WebFrameMain } from 'electron'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { assertDesktopSender, DESKTOP_IPC } from '../src/ipc.ts'
import { resolveDesktopLocale } from '../src/locale.ts'
import { DesktopTaskbarUnread, installDesktopTaskbarIpc, taskbarUnreadBitmap } from '../src/taskbar-unread.ts'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  class Preferences extends EventEmitter {
    accent = '336699ff'
    getAccentColor(): string { return this.accent }
  }
  return {
    preferences: new Preferences(),
    createFromBitmap: vi.fn((bitmap: Buffer, size: { width: number; height: number }) => ({
      toBitmap: () => Buffer.from(bitmap), getSize: () => size,
    })),
  }
})
vi.mock('electron', () => ({ systemPreferences: native.preferences, nativeImage: { createFromBitmap: native.createFromBitmap } }))
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

function frame(url = 'dsh-app://app/'): WebFrameMain {
  return { url, processId: 10, routingId: 20, detached: false, isDestroyed: () => false } as WebFrameMain
}

class Contents extends EventEmitter {
  mainFrame = frame()
  loading = false
  destroyed = false
  isDestroyed(): boolean { return this.destroyed }
  isLoadingMainFrame(): boolean { return this.loading }
}

class Window extends EventEmitter {
  readonly webContents = new Contents()
  destroyed = false
  readonly setOverlayIcon = vi.fn<(image: NativeImage | null, description: string) => void>()
  isDestroyed(): boolean { return this.destroyed }
}

function nativeContents(contents: Pick<WebContents, 'mainFrame' | 'isDestroyed'>): WebContents {
  return contents as WebContents
}

function unreadyFixture() {
  native.preferences.accent = '336699ff'
  const window = new Window()
  const windowApi: Pick<BrowserWindow, 'isDestroyed' | 'setOverlayIcon'> = window
  const ownerWindow = windowApi as BrowserWindow
  const ownerContents = nativeContents(window.webContents)
  let locale = resolveDesktopLocale('en')
  const badge = new DesktopTaskbarUnread(ownerWindow, () => locale)
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const ipc: Pick<IpcMain, 'handle' | 'removeHandler'> = {
    handle: (channel, handler) => { handlers.set(channel, handler) },
    removeHandler: (channel) => { handlers.delete(channel) },
  }
  const authorize = (event: IpcMainInvokeEvent): void => {
    assertDesktopSender(event, ['app'])
    if (window.destroyed || event.sender !== ownerContents || event.senderFrame !== ownerContents.mainFrame) {
      throw new Error('Rejected unowned renderer')
    }
  }
  const detach = installDesktopTaskbarIpc(ipc, authorize, () => badge)
  onTestFinished(() => { detach(); badge.dispose() })
  const event = (): IpcMainInvokeEvent => ({ sender: ownerContents, senderFrame: ownerContents.mainFrame }) as IpcMainInvokeEvent
  const invoke = (channel: string, args: unknown[] = [], sender = event()): unknown => {
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error('Taskbar handler is not registered')
    return handler(sender, ...args)
  }
  const epoch = invoke(DESKTOP_IPC.taskbarDocument)
  const setUnread = (unread: unknown, ticket = epoch): unknown => invoke(DESKTOP_IPC.taskbarSetUnread, [unread, ticket])
  const overlay = (): NativeImage | null => {
    const call = window.setOverlayIcon.mock.calls.at(-1)
    if (call === undefined) throw new Error('No overlay update')
    return call[0]
  }
  return { window, badge, handlers, detach, event, epoch, invoke, setUnread, overlay,
    setLocale: (language: string) => { locale = resolveDesktopLocale(language) } }
}

function fixture() {
  const f = unreadyFixture()
  f.window.webContents.emit('dom-ready')
  return f
}

function pixel(bitmap: Buffer, x: number, y: number): number[] {
  const offset = (y * 16 + x) * 4
  return [...bitmap.subarray(offset, offset + 4)]
}

describe('Windows unread dot', () => {
  it.each([
    ['336699ff', [153, 102, 51, 255]],
    ['ff804080', [32, 64, 128, 128]],
    ['ff804000', [0, 0, 0, 0]],
  ])('rasterizes %s in premultiplied Windows BGRA with transparent surroundings', (accent, center) => {
    const bitmap = taskbarUnreadBitmap(accent)
    expect(bitmap.length).toBe(16 * 16 * 4)
    expect(pixel(bitmap, 7, 7)).toEqual(center)
    expect(pixel(bitmap, 0, 0)).toEqual([0, 0, 0, 0])
    expect(pixel(bitmap, 15, 15)).toEqual([0, 0, 0, 0])
    expect(pixel(bitmap, 7, 0)).toEqual([0, 0, 0, 0])
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        expect(pixel(bitmap, x, y)).toEqual(pixel(bitmap, y, x))
        expect(pixel(bitmap, x, y)).toEqual(pixel(bitmap, 15 - x, 15 - y))
      }
    }
  })

  it('fills one circular region rather than a square, count or transparent image', () => {
    const bitmap = taskbarUnreadBitmap('336699ff')
    expect(pixel(bitmap, 2, 2)).toEqual([0, 0, 0, 0])
    expect(pixel(bitmap, 7, 3)).toEqual([153, 102, 51, 255])
    expect(pixel(bitmap, 3, 3)[3]).toBeGreaterThan(0)
    expect(pixel(bitmap, 3, 3)[3]).toBeLessThan(255)
    for (let y = 2; y <= 13; y++) {
      const occupied = Array.from({ length: 16 }, (_, x) => pixel(bitmap, x, y)[3] !== 0)
      const first = occupied.indexOf(true)
      const last = occupied.lastIndexOf(true)
      expect(first).toBeGreaterThan(0)
      expect(occupied.slice(first, last + 1)).not.toContain(false)
    }
  })

  it('rotates the system accent and localized description only while unread, then clears without repainting', () => {
    const f = fixture()
    f.setUnread(true)
    const first = f.overlay()
    expect(first?.getSize()).toEqual({ width: 16, height: 16 })
    expect(pixel(first?.toBitmap() ?? Buffer.alloc(0), 7, 7)).toEqual([153, 102, 51, 255])
    f.setLocale('zh')
    native.preferences.accent = 'aabbccff'
    native.preferences.emit('accent-color-changed', {}, 'aabbccff')
    expect(pixel(f.overlay()?.toBitmap() ?? Buffer.alloc(0), 7, 7)).toEqual([204, 187, 170, 255])
    expect(f.window.setOverlayIcon.mock.calls.at(-1)?.[1]).toBe(resolveDesktopLocale('zh').messages.taskbarUnread)
    f.setUnread(false)
    expect(f.overlay()).toBeNull()
    const calls = f.window.setOverlayIcon.mock.calls.length
    native.preferences.emit('accent-color-changed', {}, '112233ff')
    f.badge.repaint()
    expect(f.window.setOverlayIcon.mock.calls.length).toBe(calls)
  })

  it('withholds the dot when Windows has no accent and repaints unread when the accent becomes available', () => {
    const f = fixture()
    native.preferences.accent = ''
    f.setUnread(true)
    expect(f.overlay()).toBeNull()
    expect(native.createFromBitmap).not.toHaveBeenCalled()
    native.preferences.accent = '336699ff'
    native.preferences.emit('accent-color-changed', {}, '336699ff')
    expect(f.overlay()).not.toBeNull()
  })

  it.each(['accent getter', 'invalid accent', 'native image', 'native overlay'])
  ('diagnoses %s failures without throwing from IPC, accent or locale repaint and recovers unread on a valid accent', (operation) => {
    const f = fixture()
    const failure = new Error(`${operation} unavailable`)
    const diagnostics = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let recover: () => void
    if (operation === 'accent getter') {
      const getter = vi.spyOn(native.preferences, 'getAccentColor').mockImplementation(() => { throw failure })
      recover = () => { getter.mockRestore() }
    } else if (operation === 'invalid accent') {
      native.preferences.accent = 'not-an-accent'
      recover = () => { native.preferences.accent = '336699ff' }
    } else if (operation === 'native image') {
      const create = vi.spyOn(nativeImage, 'createFromBitmap').mockImplementation(() => { throw failure })
      recover = () => { create.mockRestore() }
    } else {
      f.window.setOverlayIcon.mockImplementation(() => { throw failure })
      recover = () => { f.window.setOverlayIcon.mockReset() }
    }
    try {
      expect(() => f.setUnread(true)).not.toThrow()
      expect(() => native.preferences.emit('accent-color-changed', {}, '336699ff')).not.toThrow()
      f.setLocale('zh')
      expect(() => f.badge.repaint()).not.toThrow()
      expect(diagnostics).toHaveBeenCalledTimes(3)
      expect(diagnostics).toHaveBeenLastCalledWith(expect.any(String),
        operation === 'invalid accent' ? expect.any(Error) : failure)
    } finally {
      recover()
    }
    native.preferences.accent = 'aabbccff'
    native.preferences.emit('accent-color-changed', {}, 'aabbccff')
    expect(pixel(f.overlay()?.toBitmap() ?? Buffer.alloc(0), 7, 7)).toEqual([204, 187, 170, 255])
    expect(f.window.setOverlayIcon.mock.calls.at(-1)?.[1]).toBe(resolveDesktopLocale('zh').messages.taskbarUnread)
    expect(diagnostics).toHaveBeenCalledTimes(3)
  })

  it.each(['unread reset', 'main navigation'])('diagnoses native clear failure during %s without restoring retired unread', (operation) => {
    const f = fixture()
    f.setUnread(true)
    const failure = new Error('Overlay clear unavailable')
    const diagnostics = vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.window.setOverlayIcon.mockImplementationOnce(() => { throw failure })
    expect(() => {
      if (operation === 'unread reset') f.setUnread(false)
      else f.window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    }).not.toThrow()
    expect(diagnostics).toHaveBeenCalledWith(expect.any(String), failure)
    const calls = f.window.setOverlayIcon.mock.calls.length
    native.preferences.emit('accent-color-changed', {}, '336699ff')
    f.badge.repaint()
    expect(f.window.setOverlayIcon.mock.calls.length).toBe(calls)
  })

  it('diagnoses a failed missing-accent clear and repaints retained unread when the accent returns', () => {
    const f = fixture()
    f.setUnread(true)
    const failure = new Error('Overlay clear unavailable')
    const diagnostics = vi.spyOn(console, 'warn').mockImplementation(() => {})
    native.preferences.accent = ''
    f.window.setOverlayIcon.mockImplementationOnce(() => { throw failure })
    expect(() => native.preferences.emit('accent-color-changed', {}, '')).not.toThrow()
    expect(diagnostics).toHaveBeenCalledWith(expect.any(String), failure)
    native.preferences.accent = 'aabbccff'
    native.preferences.emit('accent-color-changed', {}, 'aabbccff')
    expect(pixel(f.overlay()?.toBitmap() ?? Buffer.alloc(0), 7, 7)).toEqual([204, 187, 170, 255])
  })

  it('rejects unread before dom-ready but accepts the current ready document while resources are loading', () => {
    const f = unreadyFixture()
    f.window.webContents.loading = true
    expect(() => f.setUnread(true)).toThrow('stale application document')
    expect(f.overlay()).toBeNull()
    f.window.webContents.emit('dom-ready')
    expect(() => f.setUnread(true)).not.toThrow()
    expect(f.window.webContents.isLoadingMainFrame()).toBe(true)
    expect(f.overlay()).not.toBeNull()
  })

  it.each(['same frame', 'replacement frame'])
  ('retires unread immediately on a same-origin reload with %s and rejects the old ticket after dom-ready', (reload) => {
    const f = fixture()
    f.setUnread(true)
    f.window.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    f.window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(f.overlay()).not.toBeNull()
    f.window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(f.overlay()).toBeNull()
    expect(() => f.setUnread(true)).toThrow('stale application document')
    if (reload === 'replacement frame') f.window.webContents.mainFrame = frame()
    f.window.webContents.loading = true
    const next = f.invoke(DESKTOP_IPC.taskbarDocument)
    expect(next).not.toBe(f.epoch)
    expect(() => f.setUnread(true, next)).toThrow('stale application document')
    f.window.webContents.emit('dom-ready')
    expect(() => f.setUnread(true)).toThrow('stale document ticket')
    expect(f.overlay()).toBeNull()
    f.setUnread(true, next)
    expect(f.overlay()).not.toBeNull()
  })

  it.each(['render-process-gone', 'destroyed', 'closed'])('clears on %s and cannot be revived by late renderer or accent work', (event) => {
    const f = fixture()
    f.setUnread(true)
    if (event === 'closed') f.window.emit(event)
    else f.window.webContents.emit(event)
    expect(f.overlay()).toBeNull()
    expect(() => f.setUnread(true)).toThrow('stale application document')
    const calls = f.window.setOverlayIcon.mock.calls.length
    native.preferences.emit('accent-color-changed', {}, 'aabbccff')
    f.badge.repaint()
    expect(f.window.setOverlayIcon.mock.calls.length).toBe(calls)
  })

  it.each(['available', 'throwing'])('detaches owned native listeners and IPC handlers with %s native clearing', (clearing) => {
    const f = fixture()
    f.setUnread(true)
    const failure = new Error('Overlay clear unavailable')
    const diagnostics = vi.spyOn(console, 'warn').mockImplementation(() => {})
    if (clearing === 'throwing') f.window.setOverlayIcon.mockImplementationOnce(() => { throw failure })
    expect(() => f.badge.dispose()).not.toThrow()
    if (clearing === 'throwing') expect(diagnostics).toHaveBeenCalledWith(expect.any(String), failure)
    else expect(diagnostics).not.toHaveBeenCalled()
    f.badge.dispose()
    f.detach()
    expect(f.window.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
    expect(f.handlers.size).toBe(0)
    expect(native.preferences.listenerCount('accent-color-changed')).toBe(0)
    expect(f.window.webContents.eventNames()).toEqual([])
    expect(f.window.eventNames()).toEqual([])
    expect(() => f.badge.setUnread(f.event(), true, f.epoch)).toThrow('stale')
    const calls = f.window.setOverlayIcon.mock.calls.length
    native.preferences.emit('accent-color-changed', {}, 'aabbccff')
    f.badge.repaint()
    expect(f.window.setOverlayIcon.mock.calls.length).toBe(calls)
  })

  it.each([undefined, null, 0, 1, 'true', {}, []])('refuses non-boolean IPC state %s without changing the overlay', (unread) => {
    const f = fixture()
    expect(() => f.setUnread(unread)).toThrow('unread must be boolean')
    expect(f.overlay()).toBeNull()
  })

  it.each(['guest', 'login', 'subframe', 'missing-frame', 'foreign-origin', 'port', 'credentials', 'detached', 'process'])
  ('refuses %s IPC before a native badge mutation', (caller) => {
    const f = fixture()
    let event = f.event()
    if (caller === 'guest') event = { ...event, sender: nativeContents(new Contents()) }
    if (caller === 'login') f.window.webContents.mainFrame = frame('dsh-app://shell/login.html')
    if (caller === 'subframe') event = { ...event, senderFrame: frame() }
    if (caller === 'missing-frame') event = { ...event, senderFrame: null }
    if (caller === 'foreign-origin') f.window.webContents.mainFrame = frame('https://example.test/')
    if (caller === 'port') f.window.webContents.mainFrame = frame('dsh-app://app:123/')
    if (caller === 'credentials') f.window.webContents.mainFrame = frame('dsh-app://user@app/')
    if (caller === 'detached') Object.assign(f.window.webContents.mainFrame, { detached: true })
    if (caller === 'process') Object.assign(f.window.webContents.mainFrame, { processId: 11 })
    if (!['guest', 'subframe', 'missing-frame'].includes(caller)) event = f.event()
    expect(() => f.invoke(DESKTOP_IPC.taskbarSetUnread, [true, f.epoch], event)).toThrow(/rejected|Rejected/)
    if (caller !== 'process') {
      expect(() => f.invoke(DESKTOP_IPC.taskbarDocument, [], event)).toThrow(/rejected|Rejected/)
    }
    expect(f.overlay()).toBeNull()
  })

  it('rolls back its document handler when unread-handler registration fails', () => {
    const channels = new Set<string>()
    const ipc: Pick<IpcMain, 'handle' | 'removeHandler'> = {
      handle: (channel) => {
        if (channel === DESKTOP_IPC.taskbarSetUnread) throw new Error('IPC conflict')
        channels.add(channel)
      },
      removeHandler: (channel) => { channels.delete(channel) },
    }
    expect(() => installDesktopTaskbarIpc(ipc, () => {}, () => undefined)).toThrow('IPC conflict')
    expect(channels.size).toBe(0)
  })

  it('leaves platforms without an overlay owner untouched while retaining wire validation', () => {
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
    const detach = installDesktopTaskbarIpc({
      handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) },
    }, (event) => { assertDesktopSender(event, ['app']) }, () => undefined)
    onTestFinished(detach)
    const handler = handlers.get(DESKTOP_IPC.taskbarSetUnread)
    if (handler === undefined) throw new Error('Missing taskbar handler')
    const event = { senderFrame: frame() } as IpcMainInvokeEvent
    expect(handler(event, true, undefined)).toBeUndefined()
    expect(() => handler(event, 1, undefined)).toThrow('unread must be boolean')
    expect(native.createFromBitmap).not.toHaveBeenCalled()
  })
})
