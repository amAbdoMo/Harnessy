// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { requestStubs } from './website-request-stubs.client.ts'
import { ElectronWebViewImpl } from '../src/client/electron/ElectronWebViewImpl.ts'
import { ElectronWebviewPresentation, type WebviewElement } from '../src/client/electron/ElectronWebviewPresentation.ts'
import type { DesktopBrowserBridge, DesktopBrowserHumanCommand, DesktopBrowserLeaseId, DesktopWebsiteProfileId } from '../src/types.ts'
import { electronFixture } from './electron-harness.client.ts'

it('finds matches in the human-controlled native page and discards previous search results', async () => {
  const f = electronFixture()
  try {
    f.mount()
    f.frame.loadUrl({ kind: 'https', url: 'https://example.test/', title: 'Example' })
    const guest = await f.guest()
    guest.emit('dom-ready')
    guest.state.url = 'https://example.test/'
    guest.state.loading = false
    guest.emit('did-navigate')
    await f.frame.control?.(true)
    f.frame.findInPage?.('first')
    f.frame.findInPage?.('needle')
    expect(guest.findInPage).toHaveBeenLastCalledWith('needle', { forward: true, findNext: true })
    guest.emit('found-in-page', { result: { requestId: 1, activeMatchOrdinal: 1, matches: 8 } })
    expect(f.frame.getSnapshot().findResult).toBeUndefined()
    guest.emit('found-in-page', { result: { requestId: 2, activeMatchOrdinal: 1, matches: 3 } })
    expect(f.frame.getSnapshot().findResult).toEqual({ active: 1, matches: 3 })

    f.frame.findInPage?.('needle', false)
    expect(guest.findInPage).toHaveBeenLastCalledWith('needle', { forward: false, findNext: false })
    guest.emit('found-in-page', { result: { requestId: 3, activeMatchOrdinal: 3, matches: -1 } })
    expect(f.frame.getSnapshot().findResult).toEqual({ active: 3, matches: 3 })

    await f.frame.control?.(false)
    expect(guest.stopFindInPage).toHaveBeenCalledWith('clearSelection')
    guest.emit('found-in-page', { result: { requestId: 3, activeMatchOrdinal: 2, matches: 3 } })
    f.frame.findInPage?.('other')
    expect(f.frame.getSnapshot().findResult).toBeUndefined()
    expect(guest.findInPage).toHaveBeenCalledTimes(3)
  } finally { await f.dispose() }
})

it('clears a failed load when the main page retries without a toolbar command', async () => {
  let url = 'about:blank'
  let loading = true
  const element: WebviewElement = Object.assign(document.createElement('div'), {
    loadURL: vi.fn(async () => {}), getURL: () => url, getTitle: () => 'Recovered',
    canGoBack: () => false, canGoForward: () => false, clearHistory: vi.fn(),
    goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), isLoading: () => loading,
  })
  const reservation = { lease: 'lease' as DesktopBrowserLeaseId, partition: 'partition' }
  const bridge: DesktopBrowserBridge = {
    requests: requestStubs(),
    profiles: {
      list: async () => [],
      create: async input => ({ ...input, id: 'created' as DesktopWebsiteProfileId, control: 'human', access: 'ask', hasSavedLogin: false }),
      acquire: async () => reservation,
      setUrl: async () => {}, setAccess: async () => {}, saveLogin: async () => {}, removeLogin: async () => {},
      setControl: async () => {}, signOut: async () => {}, forget: async () => {}, onChanged: () => () => {},
    },
    acquire: vi.fn(async () => reservation),
    command: vi.fn(async (_lease: DesktopBrowserLeaseId, command: DesktopBrowserHumanCommand) => {
      if (command.kind === 'navigate') await element.loadURL(command.url)
    }),
    release: vi.fn(async () => {}), onOpenRequested: () => () => {}, onReacquireRequested: () => () => {},
  }
  const presentation = new ElectronWebviewPresentation({ mounted: () =>{  frame.attach() }, unmounted: () =>{  frame.detach() } })
  const frame = new ElectronWebViewImpl({ initial: undefined, profileId: undefined, persist: vi.fn(), openRequested: vi.fn() },
    bridge, async () => 'cwd:/workspace', presentation)
  const createElement = vi.spyOn(presentation, 'createElement').mockReturnValue(element)
  const host = document.createElement('div')
  host.id = 'electron-frame-retry'
  document.body.append(host)
  try {
    presentation.mount(host.id)
    frame.loadUrl({ kind: 'https', url: 'https://example.test/', title: 'Example' })
    await vi.waitFor(() => { expect(host.firstElementChild).toBe(element) })
    element.dispatchEvent(new Event('dom-ready'))
    element.dispatchEvent(Object.assign(new Event('did-fail-load'), {
      isMainFrame: true, errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED',
    }))
    expect(frame.getSnapshot().error?.code).toBe(-105)
    element.dispatchEvent(new Event('page-title-updated'))
    element.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: false }))
    expect(frame.getSnapshot().error?.code).toBe(-105)

    element.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: true }))
    expect(frame.getSnapshot()).toMatchObject({ error: undefined, loading: true })
    element.dispatchEvent(Object.assign(new Event('did-fail-load'), {
      isMainFrame: true, errorCode: -202, errorDescription: 'ERR_CERT_AUTHORITY_INVALID',
    }))
    expect(frame.getSnapshot().error?.code).toBe(-202)
    url = 'https://example.test/recovered'
    element.dispatchEvent(Object.assign(new Event('did-frame-navigate'), { isMainFrame: true, httpResponseCode: -1 }))
    expect(frame.getSnapshot().error?.code).toBe(-202)
    element.dispatchEvent(Object.assign(new Event('did-frame-navigate'), { isMainFrame: true, httpResponseCode: 200 }))
    element.dispatchEvent(new Event('did-navigate'))
    loading = false
    element.dispatchEvent(new Event('did-stop-loading'))
    expect(frame.getSnapshot()).toMatchObject({ error: undefined, loading: false, target: { url, title: 'Recovered' } })
  } finally {
    await frame.dispose()
    createElement.mockRestore()
    host.remove()
  }
})
