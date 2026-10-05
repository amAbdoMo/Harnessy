/** Owner-local native adapter tests execute generated page code against a real jsdom document. */
import { Script } from 'node:vm'
import type { NativeImage, Rectangle, WebContents, WebSource } from 'electron'
import { JSDOM } from 'jsdom'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  executeWebsiteBrowserOperation, isWebsiteBrowserOperation, WEBSITE_BROWSER_LIMITS,
} from '../src/website-browser.ts'
import type {
  WebsiteBrowserExecution, WebsiteBrowserGuest, WebsiteBrowserNavigationEvent, WebsiteBrowserOperation,
} from '../src/website-browser.ts'

const ORIGIN = 'https://portal.example.test'
const read: WebsiteBrowserOperation = { kind: 'dom-read', selector: 'body', maxElements: 4, maxTextChars: 128 }
const screenshot: WebsiteBrowserOperation = { kind: 'screenshot', clip: { x: 1, y: 2, width: 50, height: 40 } }

// The actual Electron type must remain assignable without importing its runtime.
const acceptWebContents = (guest: WebContents): WebsiteBrowserGuest => guest
void acceptWebContents

class ElectronGuestStub implements WebsiteBrowserGuest {
  readonly dom = new JSDOM('<body></body>', { url: `${ORIGIN}/account`, runScripts: 'outside-only' })
  readonly page = new JSDOM('<body></body>', { url: `${ORIGIN}/account`, runScripts: 'outside-only' })
  readonly mainFrame: { frames: unknown[] } = { frames: [] }
  readonly created = new Set<() => void>()
  readonly scripts: string[] = []
  readonly nativeResults: unknown[] = []
  readonly navigations: string[] = []
  readonly captures: Rectangle[] = []
  readonly listeners = new Map<string, Set<(event: WebsiteBrowserNavigationEvent) => void>>()
  address = `${ORIGIN}/account`
  destroyed = false
  png = Buffer.from([137, 80, 78, 71])
  size = { width: 50, height: 40 }
  empty = false
  executeHook?: (code: string) => Promise<unknown>
  loadHook?: (url: string) => Promise<void>
  captureHook?: () => Promise<void>

  constructor(html = '<body></body>') {
    this.dom.window.document.body.innerHTML = html
    this.page.window.document.body.innerHTML = html
    Object.defineProperty(this.dom.window, 'TextEncoder', { value: TextEncoder })
    // These realms approximate isolated DOM wrappers, not native Electron layout.
    onTestFinished(() => { this.dom.window.close(); this.page.window.close() })
  }

  isDestroyed(): boolean { return this.destroyed }
  getURL(): string { return this.address }
  async executeJavaScript(code: string, userGesture = false): Promise<unknown> {
    expect(userGesture).toBe(false)
    this.scripts.push(code)
    if (this.executeHook) return this.executeHook(code)
    const result: unknown = new Script(code).runInContext(this.page.getInternalVMContext())
    return await Promise.resolve(result)
  }

  async executeJavaScriptInIsolatedWorld(worldId: number, sources: WebSource[], userGesture = false): Promise<unknown> {
    expect(userGesture).toBe(false)
    if (worldId !== 1001) throw new Error('Unexpected isolated world')
    const context = this.dom.getInternalVMContext()
    let returned: unknown
    for (const { code } of sources) {
      this.scripts.push(code)
      returned = this.executeHook ? await this.executeHook(code) : await new Script(code).runInContext(context)
    }
    this.nativeResults.push(returned)
    return returned
  }

  async loadURL(url: string): Promise<void> {
    this.navigations.push(url)
    if (this.loadHook) await this.loadHook(url)
    else this.address = url
  }

  async capturePage(rect: Rectangle): Promise<Pick<NativeImage, 'isEmpty' | 'getSize' | 'toPNG'>> {
    this.captures.push(rect)
    if (this.captureHook) await this.captureHook()
    return { isEmpty: () => this.empty, getSize: () => this.size, toPNG: () => this.png }
  }

