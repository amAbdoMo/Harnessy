/** Native calls are mocked; these cases do not qualify actual Windows taskbar presentation. */
import { EventEmitter } from 'node:events'
import { nativeImage, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent,
  type NativeImage, type WebContents, type WebFrameMain } from 'electron'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { assertDesktopSender, DESKTOP_IPC } from '../src/ipc.ts'
import { resolveDesktopLocale } from '../src/locale.ts'
import { DesktopTaskbarUnread, installDesktopTaskbarIpc } from '../src/taskbar-unread.ts'

const gdi = await vi.hoisted(async () => (await import('./gdi-mock.ts')).createGdiMock())
vi.mock('koffi', () => ({ default: gdi.koffi }))
const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return {
    preferences: new EventEmitter(),
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
  const setUnreadCount = (count: unknown, ticket = epoch): unknown => invoke(DESKTOP_IPC.taskbarSetUnreadCount, [count, ticket])
  const overlay = (): NativeImage | null => {
    const call = window.setOverlayIcon.mock.calls.at(-1)
    if (call === undefined) throw new Error('No overlay update')
    return call[0]
  }
  return { window, badge, handlers, detach, event, epoch, invoke, setUnreadCount, overlay,
    setLocale: (language: string) => { locale = resolveDesktopLocale(language) } }
}

function fixture() {
  const f = unreadyFixture()
  f.window.webContents.emit('dom-ready')
  return f
}

