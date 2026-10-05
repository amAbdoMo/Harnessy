/**
 * Bounded execution on one captured Electron website guest. Host owns per-operation
 * allowed-once consent and authority; this module neither acquires nor extends them.
 * Evaluation runs arbitrary code in a persistent isolated world, NOT the page's JS
 * global environment or a security sandbox. DOM, cookies and storage remain accessible;
 * separate explicit Host consent must describe sensitive-data access and site mutation.
 * Fixed helpers use a different isolated world; evaluation serialization retains trusted
 * intrinsics before supplied code runs and bounds bytes before native IPC. Byte limits do not
 * bound JavaScript CPU time. Abort withholds results but waits for native settlement.
 * Native promise rejection details are suppressed because page errors can contain secrets.
 */
import type { NativeImage, Rectangle, WebSource } from 'electron'

/** Fixed security limits; the Host parser must enforce these before asking consent. */
export const WEBSITE_BROWSER_LIMITS = Object.freeze({
  selectorBytes: 512, fillBytes: 8192, scriptBytes: 16 * 1024, urlBytes: 4096,
  elements: 32, textChars: 2048, totalTextChars: 4096, jsonBytes: 32 * 1024, jsonDepth: 8, jsonNodes: 1024,
  screenshotBytes: 1024 * 1024, viewportDimension: 4096, clipDimension: 1024,
  imageDimension: 2048,
})

/** Device-independent clip coordinates; executor requires nonnegative integer positions and positive bounded dimensions. */
export interface WebsiteBrowserClip {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Only top-document light DOM is addressed. Reads return text/tag/rect projections,
 * excluding controls, never HTML, attributes or form values. Fixed DOM operations and
 * screenshots reject entire detected credential/OTP documents, including form-less containers.
 * Selectors allow tags, IDs, classes, descendants and child combinators; attribute
 * predicates and pseudo-selectors are refused to avoid value-dependent read queries.
 */
export type WebsiteBrowserOperation =
  | { readonly kind: 'dom-read'; readonly selector: string; readonly maxElements: number; readonly maxTextChars: number }
  | { readonly kind: 'click'; readonly selector: string }
  | { readonly kind: 'fill'; readonly selector: string; readonly text: string }
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'evaluate'; readonly code: string }
  | { readonly kind: 'screenshot'; readonly clip: WebsiteBrowserClip }

/** JSON-only values; result serialization refuses accessors, non-finite numbers and non-JSON objects. */
export type WebsiteBrowserJson = null | boolean | number | string | WebsiteBrowserJson[] | { [key: string]: WebsiteBrowserJson }

/** Mutations report only an attempted operation, never remote save or navigation completion. */
export type WebsiteBrowserResult =
  | { readonly kind: 'json'; readonly value: WebsiteBrowserJson }
  | { readonly kind: 'screenshot'; readonly png: Uint8Array; readonly width: number; readonly height: number }

/** Electron navigation notification; only main-frame navigation is constrained here. */
export interface WebsiteBrowserNavigationEvent {
  readonly url: string
  readonly isMainFrame: boolean
  preventDefault(): void
}

/** Structural Electron adapter for a captured WebContents; no browser lookup or feature services. */
export interface WebsiteBrowserGuest {
  readonly mainFrame: { readonly frames: readonly unknown[] }
  isDestroyed(): boolean
  getURL(): string
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: WebSource[], userGesture?: boolean): Promise<unknown>
  loadURL(url: string): Promise<void>
  capturePage(rect: Rectangle): Promise<Pick<NativeImage, 'isEmpty' | 'getSize' | 'toPNG'>>
  on(event: 'will-navigate' | 'will-redirect', listener: (event: WebsiteBrowserNavigationEvent) => void): unknown
  on(event: 'frame-created', listener: () => void): unknown
  removeListener(event: 'will-navigate' | 'will-redirect', listener: (event: WebsiteBrowserNavigationEvent) => void): unknown
  removeListener(event: 'frame-created', listener: () => void): unknown
}

/** Host must capture the guest and approved normalized HTTP(S) origin before invocation. */
export interface WebsiteBrowserExecution {
  readonly guest: WebsiteBrowserGuest
  readonly approvedOrigin: string
  readonly signal: AbortSignal
  /** Synchronously throws if the captured authority is no longer valid. */
  readonly assertAuthority: () => void
}

