// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createBrowserControllers, type BrowserControllerState, type BrowserInjected, type BrowserTabControllers } from '../src/client/browser/BrowserController.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'
import { createWebsiteProfileDraftStore } from '../src/client/browser/profile-draft.ts'
import { BrowserProfilePicker, type BrowserProfilePickerProps } from '../src/client/view/BrowserProfilePicker.tsx'
import type { BrowserBodyProps } from '../src/client/view/BrowserBody.tsx'
import { BrowserBody } from '../src/client/view/BrowserBody.tsx'
import { WEB_BROWSER_SANDBOX } from '../src/client/view/IframePresentation.ts'
import { createIframePage } from '../src/client/pages.ts'
import { zh as browserZh } from '../src/client/locales.ts'
import { zh as commonZh } from '../../locale/src/locales/zh.ts'
const zh = { ...commonZh, ...browserZh }
import { browserAddressCheckpoint, type BrowserTabState } from '../src/client/browser/BrowserPersistence.ts'
import type { BrowserPageFactory, BrowserPageOptions } from '../src/client/browser/BrowserPage.ts'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { emptyBrowserFrame, type BrowserFrameState } from '../src/client/browser/BrowserFrame.ts'
import type { WebsiteProfileCommands, WebsiteProfilesState } from '../src/client/browser/profiles.ts'
import type { DesktopBrowserLeaseId, DesktopWebsiteProfile, DesktopWebsiteProfileId, DesktopWebsiteProfileInput, DesktopWebsiteRequestId, DesktopWebsiteVisibilityId } from '../src/types.ts'
import { WebsiteRequestSession } from '../src/client/browser/WebsiteRequestSession.ts'
import type { WebsiteRequestPageState } from '../src/client/browser/WebsiteRequestPage.ts'
import { requestStubs } from './website-request-stubs.client.ts'

const SESSION = 'session' as SessionId
const TAB = 'tab' as TabId
const messages: Readonly<Record<string, string>> = zh
const lifetimes = new Set<AbortController>()
const controllers: BrowserTabControllers[] = []
const requestSessions: WebsiteRequestSession[] = []
const EMPTY_PROFILES: WebsiteProfilesState = {
  phase: 'ready', profiles: [], busy: undefined, creating: false, notice: null,
}
let mountSequence = 0

/** @param state - profile facts this occurrence should read. @returns a source store for them. */
function profileState(state: Partial<WebsiteProfilesState> = {}): SnapshotStore<WebsiteProfilesState> {
  return createSnapshotStore<WebsiteProfilesState>({ ...EMPTY_PROFILES, ...state })
}

/** @param overrides - per-command behavior. @returns recorded profile commands with defaults. */
function profileCommands(overrides: Partial<WebsiteProfileCommands> = {}): WebsiteProfileCommands {
  return {
    create: vi.fn(async (_input: DesktopWebsiteProfileInput) => undefined),
    takeover: vi.fn(async (_profile: DesktopWebsiteProfileId) => {}),
    signOut: vi.fn(async (_profile: DesktopWebsiteProfileId) => {}),
    forget: vi.fn(async (_profile: DesktopWebsiteProfileId) => {}),
    reload: vi.fn(async () => {}),
    dismiss: vi.fn(),
    ...overrides,
  }
}

function hookOf<T>(store: { subscribe(listener: () => void): () => void; getSnapshot(): T }) {
  return function useSelector<S>(select: (state: T) => S): S {
    return select(useSyncExternalStore(
      listener => store.subscribe(listener),
      () => store.getSnapshot(),
    ))
  }
}

const absentState = {
  subscribe: (_listener: () => void): (() => void) => () => {},
  getSnapshot: (): BrowserControllerState | undefined => undefined,
}

