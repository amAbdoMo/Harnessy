/** Native preview routing uses attached leases, chat ownership and human handoff. */
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { DesktopBrowserLeaseId, DesktopWebsiteProfile } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DesktopBrowserPreview } from '../src/browser-preview.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

function fixture(profiles: readonly DesktopWebsiteProfile[] = []) {
  const published = vi.fn()
  const owner = { isDestroyed: () => false, send: published } as Pick<WebContents, 'isDestroyed' | 'send'> as WebContents
  const guest = {
    isDestroyed: () => false, getURL: () => 'https://example.test/', getTitle: () => 'Example', isLoading: () => false,
    loadURL: vi.fn(async () => {}), executeJavaScript: vi.fn(async () => ({ text: 'Visible page', elements: [] })),
    capturePage: vi.fn(async () => ({ getSize: () => ({ width: 800, height: 600 }), toPNG: () => Buffer.from('png') })),
    sendInputEvent: vi.fn(),
    on: vi.fn(),
  }
  const lease = 'tab-one' as DesktopBrowserLeaseId
  const inspectBrowser = vi.fn((_owner: WebContents, id: DesktopBrowserLeaseId) => id === lease
    ? guest as Pick<WebContents, 'getURL' | 'getTitle' | 'isLoading'> as WebContents : undefined)
  const preview = new DesktopBrowserPreview({ inspectBrowser, onInvalidated: () => () => {},
    command: async () => {},
    allowsBrowserAddress: url => url.startsWith('https://example.test/') }, () => owner, async () => profiles)
  const request = (sessionId: string, operation: object, requestId = randomUUID()) => preview.request({ type: 'browser-preview', requestId, sessionId, operation })
  return { owner, guest, preview, lease, request, inspectBrowser, published }
}

it('lists only its chat and unclaimed tabs, while an explicit observation remains available during human control', async () => {
  const f = fixture()
  f.preview.bind(f.owner, f.lease, 'one')
  await expect(f.request('two', { kind: 'status' })).resolves.toMatchObject({ ok: true, result: { tabs: [] } })
  await f.preview.control(f.owner, f.lease, true)
  await expect(f.request('two', { kind: 'snapshot', tabId: f.lease })).resolves.toMatchObject({ ok: true, result: { page: { text: 'Visible page' } } })
  expect(f.guest.capturePage).not.toHaveBeenCalled()
  await expect(f.request('one', { kind: 'navigate', tabId: f.lease, url: 'https://example.test/next' })).resolves.toMatchObject({ ok: false, error: 'A human controls this browser tab; resume the agent to act' })
})

it('refuses cross-chat mutations and keeps its own tab available across separate invocations', async () => {
  const f = fixture()
  f.preview.bind(f.owner, f.lease, 'one')
  await expect(f.request('two', { kind: 'evaluate', tabId: f.lease, expression: 'location.href' })).resolves.toMatchObject({ ok: false, error: 'This browser tab belongs to another chat' })
  await expect(f.request('one', { kind: 'evaluate', tabId: f.lease, expression: 'document.title' })).resolves.toMatchObject({ ok: true, result: { value: { text: 'Visible page' } } })
  await expect(f.request('one', { kind: 'navigate', tabId: f.lease, url: 'https://example.test/next' })).resolves.toMatchObject({ ok: true })
  expect(f.guest.loadURL).toHaveBeenCalledWith('https://example.test/next')
})

it('permits unclaimed tabs and refuses destinations excluded by native navigation', async () => {
  const f = fixture()
  f.preview.bind(f.owner, f.lease, null)
  await expect(f.request('one', { kind: 'navigate', tabId: f.lease, url: 'https://forbidden.test/' })).resolves.toMatchObject({ ok: false, error: 'Browser URL is not permitted' })
  expect(f.guest.loadURL).not.toHaveBeenCalled()
  await expect(f.request('two', { kind: 'act', tabId: f.lease, action: 'press', key: 'Enter' })).resolves.toMatchObject({ ok: true, result: { attempted: true } })
  expect(f.guest.sendInputEvent).toHaveBeenCalledTimes(2)
})

it('completes an agent opening only after the exact owning chat binds the attached guest', async () => {
  const f = fixture()
  const requestId = randomUUID()
  const opening = f.request('one', { kind: 'open', url: 'https://example.test/', reuseExistingTab: false }, requestId)
  expect(f.published).toHaveBeenCalledWith(DESKTOP_IPC.browserAgentOpen, { requestId, sessionId: 'one', url: 'https://example.test/' })
  f.preview.bind(f.owner, f.lease, 'one')
  f.preview.completeOpen(f.owner, requestId, f.lease)
  await expect(opening).resolves.toMatchObject({ ok: true, result: { tabId: f.lease, sessionId: 'one' } })
  expect(() =>{  f.preview.bind(f.owner, f.lease, 'two') }).toThrow('ownership cannot be replaced')
})

it('discovers saved accounts and opens their storage without legacy request admission', async () => {
  const profile: DesktopWebsiteProfile = { id: 'saved-profile' as DesktopWebsiteProfile['id'], name: 'Saved site',
    accountLabel: 'Editor', url: 'https://example.test/', mcpServerName: 'paired-server', control: 'human', access: 'ask', hasSavedLogin: true }
  const f = fixture([profile])
  await expect(f.request('one', { kind: 'status' })).resolves.toMatchObject({ ok: true, result: {
    profiles: [{ profileId: profile.id, name: profile.name, accountLabel: profile.accountLabel, url: profile.url }],
  } })
  const requestId = randomUUID()
  const opening = f.request('one', { kind: 'open', url: profile.url, profileId: profile.id }, requestId)
  await vi.waitFor(() => { expect(f.published).toHaveBeenCalledWith(DESKTOP_IPC.browserAgentOpen,
    { requestId, sessionId: 'one', url: profile.url, profileId: profile.id }) })
  f.preview.bind(f.owner, f.lease, 'one')
  f.preview.completeOpen(f.owner, requestId, f.lease)
  await expect(opening).resolves.toMatchObject({ ok: true, result: { tabId: f.lease, sessionId: 'one' } })
})

it('rejects a canceled queued action before native dispatch', async () => {
  const f = fixture()
  f.preview.bind(f.owner, f.lease, 'one')
  const held = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  f.guest.loadURL.mockImplementationOnce(async () => { started.resolve(undefined); await held.promise })
  const first = f.request('one', { kind: 'navigate', tabId: f.lease, url: 'https://example.test/first' })
  await started.promise
  const queuedId = randomUUID()
  const queued = f.request('one', { kind: 'navigate', tabId: f.lease, url: 'https://example.test/stale' }, queuedId)
  await f.preview.request({ type: 'browser-preview-cancel', requestId: queuedId })
  held.resolve(undefined)
  await first
  await expect(queued).resolves.toMatchObject({ ok: false })
  expect(f.guest.loadURL).toHaveBeenCalledTimes(1)
})

it('retiring a Host cancels pending openings and refuses old queued work', async () => {
  const f = fixture()
  const opening = f.request('one', { kind: 'open', url: 'https://example.test/' })
  f.preview.retireHost()
  await expect(opening).resolves.toMatchObject({ ok: false })
})

it('refuses an invalidated native lease instead of reading its replacement', async () => {
  const f = fixture()
  f.preview.bind(f.owner, f.lease, 'one')
  f.inspectBrowser.mockReturnValue(undefined)
  await expect(f.request('one', { kind: 'snapshot', tabId: f.lease })).resolves.toMatchObject({ ok: false, error: 'Browser tab is closed or no longer attached' })
  expect(f.guest.executeJavaScript).not.toHaveBeenCalled()
})
