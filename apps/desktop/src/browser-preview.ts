/** Native browser tab inventory, chat ownership and private Host operation routing. */
import type { WebContents } from 'electron'
import type { BrowserAgentOpenRequest, BrowserTabStatus, DesktopBrowserLeaseId, DesktopWebsiteProfile } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { BrowserTabControl } from './browser-tab-control.ts'
import { setImmediate } from 'node:timers/promises'
import type { DesktopBrowserGuests } from './browser-guests.ts'
import { DESKTOP_IPC } from './ipc.ts'

interface Tab {
  readonly owner: WebContents
  readonly lease: DesktopBrowserLeaseId
  readonly guest: WebContents
  readonly control: BrowserTabControl
  nativeInput: boolean
}

interface PendingOpen {
  readonly owner: WebContents
  readonly sessionId: string
  readonly resolve: (tab: Tab) => void
  readonly reject: (error: Error) => void
}

function object(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Browser request must be an object')
  return input as Record<string, unknown>
}

function text(input: unknown, name: string, limit: number): string {
  if (typeof input !== 'string' || input.length === 0 || Buffer.byteLength(input) > limit) throw new Error(`Invalid browser ${name}`)
  return input
}

function number(input: unknown, name: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || Math.abs(input) > 100_000) throw new Error(`Invalid browser ${name}`)
  return input
}

function selector(input: unknown): string { return text(input, 'selector', 4096) }

/** Owns all browser tabs for the current application window; no credentials or native objects cross the Host channel. */
export class DesktopBrowserPreview {
  private readonly tabs = new Map<DesktopBrowserLeaseId, Tab>()
  private readonly openings = new Map<string, PendingOpen>()
  private readonly calls = new Map<string, AbortController>()

  /** @param guests - native lease owner. @param window - current authenticated primary renderer.
   * @param profiles - saved account inventory; returned metadata never includes credentials.
   */
  constructor(private readonly guests: Pick<DesktopBrowserGuests, 'inspectBrowser' | 'onInvalidated' | 'allowsBrowserAddress' | 'command'>,
    private readonly window: () => WebContents | undefined,
    private readonly profiles: () => Promise<readonly DesktopWebsiteProfile[]>) {
    guests.onInvalidated((_owner, lease) => {
      const tab = this.tabs.get(lease)
      this.tabs.delete(lease)
      if (tab !== undefined) { this.changed(tab); return tab.control.close() }
    })
  }

  /** @param owner - authenticated primary renderer. @param lease - exact live guest. @param sessionId - chat or unclaimed manual tab. */
  bind(owner: WebContents, lease: DesktopBrowserLeaseId, sessionId: string | null): void {
    if (sessionId !== null) text(sessionId, 'chat identity', 4096)
    const guest = this.guests.inspectBrowser(owner, lease)
    if (guest === undefined) throw new Error('Browser tab is not attached')
    const existing = this.tabs.get(lease)
    if (existing !== undefined) {
      if (existing.owner !== owner || existing.guest !== guest || existing.control.sessionId !== sessionId) throw new Error('Browser tab ownership cannot be replaced')
      return
    }
    const tab: Tab = { owner, lease, guest, control: new BrowserTabControl(sessionId), nativeInput: false }
    guest.on('before-input-event', (event) => { if (!tab.control.humanMayAct && !tab.nativeInput) event.preventDefault() })
    guest.on('before-mouse-event', (event) => { if (!tab.control.humanMayAct && !tab.nativeInput) event.preventDefault() })
    this.tabs.set(lease, tab)
    this.changed(tab)
  }

  /** @param owner - authenticated primary renderer. @param lease - owned native guest. @returns current control state. */
  status(owner: WebContents, lease: DesktopBrowserLeaseId): BrowserTabStatus { return this.snapshot(this.tab(owner, lease)) }

  /** @param owner - authenticated primary renderer. @param lease - exact guest. @param human - requested control. */
  async control(owner: WebContents, lease: DesktopBrowserLeaseId, human: boolean): Promise<void> {
    if (typeof human !== 'boolean') throw new Error('Invalid browser control choice')
    const tab = this.tab(owner, lease)
    const draining = tab.control.control(human)
    this.changed(tab)
    await draining
    this.changed(tab)
  }