function mountBrowser(navigation?: { readonly url?: string; readonly profileId?: DesktopWebsiteProfileId },
  options: {
    initial?: BrowserTabState
    createPage?: BrowserPageFactory
    refreshShortcut?: ReturnType<BrowserBodyProps['useTabInfo']>['tab']['refreshShortcut']
    profiles?: WebsiteProfileCommands
    websiteProfiles?: SnapshotStore<WebsiteProfilesState>
  } = {}) {
  const store = createBrowserStore().create(`browser-body-test-${String(++mountSequence)}`)
  if (options.initial !== undefined) store.actions.replace(TAB, options.initial)
  const lifetime = new AbortController()
  lifetimes.add(lifetime)
  const websiteProfiles = options.websiteProfiles ?? profileState()
  const injected = createBrowserControllers(store.actions, options.createPage ?? createIframePage,
    () => true, () => websiteProfiles.getSnapshot())
  controllers.push(injected)
  const { keyedHooks, ...commands } = injected
  function useWebsiteRequests(key: string): WebsiteRequestPageState | undefined
  function useWebsiteRequests<Selected>(key: string, select: (state: WebsiteRequestPageState | undefined) => Selected): Selected
  function useWebsiteRequests<Selected>(key: string, select?: (state: WebsiteRequestPageState | undefined) => Selected):
    Selected | WebsiteRequestPageState | undefined {
    const state = keyedHooks.websiteRequests(key)
    const snapshot = useSyncExternalStore(state === undefined ? absentState.subscribe : listener => state.subscribe(listener),
      () => state?.getSnapshot())
    return select === undefined ? snapshot : select(snapshot)
  }
  const profileDraft = createWebsiteProfileDraftStore().create()
  const tabActions = { bindCommands: vi.fn<ReturnType<BrowserBodyProps['useTabInfo']>['tab']['actions']['bindCommands']>(() => vi.fn()), openResource: vi.fn(), openTab: vi.fn(), close: vi.fn() }
  const props: Pick<BrowserBodyProps, 'sessionId' | 'useTabInfo' | 'useStore' | 'actions' | 't' | 'useBrowserState' | 'useWebsiteProfiles' | 'useWebsiteRequests' | 'profiles' | 'renderSlot'>
    & Omit<BrowserInjected, 'keyedHooks' | 'hooks'> = {
      sessionId: SESSION,
      useTabInfo: () => ({
        sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane' as PaneId },
        tab: {
          id: TAB, kind: 'browser', title: 'Browser', contentId: 'sidebar://browser/1', visible: true,
          navigation: { address: 'sidebar://browser/1', params: navigation, revision: 0 },
          signal: lifetime.signal,
          actions: tabActions, refreshShortcut: options.refreshShortcut,
        },
      }),
      useStore: hookOf(store),
      actions: store.actions,
      profiles: options.profiles,
      renderSlot: ((_name: 'sidebar.right.pane.tab.browser.profiles', owner: Pick<BrowserProfilePickerProps, 'profileId' | 'openProfile'>) => options.profiles === undefined ? null : <BrowserProfilePicker {...{
        ...owner, sessionId: SESSION, profiles: options.profiles, useStore: hookOf(profileDraft), actions: profileDraft.actions,
        useWebsiteProfiles: props.useWebsiteProfiles, t: props.t,
      } as BrowserProfilePickerProps} />) as BrowserBodyProps['renderSlot'],
      t: (key, params) => {
        const template = messages[key] ?? key
        return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name]))
      },
      ...commands,
      useBrowserState: (key: string) => {
        const state = keyedHooks.browserState(key) ?? absentState
        return useSyncExternalStore(state.subscribe, state.getSnapshot)
      },
      useWebsiteRequests,
      useWebsiteProfiles: hookOf(websiteProfiles),
    }
  let visible = true
  const readTab = props.useTabInfo
  props.useTabInfo = () => {
    const current = readTab()
    return { ...current, tab: { ...current.tab, visible } }
  }
  const renderBody = () => render(<BrowserBody {...props as BrowserBodyProps} />)
  const view = renderBody()
  return {
    view, remount: renderBody, store, lifetime, injected, tabActions, websiteProfiles,
    setVisible(next: boolean) { visible = next; view.rerender(<BrowserBody {...props as BrowserBodyProps} />) },
  }
}

afterEach(async () => {
  cleanup()
  const results = await Promise.allSettled([
    ...controllers.splice(0).map(controller => controller.dispose()),
    ...requestSessions.splice(0).map(session => session.dispose()),
  ])
  for (const lifetime of lifetimes) lifetime.abort()
  lifetimes.clear()
  localStorage.clear()
  vi.restoreAllMocks()
  const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
  if (failures.length !== 0) throw new AggregateError(failures, 'Browser component fixtures failed to drain')
})