// Wire cases: zero clears, 1–99 render exactly, larger counts render 99+ without truncating accessible copy.
describe('Windows unread count', () => {
  it.each([1, 9, 10, 99, 100, Number.MAX_SAFE_INTEGER])('renders %s with its full localized accessible count and no accent subscription', (count) => {
    const f = fixture()
    f.setUnreadCount(count)
    expect(f.overlay()?.getSize()).toEqual({ width: 16, height: 16 })
    expect(gdi.calls.DrawTextW).toHaveBeenLastCalledWith(expect.anything(), count > 99 ? '99+' : String(count),
      count > 99 ? 3 : String(count).length, expect.anything(), expect.any(Number))
    expect(f.window.setOverlayIcon.mock.lastCall?.[1]).toBe(`Unread session completions: ${count}`)
    f.setLocale('zh')
    f.badge.repaint()
    expect(f.window.setOverlayIcon.mock.lastCall?.[1]).toBe(`${count} 个会话完成结果未读`)
    const calls = f.window.setOverlayIcon.mock.calls.length
    native.preferences.emit('accent-color-changed')
    expect(f.window.setOverlayIcon.mock.calls.length).toBe(calls)
    expect(native.preferences.listenerCount('accent-color-changed')).toBe(0)
    expect(gdi.owned.size).toBe(0)
    f.setUnreadCount(0)
    expect(f.overlay()).toBeNull()
    f.badge.repaint()
    expect(f.overlay()).toBeNull()
  })

  it.each(['raster', 'native image', 'native overlay'])('diagnoses %s failure without rejecting accepted count and recovers on repaint', (operation) => {
    const f = fixture()
    const failure = new Error(`${operation} unavailable`)
    const diagnostics = vi.spyOn(console, 'warn').mockImplementation(() => {})
    if (operation === 'raster') gdi.calls.DrawTextW!.mockImplementationOnce(() => { throw failure })
    if (operation === 'native image') vi.spyOn(nativeImage, 'createFromBitmap').mockImplementationOnce(() => { throw failure })
    if (operation === 'native overlay') f.window.setOverlayIcon.mockImplementationOnce(() => { throw failure })
    expect(() => f.setUnreadCount(123)).not.toThrow()
    expect(diagnostics).toHaveBeenCalledWith(expect.any(String), failure)
    expect(gdi.owned.size).toBe(0)
    f.setLocale('zh')
    expect(() => { f.badge.repaint() }).not.toThrow()
    expect(f.overlay()).not.toBeNull()
    expect(f.window.setOverlayIcon.mock.lastCall?.[1]).toBe('123 个会话完成结果未读')
    expect(diagnostics).toHaveBeenCalledOnce()
  })

  it.each(['count reset', 'main navigation'])('diagnoses native clear failure during %s without restoring retired count', (operation) => {
    const f = fixture()
    f.setUnreadCount(8)
    const failure = new Error('Overlay clear unavailable')
    const diagnostics = vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.window.setOverlayIcon.mockImplementationOnce(() => { throw failure })
    expect(() => {
      if (operation === 'count reset') f.setUnreadCount(0)
      else f.window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    }).not.toThrow()
    expect(diagnostics).toHaveBeenCalledWith(expect.any(String), failure)
    const calls = f.window.setOverlayIcon.mock.calls.length
    f.badge.repaint()
    expect(f.window.setOverlayIcon.mock.calls.length).toBe(calls)
  })

  it('rejects counts before dom-ready but accepts the current ready document while resources are loading', () => {
    const f = unreadyFixture()
    f.window.webContents.loading = true
    expect(() => f.setUnreadCount(7)).toThrow('stale application document')
    expect(f.overlay()).toBeNull()
    f.window.webContents.emit('dom-ready')
    expect(() => f.setUnreadCount(7)).not.toThrow()
    expect(f.window.webContents.isLoadingMainFrame()).toBe(true)
    expect(f.overlay()).not.toBeNull()
  })

  it.each(['same frame', 'replacement frame'])
  ('retires counts immediately on a same-origin reload with %s and rejects the old ticket after dom-ready', (reload) => {
    const f = fixture()
    f.setUnreadCount(7)
    f.window.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    f.window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(f.overlay()).not.toBeNull()
    f.window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(f.overlay()).toBeNull()
    expect(() => f.setUnreadCount(7)).toThrow('stale application document')
    if (reload === 'replacement frame') f.window.webContents.mainFrame = frame()
    f.window.webContents.loading = true
    const next = f.invoke(DESKTOP_IPC.taskbarDocument)
    expect(next).not.toBe(f.epoch)
    expect(() => f.setUnreadCount(7, next)).toThrow('stale application document')
    f.window.webContents.emit('dom-ready')
    expect(() => f.setUnreadCount(7)).toThrow('stale document ticket')
    expect(f.overlay()).toBeNull()
    f.setUnreadCount(7, next)
    expect(f.overlay()).not.toBeNull()
  })

  it.each(['render-process-gone', 'destroyed', 'closed'])('clears on %s and cannot be revived by late renderer or locale work', (event) => {
    const f = fixture()
    f.setUnreadCount(7)
    if (event === 'closed') f.window.emit(event)
    else f.window.webContents.emit(event)
    expect(f.overlay()).toBeNull()
    expect(() => f.setUnreadCount(7)).toThrow('stale application document')
    const calls = f.window.setOverlayIcon.mock.calls.length
    f.badge.repaint()
    expect(f.window.setOverlayIcon.mock.calls.length).toBe(calls)
  })

  it.each(['available', 'throwing'])('detaches owned listeners and IPC handlers with %s native clearing', (clearing) => {
    const f = fixture()
    f.setUnreadCount(7)
    const failure = new Error('Overlay clear unavailable')
    const diagnostics = vi.spyOn(console, 'warn').mockImplementation(() => {})
    if (clearing === 'throwing') f.window.setOverlayIcon.mockImplementationOnce(() => { throw failure })
    expect(() => { f.badge.dispose() }).not.toThrow()
    if (clearing === 'throwing') expect(diagnostics).toHaveBeenCalledWith(expect.any(String), failure)
    else expect(diagnostics).not.toHaveBeenCalled()
    f.badge.dispose()
    f.detach()
    expect(f.window.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
    expect(f.handlers.size).toBe(0)
    expect(f.window.webContents.eventNames()).toEqual([])
    expect(f.window.eventNames()).toEqual([])
    expect(() => { f.badge.setUnreadCount(f.event(), 7, f.epoch) }).toThrow('stale')
    const calls = f.window.setOverlayIcon.mock.calls.length
    f.badge.repaint()
    expect(f.window.setOverlayIcon.mock.calls.length).toBe(calls)
  })

  it.each([undefined, null, true, false, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', {}, []])
  ('refuses invalid IPC count %s without changing accepted state', (count) => {
    const f = fixture()
    f.setUnreadCount(7)
    const previous = f.overlay()
    expect(() => f.setUnreadCount(count)).toThrow('unread count must be a nonnegative safe integer')
    expect(f.overlay()).toBe(previous)
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
    expect(() => f.invoke(DESKTOP_IPC.taskbarSetUnreadCount, [7, f.epoch], event)).toThrow(/rejected|Rejected/u)
    if (caller !== 'process') expect(() => f.invoke(DESKTOP_IPC.taskbarDocument, [], event)).toThrow(/rejected|Rejected/u)
    expect(f.overlay()).toBeNull()
  })

  it('rolls back its document handler when count-handler registration fails', () => {
    const channels = new Set<string>()
    const ipc: Pick<IpcMain, 'handle' | 'removeHandler'> = {
      handle: (channel) => {
        if (channel === DESKTOP_IPC.taskbarSetUnreadCount) throw new Error('IPC conflict')
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
    const handler = handlers.get(DESKTOP_IPC.taskbarSetUnreadCount)
    if (handler === undefined) throw new Error('Missing taskbar handler')
    const event = { senderFrame: frame() } as IpcMainInvokeEvent
    expect(handler(event, 1, undefined)).toBeUndefined()
    expect(() => { handler(event, true, undefined) }).toThrow('unread count must be a nonnegative safe integer')
    expect(native.createFromBitmap).not.toHaveBeenCalled()
  })
})
