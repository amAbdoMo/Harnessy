/** Electron tag DOM inside a Sidebar-owned, stable content container. */
import type { DesktopBrowserReservation } from '../../types.ts'
import type { BrowserPresentation } from '../view/BrowserPresentation.ts'
import css from '../view/Browser.module.css'

/** The Electron tag API used by its navigation provider. */
export interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  clearHistory(): void
  goBack(): void
  goForward(): void
  reload(): void
  isLoading(): boolean
  getZoomFactor?(): number
  findInPage?(text: string, options: { readonly forward: boolean; readonly findNext: boolean }): number
  stopFindInPage?(action: 'clearSelection'): void
}

/** Physical attachment notifications; hiding a retained Sidebar body emits neither. */
export interface ElectronPresentationEvents {
  readonly mounted: () => void
  readonly unmounted: () => void
}

/** Owns tag attachment and fits fixed-size ordinary guests within the Sidebar. */
export class ElectronWebviewPresentation implements BrowserPresentation {
  private element: WebviewElement | undefined
  private host: HTMLElement | undefined
  private fit: ResizeObserver | undefined
  private viewportBox: HTMLElement | undefined

  constructor(private readonly events: ElectronPresentationEvents,
    private readonly dimensions?: { readonly width: number; readonly height: number }) {}

  /** @param viewportId - committed content container. @returns ends attachment and releases its guest. */
  mount(viewportId: string): () => void {
    const host = document.getElementById(viewportId)
    if (host === null) throw new Error('Electron presentation: content container is not mounted')
    if (this.host !== undefined) this.events.unmounted()
    this.host = host
    this.events.mounted()
    return () => {
      if (this.host !== host) return
      this.events.unmounted()
      this.host = undefined
    }
  }

  /**
   * Configure a detached webview for an approved guest reservation.
   * @param reservation - main-approved partition and bootstrap lease.
   * @returns a detached, configured webview.
   */
  createElement(reservation: DesktopBrowserReservation): WebviewElement {
    const element = document.createElement('webview') as WebviewElement
    element.className = css.webview as string
    element.dataset.sidebarBrowserFrame = 'webview'
    element.setAttribute('name', reservation.lease)
    element.setAttribute('partition', reservation.partition)
    element.setAttribute('allowpopups', '')
    element.setAttribute('src', 'about:blank#' + reservation.lease)
    return element
  }

  /**
   * Attach a prepared guest, removing any previous guest DOM from the container.
   * @param element - configured guest with its navigation listeners already installed.
   * @throws when no content container is mounted.
   */
  present(element: WebviewElement): void {
    if (this.host === undefined) throw new Error('Electron presentation: cannot attach without a content container')
    this.clear()
    this.element = element
    const host = this.host
    const dimensions = this.dimensions
    if (dimensions === undefined) { host.append(element); return }
    const box = document.createElement('div')
    box.className = css.fixedViewport as string
    element.classList.add(css.fixedViewportGuest as string)
    element.style.width = `${dimensions.width}px`
    element.style.height = `${dimensions.height}px`
    const fit = (width: number, height: number): void => {
      if (width === 0 || height === 0) return
      const scale = Math.min(1, width / dimensions.width, height / dimensions.height)
      box.style.width = `${dimensions.width * scale}px`
      box.style.height = `${dimensions.height * scale}px`
      element.style.transform = `scale(${scale})`
    }
    fit(host.clientWidth, host.clientHeight)
    box.append(element)
    host.append(box)
    this.viewportBox = box
    this.fit = new ResizeObserver(([entry]) => {
      if (entry !== undefined && this.viewportBox === box) fit(entry.contentRect.width, entry.contentRect.height)
    })
    this.fit.observe(host)
  }

  /**
   * Set the guest element's accessible label.
   * @param title - observed document title.
   */
  show(title: string): void {
    this.element?.setAttribute('aria-label', title)
  }

  /** Destroy only the guest DOM; a replacement may use the same mounted container. */
  clear(): void {
    this.fit?.disconnect()
    this.fit = undefined
    this.element?.remove()
    this.element = undefined
    this.viewportBox?.remove()
    this.viewportBox = undefined
  }

  /** Destroy the guest DOM and release its content container. */
  dispose(): void {
    this.clear()
    this.host = undefined
  }
}