describe('BrowserBody', () => {
  it('displays the effective browser refresh accelerator', () => {
    const mounted = mountBrowser(undefined, { refreshShortcut: { id: 'page.refresh' as never,
      label: 'Refresh', aliases: [], binding: null, keys: ['Ctrl', 'R'], aria: 'Control+R',
      modified: true, conflicts: [], issue: null } })
    expect(mounted.view.getByRole('button', { name: zh.reload }).getAttribute('aria-keyshortcuts')).toBe('Control+R')
  })
  it('shows the saved title and URL without loading until Restore is clicked', async () => {
    const target = { kind: 'https' as const, url: 'https://saved.example/page', title: 'Saved title' }
    const mounted = mountBrowser(undefined, { initial: browserAddressCheckpoint(target, 1) })
    expect(mounted.view.getByText(target.title)).toBeDefined()
    expect(mounted.view.getByText(target.url)).toBeDefined()
    expect(mounted.view.container.querySelector('iframe')).toBeNull()
    expect(mounted.view.getByRole('button', { name: zh.reload })).toHaveProperty('disabled', false)
    fireEvent.click(mounted.view.getByRole('button', { name: zh['restore.action'] }))
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')?.src).toBe(target.url) })
    expect(mounted.view.queryByText(target.title)).toBeNull()
  })

  it('renders native error details and routes provider open requests through the source tab', () => {
    const state = createSnapshotStore<BrowserFrameState>({ ...emptyBrowserFrame(), error: { code: -105, description: 'DNS failure' } })
    const providers: BrowserPageOptions[] = []
    const mounted = mountBrowser(undefined, { createPage: (options) => {
      providers.push(options)
      return {
        presentation: { mount: () => () => {} },
        frame: { getSnapshot: () => state.getSnapshot(), subscribe: listener => state.subscribe(listener),
          loadUrl: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), dispose: async () => {} },
      }
    } })
    expect(mounted.view.getByRole('status').textContent).toContain('DNS failure')
    expect(mounted.view.getByRole('status').textContent).toContain('-105')
    act(() => { state.set({ ...state.getSnapshot(), error: { code: -105, description: undefined } }) })
    expect(mounted.view.getByRole('status').textContent).toBe(zh['load.failed'])
    act(() => { providers[0]!.openRequested('https://new.example/') })
    expect(mounted.tabActions.openTab).toHaveBeenCalledExactlyOnceWith('browser', {
      params: { url: 'https://new.example/' }, revealIfOpened: false,
    })
  })

  it('routes address input to the controller and renders parser failures', async () => {
    const mounted = mountBrowser()
    const input = mounted.view.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => { expect(mounted.view.getByRole('alert').textContent).toBe(zh['error.protocol']) })
    expect(input).toHaveProperty('value', 'javascript:alert(1)')
    expect(mounted.view.container.querySelector('iframe')).toBeNull()
    fireEvent.change(input, { target: { value: 'file:///work/index.html' } })
    fireEvent.submit(input.closest('form')!)
    expect(mounted.view.getByRole('alert').textContent).toBe(zh['error.protocol'])
  })

  it('renders HTTPS in the fixed sandbox and follows controller history', async () => {
    const mounted = mountBrowser()
    const input = mounted.view.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'example.com/one' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')).not.toBeNull() })
    expect(input).toHaveProperty('value', 'https://example.com/one')
    let frame = mounted.view.container.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe('https://example.com/one')
    expect(frame.getAttribute('sandbox')).toBe(WEB_BROWSER_SANDBOX)
    expect(frame.getAttribute('allow')).toBeNull()
    // jsdom does not reflect the iframe referrerPolicy property to its attribute.
    expect(frame.referrerPolicy).toBe('no-referrer')
    const disableSandbox = mounted.view.getByRole('button', { name: zh['sandbox.disable'] })
    const protectedMark = disableSandbox.querySelector('svg path:last-child')?.getAttribute('d')
    fireEvent.click(disableSandbox)
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')?.getAttribute('sandbox')).toBeNull() })
    expect(mounted.view.getByRole('status').textContent).toBe(zh['sandbox.warning'])
    const enableSandbox = mounted.view.getByRole('button', { name: zh['sandbox.enable'] })
    expect(enableSandbox.querySelector('svg path:last-child')?.getAttribute('d')).not.toBe(protectedMark)
    fireEvent.click(enableSandbox)
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')?.getAttribute('sandbox')).toBe(WEB_BROWSER_SANDBOX) })
    expect(mounted.view.getByRole('button', { name: zh['sandbox.disable'] }).querySelector('svg path:last-child')?.getAttribute('d')).toBe(protectedMark)

    fireEvent.change(input, { target: { value: 'https://example.com/two' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/two') })
    fireEvent.click(mounted.view.getByRole('button', { name: zh.back }))
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/one') })
    expect(input).toHaveProperty('value', 'https://example.com/one')
    frame = mounted.view.container.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe('https://example.com/one')
    expect(mounted.store.getSnapshot().byTab[TAB]?.index).toBe(0)
    fireEvent.click(mounted.view.getByRole('button', { name: zh.forward }))
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/two') })
    expect(input).toHaveProperty('value', 'https://example.com/two')

    const beforeReload = mounted.store.getSnapshot().byTab[TAB]!.request!.revision
    fireEvent.click(mounted.view.getByRole('button', { name: zh.reload }))
    expect(mounted.store.getSnapshot().byTab[TAB]!.request?.revision).toBe(beforeReload + 1)
    fireEvent.submit(input.closest('form')!)
    expect(mounted.store.getSnapshot().byTab[TAB]!.request?.revision).toBe(beforeReload + 2)
    act(() => { mounted.tabActions.bindCommands.mock.calls.at(-1)![0].refresh!() })
    expect(mounted.store.getSnapshot().byTab[TAB]!.request?.revision).toBe(beforeReload + 3)
  })

  it('marks later frame loads unknown and limits unsafe toolbar actions', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const mounted = mountBrowser()
    const input = mounted.view.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'https://example.com/one' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')).not.toBeNull() })
    fireEvent.change(input, { target: { value: 'https://example.com/two' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/two') })
    const frame = mounted.view.container.querySelector('iframe')!
    const revision = mounted.store.getSnapshot().byTab[TAB]!.request!.revision

    fireEvent.load(frame)
    expect(mounted.store.getSnapshot().byTab[TAB]?.navigation).toEqual({ status: 'known', revision })
    expect(mounted.view.getByRole('button', { name: zh.back })).toHaveProperty('disabled', false)
    fireEvent.load(frame)
    expect(mounted.store.getSnapshot().byTab[TAB]?.navigation).toEqual({ status: 'unknown', revision })
    expect(mounted.view.getByText(zh['address.changed'])).toBeDefined()
    expect(mounted.view.getByRole('button', { name: zh.back })).toHaveProperty('disabled', true)
    expect(mounted.view.getByRole('button', { name: zh.forward })).toHaveProperty('disabled', true)
    expect(mounted.view.getByRole('button', { name: zh.external })).toHaveProperty('disabled', true)
    expect(mounted.view.getByRole('button', { name: zh.reload })).toHaveProperty('disabled', false)
    fireEvent.click(mounted.view.getByRole('button', { name: zh.external }))
    expect(open).not.toHaveBeenCalled()

    fireEvent.click(mounted.view.getByRole('button', { name: zh.reload }))
    expect(mounted.store.getSnapshot().byTab[TAB]?.navigation).toEqual({ status: 'loading', revision: revision + 1 })
  })

  it('shows a best-effort iframe error notice until the next controlled load', async () => {
    const mounted = mountBrowser()
    const input = mounted.view.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'https://example.com/one' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')).not.toBeNull() })
    const failedFrame = mounted.view.container.querySelector('iframe')!

    fireEvent.error(failedFrame)
    expect(mounted.injected.keyedHooks.browserState(TAB)?.getSnapshot().frame.error).toBeDefined()
    await waitFor(() => { expect(mounted.view.getByText(zh['load.failed'])).toBeDefined() })
    fireEvent.click(mounted.view.getByRole('button', { name: zh.reload }))
    await waitFor(() => { expect(mounted.view.queryByText(zh['load.failed'])).toBeNull() })
    fireEvent.error(failedFrame)
    expect(mounted.view.queryByText(zh['load.failed'])).toBeNull()
  })

  it('loads loopback under the default sandbox and keeps it across sandbox changes', async () => {
    const mounted = mountBrowser()
    const input = mounted.view.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'http://localhost:5173/' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/') })
    expect(mounted.view.container.querySelector('iframe')?.getAttribute('sandbox')).toBe(WEB_BROWSER_SANDBOX)

    fireEvent.click(mounted.view.getByRole('button', { name: zh['sandbox.disable'] }))
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')?.getAttribute('sandbox')).toBeNull() })
    fireEvent.click(mounted.view.getByRole('button', { name: zh['sandbox.enable'] }))
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')?.getAttribute('sandbox')).toBe(WEB_BROWSER_SANDBOX) })
    expect(mounted.view.container.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/')
  })

  it('opens known Web targets externally and consumes an initial typed navigation', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const mounted = mountBrowser({ url: 'https://initial.example/path' })
    const input = mounted.view.getByRole('textbox') as HTMLInputElement
    await waitFor(() => { expect(input.value).toBe('https://initial.example/path') })
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')).not.toBeNull() })
    fireEvent.click(mounted.view.getByRole('button', { name: zh.external }))
    expect(open).toHaveBeenCalledWith('https://initial.example/path', '_blank', 'noopener,noreferrer')
  })

  it('keeps a rejected initial URL in the address input for editing', async () => {
    const mounted = mountBrowser({ url: 'file:/work/index.html' })
    const input = mounted.view.getByRole('textbox')
    await waitFor(() => { expect(mounted.view.getByRole('alert').textContent).toBe(zh['error.protocol']) })
    expect(input).toHaveProperty('value', 'file:/work/index.html')
    expect(mounted.view.container.querySelector('iframe')).toBeNull()
  })

  it('reloads the latest controlled URL instead of replaying the initial URL after remount', async () => {
    const mounted = mountBrowser({ url: 'https://initial.example/path' })
    const input = mounted.view.getByRole('textbox')
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')?.getAttribute('src')).toBe('https://initial.example/path') })
    fireEvent.change(input, { target: { value: 'https://latest.example/path' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => { expect(mounted.view.container.querySelector('iframe')?.getAttribute('src')).toBe('https://latest.example/path') })

    mounted.view.unmount()
    const remounted = mounted.remount()
    await waitFor(() => { expect(remounted.container.querySelector('iframe')?.getAttribute('src')).toBe('https://latest.example/path') })
    expect(remounted.getByRole('textbox')).toHaveProperty('value', 'https://latest.example/path')
    expect(mounted.store.getSnapshot().byTab[TAB]?.entries.at(-1)?.url).toBe('https://latest.example/path')
  })

})

const PROFILE_ID = 'profile-1' as DesktopWebsiteProfileId
const PROFILE: DesktopWebsiteProfile = {
  id: PROFILE_ID, name: 'Work account', accountLabel: 'me@example.test',
  url: 'https://work.example/', mcpServerName: 'website', control: 'human',
}

/** @param profileIds - saved profiles this tab may pick from. @returns one occurrence of a profile tab. */
function mountProfileTab(profiles: WebsiteProfileCommands, state: Partial<WebsiteProfilesState>, profileId = PROFILE_ID) {
  return mountBrowser({ url: PROFILE.url, profileId }, { profiles, websiteProfiles: profileState(state) })
}

describe('BrowserBody saved profiles', () => {
  it('shows account-wide reservations without granting this page and routes nondestructive alias Takeover', async () => {
    const commands = profileCommands()
    const navigation = vi.fn()
    const state = profileState({ profiles: [{ ...PROFILE, control: 'agent' }] })
    const mounted = mountBrowser({ url: PROFILE.url, profileId: PROFILE_ID }, {
      profiles: commands, websiteProfiles: state,
      createPage: (options) => {
        const page = createIframePage(options)
        return { ...page, frame: { getSnapshot: () => page.frame.getSnapshot(),
          subscribe: listener => page.frame.subscribe(listener), dispose: () => page.frame.dispose(),
          loadUrl: navigation, reload: navigation, goBack: navigation,
          goForward: navigation, sandbox: { setEnabled: navigation } } }
      },
    })
    expect(mounted.view.getByText(zh['profiles.detail.reserved'])).toBeDefined()
    expect(mounted.view.queryByText(zh['profiles.bar.agent'])).toBeNull()
    expect(mounted.view.getByRole('button', { name: zh['profiles.resume'] })).toHaveProperty('disabled', true)
    expect(mounted.view.getByRole('textbox')).toHaveProperty('disabled', true)
    act(() => {
      mounted.injected.loadUrl(TAB, 'https://work.example/inbox')
      mounted.injected.goBack(TAB)
      mounted.injected.goForward(TAB)
      mounted.injected.reload(TAB)
      mounted.injected.setSandbox(TAB, false)
    })
    expect(navigation).not.toHaveBeenCalled()
    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.takeControl'] }))
    expect(commands.takeover).toHaveBeenCalledExactlyOnceWith(PROFILE_ID)
    expect(commands.signOut).not.toHaveBeenCalled()
    expect(commands.forget).not.toHaveBeenCalled()
    act(() => { state.set({ ...state.getSnapshot(), profiles: [PROFILE] }) })
    expect(mounted.view.queryByRole('button', { name: zh['profiles.takeControl'] })).toBeNull()
    act(() => { mounted.injected.loadUrl(TAB, 'https://work.example/inbox') })
    expect(navigation).toHaveBeenCalledOnce()
    act(() => { state.set({ ...state.getSnapshot(), phase: 'loading' }) })
    act(() => { mounted.injected.loadUrl(TAB, 'https://work.example/blocked') })
    expect(navigation).toHaveBeenCalledOnce()
    act(() => { state.set({ ...state.getSnapshot(), phase: 'ready', profiles: [] }) })
    act(() => { mounted.injected.loadUrl(TAB, 'https://work.example/missing') })
    expect(navigation).toHaveBeenCalledOnce()
  })

  it('requires explicit request selection, keeps Takeover immediate, and never resumes on showing a hidden tab', async () => {
    const requestId = 'request-1' as DesktopWebsiteRequestId
    const bridge = requestStubs()
    vi.mocked(bridge.list).mockResolvedValue([{ id: requestId, sessionId: SESSION, profile: PROFILE_ID, epoch: 1, status: 'pending' }])
    const lease = 'lease' as DesktopBrowserLeaseId
    const receipt = { requestId, epoch: 3, lease, visibility: 'visible' as DesktopWebsiteVisibilityId }
    vi.mocked(bridge.prepare).mockResolvedValue(receipt)
    vi.mocked(bridge.resume).mockImplementation(async current => current)
    const session = new WebsiteRequestSession(SESSION, bridge, vi.fn())
    requestSessions.push(session)
    const binding = new AbortController()
    lifetimes.add(binding)
    const mounted = mountBrowser({ url: PROFILE.url, profileId: PROFILE_ID }, {
      profiles: profileCommands(), websiteProfiles: profileState({ profiles: [PROFILE] }),
      createPage: (options) => {
        const requests = session.createPage(PROFILE_ID)
        requests.bind({ lease, signal: binding.signal })
        return { ...createIframePage(options), requests }
      },
    })
    await act(async () => { await session.reload() })
    const resume = mounted.view.getByRole('button', { name: zh['profiles.resume'] })
    expect(resume).toHaveProperty('disabled', true)
    expect(mounted.view.getByText(zh['profiles.bar.human'])).toBeDefined()
    mounted.view.container.style.overflow = 'hidden'
    fireEvent.click(mounted.view.getByRole('button', { name: zh['requests.choose'] }))
    expect(mounted.view.container.contains(mounted.view.getByRole('menu'))).toBe(false)
    const selectedLabel = zh['requests.label'].replace('{id}', requestId)
    fireEvent.click(mounted.view.getByRole('menuitem', { name: selectedLabel }))
    expect(resume).toHaveProperty('disabled', false)
    expect(bridge.resume).not.toHaveBeenCalled()
    act(() => { mounted.websiteProfiles.set({ ...mounted.websiteProfiles.getSnapshot(), profiles: [{ ...PROFILE, control: 'agent' }] }) })
    expect(resume).toHaveProperty('disabled', true)
    await mounted.injected.resumeRequest(TAB)
    expect(bridge.resume).not.toHaveBeenCalled()
    act(() => { mounted.websiteProfiles.set({ ...mounted.websiteProfiles.getSnapshot(), profiles: [PROFILE] }) })
    fireEvent.click(resume)
    await waitFor(() => { expect(mounted.view.getByText(zh['profiles.bar.agent'])).toBeDefined() })
    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.takeControl'] }))
    expect(bridge.takeover).toHaveBeenCalledWith(requestId)
    expect(mounted.view.getByText(zh['profiles.bar.human'])).toBeDefined()
    await waitFor(() => { expect(resume).toHaveProperty('disabled', false) })
    fireEvent.click(resume)
    await waitFor(() => { expect(mounted.view.getByText(zh['profiles.bar.agent'])).toBeDefined() })
    mounted.setVisible(false)
    expect(mounted.view.getByText(zh['profiles.bar.human'])).toBeDefined()
    expect(resume).toHaveProperty('disabled', true)
    expect(bridge.takeover).toHaveBeenCalledTimes(2)
    mounted.setVisible(true)
    await waitFor(() => { expect(resume).toHaveProperty('disabled', false) })
    expect(mounted.view.getByText(zh['profiles.bar.human'])).toBeDefined()
    expect(bridge.resume).toHaveBeenCalledTimes(2)
    expect(mounted.view.getByRole('button', { name: selectedLabel })).toBeDefined()
  })

  it('never substitutes account Takeover for this page’s failed drainage', async () => {
    const requestId = 'held-request' as DesktopWebsiteRequestId
    const lease = 'held-lease' as DesktopBrowserLeaseId
    const bridge = requestStubs()
    vi.mocked(bridge.list).mockResolvedValue([{ id: requestId, sessionId: SESSION, profile: PROFILE_ID, epoch: 1, status: 'pending' }])
    vi.mocked(bridge.prepare).mockResolvedValue({ requestId, epoch: 2, lease, visibility: 'visible' as DesktopWebsiteVisibilityId })
    vi.mocked(bridge.resume).mockImplementation(async receipt => receipt)
    const failure = new Error('private retained drainage failure')
    vi.mocked(bridge.takeover).mockRejectedValue(failure)
    const session = new WebsiteRequestSession(SESSION, bridge, vi.fn())
    const commands = profileCommands()
    const binding = new AbortController()
    lifetimes.add(binding)
    let requests: ReturnType<WebsiteRequestSession['createPage']> | undefined
    const mounted = mountBrowser({ url: PROFILE.url, profileId: PROFILE_ID }, {
      profiles: commands, websiteProfiles: profileState({ profiles: [PROFILE] }),
      createPage: (options) => {
        requests = session.createPage(PROFILE_ID)
        requests.bind({ lease, signal: binding.signal })
        return { ...createIframePage(options), requests }
      },
    })
    try {
      await act(async () => { await session.reload() })
      act(() => { mounted.injected.selectRequest(TAB, requestId) })
      await act(async () => { await mounted.injected.resumeRequest(TAB) })
      act(() => { mounted.websiteProfiles.set({ ...mounted.websiteProfiles.getSnapshot(), profiles: [{ ...PROFILE, control: 'agent' }] }) })
      await act(async () => { await mounted.injected.takeoverRequest(TAB) })
      expect(mounted.view.queryByRole('button', { name: zh['profiles.takeControl'] })).toBeNull()
      expect(mounted.view.getByRole('button', { name: zh['profiles.resume'] })).toHaveProperty('disabled', true)
      expect(commands.takeover).not.toHaveBeenCalled()
      expect(mounted.view.container.textContent).not.toContain(failure.message)
    } finally {
      // Retained failures remain joinable during fixture teardown.
      mounted.view.unmount()
      controllers.splice(controllers.indexOf(mounted.injected), 1)
      await expect(mounted.injected.dispose()).rejects.toBeInstanceOf(AggregateError)
      await expect(requests?.dispose()).rejects.toBeInstanceOf(AggregateError)
      await expect(session.dispose()).rejects.toBeInstanceOf(AggregateError)
    }
  })

  it('reports saved profiles as desktop-only instead of faking them in Web', () => {
    const mounted = mountBrowser({ profileId: PROFILE_ID })
    expect(mounted.view.getByText(zh['profiles.desktopOnly'])).toBeDefined()
    expect(mounted.view.queryByRole('button', { name: zh['profiles.button'] })).toBeNull()
    expect(mounted.view.queryByText(zh['profiles.missing'])).toBeNull()
  })

  it('keeps the account menu outside clipped toolbar ancestors and inside the right window edge', () => {
    const width = 260
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(window.innerWidth - 36, 20, 24, 24))
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(180)
    const mounted = mountProfileTab(profileCommands(), { profiles: [PROFILE] })
    mounted.view.container.style.overflow = 'hidden'
    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.button'] }))
    const menu = mounted.view.getByRole('menu')
    expect(mounted.view.container.contains(menu)).toBe(false)
    expect(parseFloat(menu.style.left)).toBe(window.innerWidth - 12 - width)
    expect(menu.textContent).toContain(PROFILE.name)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(mounted.view.queryByRole('menu')).toBeNull()
    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.button'] }))
    fireEvent.pointerDown(document.body)
    expect(mounted.view.queryByRole('menu')).toBeNull()
  })

  it('opens a saved profile page from the picker and marks the profile this tab uses', () => {
    const other = { ...PROFILE, id: 'profile-2' as DesktopWebsiteProfileId, name: 'Personal', url: 'https://personal.example/' }
    const mounted = mountProfileTab(profileCommands(), { profiles: [PROFILE, other] })
    expect(mounted.view.getByText(zh['profiles.bar.human'])).toBeDefined()
    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.button'] }))

    const rows = mounted.view.getAllByRole('menuitem')
    expect(rows[0]?.textContent).toContain(PROFILE.name)
    expect(rows[0]?.querySelector('svg')).not.toBeNull()
    expect(rows[1]?.textContent).toContain(other.name)
    expect(rows[1]?.querySelector('svg')).toBeNull()

    fireEvent.click(rows[1]!)
    expect(mounted.tabActions.openTab).toHaveBeenCalledExactlyOnceWith('browser', {
      params: { url: other.url, profileId: other.id }, revealIfOpened: false,
    })
  })

  it('keeps a link opened from a profile page inside that profile', () => {
    const providers: BrowserPageOptions[] = []
    const frames = createSnapshotStore<BrowserFrameState>(emptyBrowserFrame())
    const mounted = mountProfileTab(profileCommands(), { profiles: [PROFILE] })
    mounted.view.unmount()
    const profileTab = mountBrowser({ url: PROFILE.url, profileId: PROFILE_ID }, {
      profiles: profileCommands(),
      websiteProfiles: profileState({ profiles: [PROFILE] }),
      createPage: (options) => {
        providers.push(options)
        return {
          presentation: { mount: () => () => {} },
          frame: { getSnapshot: () => frames.getSnapshot(), subscribe: listener => frames.subscribe(listener),
            loadUrl: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), dispose: async () => {} },
        }
      },
    })
    act(() => { providers[0]!.openRequested('https://work.example/inbox?thread=2') })
    expect(profileTab.tabActions.openTab).toHaveBeenCalledExactlyOnceWith('browser', {
      params: { url: 'https://work.example/inbox?thread=2', profileId: PROFILE_ID }, revealIfOpened: false,
    })
  })

  it('creates a saved profile from the toolbar form and opens its own page', async () => {
    const created = { ...PROFILE, id: 'profile-3' as DesktopWebsiteProfileId, name: 'New account', url: 'https://new.example/' }
    const create = vi.fn(async (_input: DesktopWebsiteProfileInput) => created)
    const mounted = mountBrowser(undefined, { profiles: profileCommands({ create }), websiteProfiles: profileState() })
    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.button'] }))
    expect(mounted.view.getByRole('menuitem', { name: zh['profiles.empty'] })).toHaveProperty('disabled', true)
    fireEvent.click(mounted.view.getByRole('menuitem', { name: zh['profiles.new'] }))

    fireEvent.change(mounted.view.getByLabelText(zh['profiles.create.name']), { target: { value: ' New account ' } })
    fireEvent.change(mounted.view.getByLabelText(zh['profiles.create.url']), { target: { value: 'https://new.example/' } })
    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.create.action'] }))
    expect(create).not.toHaveBeenCalled()
    fireEvent.keyDown(mounted.view.getByLabelText(zh['profiles.create.url']), { key: 'Enter' })
    expect(create).not.toHaveBeenCalled()

    fireEvent.change(mounted.view.getByLabelText(zh['profiles.create.mcp']), { target: { value: 'website' } })
    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.create.action'] }))
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({ name: 'New account', accountLabel: '', url: 'https://new.example/', mcpServerName: 'website' })
    })
    await waitFor(() => { expect(mounted.view.queryByRole('dialog')).toBeNull() })
    expect(mounted.tabActions.openTab).toHaveBeenCalledExactlyOnceWith('browser', {
      params: { url: 'https://new.example/', profileId: created.id }, revealIfOpened: false,
    })
  })

  it('keeps the create form open when the desktop app refuses the pairing', async () => {
    const create = vi.fn(async (_input: DesktopWebsiteProfileInput) => undefined)
    const mounted = mountBrowser(undefined, { profiles: profileCommands({ create }), websiteProfiles: profileState() })
    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.button'] }))
    fireEvent.click(mounted.view.getByRole('menuitem', { name: zh['profiles.new'] }))
    fireEvent.change(mounted.view.getByLabelText(zh['profiles.create.name']), { target: { value: 'Work' } })
    fireEvent.change(mounted.view.getByLabelText(zh['profiles.create.url']), { target: { value: 'https://work.example/' } })
    fireEvent.change(mounted.view.getByLabelText(zh['profiles.create.mcp']), { target: { value: 'website' } })
    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.create.action'] }))
    await waitFor(() => { expect(create).toHaveBeenCalledOnce() })
    expect(mounted.view.getByRole('dialog')).toBeDefined()
    expect(mounted.tabActions.openTab).not.toHaveBeenCalled()
    mounted.view.unmount()
    const remounted = mounted.remount()
    fireEvent.click(remounted.getByRole('button', { name: zh['profiles.button'] }))
    fireEvent.click(remounted.getByRole('menuitem', { name: zh['profiles.new'] }))
    expect(remounted.getByLabelText(zh['profiles.create.name'])).toHaveProperty('value', 'Work')
    expect(remounted.getByLabelText(zh['profiles.create.url'])).toHaveProperty('value', 'https://work.example/')
    expect(remounted.getByLabelText(zh['profiles.create.mcp'])).toHaveProperty('value', 'website')
    fireEvent.click(remounted.getByRole('button', { name: zh['cancel'] }))
    expect(remounted.queryByRole('dialog')).toBeNull()
    fireEvent.click(remounted.getByRole('button', { name: zh['profiles.button'] }))
    fireEvent.click(remounted.getByRole('menuitem', { name: zh['profiles.new'] }))
    expect(remounted.getByLabelText(zh['profiles.create.name'])).toHaveProperty('value', '')
  })

  it('does not mistake profile-wide control for permission to admit a page request', () => {
    const mounted = mountProfileTab(profileCommands(), { profiles: [{ ...PROFILE, control: 'agent' }] })
    expect(mounted.view.getByText(zh['profiles.bar.reserved'])).toBeDefined()
    expect(mounted.view.getByRole('button', { name: zh['profiles.resume'] })).toHaveProperty('disabled', true)
    expect(mounted.view.getByRole('button', { name: zh['requests.choose'] })).toHaveProperty('disabled', true)
    expect(mounted.view.getByRole('button', { name: zh['profiles.takeControl'] })).toBeDefined()
  })

  it('signs out immediately and forgets only after confirmation', () => {
    const profiles = profileCommands()
    const mounted = mountProfileTab(profiles, { profiles: [PROFILE] })
    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.signOut'] }))
    expect(profiles.signOut).toHaveBeenCalledExactlyOnceWith(PROFILE_ID)

    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.forget'] }))
    expect(profiles.forget).not.toHaveBeenCalled()
    const dialog = mounted.view.getByRole('dialog')
    expect(dialog.textContent).toContain(zh['profiles.forgetConfirm.description'])
    fireEvent.click(within(dialog).getByRole('button', { name: zh['cancel'] }))
    expect(profiles.forget).not.toHaveBeenCalled()

    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.forget'] }))
    fireEvent.click(within(mounted.view.getByRole('dialog')).getByRole('button', { name: zh['profiles.forget'] }))
    expect(profiles.forget).toHaveBeenCalledExactlyOnceWith(PROFILE_ID)
    expect(mounted.view.queryByRole('dialog')).toBeNull()
  })

  it('keeps a retained cleanup failure visible and reachable from the picker', () => {
    const profiles = profileCommands()
    const mounted = mountProfileTab(profiles, { profiles: [{ ...PROFILE, control: 'cleanup-failed' }] })
    expect(mounted.view.getByText(zh['profiles.bar.cleanupFailed'])).toBeDefined()
    expect(mounted.view.queryByRole('button', { name: zh['profiles.resume'] })).toBeNull()
    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.button'] }))
    expect(mounted.view.getByRole('menuitem', { name: new RegExp(`^${PROFILE.name}`) })).toHaveProperty('disabled', true)
    fireEvent.click(mounted.view.getByRole('menuitem', { name: zh['profiles.retryCleanup'].replace('{name}', PROFILE.name) }))
    expect(profiles.signOut).toHaveBeenCalledExactlyOnceWith(PROFILE_ID)
  })

  it('holds every action while one is in flight and while a cleanup runs', () => {
    const profiles = profileCommands()
    const busy = mountProfileTab(profiles, { profiles: [PROFILE], busy: PROFILE_ID })
    expect(busy.view.getByRole('button', { name: zh['profiles.resume'] })).toHaveProperty('disabled', true)
    expect(busy.view.getByRole('button', { name: zh['profiles.signOut'] })).toHaveProperty('disabled', true)

    busy.view.unmount()
    const clearing = mountProfileTab(profiles, { profiles: [{ ...PROFILE, control: 'clearing' }] })
    expect(clearing.view.getByText(zh['profiles.bar.clearing'])).toBeDefined()
    expect(clearing.view.queryByRole('button', { name: zh['profiles.signOut'] })).toBeNull()
    expect(clearing.view.queryByRole('button', { name: zh['profiles.forget'] })).toBeNull()
    fireEvent.click(clearing.view.getByRole('button', { name: zh['profiles.button'] }))
    expect(clearing.view.getByRole('menuitem', { name: new RegExp(`^${PROFILE.name}`) })).toHaveProperty('disabled', true)
  })

  it('names a profile the desktop app no longer reports', () => {
    const mounted = mountProfileTab(profileCommands(), { phase: 'loading' })
    expect(mounted.view.getByText(zh['profiles.missing'])).toBeDefined()
    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.button'] }))
    expect(mounted.view.getByRole('menuitem', { name: zh['profiles.loading'] })).toHaveProperty('disabled', true)
  })

  it('offers a retry when the saved list could not be read', () => {
    const profiles = profileCommands()
    const mounted = mountBrowser(undefined, { profiles, websiteProfiles: profileState({ phase: 'failed' }) })
    fireEvent.click(mounted.view.getByRole('button', { name: zh['profiles.button'] }))
    expect(mounted.view.getByRole('menuitem', { name: zh['profiles.loadFailed'] })).toHaveProperty('disabled', true)
    fireEvent.click(mounted.view.getByRole('menuitem', { name: zh['retry'] }))
    expect(profiles.reload).toHaveBeenCalledOnce()
  })
})
