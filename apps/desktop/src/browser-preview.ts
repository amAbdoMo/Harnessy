/** Native browser tab inventory, chat ownership and private Host operation routing. */
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { BrowserAgentOpenRequest, BrowserTabStatus, DesktopBrowserLeaseId, DesktopWebsiteProfile } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { BrowserRecordingDocumentId, BrowserRecordingFrame, BrowserRemoteShare } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
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
  recordingDocument: BrowserRecordingDocumentId
  recordingCapturePending?: boolean
}

const RECORDING_MAX_WIDTH = 960
const RECORDING_MAX_HEIGHT = 540
const RECORDING_MAX_FRAME_BYTES = 512 * 1024
const REMOTE_SHARE_DURATION_MS = 15 * 60_000
const REMOTE_SHARE_FRAME_INTERVAL_MS = 200

interface Share extends BrowserRemoteShare {
  readonly id: string
  readonly tab: Tab
  readonly urlAtStart: string
  readonly documentId: BrowserRecordingDocumentId
  readonly permitted: (guest: WebContents) => boolean
  nextFrameAt: number
}

function recordingDocumentId(): BrowserRecordingDocumentId { return randomUUID() as BrowserRecordingDocumentId }

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
  private share: Share | undefined

  /** @param guests - native lease owner. @param window - current authenticated primary renderer.
   * @param profiles - saved account inventory; returned metadata never includes credentials.
   */
  constructor(private readonly guests: Pick<DesktopBrowserGuests,
    'inspectBrowser' | 'onInvalidated' | 'allowsBrowserAddress' | 'command' | 'setZoom' | 'openLocalDevTools' | 'closeLocalDevTools'>,
  private readonly window: () => WebContents | undefined,
  private readonly profiles: () => Promise<readonly DesktopWebsiteProfile[]>) {
    guests.onInvalidated((_owner, lease) => {
      const tab = this.tabs.get(lease)
      this.tabs.delete(lease)
      if (tab !== undefined) { this.revokeShare(tab); this.changed(tab); return tab.control.close() }
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
    const tab: Tab = { owner, lease, guest, control: new BrowserTabControl(sessionId), nativeInput: false,
      recordingDocument: recordingDocumentId() }
    const changeDocument = (): void => { tab.recordingDocument = recordingDocumentId(); this.revokeShare(tab) }
    guest.on('did-start-navigation', (event) => { if (event.isMainFrame) changeDocument() })
    guest.on('did-navigate-in-page', (_event, _url, mainFrame) => {
      if (mainFrame) changeDocument()
    })
    guest.on('before-input-event', (event) => { if (!tab.control.humanMayAct && !tab.nativeInput) event.preventDefault() })
    guest.on('before-mouse-event', (event) => { if (!tab.control.humanMayAct && !tab.nativeInput) event.preventDefault() })
    guest.on('devtools-opened', () => { if (!tab.control.humanMayAct) guest.closeDevTools() })
    this.tabs.set(lease, tab)
    this.changed(tab)
  }

  /** @param owner - authenticated primary renderer. @param lease - owned native guest. @returns current control state. */
  status(owner: WebContents, lease: DesktopBrowserLeaseId): BrowserTabStatus { return this.snapshot(this.tab(owner, lease)) }

  /**
   * Apply native page zoom for the local user after Human Takeover.
   * @param owner - authenticated application renderer.
   * @param lease - exact tab lease.
   * @param factor - untrusted zoom factor.
   * @returns the acknowledged zoom factor.
   */
  setZoom(owner: WebContents, lease: DesktopBrowserLeaseId, factor: unknown): number {
    this.assertLocalHuman(owner, lease)
    return this.guests.setZoom(owner, lease, factor)
  }

  /**
   * Open the exact ordinary guest's local developer tools.
   * @param owner - authenticated application renderer.
   * @param lease - exact tab lease.
   */
  openDevTools(owner: WebContents, lease: DesktopBrowserLeaseId): void {
    this.assertLocalHuman(owner, lease)
    this.guests.openLocalDevTools(owner, lease)
  }

  private assertLocalHuman(owner: WebContents, lease: DesktopBrowserLeaseId): void {
    if (!this.tab(owner, lease).control.humanMayAct) throw new Error('Desktop browser requires Human Takeover')
  }

  /** @param owner - authenticated primary renderer. @param lease - exact guest. @param human - requested control. */
  async control(owner: WebContents, lease: DesktopBrowserLeaseId, human: boolean): Promise<void> {
    if (typeof human !== 'boolean') throw new Error('Invalid browser control choice')
    const tab = this.tab(owner, lease)
    if (!human) { this.guests.closeLocalDevTools(owner, lease); this.revokeShare(tab) }
    if (tab.control.humanControl !== human) tab.recordingDocument = recordingDocumentId()
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

  /**
   * Capture one frame without changing who controls the tab.
   * @param owner - authenticated primary renderer.
   * @param lease - exact native tab received over IPC.
   * @param urlInput - page address captured when the user started recording.
   * @param documentInput - document identity of the first frame, or undefined before that frame.
   * @param permitted - Main check for the ordinary guest and visible window.
   * @returns a bounded JPEG for that document and human control generation.
   */
  async captureRecordingFrame(owner: WebContents, lease: DesktopBrowserLeaseId, urlInput: unknown,
    documentInput: unknown, permitted: (guest: WebContents) => boolean): Promise<BrowserRecordingFrame> {
    text(lease, 'recording tab identity', 128)
    const url = text(urlInput, 'recording URL', 4096)
    const tab = this.tab(owner, lease)
    const documentId = tab.recordingDocument
    if (documentInput !== undefined && documentInput !== documentId) throw new Error('Browser recording page changed')
    const requireCurrent = (): void => {
      if (this.tab(owner, lease) !== tab || tab.recordingDocument !== documentId || !tab.control.humanMayAct
        || !permitted(tab.guest) || tab.guest.isLoading() || tab.guest.getURL() !== url) throw new Error('Browser recording page is unavailable')
    }
    if (!this.guests.allowsBrowserAddress(url) || tab.recordingCapturePending === true) throw new Error('Browser recording frame is unavailable')
    requireCurrent()
    tab.recordingCapturePending = true
    try {
      const image = await tab.guest.capturePage()
      requireCurrent()
      const { width, height } = image.getSize()
      if (image.isEmpty() || width <= 0 || height <= 0) throw new Error('Browser recording frame is empty')
      const scale = Math.min(1, RECORDING_MAX_WIDTH / width, RECORDING_MAX_HEIGHT / height)
      const bounded = scale === 1 ? image : image.resize({
        width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)),
      })
      const jpeg = bounded.toJPEG(65)
      if (jpeg.byteLength === 0 || jpeg.byteLength > RECORDING_MAX_FRAME_BYTES) {
        throw new Error('Browser recording frame exceeds its byte limit')
      }
      return { documentId, jpeg: jpeg.toString('base64') }
    } finally { tab.recordingCapturePending = false }
  }

  /**
   * Start a view-only share for one ordinary tab and document.
   * @param owner - authenticated primary renderer.
   * @param lease - exact native tab.
   * @param root - private HTTPS root confirmed by the current Host.
   * @param permitted - exact ordinary guest and native window visibility check.
   * @returns Expiring viewer link containing no Web sign-in credential.
   */
  beginRemoteShare(owner: WebContents, lease: DesktopBrowserLeaseId, root: string,
    permitted: (guest: WebContents) => boolean): BrowserRemoteShare {
    const tab = this.tab(owner, lease)
    const urlAtStart = tab.guest.getURL()
    if (!tab.control.humanMayAct || !permitted(tab.guest) || tab.guest.isLoading() || !this.guests.allowsBrowserAddress(urlAtStart)) {
      throw new Error('Browser tab is unavailable for sharing')
    }
    if (this.share !== undefined && this.shareIsCurrent(this.share)) throw new Error('A browser tab is already being shared')
    const id = randomUUID()
    const url = new URL('/api/browser-share', root)
    url.searchParams.set('view', id)
    const expiresAt = Date.now() + REMOTE_SHARE_DURATION_MS
    this.share = { id, tab, urlAtStart, documentId: tab.recordingDocument, permitted, url: url.href, expiresAt, nextFrameAt: 0 }
    return { url: url.href, expiresAt }
  }

  /** @param owner - authenticated primary renderer. @param lease - exact tab. @param url - receipt for this share. */
  endRemoteShare(owner: WebContents, lease: DesktopBrowserLeaseId, url: unknown): void {
    const share = this.share
    if (share?.tab.owner === owner && share.tab.lease === lease && share.url === url) this.share = undefined
  }

  /** @param owner - hidden or retiring primary window whose live view must end. */
  revokeRemoteShare(owner: WebContents): void {
    if (this.share?.tab.owner === owner) this.share = undefined
  }

  private revokeShare(tab: Tab): void {
    if (this.share?.tab === tab) this.share = undefined
  }

  private shareIsCurrent(share: Share): boolean {
    const tab = share.tab
    return this.share === share && Date.now() < share.expiresAt && tab.recordingDocument === share.documentId
      && tab.control.humanMayAct && !tab.guest.isDestroyed() && share.permitted(tab.guest)
      && !tab.guest.isLoading() && tab.guest.getURL() === share.urlAtStart
  }

  private async remoteShareFrame(requestId: string, id: unknown): Promise<object> {
    const reply = { type: 'browser-share-frame-result', requestId }
    const share = this.share
    if (share === undefined || share.id !== id) return { ...reply, status: 'ended' }
    if (!this.shareIsCurrent(share)) { this.revokeShare(share.tab); return { ...reply, status: 'ended' } }
    const now = Date.now()
    if (now < share.nextFrameAt || share.tab.recordingCapturePending === true) return { ...reply, status: 'busy' }
    share.nextFrameAt = now + REMOTE_SHARE_FRAME_INTERVAL_MS
    const { owner, lease } = share.tab
    try {
      const frame = await this.captureRecordingFrame(owner, lease, share.urlAtStart, share.documentId, share.permitted)
      if (this.shareIsCurrent(share)) return { ...reply, status: 'frame', jpeg: frame.jpeg }
    } catch (_error: unknown) {
      if (this.shareIsCurrent(share)) return { ...reply, status: 'busy' }
    }
    if (this.share === share) this.share = undefined
    return { ...reply, status: 'ended' }
  }

  /** @param input - validated private Host event. @returns response, or no response for cancellation. */
  async request(input: unknown): Promise<object | undefined> {
    const packet = object(input)
    const requestId = text(packet.requestId, 'request identity', 128)
    if (packet.type === 'browser-share-frame') return this.remoteShareFrame(requestId, packet.id)
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
    this.share = undefined
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
        accountLabel: profile.accountLabel, url: profile.url, mcpServerName: profile.mcpServerName }))
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
