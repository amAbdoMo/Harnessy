/** Executes bounded Human navigation and viewport fit in Main, retaining native account reservation checks. */
import type { WebContents } from 'electron'
import type { BrowserViewport, DesktopBrowserHumanCommand } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

interface HumanBrowserGuest {
  readonly navigationHistory: Pick<WebContents['navigationHistory'], 'canGoBack' | 'goBack' | 'canGoForward' | 'goForward'>
  loadURL: WebContents['loadURL']
  reload: WebContents['reload']
  setViewport?: (viewport: BrowserViewport) => Promise<void>
  navigationReady?: () => Promise<void>
}

function parseCommand(input: unknown, allowedUrl: (url: string) => boolean): DesktopBrowserHumanCommand {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || !Object.hasOwn(input, 'kind') || !('kind' in input)) {
    throw new Error('Desktop browser command rejected')
  }
  const kind = input.kind
  if (kind === 'preview-viewport') {
    if (Object.keys(input).length !== 2 || !Object.hasOwn(input, 'viewport') || !('viewport' in input)) {
      throw new Error('Desktop browser command rejected')
    }
    return { kind, viewport: parseViewport(input.viewport) }
  }
  if (kind === 'navigate') {
    if (Object.keys(input).length !== 2 || !Object.hasOwn(input, 'url') || !('url' in input) || typeof input.url !== 'string'
      || Buffer.byteLength(input.url, 'utf8') > 4096 || !allowedUrl(input.url)) {
      throw new Error('Desktop browser command rejected')
    }
    return { kind, url: input.url }
  }
  if ((kind !== 'back' && kind !== 'forward' && kind !== 'reload') || Object.keys(input).length !== 1) {
    throw new Error('Desktop browser command rejected')
  }
  return { kind }
}

function parseViewport(input: unknown): BrowserViewport {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).length !== 3
    || !Object.hasOwn(input, 'width') || !('width' in input) || typeof input.width !== 'number'
    || !Object.hasOwn(input, 'height') || !('height' in input) || typeof input.height !== 'number'
    || !Object.hasOwn(input, 'scale') || !('scale' in input) || typeof input.scale !== 'number'
    || !Number.isInteger(input.width) || input.width < 1 || input.width > 8192
    || !Number.isInteger(input.height) || input.height < 1 || input.height > 8192
    || !Number.isFinite(input.scale) || input.scale <= 0 || input.scale > 1) {
    throw new Error('Desktop browser command rejected')
  }
  return { width: input.width, height: input.height, scale: input.scale }
}

function assertNever(_command: never): never { throw new Error('Desktop browser command rejected') }

/**
 * @param guest - exact live guest captured by the native lease owner.
 * @param input - untrusted renderer command; no Agent operation is accepted.
 * @param allowedUrl - application-host and credential exclusion for HTTP(S) loads.
 * @param humanAllowed - synchronous account reservation check immediately before native execution.
 * @returns after load settlement (including a superseded load), history/reload dispatch or native metrics acknowledgement.
 * Unsupported viewport adapters reject before admission; native failures omit private page diagnostics.
 */
export async function executeHumanBrowserCommand(guest: HumanBrowserGuest, input: unknown,
  allowedUrl: (url: string) => boolean, humanAllowed: () => boolean): Promise<void> {
  const command = parseCommand(input, allowedUrl)
  if (command.kind === 'preview-viewport' && guest.setViewport === undefined) throw new Error('Desktop browser native command failed')
  if (!humanAllowed()) throw new Error('Desktop browser requires Human Takeover')
  try {
    if (command.kind !== 'preview-viewport' && guest.navigationReady !== undefined) {
      await guest.navigationReady()
      if (!humanAllowed()) throw new Error('Desktop browser requires Human Takeover')
    }
    switch (command.kind) {
      case 'navigate': await guest.loadURL(command.url); return
      case 'back': if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack(); return
      case 'forward': if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward(); return
      case 'reload': guest.reload(); return
      case 'preview-viewport':
        if (guest.setViewport === undefined) throw new Error('Desktop browser viewport unavailable')
        await guest.setViewport(command.viewport)
        return
      default: return assertNever(command)
    }
  } catch (error: unknown) {
    if (command.kind === 'navigate' && typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_ABORTED') return
    throw new Error('Desktop browser native command failed')
  }
}
