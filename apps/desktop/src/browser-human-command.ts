/** Executes bounded Human navigation in Main; renderer webview methods cannot enforce account reservations. */
import type { WebContents } from 'electron'
import type { DesktopBrowserHumanCommand } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

interface HumanBrowserGuest {
  readonly navigationHistory: Pick<WebContents['navigationHistory'], 'canGoBack' | 'goBack' | 'canGoForward' | 'goForward'>
  loadURL: WebContents['loadURL']
  reload: WebContents['reload']
}

function parseCommand(input: unknown, allowedUrl: (url: string) => boolean): DesktopBrowserHumanCommand {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || !Object.hasOwn(input, 'kind') || !('kind' in input)) {
    throw new Error('Desktop browser command rejected')
  }
  const kind = input.kind
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

function assertNever(_command: never): never { throw new Error('Desktop browser command rejected') }

/**
 * @param guest - exact live guest captured by the native lease owner.
 * @param input - untrusted renderer command; no Agent operation is accepted.
 * @param allowedUrl - application-host and credential exclusion for HTTP(S) loads.
 * @param humanAllowed - synchronous account reservation check immediately before native execution.
 * @returns after load settlement (including a superseded load) or history/reload dispatch.
 * Denied commands never touch native navigation; native failures omit private page diagnostics.
 */
export async function executeHumanBrowserCommand(guest: HumanBrowserGuest, input: unknown,
  allowedUrl: (url: string) => boolean, humanAllowed: () => boolean): Promise<void> {
  const command = parseCommand(input, allowedUrl)
  if (!humanAllowed()) throw new Error('Desktop browser requires Human Takeover')
  try {
    switch (command.kind) {
      case 'navigate': await guest.loadURL(command.url); return
      case 'back': if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack(); return
      case 'forward': if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward(); return
      case 'reload': guest.reload(); return
      default: return assertNever(command)
    }
  } catch (error: unknown) {
    if (command.kind === 'navigate' && typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_ABORTED') return
    throw new Error('Desktop browser native command failed')
  }
}
