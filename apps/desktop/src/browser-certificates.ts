/** Human-only consent for local-device certificate failures in a lease-exclusive Session. */
import { X509Certificate } from 'node:crypto'
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

interface CertificateApproval {
  readonly origin: string
  readonly fingerprint: string
  readonly validStart: number
  readonly validExpiry: number
}

interface CertificateDecision extends CertificateApproval {
  readonly controller: AbortController
  readonly generation: number
  readonly address: string
  readonly callbacks: Array<{ readonly address: string; readonly finish: (trusted: boolean) => void }>
}

/**
 * Retain one approved origin and leaf fingerprint in this guest until replacement or disposal.
 * Only authority/name-invalid errors on a parsed, valid-date leaf allow consent for the current main-frame navigation.
 * Matching pending resources share consent, with each request's URL rechecked; changed fingerprints withdraw consent and approval.
 * Navigation cancels pending consent, not approval; no shared Session or hostname allowlist receives trust.
 * @param guest - exact native guest owned by the Browser lease.
 * @param owner - authenticated primary renderer that owns this lease.
 * @param eligible - live lease-exclusive guest ownership and existing navigation/website policy, rechecked before accepting.
 * @param confirm - Main-owned user confirmation; omitted means deny.
 * @returns disposer that denies pending callbacks, clears approval, and withdraws all listeners.
 */
export function bindBrowserCertificateErrors(guest: WebContents, owner: WebContents, eligible: (url: string) => boolean,
  confirm: ConfirmBrowserCertificate | undefined): () => void {
  if (confirm === undefined) return () => {}
  let target: string | undefined
  let generation = 0
  let approved: CertificateApproval | undefined
  let pending: CertificateDecision | undefined
  let disposed = false
  const cancelPending = (): void => {
    const decision = pending
    pending = undefined
    decision?.controller.abort()
  }
  const advance = (url: string): void => {
    target = navigationTarget(url)
    generation += 1
    cancelPending()
  }
  const isEligible = (address: string): boolean => {
    if (disposed) return false
    let allowed = false
    try { allowed = eligible(address) }
    catch (_error: unknown) { /* Failed ownership checks deny this request without starving other native callbacks. */ }
    return allowed && !disposed
  }
  const canConsent = (decision: CertificateDecision): boolean => isEligible(decision.address) && pending === decision
    && !decision.controller.signal.aborted && generation === decision.generation && target === decision.address
    && certificateCurrent(decision)
  const settleDecision = (decision: CertificateDecision, approval: CertificateApproval | undefined): void => {
    if (pending === decision) pending = undefined
    // Committed callbacks survive loading events, but never guest loss or withdrawal of this certificate.
    for (const { address, finish } of decision.callbacks.splice(0)) {
      finish(approval !== undefined && isEligible(address) && approved === approval && certificateCurrent(approval))
    }
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
    const requestGeneration = generation
    const address = navigationTarget(url)
    if (address === undefined || !localDevice(new URL(address).hostname)) { finish(false); return }
    const origin = new URL(address).origin
    const leaf = validCertificateLeaf(certificate)
    if (approved?.origin === origin && approved.fingerprint !== leaf?.fingerprint) approved = undefined
    if (pending?.origin === origin && pending.fingerprint !== leaf?.fingerprint) cancelPending()
    if (leaf === undefined || !isEligible(address) || !certificateCurrent(leaf)
      || !['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_COMMON_NAME_INVALID'].includes(error)) { finish(false); return }
    const { fingerprint, validStart, validExpiry } = leaf
    if (approved?.origin === origin && approved.fingerprint === fingerprint) { finish(true); return }
    if (requestGeneration !== generation || (mainFrame && address !== target)) { finish(false); return }
    if (pending !== undefined) {
      if (pending.generation === generation && pending.origin === origin && pending.fingerprint === fingerprint) {
        pending.callbacks.push({ address, finish })
      } else finish(false)
      return
    }
    if (!mainFrame || address !== target) { finish(false); return }
    const decision: CertificateDecision = {
      controller: new AbortController(), generation, address, origin, fingerprint, validStart, validExpiry,
      callbacks: [{ address, finish }],
    }
    pending = decision
    decision.controller.signal.addEventListener('abort', () => { settleDecision(decision, undefined) }, { once: true })
    void Promise.resolve().then(() => {
      if (!canConsent(decision)) return false
      return confirm({ owner, origin, fingerprint, signal: decision.controller.signal })
    }).then((accepted) => {
      const approval = accepted && canConsent(decision) ? { origin, fingerprint, validStart, validExpiry } : undefined
      if (approval !== undefined) approved = approval
      settleDecision(decision, approval)
    }).catch((_error: unknown) => { settleDecision(decision, undefined) })
  }
  const dispose = (): void => {
    disposed = true
    approved = undefined
    cancelPending()
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

/** Native certificate uncertainty denies consent, including an authority error masking invalid dates. */
function validCertificateLeaf(certificate: Electron.Certificate): Omit<CertificateApproval, 'origin'> | undefined {
  let leaf: X509Certificate
  try { leaf = new X509Certificate(certificate.data) }
  catch (_error: unknown) { return undefined /* Malformed native PEM cannot establish a certificate pin. */ }
  const validStart = leaf.validFromDate.getTime()
  const validExpiry = leaf.validToDate.getTime()
  const now = Date.now()
  if (!Number.isFinite(validStart) || !Number.isFinite(validExpiry) || validStart >= validExpiry
    || now < validStart || now >= validExpiry || certificate.validStart !== validStart / 1000
    || certificate.validExpiry !== validExpiry / 1000) return undefined
  const fingerprint = certificate.fingerprint
  const hexadecimal = leaf.fingerprint256.replaceAll(':', '')
  const nativeFingerprint = `sha256/${Buffer.from(hexadecimal, 'hex').toString('base64')}`
  const matchesNative = fingerprint === nativeFingerprint
  const matchesHexadecimal = /^(?:[0-9a-f]{64}|(?:[0-9a-f]{2}:){31}[0-9a-f]{2})$/iu.test(fingerprint)
    && fingerprint.replaceAll(':', '').toUpperCase() === hexadecimal
  if (!matchesNative && !matchesHexadecimal) return undefined
  return { fingerprint: leaf.fingerprint256, validStart, validExpiry }
}

function certificateCurrent(certificate: Pick<CertificateApproval, 'validStart' | 'validExpiry'>): boolean {
  const now = Date.now()
  return now >= certificate.validStart && now < certificate.validExpiry
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