  on(...[event, listener]: ['frame-created', () => void] | ['will-navigate' | 'will-redirect', (event: WebsiteBrowserNavigationEvent) => void]): void {
    if (event === 'frame-created') { this.created.add(listener); return }
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  removeListener(...[event, listener]: ['frame-created', () => void] | ['will-navigate' | 'will-redirect', (event: WebsiteBrowserNavigationEvent) => void]): void {
    if (event === 'frame-created') { this.created.delete(listener); return }
    this.listeners.get(event)?.delete(listener)
  }

  navigation(event: 'will-navigate' | 'will-redirect', url: string, isMainFrame = true): boolean {
    let prevented = false
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ url, isMainFrame, preventDefault: () => { prevented = true } })
    }
    return prevented
  }

  get listenerCount(): number { return this.created.size + [...this.listeners.values()].reduce((n, set) => n + set.size, 0) }
}

function fixture(html?: string) {
  const guest = new ElectronGuestStub(html)
  const controller = new AbortController()
  const assertAuthority = vi.fn<() => void>()
  const execution: WebsiteBrowserExecution = { guest, approvedOrigin: ORIGIN, signal: controller.signal, assertAuthority }
  return { guest, controller, assertAuthority, execution,
    run: (operation: WebsiteBrowserOperation = read) => executeWebsiteBrowserOperation(execution, operation) }
}

describe('bounded native operation arguments', () => {
  it.each([
    null, [], {}, { kind: 'cookies' }, { ...read, extra: true }, { ...read, maxElements: 0 },
    { ...read, maxElements: 33 }, { ...read, maxElements: 1.5 }, { ...read, maxTextChars: 2049 },
    { ...read, selector: 'a'.repeat(513) }, { ...read, selector: 'input[value^="secret"]' },
    { ...read, selector: ':has(input)' }, { ...read, selector: 'body,iframe' }, { ...read, selector: 'body\ninput' },
    { kind: 'fill', selector: '#name', text: '界'.repeat(2731) },
    { kind: 'evaluate', code: 'x'.repeat(16 * 1024 + 1) }, { kind: 'evaluate', code: '' },
    { kind: 'navigate', url: 'file:///private' }, { kind: 'navigate', url: '/relative' },
    { kind: 'navigate', url: 'https:portal.example.test' }, { kind: 'navigate', url: 'https://@portal.example.test/' },
    { kind: 'navigate', url: `${ORIGIN}/\nprivate` }, { kind: 'navigate', url: 'https://user:secret@portal.example.test' },
    { kind: 'navigate', url: 'https://portal.example.test\\@other.test' },
    { ...screenshot, clip: { x: 0, y: 0, width: 0, height: 10 } },
    { ...screenshot, clip: { x: -1, y: 0, width: 10, height: 10 } },
    { ...screenshot, clip: { x: 0, y: 0, width: 1025, height: 10 } },
    { ...screenshot, clip: { x: 0, y: 0, width: 10, height: 10, scale: 1 } },
  ])('rejects malformed or unbounded operation %#', (operation) => {
    expect(isWebsiteBrowserOperation(operation)).toBe(false)
  })

  it('accepts only the declared operation fields and bounded selector syntax', () => {
    for (const operation of [read, screenshot, { kind: 'click', selector: 'main > button.submit' },
      { kind: 'fill', selector: '#name', text: '' }, { kind: 'navigate', url: `${ORIGIN}/next` },
      { kind: 'evaluate', code: '({ message: "approved" })' }]) {
      expect(isWebsiteBrowserOperation(operation)).toBe(true)
    }
  })

  it('rechecks argument bounds at execution without touching the guest', async () => {
    const f = fixture()
    await expect(f.run({ kind: 'fill', selector: '#name', text: 'x'.repeat(8193) })).rejects.toThrow('arguments rejected')
    expect(f.guest.scripts).toEqual([])
    expect(f.guest.listenerCount).toBe(0)
  })
})

