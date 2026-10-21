/** Windows taskbar overlay owned by one primary window and its current application document. */

import { nativeImage, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent,
  type NativeImage, type WebFrameMain, type WebContentsDidStartNavigationEventParams } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'
import type { DesktopLocale } from './locale.ts'
import { taskbarUnreadBitmap } from './taskbar-badge.ts'

/** Primary-window overlay; new main-document navigation and renderer loss immediately retire unread state and tickets. */
export class DesktopTaskbarUnread {
  private unreadCount = 0
  private disposed = false
  private epoch = 0
  private frame: WebFrameMain | undefined
  private frameProcess = -1
  private frameRouting = -1

  /** @param window - exact primary native window. @param locale - current shell accessible copy. */
  constructor(private readonly window: BrowserWindow, private readonly locale: () => DesktopLocale) {
    this.clear()
    window.webContents.on('dom-ready', this.captureDocument)
    window.webContents.on('did-start-navigation', this.navigate)
    window.webContents.on('render-process-gone', this.retireDocument)
    window.webContents.on('destroyed', this.dispose)
    window.on('closed', this.dispose)
  }

  private readonly captureDocument = (): void => {
    if (this.disposed || this.window.isDestroyed() || this.window.webContents.isDestroyed()) return
    const frame = this.window.webContents.mainFrame
    this.frame = frame
    this.frameProcess = frame.processId
    this.frameRouting = frame.routingId
  }

  private readonly navigate = (details: WebContentsDidStartNavigationEventParams): void => {
    if (details.isMainFrame && !details.isSameDocument) this.retireDocument()
  }

  private readonly retireDocument = (): void => {
    this.epoch++
    this.frame = undefined
    this.clear()
  }

  private assertDocument(event: IpcMainInvokeEvent): void {
    const contents = this.window.webContents
    const frame = event.senderFrame
    if (this.disposed || this.window.isDestroyed() || contents.isDestroyed()
      || event.sender !== contents || frame === null || frame !== this.frame || frame !== contents.mainFrame
      || frame.isDestroyed() || frame.detached || frame.processId !== this.frameProcess || frame.routingId !== this.frameRouting) {
      throw new Error('Desktop taskbar: rejected stale application document')
    }
  }

  /** @param event - authenticated primary top-frame caller. @returns ticket invalidated at document retirement. */
  documentEpoch(event: IpcMainInvokeEvent): number {
    const contents = this.window.webContents
    const frame = event.senderFrame
    if (this.disposed || this.window.isDestroyed() || contents.isDestroyed() || event.sender !== contents
      || frame === null || frame !== contents.mainFrame || frame.isDestroyed() || frame.detached) {
      throw new Error('Desktop taskbar: rejected stale application document')
    }
    return this.epoch
  }

  /**
   * Apply authoritative unread state only after the current document's dom-ready; native paint failures are diagnosed.
   * @param event - authenticated primary top-frame caller.
   * @param count - accepted nonnegative safe-integer count of ordinary Sessions with unread completions.
   * @param epoch - private preload ticket captured before dispatch.
   */
  setUnreadCount(event: IpcMainInvokeEvent, count: number, epoch: unknown): void {
    this.assertDocument(event)
    if (epoch !== this.epoch) throw new Error('Desktop taskbar: rejected stale document ticket')
    if (count === 0) { this.clear(); return }
    this.unreadCount = count
    this.repaint()
  }

  private clear(): void {
    this.unreadCount = 0
    this.setOverlay(null, '')
  }

  private setOverlay(image: NativeImage | null, description: string): void {
    if (this.window.isDestroyed()) return
    try { this.window.setOverlayIcon(image, description) } catch (error) {
      console.warn('Desktop taskbar: could not update overlay', error)
    }
  }

  /** Refresh localized copy; diagnosed native paint failures preserve unread for the next repaint. */
  readonly repaint = (): void => {
    if (this.disposed || this.unreadCount === 0 || this.window.isDestroyed()) return
    let bitmap: Buffer
    try { bitmap = taskbarUnreadBitmap(this.unreadCount) } catch (error) {
      console.warn('Desktop taskbar: could not rasterize unread count', error)
      return
    }
    let image: NativeImage
    try { image = nativeImage.createFromBitmap(bitmap, { width: 16, height: 16 }) } catch (error) {
      console.warn('Desktop taskbar: could not create overlay image', error)
      return
    }
    this.setOverlay(image, this.locale().messages.taskbarUnread.replace('{count}', String(this.unreadCount)))
  }

  /** Detach every listener and attempt native clearing; late callbacks stay inert even if diagnosed clearing fails. */
  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.window.webContents.off('dom-ready', this.captureDocument)
    this.window.webContents.off('did-start-navigation', this.navigate)
    this.window.webContents.off('render-process-gone', this.retireDocument)
    this.window.webContents.off('destroyed', this.dispose)
    this.window.off('closed', this.dispose)
    this.retireDocument()
  }
}

/**
 * Install private taskbar IPC; non-Windows callers authenticate and validate but do not touch native state.
 * @param ipc - main-process handler registration owner.
 * @param authorize - existing exact primary-window, top-frame and app-origin guard.
 * @param current - Windows overlay owner, absent on other platforms or after teardown.
 * @returns disposer of both private handlers.
 */
export function installDesktopTaskbarIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  authorize: (event: IpcMainInvokeEvent) => void, current: () => DesktopTaskbarUnread | undefined): () => void {
  const assertSender = (event: IpcMainInvokeEvent): void => {
    authorize(event)
    const frame = event.senderFrame
    if (frame === null) throw new Error('Desktop taskbar: rejected missing sender frame')
    const url = new URL(frame.url)
    if (url.host !== 'app' || url.username !== '' || url.password !== '') {
      throw new Error('Desktop taskbar: rejected application origin')
    }
  }
  ipc.handle(DESKTOP_IPC.taskbarDocument, (event) => { assertSender(event); return current()?.documentEpoch(event) })
  try {
    ipc.handle(DESKTOP_IPC.taskbarSetUnreadCount, (event, count: unknown, epoch: unknown) => {
      assertSender(event)
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        throw new Error('Desktop taskbar: unread count must be a nonnegative safe integer')
      }
      current()?.setUnreadCount(event, count, epoch)
    })
  } catch (error) {
    ipc.removeHandler(DESKTOP_IPC.taskbarDocument)
    throw error
  }
  let attached = true
  return () => {
    if (!attached) return
    attached = false
    ipc.removeHandler(DESKTOP_IPC.taskbarDocument)
    ipc.removeHandler(DESKTOP_IPC.taskbarSetUnreadCount)
  }
}
