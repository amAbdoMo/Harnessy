/** External Electron bridge and guest fixture, installed before the real client boots. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  DesktopBrowserBridge, DesktopBrowserLeaseId, DesktopWebsiteHostSnapshot,
  DesktopWebsiteProfile, DesktopWebsiteProfileId, DesktopWebsiteRequestId,
  DesktopWebsiteRequestReceipt, DesktopWebsiteVisibilityId,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

interface WebsiteBridgeProbe {
  readonly sessionIds: readonly string[]
  readonly preparedSessions: readonly string[]
  readonly resumed: number
  readonly revoked: number
  readonly drained: number
  readonly releasesStarted: number
  readonly releasesSettled: number
  readonly listeners: number
  hold(): void
  finish(): void
  notify(): void
}

declare global {
  interface Window {
    /** Test-owned external bridge observations, never a product controller. */
    readonly websiteBridgeProbe: WebsiteBridgeProbe
  }
}

/** Install only the private Electron API and native webview methods for this page. */
export function installWebsiteBridge(): void {
  const profileId = 'website-fixture-profile' as DesktopWebsiteProfileId
  const requestId = 'website-fixture-request' as DesktopWebsiteRequestId
  const profile: DesktopWebsiteProfile = {
    id: profileId, name: 'Fixture site', accountLabel: 'Test account', url: 'https://example.test/',
    mcpServerName: 'fixture-mcp', control: 'human',
  }
  const profileListeners = new Set<() => void>()
  const requestListeners = new Set<() => void>()
  const openListeners = new Set<(url: string) => void>()
  const sessionIds: Branded<'SessionId'>[] = []
  const preparedSessions: Branded<'SessionId'>[] = []
  let resumed = 0
  let revoked = 0
  let drained = 0
  let releasesStarted = 0
  let releasesSettled = 0
  let held = false
  let leaseNumber = 0
  let receipt: DesktopWebsiteRequestReceipt | undefined
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const subscribe = <T>(listeners: Set<T>, listener: T): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const reserve = (persistent: boolean) => ({
    lease: `website-fixture-lease-${++leaseNumber}` as DesktopBrowserLeaseId,
    partition: persistent ? `persist:dsh-website-${profileId}` : 'dsh-website-fixture-ordinary',
  })
  const browser: DesktopBrowserBridge = {
    profiles: {
      list: async () => [profile],
      create: async () => { throw new Error('This scenario opens an existing external profile') },
      acquire: async () => reserve(true),
      setControl: async () => { throw new Error('Only request-specific admission is supported') },
      signOut: async () => { throw new Error('Sign out is outside this scenario') },
      forget: async () => { throw new Error('Forget is outside this scenario') },
      onChanged: listener => subscribe(profileListeners, listener),
    },
    requests: {
      list: async (sessionId) => {
        sessionIds.push(sessionId)
        const row: DesktopWebsiteHostSnapshot = {
          id: requestId, profile: profileId, sessionId, epoch: 1, status: 'pending',
        }
        return [row]
      },
      prepare: async (input) => {
        preparedSessions.push(input.sessionId)
        receipt = { requestId: input.requestId, lease: input.lease, epoch: 1,
          visibility: 'website-fixture-visible' as DesktopWebsiteVisibilityId }
        return receipt
      },
      visible: async (_id, visible) => visible ? receipt : undefined,
      acknowledge: async () => {},
      resume: async (current) => { resumed++; return current },
      takeover: async () => {
        revoked++
        if (held) await barrier
        drained++
      },
      onChanged: listener => subscribe(requestListeners, listener),
    },
    acquire: async () => reserve(false),
    command: async (lease, command) => {
      if (resumed > revoked || held) throw new Error('Desktop browser requires Human Takeover')
      type NativeGuest = HTMLElement & { loadURL(url: string): Promise<void>; goBack(): void; goForward(): void; reload(): void }
      const guest = [...document.querySelectorAll<NativeGuest>('webview')]
        .find(element => element.getAttribute('src') === `about:blank#${lease}`)
      if (guest === undefined) throw new Error('Native guest is unavailable')
      switch (command.kind) {
        case 'navigate': await guest.loadURL(command.url); return
        case 'back': guest.goBack(); return
        case 'forward': guest.goForward(); return
        case 'reload': guest.reload(); return
        default: assertNever(command)
      }
    },
    release: async () => {
      releasesStarted++
      if (held) await barrier
      releasesSettled++
    },
    onOpenRequested: (_lease, listener) => subscribe(openListeners, listener),
    onReacquireRequested: () => () => {},
  }
  Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1, browser }, configurable: true })
  Object.defineProperty(globalThis, 'websiteBridgeProbe', { value: {
    get sessionIds() { return [...sessionIds] },
    get preparedSessions() { return [...preparedSessions] },
    get resumed() { return resumed },
    get revoked() { return revoked },
    get drained() { return drained },
    get releasesStarted() { return releasesStarted },
    get releasesSettled() { return releasesSettled },
    get listeners() { return profileListeners.size + requestListeners.size + openListeners.size },
    hold() { held = true },
    finish() { held = false; release() },
    notify() {
      for (const listener of profileListeners) listener()
      for (const listener of requestListeners) listener()
      for (const listener of openListeners) listener('https://example.test/late')
    },
  } satisfies WebsiteBridgeProbe, configurable: true })

  // oxlint-disable-next-line typescript/no-deprecated -- Only the legacy tag-name overload is deprecated; this uses the string overload.
  const createElement: (tag: string, options?: ElementCreationOptions) => HTMLElement = document.createElement.bind(document)
  Object.defineProperty(Document.prototype, 'createElement', { configurable: true, writable: true,
    value(this: Document, tag: string, options?: ElementCreationOptions): HTMLElement {
      const element = createElement(tag, options)
      if (tag.toLowerCase() !== 'webview') return element
      let url = 'about:blank'
      Object.defineProperties(element, {
        loadURL: { value: async (next: string) => { url = next; element.dispatchEvent(new Event('did-navigate')) } },
        getURL: { value: () => url },
        getTitle: { value: () => 'Fixture page' },
        canGoBack: { value: () => false },
        canGoForward: { value: () => false },
        clearHistory: { value: () => {} },
        goBack: { value: () => {} },
        goForward: { value: () => {} },
        reload: { value: () => { element.dispatchEvent(new Event('did-stop-loading')) } },
        isLoading: { value: () => false },
      })
      queueMicrotask(() => { element.dispatchEvent(new Event('dom-ready')) })
      return element
    },
  })
}
