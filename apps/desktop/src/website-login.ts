/** Main-owned login coordination for fixed conventional website form adapters. */
import type { Event as ElectronEvent, WebContents, WebContentsDidStartNavigationEventParams } from 'electron'
import type { DesktopWebsiteProfileId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DesktopWebsiteCredentials, type DesktopWebsiteLoginSecret } from './website-credentials.ts'

/** Public profile facts needed to decide whether automatic sign-in is permitted. */
export interface DesktopWebsiteLoginProfile {
  readonly id: DesktopWebsiteProfileId
  readonly url: string
  readonly access: 'automatic' | 'ask' | 'disabled'
}

/** Result of an automatic conventional-form attempt. */
export type DesktopWebsiteLoginOutcome = 'not-needed' | 'submitted' | 'unavailable'

/** Fixed Main-owned adapter for an ordinary username/password form. */
export interface DesktopWebsiteLoginForm {
  /** @returns the page address at the instant login fields will be inspected. */
  currentUrl(): string
  /** @param signal - request lifetime. @returns whether this top-level page has one safe conventional login form. */
  inspect(signal?: AbortSignal): Promise<'login' | 'not-needed' | 'unavailable'>
  /**
   * Fills a conventional form without exposing values to renderer IPC, model tools or logs.
   * @param secret - decrypted values scoped to this call.
   * @param signal - request lifetime.
   * @returns submitted only after navigation settles on a page without another login or MFA form.
   */
  fillAndSubmit(secret: DesktopWebsiteLoginSecret, signal?: AbortSignal): Promise<'submitted' | 'unavailable'>
}

type LoginWebContents = Pick<WebContents, 'isDestroyed' | 'getURL'> & Pick<NodeJS.EventEmitter, 'on' | 'off'> & {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
}
type StartNavigationListener = (details: ElectronEvent<WebContentsDidStartNavigationEventParams>, url: string,
  isInPlace: boolean, isMainFrame: boolean, frameProcessId: number, frameRoutingId: number) => void
type FailedNavigationListener = (event: ElectronEvent, errorCode: number, errorDescription: string, validatedURL: string,
  isMainFrame: boolean, frameProcessId: number, frameRoutingId: number) => void
type InPageNavigationListener = (event: ElectronEvent, url: string, isMainFrame: boolean,
  frameProcessId: number, frameRoutingId: number) => void

const CONVENTIONAL_LOGIN_SCRIPT = String.raw`input => {
  const { expectedOrigin, mode } = input
  if (location.origin !== expectedOrigin || window.top !== window) return 'unavailable'
  const visible = element => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return !element.disabled && style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0
  }
  const oneTimeCode = [...document.querySelectorAll('input')].some(field => visible(field)
    && (field.autocomplete === 'one-time-code' || /(^|[-_])(otp|totp|2fa|mfa|code)([-_]|$)/i.test(field.name)))
  if (oneTimeCode) return 'unavailable'
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible)
  if (passwords.length === 0) {
    const usernameOnly = [...document.querySelectorAll('input')].some(field => visible(field)
      && (field.autocomplete === 'username' || field.type === 'email'
        || (field.type === 'text' && /user|email|login|account/i.test(field.name + ' ' + field.id))))
    return usernameOnly && /\/(login|sign-?in|auth)(\/|[.?_-]|$)/i.test(location.pathname) ? 'unavailable' : 'not-needed'
  }
  if (passwords.length !== 1 || passwords[0].autocomplete === 'new-password') return 'unavailable'
  const passwordField = passwords[0]
  const form = passwordField.form
  if (form === null || form.method.toLowerCase() !== 'post') return 'unavailable'
  const action = new URL(form.action || location.href, location.href)
  if (action.origin !== expectedOrigin) return 'unavailable'
  const candidates = [...form.querySelectorAll('input')].filter(field => visible(field)
    && field !== passwordField && !field.readOnly && (field.autocomplete === 'username' || field.type === 'email'
      || (field.type === 'text' && /user|email|login|account/i.test(field.name + ' ' + field.id))))
  const submitters = [...form.querySelectorAll('button[type="submit"], button:not([type]), input[type="submit"]')].filter(visible)
  if (candidates.length !== 1 || submitters.length !== 1) return 'unavailable'
  const submitAction = new URL(submitters[0].getAttribute('formaction') || form.action || location.href, location.href)
  const target = submitters[0].getAttribute('formtarget') || form.target
  if (submitAction.origin !== expectedOrigin || submitAction.username || submitAction.password
    || (target !== '' && target !== '_self')) return 'unavailable'
  if (mode === 'inspect') return 'login'
  const setValue = (field, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter === undefined) return false
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  if (!setValue(candidates[0], input.username) || !setValue(passwordField, input.password)) return 'unavailable'
  form.requestSubmit(submitters[0])
  return 'submitted'
}`