  /** Human navigation takes control of bound tabs; bootstrap commands on unbound guests remain available.
   * @param owner - authenticated renderer. @param lease - exact native guest.
   */
  async takeForNavigation(owner: WebContents, lease: DesktopBrowserLeaseId): Promise<void> {
    if (this.tabs.has(lease)) await this.control(owner, lease, true)
  }

  /** @param owner - authenticated primary renderer. @param requestId - pending native opening. @param lease - bound and attached tab. */
  completeOpen(owner: WebContents, requestId: string, lease: DesktopBrowserLeaseId): void {
    const pending = this.openings.get(requestId)
    if (pending === undefined || pending.owner !== owner) throw new Error('Browser opening is no longer pending')
    const tab = this.tab(owner, lease)
    if (tab.control.sessionId !== pending.sessionId) throw new Error('Browser opening belongs to another chat')
    pending.resolve(tab)
  }

  /** @param owner - authenticated primary renderer. @param lease - exact tab. @returns its live guest for human annotations. */
  guest(owner: WebContents, lease: DesktopBrowserLeaseId): WebContents {
    const guest = this.guests.inspectBrowser(owner, lease)
    if (guest === undefined) throw new Error('Browser tab is not attached')
    return guest
  }

  /** @param input - validated private Host event. @returns response, or no response for cancellation. */
  async request(input: unknown): Promise<object | undefined> {
    const packet = object(input)
    const requestId = text(packet.requestId, 'request identity', 128)
    if (packet.type === 'browser-preview-cancel') { this.calls.get(requestId)?.abort(); return undefined }
    if (packet.type !== 'browser-preview' || this.calls.has(requestId)) throw new Error('Invalid browser preview request')
    const cancellation = new AbortController()
    this.calls.set(requestId, cancellation)
    try {
      const sessionId = text(packet.sessionId, 'chat identity', 4096)
      const operation = object(packet.operation)
      if (Buffer.byteLength(JSON.stringify(operation)) > 128 * 1024) throw new Error('Browser operation exceeds its size limit')
      const result = await this.run(sessionId, operation, requestId, cancellation.signal)
      cancellation.signal.throwIfAborted()
      if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new Error('Browser result exceeds its size limit')
      return { type: 'browser-preview-result', requestId, ok: true, result }
    } catch (error) {
      return { type: 'browser-preview-result', requestId, ok: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2048) }
    } finally { this.calls.delete(requestId) }
  }

  /** Cancel old Host invocations and pending openings; tab ownership remains attached to its chat. */
  retireHost(): void {
    for (const cancellation of this.calls.values()) cancellation.abort()
    for (const opening of this.openings.values()) opening.reject(new Error('Browser Host retired'))
    this.openings.clear()
  }

  private async run(sessionId: string, operation: Record<string, unknown>, requestId: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const owner = this.window()
    if (owner === undefined || owner.isDestroyed()) throw new Error('Browser window is unavailable')
    if (operation.kind === 'status' && operation.tabId === undefined) {
      const profiles = (await this.profiles()).map(profile => ({ profileId: profile.id, name: profile.name,
        accountLabel: profile.accountLabel, url: profile.url }))
      signal.throwIfAborted()
      return { tabs: [...this.tabs.values()].filter(tab => tab.control.mayAct(sessionId)).map(tab => this.snapshot(tab)), profiles }
    }
    if (operation.kind === 'open') return this.open(owner, sessionId, operation, requestId, signal)
    const lease = text(operation.tabId, 'tab identity', 128) as DesktopBrowserLeaseId
    const tab = this.tab(owner, lease)
    if (operation.kind === 'status') return this.snapshot(tab)
    if (operation.kind === 'snapshot') return tab.control.observe(() => this.capture(tab, operation.includeImage === true))
    return tab.control.act(sessionId, async () => {
      signal.throwIfAborted()
      this.tab(owner, lease)
      const result = await this.action(tab, operation)
      signal.throwIfAborted()
      return result
    })
  }

  private async open(owner: WebContents, sessionId: string, operation: Record<string, unknown>,
    requestId: string, signal: AbortSignal): Promise<BrowserTabStatus> {
    const profile = operation.profileId === undefined ? undefined : (await this.profiles()).find(
      candidate => candidate.id === text(operation.profileId, 'profile identity', 128))
    if (operation.profileId !== undefined && profile === undefined) throw new Error('Saved browser account was not found')
    signal.throwIfAborted()
    const url = text(operation.url, 'URL', 4096)
    if (!this.guests.allowsBrowserAddress(url)) throw new Error('Browser URL is not permitted')
    const existing = operation.reuseExistingTab === false || profile !== undefined ? undefined
      : [...this.tabs.values()].find(tab => tab.control.sessionId === sessionId && !tab.control.humanControl)
    if (existing !== undefined) return existing.control.act(sessionId, async () => {
      signal.throwIfAborted()
      await existing.guest.loadURL(url)
      signal.throwIfAborted()
      return this.snapshot(existing)
    })
    if (this.openings.size >= 32) throw new Error('Too many pending browser openings')
    const completion = Promise.withResolvers<Tab>()
    const abort = () =>{  completion.reject(new Error('Browser opening was canceled')) }
    const timer = setTimeout(() =>{  completion.reject(new Error('Browser tab did not attach within 30 seconds')) }, 30_000)
    this.openings.set(requestId, { owner, sessionId, resolve: completion.resolve, reject: completion.reject })
    signal.addEventListener('abort', abort, { once: true })
    try {
      owner.send(DESKTOP_IPC.browserAgentOpen, { requestId, sessionId, url,
        ...(profile === undefined ? {} : { profileId: profile.id }) } satisfies BrowserAgentOpenRequest)
      const tab = await completion.promise
      signal.throwIfAborted()
      return this.snapshot(tab)
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); this.openings.delete(requestId) }
  }

  private async action(tab: Tab, operation: Record<string, unknown>): Promise<unknown> {
    switch (operation.kind) {
      case 'navigate': {
        const url = text(operation.url, 'URL', 4096)
        if (!this.guests.allowsBrowserAddress(url)) throw new Error('Browser URL is not permitted')
        await tab.guest.loadURL(url)
        return this.snapshot(tab)
      }
      case 'evaluate': {
        const expression = text(operation.expression, 'expression', 64 * 1024)
        const result: unknown = await tab.guest.executeJavaScript(expression, true)
        const serialized = JSON.stringify(result ?? null)
        if (Buffer.byteLength(serialized) > 64 * 1024) throw new Error('Browser evaluation result exceeds 64 KB')
        const value: unknown = JSON.parse(serialized)
        return { value }
      }
      case 'act': {
        tab.nativeInput = true
        try { await this.input(tab.guest, operation); await setImmediate() }
        finally { tab.nativeInput = false }
        return { attempted: true }
      }
      case 'resize': {
        const width = number(operation.width, 'width'), height = number(operation.height, 'height')
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('Browser viewport dimensions must be integers from 1 to 8192')
        await this.guests.command(tab.owner, tab.lease, { kind: 'preview-viewport', viewport: { width, height, scale: 1 } })
        return { width, height }
      }
      default: throw new Error('Unsupported browser operation')
    }
  }

  private async input(guest: WebContents, operation: Record<string, unknown>): Promise<void> {
    if (operation.action === 'drag') {
      const source = JSON.stringify(selector(operation.source)), target = JSON.stringify(selector(operation.target))
      const coordinates: unknown = await guest.executeJavaScript(`(()=>{const source=document.querySelector(${source}),target=document.querySelector(${target});if(!source||!target)throw new Error('Browser drag element was not found');const a=source.getBoundingClientRect(),b=target.getBoundingClientRect();return {x:a.x+a.width/2,y:a.y+a.height/2,targetX:b.x+b.width/2,targetY:b.y+b.height/2}})()`, false)
      const points = object(coordinates)
      const x = number(points.x, 'x'), y = number(points.y, 'y'), targetX = number(points.targetX, 'targetX'), targetY = number(points.targetY, 'targetY')
      guest.sendInputEvent({ type: 'mouseMove', x, y })
      guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      guest.sendInputEvent({ type: 'mouseMove', x: targetX, y: targetY, modifiers: ['leftbuttondown'] })
      guest.sendInputEvent({ type: 'mouseUp', x: targetX, y: targetY, button: 'left', clickCount: 1 }); return
    }
    if (operation.action === 'press') {
      const keyCode = text(operation.key, 'key', 64)
      guest.sendInputEvent({ type: 'keyDown', keyCode }); guest.sendInputEvent({ type: 'keyUp', keyCode }); return
    }
    if (operation.action === 'scroll') {
      guest.sendInputEvent({ type: 'mouseWheel', x: number(operation.x ?? 1, 'x'), y: number(operation.y ?? 1, 'y'),
        deltaX: number(operation.deltaX ?? 0, 'deltaX'), deltaY: number(operation.deltaY ?? 0, 'deltaY') }); return
    }
    if (operation.action === 'click' && operation.selector === undefined) {
      const x = number(operation.x, 'x'), y = number(operation.y, 'y')
      guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); return
    }
    const query = JSON.stringify(selector(operation.selector))
    const root = operation.frameSelector === undefined ? 'document'
      : `document.querySelector(${JSON.stringify(selector(operation.frameSelector))})?.contentDocument`
    let expression: string
    switch (operation.action) {
      case 'click': expression = 'element.click()'; break
      case 'hover': expression = 'element.dispatchEvent(new MouseEvent(\'mouseover\',{bubbles:true}));element.dispatchEvent(new MouseEvent(\'mouseenter\'))'; break
      case 'type': {
        const content = JSON.stringify(typeof operation.text === 'string' && Buffer.byteLength(operation.text) <= 8192 ? operation.text : text(operation.text, 'text', 8192))
        expression = `element.focus();const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element),'value')?.set;if(setter)setter.call(element,${content});else element.textContent=${content};element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}))`; break
      }
      case 'select': expression = `element.value=${JSON.stringify(text(operation.value, 'selection', 8192))};element.dispatchEvent(new Event('change',{bubbles:true}))`; break
      default: throw new Error('Unsupported browser input action')
    }
    await guest.executeJavaScript(`(()=>{const root=${root};if(!root)throw new Error('Browser frame is unavailable or cross-origin');const element=root.querySelector(${query});if(!element)throw new Error('Browser element was not found');${expression};return null})()`, true)
  }

  private async capture(tab: Tab, includeImage: boolean): Promise<unknown> {
    const url = tab.guest.getURL()
    const page: unknown = await tab.guest.executeJavaScript(`(()=>{
      const path=element=>{const parts=[];for(let node=element;node&&node.nodeType===1;node=node.parentElement){if(node.id){parts.unshift('#'+CSS.escape(node.id));break}const name=node.tagName.toLowerCase();const siblings=node.parentElement?Array.from(node.parentElement.children).filter(sibling=>sibling.tagName===node.tagName):[node];parts.unshift(name+':nth-of-type('+(siblings.indexOf(node)+1)+')')}return parts.join(' > ')};
      const collect=(root,frameSelector)=>Array.from(root.querySelectorAll('a,button,input,textarea,select,[role=button]')).slice(0,200).map(element=>({tag:element.tagName.toLowerCase(),text:(element.getAttribute('aria-label')??element.textContent??'').slice(0,200),selector:path(element),frameSelector}));
      const elements=collect(document,null);const frames=[];
      for(const frame of Array.from(document.querySelectorAll('iframe')).slice(0,16)){const frameSelector=path(frame);let readable=false;try{if(frame.contentDocument){elements.push(...collect(frame.contentDocument,frameSelector));readable=true}}catch(error){void error}frames.push({selector:frameSelector,url:frame.src,readable})}
      return {text:document.body?.innerText.slice(0,20000)??'',elements:elements.slice(0,400),frames}
    })()`, false)
    if (tab.guest.getURL() !== url) throw new Error('Browser page changed during observation')
    if (!includeImage) return { ...this.snapshot(tab), page }
    const image = await tab.guest.capturePage()
    const size = image.getSize()
    if (tab.guest.getURL() !== url) throw new Error('Browser page changed during screenshot capture')
    return { ...this.snapshot(tab), page, screenshot: { png: image.toPNG().toString('base64'), width: size.width, height: size.height } }
  }

  private tab(owner: WebContents, lease: DesktopBrowserLeaseId): Tab {
    const tab = this.tabs.get(lease)
    if (tab === undefined || tab.owner !== owner || this.guests.inspectBrowser(owner, lease) !== tab.guest) throw new Error('Browser tab is closed or no longer attached')
    return tab
  }

  private snapshot(tab: Tab): BrowserTabStatus {
    this.tab(tab.owner, tab.lease)
    return { tabId: tab.lease, sessionId: tab.control.sessionId, humanControl: tab.control.humanControl,
      generation: tab.control.generation, url: tab.guest.getURL(), title: tab.guest.getTitle(), loading: tab.guest.isLoading() }
  }

  private changed(tab: Tab): void {
    if (!tab.owner.isDestroyed()) tab.owner.send(DESKTOP_IPC.browserControlChanged)
  }
}
