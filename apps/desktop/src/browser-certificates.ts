/** Human-only consent for local-device certificate failures in a lease-exclusive Session. */
import { isIP } from 'node:net'
import type { WebContents } from 'electron'

/** Main-owned certificate details; no page path, query, certificate subject, or native callback reaches the dialog. */
export interface BrowserCertificatePrompt {
  readonly owner: WebContents
  readonly origin: string
  readonly fingerprint: string
  readonly signal: AbortSignal
}

/** A trusted shell decision; absence of a confirmation capability leaves TLS validation unchanged. */
export type ConfirmBrowserCertificate = (prompt: BrowserCertificatePrompt) => Promise<boolean>

/**
 * Bind explicit consent to the current main-frame navigation, never to a shared Session or hostname allowlist.
 * @param guest - exact native guest owned by the Browser lease.
 * @param owner - authenticated primary renderer that owns this lease.
 * @param eligible - live ordinary-guest ownership and existing navigation policy, rechecked before accepting.
 * @param confirm - Main-owned user confirmation; omitted means deny.
 * @returns disposer that denies any pending callback and withdraws all listeners.
 */
export function bindBrowserCertificateErrors(guest: WebContents, owner: WebContents, eligible: (url: string) => boolean,
  confirm: ConfirmBrowserCertificate | undefined): () => void {
  if (confirm === undefined) return () => {}
  let target: string | undefined
  let pending: AbortController | undefined
  let disposed = false
  const advance = (url: string): void => {
    pending?.abort()
    pending = undefined
    target = navigationTarget(url)
  }
  const started = (event: { isMainFrame: boolean; isSameDocument: boolean; url: string }): void => {
    if (event.isMainFrame && !event.isSameDocument) advance(event.url)
  }
  const redirected = (_event: Electron.Event, url: string, _inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame) advance(url)
  }
  const stopped = (): void => {
    if (!guest.isLoading()) advance('')
  }
  const loadFailed = (_event: Electron.Event, _code: number, _description: string, url: string, mainFrame: boolean): void => {
    if (mainFrame && navigationTarget(url) === target && !guest.isLoading()) advance('')
  }
  const certificateError = (event: Electron.Event, url: string, error: string, certificate: Electron.Certificate,
    callback: (trusted: boolean) => void, mainFrame: boolean): void => {
    event.preventDefault()
    let settled = false
    const finish = (trusted: boolean): void => {
      if (settled) return
      settled = true
      try { callback(trusted) }
      catch (_error: unknown) { /* A canceled native request may have already destroyed its callback. */ }
    }
    const address = navigationTarget(url)
    if (disposed || !mainFrame || error !== 'net::ERR_CERT_AUTHORITY_INVALID'
      || address === undefined || address !== target || !localDevice(new URL(address).hostname)
      || !eligible(address) || pending !== undefined) { finish(false); return }
    const decision = new AbortController()
    pending = decision
    decision.signal.addEventListener('abort', () => { finish(false) }, { once: true })
    const fingerprint = certificate.fingerprint
    void Promise.resolve().then(() => {
      if (decision.signal.aborted) return false
      return confirm({ owner, origin: new URL(address).origin, fingerprint, signal: decision.signal })
    }).then((accepted) => {
      finish(accepted && !decision.signal.aborted && !disposed && target === address && eligible(address))
    }).catch((_error: unknown) => { finish(false) }).finally(() => {
      if (pending === decision) pending = undefined
    })
  }
  const dispose = (): void => {
    disposed = true
    pending?.abort()
    pending = undefined
    guest.removeListener('did-start-navigation', started)
    guest.removeListener('will-redirect', redirected)
    guest.removeListener('certificate-error', certificateError)
    guest.removeListener('did-stop-loading', stopped)
    guest.removeListener('did-fail-load', loadFailed)
    guest.removeListener('did-fail-provisional-load', loadFailed)
    guest.removeListener('destroyed', dispose)
    guest.removeListener('render-process-gone', dispose)
  }
  guest.on('did-start-navigation', started)
  guest.on('will-redirect', redirected)
  guest.on('certificate-error', certificateError)
  guest.on('did-stop-loading', stopped)
  guest.on('did-fail-load', loadFailed)
  guest.on('did-fail-provisional-load', loadFailed)
  guest.once('destroyed', dispose)
  guest.once('render-process-gone', dispose)
  return dispose
}

/** @param value - candidate address. @returns literal-local HTTPS origin, or undefined without local-device eligibility. */
export function localBrowserDeviceOrigin(value: string): string | undefined {
  const address = navigationTarget(value)
  if (address === undefined) return undefined
  const url = new URL(address)
  return localDevice(url.hostname) ? url.origin : undefined
}

function navigationTarget(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined
  url.hash = ''
  return url.href
}

/** Literal loopback, private and link-local addresses; DNS names never imply a trusted local network. */
function localDevice(hostname: string): boolean {
  if (hostname === 'localhost') return true
  const address = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
  if (isIP(address) === 4) {
    const [first, second] = address.split('.').map(Number)
    return first === 10 || first === 127 || (first === 192 && second === 168)
      || (first === 172 && second !== undefined && second >= 16 && second <= 31) || (first === 169 && second === 254)
  }
  if (isIP(address) !== 6) return false
  return address === '::1' || /^(?:fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/iu.test(address)
}