const CONTROL = /[\p{Cc}\p{Cf}]/u
const SIMPLE = '(?:[a-zA-Z][a-zA-Z0-9-]*|\\*|[.#][a-zA-Z_][a-zA-Z0-9_-]*)(?:[.#][a-zA-Z_][a-zA-Z0-9_-]*)*'
const SELECTOR = new RegExp(`^${SIMPLE}(?:(?: +| *> *)${SIMPLE})*$`)

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, bytes: number, empty = false): value is string {
  return typeof value === 'string' && (empty || value.length > 0) && Buffer.byteLength(value) <= bytes
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

function selector(value: unknown): value is string {
  return boundedString(value, WEBSITE_BROWSER_LIMITS.selectorBytes) && SELECTOR.test(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function httpURL(address: string): URL {
  if (!boundedString(address, WEBSITE_BROWSER_LIMITS.urlBytes) || CONTROL.test(address)
    || address.trim() !== address || address.includes('\\')) throw new Error('Website URL rejected')
  const authority = /^https?:\/\/([^/?#]+)/i.exec(address)?.[1]
  if (!authority || authority.includes('@')) throw new Error('Website URL rejected')
  let url: URL
  try { url = new URL(address) }
  catch (_error: unknown) { throw new Error('Website URL rejected') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Website URL rejected')
  return url
}

/**
 * Validate operation arguments at the IPC/parser and executor entry points.
 * @param value - Untrusted operation, excluding authority and consent records.
 * @returns Whether all operation fields are bounded and no extra fields are present.
 */
export function isWebsiteBrowserOperation(value: unknown): value is WebsiteBrowserOperation {
  if (!record(value)) return false
  switch (value.kind) {
    case 'dom-read': return exactKeys(value, ['kind', 'selector', 'maxElements', 'maxTextChars']) && selector(value.selector)
      && integer(value.maxElements, 1, WEBSITE_BROWSER_LIMITS.elements)
      && integer(value.maxTextChars, 1, WEBSITE_BROWSER_LIMITS.textChars)
    case 'click': return exactKeys(value, ['kind', 'selector']) && selector(value.selector)
    case 'fill': return exactKeys(value, ['kind', 'selector', 'text']) && selector(value.selector)
      && boundedString(value.text, WEBSITE_BROWSER_LIMITS.fillBytes, true)
    case 'evaluate': return exactKeys(value, ['kind', 'code']) && boundedString(value.code, WEBSITE_BROWSER_LIMITS.scriptBytes)
    case 'navigate': {
      if (!exactKeys(value, ['kind', 'url']) || !boundedString(value.url, WEBSITE_BROWSER_LIMITS.urlBytes)) return false
      try { httpURL(value.url); return true }
      catch (_error: unknown) { return false }
    }
    case 'screenshot': {
      const clip = value.clip
      return exactKeys(value, ['kind', 'clip']) && record(clip) && exactKeys(clip, ['x', 'y', 'width', 'height'])
        && integer(clip.x, 0, WEBSITE_BROWSER_LIMITS.viewportDimension)
        && integer(clip.y, 0, WEBSITE_BROWSER_LIMITS.viewportDimension)
        && integer(clip.width, 1, WEBSITE_BROWSER_LIMITS.clipDimension)
        && integer(clip.height, 1, WEBSITE_BROWSER_LIMITS.clipDimension)
    }
    default: return false
  }
}

// Electron reserves world 0 for page scripts and world 999 for context isolation.
// Arbitrary evaluation never enters the fixed-helper world.
const FIXED_WORLD = 1001

// Attribute inspection only classifies sensitive documents; attributes never leave the guest.
const AUTH_CODE = `
const loginHint = /pass(word)?|log[ -]?in|sign[ -]?in|user(name)?|auth|credential|one.?time|otp|verification.?code|security.?code|2fa|mfa/i;
function sensitive(el) {
  const field = el.closest('input,textarea,select,button,[contenteditable],[role="textbox"],[role="button"]');
  const label = field && (field instanceof HTMLButtonElement || field.getAttribute('role') === 'button')
    ? field.textContent.slice(0, 128) : '';
  if (field && (field.matches('input[type="password"]') ||
      loginHint.test([field.id, field.getAttribute('name'), field.getAttribute('autocomplete'),
        field.getAttribute('aria-label'), label].join(' ')))) return true;
  const form = el.form || el.closest('form,[role="form"]');
  return !!form && (loginHint.test([form.id, form.getAttribute('name'), form.getAttribute('action'),
    form.getAttribute('class'), form.getAttribute('aria-label')].join(' ')) ||
    !!form.querySelector('input[type="password"],input[autocomplete="username"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"]'));
}
const candidates = document.querySelectorAll('input,textarea,select,button,[contenteditable],[role="textbox"],[role="button"],form,[role="form"]');
if (candidates.length > 4096) throw new Error('Website credential scan limit exceeded');
let inspected = 0;
for (const candidate of candidates) {
  if (sensitive(candidate)) throw new Error('Website credential document rejected');
  for (let ancestor = candidate.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (++inspected > 16384) throw new Error('Website credential scan limit exceeded');
    if (loginHint.test([ancestor.id, ancestor.getAttribute('class'), ancestor.getAttribute('aria-label')].join(' ')))
      throw new Error('Website credential document rejected');
  }
}
`

const DOM_CODE = `
const controls = 'input,textarea,select,option,button,output,datalist,[contenteditable],iframe,object,embed,script,style,template,noscript';
function excluded(el) {
  if (el.matches(controls) || el.matches('[role="textbox"],[role="combobox"],[hidden],[aria-hidden="true"]')) return true;
  const style = getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
    style.opacity === '0' || style.contentVisibility === 'hidden';
}
function rect(el) {
  const r = el.getBoundingClientRect();
  const bounded = n => { if (!Number.isFinite(n) || Math.abs(n) > 1000000) throw new Error('Website rectangle rejected'); return Math.round(n * 100) / 100; };
  return { x: bounded(r.x), y: bounded(r.y), width: bounded(r.width), height: bounded(r.height) };
}
function walk(root, visit) {
  let node = root, visited = 0;
  while (node) {
    if (++visited > 4096) return true;
    const skip = node.nodeType === Node.ELEMENT_NODE && excluded(node);
    if (!skip && visit(node) === false) return true;
    if (!skip && node.firstChild) { node = node.firstChild; continue; }
    while (node !== root && !node.nextSibling) node = node.parentNode;
    if (node === root) break;
    node = node.nextSibling;
  }
  return false;
}
let textBudget = limits.totalTextChars;
function text(el) {
  let result = '';
  const maxChars = Math.min(args.maxTextChars, textBudget);
  const truncated = walk(el, node => {
    if (node.nodeType !== Node.TEXT_NODE) return;
    const remaining = maxChars - result.length;
    const part = node.nodeValue || '';
    result += part.slice(0, remaining);
    if (part.length > remaining) return false;
  });
  textBudget -= result.length;
  return { text: result.toWellFormed(), textTruncated: truncated };
}
if (args.kind === 'dom-read') {
  const items = [];
  const truncated = walk(document.documentElement, el => {
    if (el.nodeType !== Node.ELEMENT_NODE || !el.matches(args.selector)) return;
    if (items.length === args.maxElements) return false;
    const tag = el.tagName.toLowerCase();
    if (tag.length > 64) throw new Error('Website tag rejected');
    items.push({ tag, ...text(el), rect: rect(el) });
  });
  return { operation: 'dom-read', items, truncated };
}
const el = document.querySelector(args.selector);
if (!el || sensitive(el) || el.closest('iframe,object,embed')) throw new Error('Website action target rejected');
if (args.kind === 'click') {
  if (!(el instanceof HTMLElement) || el.closest('[disabled],[inert]')) throw new Error('Website click target rejected');
  const sameURL = address => {
    const target = new URL(address, location.href);
    if (target.origin !== origin || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Website action URL rejected');
  };
  const baseTarget = document.querySelector('base[target]')?.getAttribute('target') || '';
  const safeTarget = target => {
    if ((target || baseTarget) && (target || baseTarget).toLowerCase() !== '_self') throw new Error('Website browsing target rejected');
  };
  const anchor = el.closest('a,area');
  if (anchor) {
    sameURL(anchor.href);
    safeTarget(anchor.target);
    if (anchor.hasAttribute('download')) throw new Error('Website link rejected');
  }
  const activated = el.closest('label')?.control || el.closest('button,input') || el;
  if (sensitive(activated) || activated instanceof HTMLInputElement && activated.type === 'file') throw new Error('Website control rejected');
  const form = activated.form;
  if (form && (activated.type === 'submit' || activated.type === 'image')) {
    sameURL(activated.hasAttribute('formaction') ? activated.formAction : form.action);
    const target = activated.hasAttribute('formtarget') ? activated.formTarget : form.target;
    safeTarget(target);
  }
  el.click();
  return { operation: 'click', attempted: true };
}
if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || el.disabled || el.readOnly ||
    (el instanceof HTMLInputElement && !['text','search','url','tel','email'].includes(el.type))) throw new Error('Website fill target rejected');
const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
setter.call(el, args.text);
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return { operation: 'fill', attempted: true };
`

const SERIALIZE_INTRINSICS = `
const jsonStringify = JSON.stringify, objectKeys = Object.keys, getPrototype = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor, hasOwn = Object.hasOwn, createObject = Object.create;
const setPrototype = Object.setPrototypeOf, plainPrototype = Object.prototype;
const isArray = Array.isArray, isFiniteNumber = Number.isFinite, ResultError = Error;
const encodeBytes = Function.prototype.call.bind(TextEncoder.prototype.encode, new TextEncoder());
const byteLength = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length').get);
`

const SERIALIZE_CODE = `
let nodes = 0;
function project(value, depth) {
  if (++nodes > limits.jsonNodes || depth > limits.jsonDepth) throw new ResultError('Website JSON limit exceeded');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && isFiniteNumber(value)) return value;
  if (typeof value === 'string' && value.length <= limits.jsonBytes) return value;
  if (typeof value !== 'object' || value === null) throw new ResultError('Website result is not JSON');
  const array = isArray(value);
  if (!array && getPrototype(value) !== plainPrototype && getPrototype(value) !== null) throw new ResultError('Website result is not plain JSON');
  const keys = objectKeys(value);
  if (keys.length > limits.jsonNodes) throw new ResultError('Website JSON limit exceeded');
  const output = array ? setPrototype([], null) : createObject(null);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (key.length > limits.jsonBytes) throw new ResultError('Website JSON key limit exceeded');
    const descriptor = getDescriptor(value, key);
    if (!descriptor || !hasOwn(descriptor, 'value')) throw new ResultError('Website JSON accessor rejected');
    output[key] = project(descriptor.value, depth + 1);
  }
  if (array && value.length !== keys.length) throw new ResultError('Website sparse array rejected');
  return output;
}
const encoded = jsonStringify(project(value, 0));
if (byteLength(encodeBytes(encoded)) > limits.jsonBytes) throw new ResultError('Website JSON byte limit exceeded');
return encoded;
`

function script(operation: WebsiteBrowserOperation, origin: string, body: string): string {
  return `(async () => { 'use strict'; const args = ${JSON.stringify(operation)}; const origin = ${JSON.stringify(origin)};
const limits = ${JSON.stringify(WEBSITE_BROWSER_LIMITS)};
${SERIALIZE_INTRINSICS}
if (window !== window.top || location.origin !== origin || location.protocol !== 'http:' && location.protocol !== 'https:' || new URL(location.href).username || new URL(location.href).password) throw new Error('Website document rejected');
${AUTH_CODE}
const value = await (async () => { ${body} })();
${SERIALIZE_CODE}
})()`
}

function jsonValue(value: unknown, depth = 0, budget = { nodes: 0 }): value is WebsiteBrowserJson {
  if (++budget.nodes > WEBSITE_BROWSER_LIMITS.jsonNodes || depth > WEBSITE_BROWSER_LIMITS.jsonDepth) return false
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => jsonValue(item, depth + 1, budget))
  return record(value) && Object.values(value).every(item => jsonValue(item, depth + 1, budget))
}

function assertNever(_value: never): never {
  throw new Error('Website operation rejected')
}

function decode(value: unknown): WebsiteBrowserJson {
  if (!boundedString(value, WEBSITE_BROWSER_LIMITS.jsonBytes)) throw new Error('Website native JSON rejected')
  let parsed: unknown
  try { parsed = JSON.parse(value) }
  catch (_error: unknown) { throw new Error('Website native JSON rejected') }
  if (!jsonValue(parsed)) throw new Error('Website native JSON rejected')
  return parsed
}

/**
 * Execute on the captured guest after Host allowed-once consent. Rechecks authority,
 * cancellation and exact native origin before/after every native await, including
 * rejection. Navigation listeners remain until physical settlement; Host must retain
 * permanent navigation/revocation, popup and download enforcement after return.
 * Cancellation withholds success without reporting that native work stopped.
 * Screenshots can contain sensitive visible data and
 * require separate explicit consent; bytes remain in memory with no files or storage.
 * @param execution - Captured guest, approved origin, cancellation and synchronous authority check.
 * @param operation - Bounded operation already approved by Host for this invocation.
 * @returns Bounded JSON or an in-memory PNG; side effects are reported only as attempted.
 */
export async function executeWebsiteBrowserOperation(
  execution: WebsiteBrowserExecution, operation: WebsiteBrowserOperation,
): Promise<WebsiteBrowserResult> {
  if (!isWebsiteBrowserOperation(operation)) throw new Error('Website operation arguments rejected')
  if (operation.kind === 'evaluate') throw new Error('Arbitrary website JavaScript is unavailable')
  const { guest, signal, assertAuthority, approvedOrigin } = execution
  if (httpURL(approvedOrigin).origin !== approvedOrigin) throw new Error('Website approved origin rejected')
  // Snapshot arguments before any await; consent cannot authorize later caller mutation.
  const captured: WebsiteBrowserOperation = operation.kind === 'screenshot'
    ? { ...operation, clip: { ...operation.clip } } : { ...operation }
  let blocked = false
  const check = (): void => {
    signal.throwIfAborted()
    assertAuthority()
    if (blocked || guest.isDestroyed() || httpURL(guest.getURL()).origin !== approvedOrigin) throw new Error('Website guest authority rejected')
    if (captured.kind === 'screenshot' && guest.mainFrame.frames.length !== 0) throw new Error('Framed screenshots are unavailable')
  }
  const guard = (event: WebsiteBrowserNavigationEvent): void => {
    if (!event.isMainFrame) return
    try {
      check()
      if (httpURL(event.url).origin !== approvedOrigin) throw new Error('Website navigation rejected')
    } catch (_error: unknown) {
      blocked = true
      event.preventDefault()
    }
  }
  const native = async <T>(start: () => Promise<T>): Promise<T> => {
    check()
    try { return await start() }
    catch (_error: unknown) { throw new Error('Website native operation rejected') }
    finally { check() }
  }
  const isolated = (worldId: number, code: string): Promise<unknown> =>
    native(() => guest.executeJavaScriptInIsolatedWorld(worldId, [{ code }], false))
  const frameCreated = (): void => { blocked = true }
  check()
  guest.on('will-navigate', guard)
  try {
    if (captured.kind === 'screenshot') guest.on('frame-created', frameCreated)
    guest.on('will-redirect', guard)
    try {
      switch (captured.kind) {
        case 'navigate': {
          if (httpURL(captured.url).origin !== approvedOrigin) throw new Error('Website navigation rejected')
          await native(() => guest.loadURL(captured.url))
          return { kind: 'json', value: { operation: 'navigate', attempted: true } }
        }
        case 'screenshot': {
          const viewport = decode(await isolated(FIXED_WORLD, script(captured, approvedOrigin,
            'return { width: innerWidth, height: innerHeight, scale: devicePixelRatio };')))
          if (!record(viewport) || !integer(viewport.width, 1, WEBSITE_BROWSER_LIMITS.viewportDimension)
            || !integer(viewport.height, 1, WEBSITE_BROWSER_LIMITS.viewportDimension)
            || typeof viewport.scale !== 'number' || !Number.isFinite(viewport.scale) || viewport.scale <= 0 || viewport.scale > 4
            || captured.clip.x + captured.clip.width > viewport.width || captured.clip.y + captured.clip.height > viewport.height
            || captured.clip.width * viewport.scale > WEBSITE_BROWSER_LIMITS.imageDimension
            || captured.clip.height * viewport.scale > WEBSITE_BROWSER_LIMITS.imageDimension) throw new Error('Website screenshot viewport rejected')
          const image = await native(() => guest.capturePage({ ...captured.clip }))
          const size = image.getSize()
          if (image.isEmpty() || !integer(size.width, 1, WEBSITE_BROWSER_LIMITS.imageDimension)
            || !integer(size.height, 1, WEBSITE_BROWSER_LIMITS.imageDimension)) throw new Error('Website screenshot dimensions rejected')
          const png = image.toPNG()
          if (png.byteLength === 0 || png.byteLength > WEBSITE_BROWSER_LIMITS.screenshotBytes) throw new Error('Website screenshot byte limit exceeded')
          check()
          return { kind: 'screenshot', png: new Uint8Array(png), width: size.width, height: size.height }
        }
        case 'dom-read':
        case 'click':
        case 'fill': {
          const value = decode(await isolated(FIXED_WORLD, script(captured, approvedOrigin, DOM_CODE)))
          check()
          return { kind: 'json', value }
        }
        default: return assertNever(captured)
      }
    } finally { guest.removeListener('will-redirect', guard) }
  } finally {
    if (captured.kind === 'screenshot') guest.removeListener('frame-created', frameCreated)
    guest.removeListener('will-navigate', guard)
  }
}
