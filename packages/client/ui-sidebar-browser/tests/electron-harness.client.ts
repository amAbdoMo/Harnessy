/** Native webview events controlled by each test; presentation and navigation stay real. */
import { vi } from 'vitest'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { WebsiteRequestSession } from '../src/client/browser/WebsiteRequestSession.ts'
import { requestStubs } from './website-request-stubs.client.ts'
import type {
  DesktopBrowserBridge, DesktopBrowserHumanCommand, DesktopBrowserLeaseId, DesktopBrowserReservation, DesktopWebsiteProfile,
  DesktopWebsiteProfileId, DesktopWebsiteProfileInput,
} from '../src/types.ts'
import type { BrowserTabState } from '../src/client/browser/BrowserPersistence.ts'
import { createElectronPage } from '../src/client/electron/pages.ts'
import { ElectronWebviewPresentation } from '../src/client/electron/ElectronWebviewPresentation.ts'

let sequence = 0

/** @param id - desired profile identity. @returns a saved profile as main reports it. */
export function websiteProfile(id: DesktopWebsiteProfileId, name = 'Work account',
  control: DesktopWebsiteProfile['control'] = 'human'): DesktopWebsiteProfile {
  return { id, name, accountLabel: 'me@example.test', url: 'https://example.test/', mcpServerName: 'website', control }
}

/**
 * @param initial - saved ordinary-tab address.
 * @param profile - saved account to open.
 * @param sessionId - enables real request ownership for this initiating Session.
 * @returns one isolated page; disposal joins navigation and request ownership.
 */
export function electronFixture(initial?: BrowserTabState, profile?: DesktopWebsiteProfileId, sessionId?: Branded<'SessionId'>) {
  const opens = new Set<(url: string) => void>()
  const reservation: DesktopBrowserReservation = { lease: `lease-${++sequence}` as DesktopBrowserLeaseId, partition: 'partition' }
  const profiles = {
    list: vi.fn(async (): Promise<readonly DesktopWebsiteProfile[]> => []),
    create: vi.fn(async (input: DesktopWebsiteProfileInput): Promise<DesktopWebsiteProfile> =>
      ({ ...input, id: `created-${String(sequence)}` as DesktopWebsiteProfileId, control: 'human' }),
    ),
    acquire: vi.fn(async (_profile: DesktopWebsiteProfileId) => reservation),
    setControl: vi.fn(async (_profile: DesktopWebsiteProfileId, _control: 'human' | 'agent') => {}),
    signOut: vi.fn(async (_profile: DesktopWebsiteProfileId) => {}),
    forget: vi.fn(async (_profile: DesktopWebsiteProfileId) => {}),
    onChanged: vi.fn((_listener: () => void) => () => {}),
  }
  const bridge = {
    profiles, requests: requestStubs(),
    acquire: vi.fn(async (_workspace: string) => reservation),
    command: vi.fn(async (lease: DesktopBrowserLeaseId, command: DesktopBrowserHumanCommand): Promise<void> => {
      const guest = guests.find(candidate => candidate.element.isConnected && candidate.element.getAttribute('src') === `about:blank#${lease}`)
      if (guest === undefined) throw new Error('Native guest is unavailable')
      switch (command.kind) {
        case 'navigate': await guest.loadURL(command.url); return
        case 'back': guest.goBack(); return
        case 'forward': guest.goForward(); return
        case 'reload': guest.reload(); return
        default: assertNever(command)
      }
    }),
    release: vi.fn(async (_lease: DesktopBrowserLeaseId) => {}),
    onOpenRequested: vi.fn((_lease: DesktopBrowserLeaseId, listener: (url: string) => void) => {
      opens.add(listener)
      return () => { opens.delete(listener) }
    }),
  } satisfies DesktopBrowserBridge
  const workspace = vi.fn(async (_signal: AbortSignal) => 'cwd:/workspace')
  const persist = vi.fn()
  const openRequested = vi.fn()
  const report = vi.fn()
  const requestsSession = sessionId === undefined ? undefined : new WebsiteRequestSession(sessionId, bridge.requests, report)
  const page = createElectronPage({ initial, profileId: profile, persist, openRequested }, bridge, workspace, requestsSession)
  const presentation = page.presentation
  if (!(presentation instanceof ElectronWebviewPresentation)) throw new Error('expected the Electron presentation')
  const create = presentation.createElement.bind(presentation)
  const guests: ReturnType<typeof prepareGuest>[] = []
  function prepareGuest(approved: DesktopBrowserReservation) {
    const element = create(approved)
    const state = { url: 'about:blank', title: '', loading: true, back: false, forward: false }
    const methods = {
      loadURL: vi.fn(async (_url: string) => {}), getURL: vi.fn(() => state.url), getTitle: vi.fn(() => state.title),
      canGoBack: () => state.back, canGoForward: () => state.forward, clearHistory: vi.fn(),
      goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), isLoading: () => state.loading,
    }
    Object.assign(element, methods)
    const emit = (type: string, fields: object = {}): void => { element.dispatchEvent(Object.assign(new Event(type), fields)) }
    return { element, state, emit, ...methods }
  }
  const createElement = vi.spyOn(presentation, 'createElement').mockImplementation((approved) => {
    const guest = prepareGuest(approved)
    guests.push(guest)
    return guest.element
  })
  const host = document.createElement('div')
  host.id = `electron-fixture-${sequence}`
  document.body.append(host)
  return {
    ...page, presentation, bridge, profiles, workspace, persist, openRequested, opens, guests, host, reservation, requestsSession, report,
    mount: () => presentation.mount(host.id),
    async guest() {
      await vi.waitFor(() => { expectGuest() })
      return guests.at(-1)!
    },
    async dispose() {
      try {
        const results = await Promise.allSettled([page.frame.dispose(), requestsSession?.dispose()])
        const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
        if (failures.length !== 0) throw new AggregateError(failures, 'Electron fixture failed to drain')
      } finally {
        createElement.mockRestore()
        host.remove()
      }
    },
  }
  function expectGuest(): void {
    if (host.firstElementChild === null || guests.length === 0) throw new Error('guest has not attached')
  }
}