describe('top-document DOM projection', () => {
  it('returns text, tag and rectangle only, excluding controls', async () => {
    const f = fixture(`<main id="public" data-secret="attribute-secret">Public<span> text</span>
      <input value="input-secret"><textarea>textarea-secret</textarea><select><option>option-secret</option></select>
      <div contenteditable>editable-secret</div><div role="textbox">role-secret</div>
      <script>script-secret</script><style>/* style-secret */</style><iframe srcdoc="frame-secret"></iframe>
      <span> tail</span></main>`)
    const result = await f.run({ ...read, selector: '#public' })
    expect(result).toEqual({ kind: 'json', value: { operation: 'dom-read', items: [{
      tag: 'main', text: 'Public text\n      \n      \n      \n       tail', textTruncated: false,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    }], truncated: false } })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(f.guest.listenerCount).toBe(0)
  })

  it.each(['hidden', 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"',
    'style="visibility:collapse"', 'style="opacity:0"'])('omits hidden subtrees selected directly or through an ancestor: %s', async (attributes) => {
    const f = fixture(`<main><span>Public</span><section id="private" ${attributes}>hidden-secret<span>nested-secret</span></section></main>`)
    expect(await f.run({ ...read, selector: 'main' })).toMatchObject({ kind: 'json', value: { items: [{ text: 'Public' }] } })
    expect(await f.run({ ...read, selector: '#private' })).toMatchObject({ kind: 'json', value: { items: [] } })
  })

  it('does not project cookies or storage into DOM results', async () => {
    const f = fixture('<p>Public</p>')
    f.guest.dom.window.document.cookie = 'cookie=private-cookie'
    f.guest.dom.window.localStorage.setItem('token', 'private-local')
    f.guest.dom.window.sessionStorage.setItem('token', 'private-session')
    const result = await f.run()
    expect(result).toMatchObject({ kind: 'json', value: { items: [{ text: 'Public' }] } })
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it.each(['input', 'textarea', 'button'])('omits prohibited selected nodes %s', async (selector) => {
    const f = fixture('<input value="secret"><textarea>secret</textarea><button>Save</button>')
    await expect(f.run({ ...read, selector })).resolves.toEqual({ kind: 'json', value: { operation: 'dom-read', items: [], truncated: false } })
  })

  it('fails closed when credential inspection exceeds its document budget', async () => {
    const f = fixture('<input>'.repeat(4100))
    await expect(f.run({ ...read, selector: '#absent' })).rejects.toThrow()
    expect(f.guest.nativeResults).toEqual([])
  })

  it.each([
    '<div role="form"><p>Your code 123456</p><input autocomplete="one-time-code"></div>',
    '<section><p>Your code 123456</p><input name="otp"></section>',
    '<div id="login"><p>private account</p><div><input id="field"></div></div>',
    '<form action="/login"><p>private account</p><input id="field"></form>',
    '<input type="password"><p>private account</p>',
    '<form id="auth-form"></form><input form="auth-form"><p>private account</p>',
  ])('rejects credential documents before fixed DOM or screenshot capture: %s', async (html) => {
    const f = fixture(`${html}<p id="public">Public</p><button id="save">Save</button><input id="description">`)
    const clicked = vi.fn()
    f.guest.dom.window.document.querySelector('#save')?.addEventListener('click', clicked)
    for (const operation of [read, { ...read, selector: '#public' }, screenshot,
      { kind: 'click', selector: '#save' }, { kind: 'fill', selector: '#description', text: 'replacement' }] satisfies WebsiteBrowserOperation[]) {
      await expect(f.run(operation)).rejects.toThrow('native operation rejected')
    }
    expect(clicked).not.toHaveBeenCalled()
    expect(f.guest.dom.window.document.querySelector<HTMLInputElement>('#description')?.value).toBe('')
    expect(f.guest.captures).toEqual([])
    expect(f.guest.nativeResults).toEqual([])
    expect(f.guest.listenerCount).toBe(0)
  })

  it('does not expose textarea text after page-world DOM prototypes are patched', async () => {
    const f = fixture('<p>Public</p><textarea>textarea-secret</textarea>')
    await f.guest.executeJavaScript('Element.prototype.matches = () => false; JSON.stringify = () => "fake";')
    await expect(f.run()).resolves.toMatchObject({ value: { items: [{ text: 'Public' }] } })
    expect(JSON.stringify(f.guest.nativeResults)).not.toContain('textarea-secret')
  })

  it('rejects credential DOM and screenshot capture despite page-world security-check tampering', async () => {
    const f = fixture('<div role="form"><p>Your code 123456</p><input autocomplete="one-time-code"></div>')
    await f.guest.executeJavaScript('Element.prototype.matches = () => false; Document.prototype.querySelectorAll = () => []; JSON.stringify = () => "null";')
    await expect(f.run()).rejects.toThrow('native operation rejected')
    await expect(f.run(screenshot)).rejects.toThrow('native operation rejected')
    expect(f.guest.captures).toEqual([])
    expect(f.guest.nativeResults).toEqual([])
  })

  it('truncates total text rather than returning oversized JSON from many large elements', async () => {
    const f = fixture(`<p>${'\u0001'.repeat(2048)}</p>`.repeat(32))
    const result = await f.run({ ...read, selector: 'p', maxElements: 32, maxTextChars: 2048 })
    if (result.kind !== 'json' || result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) {
      throw new Error('Expected a DOM JSON result')
    }
    const items = result.value.items
    if (!Array.isArray(items)) throw new Error('Expected DOM items')
    expect(items).toHaveLength(32)
    expect(items[2]).toEqual({ tag: 'p', text: '', textTruncated: true, rect: { x: 0, y: 0, width: 0, height: 0 } })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(WEBSITE_BROWSER_LIMITS.jsonBytes)
  })

  it('caps matching elements, text and traversal independently', async () => {
    const f = fixture('<p>123456</p><p>Second</p><p>Third</p>')
    await expect(f.run({ ...read, selector: 'p', maxElements: 1, maxTextChars: 3 })).resolves.toMatchObject({
      value: { items: [{ tag: 'p', text: '123', textTruncated: true }], truncated: true },
    })
    f.guest.dom.window.document.body.innerHTML = '<i></i>'.repeat(4100)
    await expect(f.run({ ...read, selector: '#absent' })).resolves.toMatchObject({ value: { items: [], truncated: true } })
  })
})

describe('attempted same-guest actions', () => {
  it('clicks one matching top-document element and reports only attempted action', async () => {
    const f = fixture('<button id="save">Save</button>')
    const clicked = vi.fn()
    f.guest.dom.window.document.querySelector('#save')?.addEventListener('click', clicked)
    await expect(f.run({ kind: 'click', selector: '#save' })).resolves.toEqual({ kind: 'json', value: { operation: 'click', attempted: true } })
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it.each([
    '<base target="_blank"><a id="target" href="/same" target="_self">Same</a>',
    '<base target="_blank"><form target="_self"><button id="target">Save</button></form>',
    '<base target="_blank"><form><button id="target" formtarget="_self">Save</button></form>',
  ])('allows an explicit self target to override the document base: %s', async (html) => {
    const f = fixture(html)
    const clicked = vi.fn((event: Event) => { event.preventDefault() })
    f.guest.dom.window.document.querySelector('#target')?.addEventListener('click', clicked)
    await expect(f.run({ kind: 'click', selector: '#target' })).resolves.toMatchObject({ value: { attempted: true } })
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('sets a normal text input through the native value setter without echoing its value', async () => {
    const f = fixture('<input id="description" value="old">')
    await expect(f.run({ kind: 'fill', selector: '#description', text: '' })).resolves.toEqual({
      kind: 'json', value: { operation: 'fill', attempted: true },
    })
    expect(f.guest.dom.window.document.querySelector('input')?.value).toBe('')
  })

  it('fills a normal control with JSON-safe text, dispatches events and never returns its value', async () => {
    const f = fixture('<textarea id="description"></textarea>')
    const input = f.guest.dom.window.document.querySelector('textarea')
    const events: string[] = []
    input?.addEventListener('input', () => { events.push('input') })
    input?.addEventListener('change', () => { events.push('change') })
    const text = '"; globalThis.injected = true; //\n😀'
    const result = await f.run({ kind: 'fill', selector: '#description', text })
    expect(input?.value).toBe(text)
    expect(events).toEqual(['input', 'change'])
    expect(result).toEqual({ kind: 'json', value: { operation: 'fill', attempted: true } })
    expect(Object.hasOwn(f.guest.dom.window, 'injected')).toBe(false)
  })

  it.each([
    ['<input id="password" type="password">', '#password', 'fill'],
    ['<input id="username" autocomplete="username">', '#username', 'fill'],
    ['<form action="/login"><input id="field"></form>', '#field', 'fill'],
    ['<form id="auth-form"><input type="password"></form><input id="field" form="auth-form">', '#field', 'fill'],
    ['<form><input type="password"><button id="save">Sign in</button></form>', '#save', 'click'],
    ['<textarea id="field" readonly></textarea>', '#field', 'fill'],
    ['<input id="field" type="file">', '#field', 'fill'],
    ['<a id="link" href="https://other.test/">Other</a>', '#link', 'click'],
    ['<a id="link" href="https://user:secret@portal.example.test/">Credentials</a>', '#link', 'click'],
    ['<a id="link" href="javascript:alert(1)">Code</a>', '#link', 'click'],
    ['<a id="link" href="/same" target="_blank">Window</a>', '#link', 'click'],
    ['<form action="https://other.test/submit"><button><span id="save">Save</span></button></form>', '#save', 'click'],
    ['<form target="_blank"><button id="save">Save</button></form>', '#save', 'click'],
    ['<base target="_blank"><a id="link" href="/same">Window</a>', '#link', 'click'],
    ['<base target="_blank"><a id="link" href="/same" target="">Window</a>', '#link', 'click'],
    ['<base target="_blank"><form><button id="save">Save</button></form>', '#save', 'click'],
    ['<base target="_blank"><form target=""><button id="save" formtarget="">Save</button></form>', '#save', 'click'],
    ['<input id="file" type="file"><label id="label" for="file">File</label>', '#label', 'click'],
    ['<input id="user" autocomplete="username"><label id="label" for="user">User</label>', '#label', 'click'],
  ] as const)('rejects sensitive or unsupported action target %s', async (html, selector, kind) => {
    const f = fixture(html)
    const operation: WebsiteBrowserOperation = kind === 'fill' ? { kind, selector, text: 'attempt' } : { kind, selector }
    await expect(f.run(operation)).rejects.toThrow()
    expect(f.guest.listenerCount).toBe(0)
  })
})

describe('arbitrary JavaScript denial', () => {
  it.each([
    'document.cookie',
    'setInterval(() => document.cookie, 1000)',
    'document.addEventListener("input", () => document.cookie)',
    'new MutationObserver(() => document.cookie).observe(document, { subtree: true, childList: true })',
    'navigator.serviceWorker.register("/worker.js")',
    'new SharedWorker("/worker.js")',
    'Promise.resolve({ public: true })',
  ])('rejects supplied code without observing or executing in the guest: %s', async (code) => {
    const f = fixture()
    const address = vi.spyOn(f.guest, 'getURL')
    await expect(f.run({ kind: 'evaluate', code })).rejects.toThrow('Arbitrary website JavaScript is unavailable')
    expect(address).not.toHaveBeenCalled()
    expect(f.assertAuthority).not.toHaveBeenCalled()
    expect(f.guest.scripts).toEqual([])
    expect(f.guest.nativeResults).toEqual([])
    expect(f.guest.listenerCount).toBe(0)
  })
})

describe('fixed helper response limits', () => {
  it('checks returned bytes independently of guest-side serialization', async () => {
    const f = fixture()
    f.guest.executeHook = async () => JSON.stringify('x'.repeat(WEBSITE_BROWSER_LIMITS.jsonBytes))
    await expect(f.run()).rejects.toThrow('native JSON rejected')
    f.guest.executeHook = async () => 'null'
    await expect(f.run()).resolves.toEqual({ kind: 'json', value: null })
  })
})

describe('same-origin navigation and native authority', () => {
  it('navigates only to an absolute credential-free HTTP(S) URL on the exact origin', async () => {
    const f = fixture()
    await expect(f.run({ kind: 'navigate', url: `${ORIGIN}/next?item=1` })).resolves.toEqual({ kind: 'json', value: { operation: 'navigate', attempted: true } })
    expect(f.guest.navigations).toEqual([`${ORIGIN}/next?item=1`])
    for (const url of ['https://sub.portal.example.test', 'http://portal.example.test', `${ORIGIN}:444/`, 'https://other.test']) {
      await expect(f.run({ kind: 'navigate', url })).rejects.toThrow('navigation rejected')
    }
    expect(f.guest.navigations).toHaveLength(1)
  })

  it.each(['will-navigate', 'will-redirect'] as const)('prevents cross-origin %s before settlement and removes listeners', async (event) => {
    const f = fixture()
    f.guest.loadHook = async () => {
      expect(f.guest.navigation(event, 'https://other.test/redirect')).toBe(true)
    }
    await expect(f.run({ kind: 'navigate', url: `${ORIGIN}/next` })).rejects.toThrow('authority rejected')
    expect(f.guest.listenerCount).toBe(0)
  })

  it('allows same-origin redirects while leaving subframes to the captured guest owner', async () => {
    const f = fixture()
    f.guest.loadHook = async () => {
      expect(f.guest.navigation('will-redirect', `${ORIGIN}/allowed`)).toBe(false)
      expect(f.guest.navigation('will-redirect', 'https://other.test/frame', false)).toBe(false)
      f.guest.address = `${ORIGIN}/allowed`
    }
    await expect(f.run({ kind: 'navigate', url: `${ORIGIN}/next` })).resolves.toMatchObject({ value: { attempted: true } })
  })

  it.each(['cancel', 'revoked', 'destroyed', 'origin', 'credentials'] as const)('refuses %s before native execution', async (cause) => {
    const f = fixture()
    if (cause === 'cancel') f.controller.abort()
    if (cause === 'revoked') f.assertAuthority.mockImplementation(() => { throw new Error('revoked') })
    if (cause === 'destroyed') f.guest.destroyed = true
    if (cause === 'origin') f.guest.address = 'https://other.test/'
    if (cause === 'credentials') f.guest.address = 'https://user:secret@portal.example.test/'
    await expect(f.run()).rejects.toThrow()
    expect(f.guest.scripts).toEqual([])
    expect(f.guest.listenerCount).toBe(0)
  })

  it.each(['cancel', 'revoked', 'destroyed', 'origin', 'reject'] as const)('retains pending native work and refuses publication after %s', async (cause) => {
    const f = fixture()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const physical = Promise.withResolvers<unknown>()
    f.guest.executeHook = () => { entered.resolve(); return physical.promise }
    let settled = false
    const operation = f.run().then(() => { settled = true }, (error: unknown) => { settled = true; throw error })
    const rejected = expect(operation).rejects.toThrow()
    onTestFinished(async () => { physical.resolve('null'); await rejected })
    await entered.promise
    if (cause === 'cancel') f.controller.abort()
    if (cause === 'revoked') f.assertAuthority.mockImplementation(() => { throw new Error('revoked') })
    if (cause === 'destroyed') f.guest.destroyed = true
    if (cause === 'origin') f.guest.address = 'https://other.test/'
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(f.guest.listenerCount).toBe(2)
    if (cause === 'reject') physical.reject(new Error('native rejection'))
    else physical.resolve('null')
    await rejected
    expect(f.guest.listenerCount).toBe(0)
    expect(f.assertAuthority.mock.calls.length).toBeGreaterThanOrEqual(cause === 'cancel' ? 2 : 3)
  })

  it('snapshots arguments before the first native await', async () => {
    const f = fixture()
    const operation = { kind: 'screenshot', clip: { x: 1, y: 2, width: 50, height: 40 } } satisfies WebsiteBrowserOperation
    f.guest.executeHook = async () => {
      operation.clip.width = 10000
      return JSON.stringify({ width: 800, height: 600, scale: 1 })
    }
    await f.run(operation)
    expect(f.guest.captures).toEqual([{ x: 1, y: 2, width: 50, height: 40 }])
  })
})

describe('bounded in-memory NativeImage capture', () => {
  it('rejects a native child frame hidden inside a shadow root before inspecting or capturing the page', async () => {
    const f = fixture('<div id="host"></div>')
    const host = f.guest.dom.window.document.querySelector('#host')
    if (host === null) throw new Error('Host element missing')
    host.attachShadow({ mode: 'closed' }).append(f.guest.dom.window.document.createElement('iframe'))
    expect(f.guest.dom.window.document.querySelector('iframe')).toBeNull()
    f.guest.mainFrame.frames.push({})
    await expect(f.run(screenshot)).rejects.toThrow('Framed screenshots are unavailable')
    expect(f.guest.scripts).toEqual([])
    expect(f.guest.captures).toEqual([])
    expect(f.guest.listenerCount).toBe(0)
  })

  it.each(['viewport inspection', 'native capture'] as const)('withholds pixels after a transient frame appears during %s', async (phase) => {
    const f = fixture()
    const createFrame = (): void => {
      f.guest.mainFrame.frames.push({})
      for (const listener of f.guest.created) listener()
      f.guest.mainFrame.frames.pop()
    }
    if (phase === 'viewport inspection') f.guest.executeHook = async () => {
      createFrame()
      return JSON.stringify({ width: 1024, height: 768, scale: 1 })
    }
    else f.guest.captureHook = async () => { createFrame() }
    await expect(f.run(screenshot)).rejects.toThrow('Website guest authority rejected')
    expect(f.guest.captures).toHaveLength(phase === 'native capture' ? 1 : 0)
    expect(f.guest.listenerCount).toBe(0)
  })

  it('checks viewport first, captures exactly the clip and returns a PNG byte copy with no paths', async () => {
    const f = fixture()
    const result = await f.run(screenshot)
    expect(f.guest.scripts).toHaveLength(1)
    expect(f.guest.captures).toEqual([screenshot.clip])
    expect(result).toEqual({ kind: 'screenshot', png: new Uint8Array(f.guest.png), width: 50, height: 40 })
    f.guest.png[0] = 0
    if (result.kind === 'screenshot') expect(result.png[0]).toBe(137)
    expect(f.guest.listenerCount).toBe(0)
  })

  it.each([
    { width: 4097, height: 600, scale: 1 }, { width: 800, height: 4097, scale: 1 },
    { width: 800, height: 600, scale: 5 }, { width: 800, height: 600, scale: 0 },
    { width: 20, height: 600, scale: 1 }, { width: 800, height: 20, scale: 1 },
  ])('rejects viewport before native capture %j', async (viewport) => {
    const f = fixture()
    f.guest.executeHook = async () => JSON.stringify(viewport)
    await expect(f.run(screenshot)).rejects.toThrow('viewport rejected')
    expect(f.guest.captures).toEqual([])
  })

  it('rejects physical clip dimensions before capture rather than resizing an unbounded image', async () => {
    const f = fixture()
    f.guest.executeHook = async () => JSON.stringify({ width: 2000, height: 2000, scale: 3 })
    await expect(f.run({ kind: 'screenshot', clip: { x: 0, y: 0, width: 1024, height: 1024 } })).rejects.toThrow('viewport rejected')
    expect(f.guest.captures).toEqual([])
  })

  it.each(['empty', 'dimension', 'bytes'] as const)('rejects unbounded NativeImage %s', async (cause) => {
    const f = fixture()
    if (cause === 'empty') f.guest.empty = true
    if (cause === 'dimension') f.guest.size.width = 2049
    if (cause === 'bytes') f.guest.png = Buffer.alloc(WEBSITE_BROWSER_LIMITS.screenshotBytes + 1)
    await expect(f.run(screenshot)).rejects.toThrow()
    expect(f.guest.captures).toHaveLength(1)
    expect(f.guest.listenerCount).toBe(0)
  })

  it('withholds an image after cancellation during native capture without claiming physical stop', async () => {
    const f = fixture()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const physical: PromiseWithResolvers<void> = Promise.withResolvers()
    f.guest.captureHook = () => { entered.resolve(); return physical.promise }
    const result = f.run(screenshot)
    const rejected = expect(result).rejects.toThrow()
    onTestFinished(async () => { physical.resolve(); await rejected })
    await entered.promise
    f.controller.abort()
    expect(f.guest.listenerCount).toBe(3)
    expect(f.guest.created.size).toBe(1)
    physical.resolve()
    await rejected
    expect(f.guest.listenerCount).toBe(0)
  })
})