async function inspectLoginForm(contents: LoginWebContents, expectedOrigin: string, signal?: AbortSignal):
Promise<'login' | 'not-needed' | 'unavailable'> {
  signal?.throwIfAborted()
  if (contents.isDestroyed()) return 'unavailable'
  const scriptInput = JSON.stringify({ expectedOrigin, mode: 'inspect' })
  const outcome: unknown = await contents.executeJavaScript(`(${CONVENTIONAL_LOGIN_SCRIPT})(${scriptInput})`, true)
  signal?.throwIfAborted()
  return outcome === 'login' || outcome === 'not-needed' ? outcome : 'unavailable'
}

async function submitLoginForm(contents: LoginWebContents, expectedOrigin: string,
  secret: DesktopWebsiteLoginSecret, signal?: AbortSignal): Promise<'submitted' | 'unavailable'> {
  signal?.throwIfAborted()
  if (contents.isDestroyed()) return 'unavailable'
  const settled: PromiseWithResolvers<'settled' | 'unavailable'> = Promise.withResolvers()
  void settled.promise.catch((_error: unknown) => { /* The navigation owner awaits and reports cancellation after script settlement. */ })
  let submitted = false
  let mainNavigationStarted = false
  let mainNavigationFinished = false
  const finishIfReady = (): void => {
    if (submitted && mainNavigationStarted && mainNavigationFinished) settled.resolve('settled')
  }
  const started: StartNavigationListener = (details) => {
    if (details.isMainFrame) mainNavigationStarted = true
  }
  const finished = (): void => { mainNavigationFinished = true; finishIfReady() }
  const failed: FailedNavigationListener = (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) settled.resolve('unavailable')
  }
  const inPage: InPageNavigationListener = (_event, _url, isMainFrame) => {
    if (isMainFrame) { mainNavigationStarted = true; mainNavigationFinished = true; finishIfReady() }
  }
  const destroyed = (): void => { settled.resolve('unavailable') }
  const aborted = (): void => { settled.reject(signal?.reason) }
  contents.on('did-start-navigation', started)
  contents.on('did-finish-load', finished)
  contents.on('did-fail-load', failed)
  contents.on('did-navigate-in-page', inPage)
  contents.on('destroyed', destroyed)
  signal?.addEventListener('abort', aborted, { once: true })
  try {
    const scriptInput = JSON.stringify({ expectedOrigin, mode: 'fill', username: secret.username, password: secret.password })
    const outcome: unknown = await contents.executeJavaScript(`(${CONVENTIONAL_LOGIN_SCRIPT})(${scriptInput})`, true)
    signal?.throwIfAborted()
    if (outcome !== 'submitted') return 'unavailable'
    submitted = true
    finishIfReady()
    if (await settled.promise !== 'settled' || contents.isDestroyed()) return 'unavailable'
    return await inspectLoginForm(contents, expectedOrigin, signal) === 'not-needed' ? 'submitted' : 'unavailable'
  } finally {
    contents.off('did-start-navigation', started)
    contents.off('did-finish-load', finished)
    contents.off('did-fail-load', failed)
    contents.off('did-navigate-in-page', inPage)
    contents.off('destroyed', destroyed)
    signal?.removeEventListener('abort', aborted)
  }
}

/**
 * Creates a fixed top-frame conventional login adapter for one exact website origin.
 * @param contents - attached saved-profile guest owned by Main.
 * @param allowedUrl - current saved profile URL.
 * @returns a form adapter that rejects cross-origin actions, iframes, MFA and password-change forms.
 */
export function electronWebsiteLoginForm(contents: LoginWebContents, allowedUrl: string): DesktopWebsiteLoginForm {
  const expectedOrigin = new URL(allowedUrl).origin
  return {
    currentUrl: () => contents.getURL(),
    inspect: signal => inspectLoginForm(contents, expectedOrigin, signal),
    fillAndSubmit: (secret, signal) => submitLoginForm(contents, expectedOrigin, secret, signal),
  }
}

/** Uses protected credentials only for enabled same-origin automatic login. */
export class DesktopWebsiteLogin {
  /** @param credentials - protected Main-only vault. */
  constructor(private readonly credentials: DesktopWebsiteCredentials) {}

  /**
   * Attempts a fixed conventional form flow. Redirected or non-automatic pages are left untouched.
   * @param profile - saved website and access decision.
   * @param form - trusted Main-owned form adapter.
   * @param signal - request lifetime.
   * @returns the settled login result without credential values.
   */
  async signInAutomatically(profile: DesktopWebsiteLoginProfile, form: DesktopWebsiteLoginForm,
    signal?: AbortSignal): Promise<DesktopWebsiteLoginOutcome> {
    signal?.throwIfAborted()
    if (profile.access !== 'automatic') return 'not-needed'
    const expected = new URL(profile.url)
    const current = new URL(form.currentUrl())
    if (!['http:', 'https:'].includes(current.protocol) || current.origin !== expected.origin) return 'unavailable'
    const inspection = await form.inspect(signal)
    if (inspection !== 'login') return inspection
    let outcome: DesktopWebsiteLoginOutcome = 'unavailable'
    const found = await this.credentials.use(profile.id, async (secret) => {
      signal?.throwIfAborted()
      outcome = await form.fillAndSubmit(secret, signal)
    })
    return found ? outcome : 'unavailable'
  }
}
