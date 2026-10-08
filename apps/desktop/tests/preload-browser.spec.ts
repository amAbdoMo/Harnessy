/** Preload forwards only named Browser operations; request subscriptions contain callback failures and support disposal. */
import type { DesktopWebsiteHostSnapshot, DesktopWebsiteRequestReceipt } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'

const ipc = vi.hoisted(() => ({
  on: vi.fn<(channel: string, listener: (event: object, payload?: unknown) => void) => void>(),
  invoke: vi.fn(async () => undefined),
}))
vi.mock('electron', () => ({ ipcRenderer: ipc }))
const { createDesktopBrowserBridge } = await import('../src/preload-browser.ts')

const REQUEST = '38ac2aa4-f8ce-4b37-951c-80a4c0c117ce' as DesktopWebsiteRequestReceipt['requestId']
const SESSION = 'owner-session' as DesktopWebsiteHostSnapshot['sessionId']
const RECEIPT: DesktopWebsiteRequestReceipt = { requestId: REQUEST, epoch: 0,
  visibility: 'e0405382-c2af-4cce-bff6-009fe742e7f8' as DesktopWebsiteRequestReceipt['visibility'],
  lease: '8d7584ac-c562-44eb-a867-0d21e80cbb05' as DesktopWebsiteRequestReceipt['lease'] }

beforeEach(() => { ipc.on.mockClear(); ipc.invoke.mockClear() })

it('exposes no arbitrary IPC, native objects, or Agent control through profile-wide permissions', async () => {
  const bridge = createDesktopBrowserBridge()
  expect(Object.keys(bridge).sort()).toEqual(['acquire', 'command', 'onOpenRequested', 'onReacquireRequested', 'profiles', 'release', 'requests'])
  expect(Object.keys(bridge.requests).sort()).toEqual(['acknowledge', 'list', 'onChanged', 'prepare', 'resume', 'takeover', 'visible'])
  await bridge.acquire('cwd:/workspace', 'https://192.168.1.10/')
  expect(ipc.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.browserAcquire, 'cwd:/workspace', 'https://192.168.1.10/')
  await bridge.acquire('cwd:/workspace')
  expect(ipc.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.browserAcquire, 'cwd:/workspace', undefined)
  await bridge.command(RECEIPT.lease, { kind: 'navigate', url: 'https://portal.example.test/next', revision: 9 })
  expect(ipc.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.browserCommand, RECEIPT.lease,
    { kind: 'navigate', url: 'https://portal.example.test/next', revision: 9 })
  await bridge.command(RECEIPT.lease, { kind: 'reload' })
  expect(ipc.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.browserCommand, RECEIPT.lease, { kind: 'reload' })
  await bridge.requests.list(SESSION)
  expect(ipc.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.websiteRequestsList, SESSION)
  await bridge.requests.prepare({ requestId: REQUEST, sessionId: SESSION, lease: RECEIPT.lease })
  expect(ipc.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.websiteRequestsPrepare,
    { requestId: REQUEST, sessionId: SESSION, lease: RECEIPT.lease })
  await bridge.requests.visible(REQUEST, false)
  expect(ipc.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.websiteRequestsVisible, REQUEST, false)
  await bridge.requests.acknowledge(RECEIPT)
  expect(ipc.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.websiteRequestsAcknowledge, RECEIPT)
  await bridge.requests.resume(RECEIPT)
  expect(ipc.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.websiteRequestsResume, RECEIPT)
  await bridge.requests.takeover(REQUEST)
  expect(ipc.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.websiteRequestsTakeover, REQUEST)
})

it('subscribes once per preload bridge and stops disposed request listeners without affecting profile or link listeners', () => {
  const bridge = createDesktopBrowserBridge()
  const requests = vi.fn()
  const profiles = vi.fn()
  const links = vi.fn()
  const detachRequest = bridge.requests.onChanged(requests)
  const detachProfile = bridge.profiles.onChanged(profiles)
  const detachLink = bridge.onOpenRequested(RECEIPT.lease, links)
  onTestFinished(() => { detachRequest(); detachProfile(); detachLink() })
  const requestEvent = ipc.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.websiteRequestsChanged)?.[1]
  const profileEvent = ipc.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.websiteProfilesChanged)?.[1]
  const linkEvent = ipc.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.browserOpenRequested)?.[1]
  if (requestEvent === undefined || profileEvent === undefined || linkEvent === undefined) throw new Error('Preload event subscription missing')
  expect(ipc.on.mock.calls.filter(([channel]) => channel === DESKTOP_IPC.websiteRequestsChanged)).toHaveLength(1)
  requestEvent({})
  expect(requests).toHaveBeenCalledOnce()
  expect(profiles).not.toHaveBeenCalled()
  detachRequest()
  requestEvent({})
  expect(requests).toHaveBeenCalledOnce()
  profileEvent({})
  linkEvent({}, { lease: RECEIPT.lease, url: 'https://portal.example.test/' })
  expect(profiles).toHaveBeenCalledOnce()
  expect(links).toHaveBeenCalledExactlyOnceWith('https://portal.example.test/')
})

it.each([
  { method: 'onOpenRequested', channel: DESKTOP_IPC.browserOpenRequested },
  { method: 'onReacquireRequested', channel: DESKTOP_IPC.browserReacquireRequested },
] as const)('$method validates bounded wire events, contains listeners, and unsubscribes only the exact lease', ({ method, channel }) => {
  const bridge = createDesktopBrowserBridge()
  const revision = Number.MAX_SAFE_INTEGER
  const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { reported.mockRestore() })
  const good = vi.fn()
  const other = vi.fn()
  const otherLease = 'x'.repeat(200) as typeof RECEIPT.lease
  const detachBad = bridge[method](RECEIPT.lease, () => { throw new Error('Consumer failed') })
  const detachGood = bridge[method](RECEIPT.lease, good)
  const detachOther = bridge[method](otherLease, other)
  onTestFinished(() => { detachBad(); detachGood(); detachOther() })
  expect(ipc.on.mock.calls.filter(([name]) => name === channel)).toHaveLength(1)
  const event = ipc.on.mock.calls.find(([name]) => name === channel)?.[1]
  if (event === undefined) throw new Error('Lease event subscription missing')
  for (const payload of [undefined, null, [], {}, { lease: 1, url: 'https://example.test/' },
    { lease: '', url: 'https://example.test/' }, { lease: 'x'.repeat(201), url: 'https://example.test/' },
    { lease: 'bad\nlease', url: 'https://example.test/' }, { lease: RECEIPT.lease, url: 1 },
    { lease: RECEIPT.lease, url: '' }, { lease: RECEIPT.lease, url: 'not a URL' },
    { lease: RECEIPT.lease, url: 'file:///private' }, { lease: RECEIPT.lease, url: 'https://user:pass@example.test/' },
    { lease: RECEIPT.lease, url: `https://example.test/${'x'.repeat(16 * 1024)}` },
    { lease: 'unregistered', url: 'https://example.test/' }]) {
    event({}, method === 'onReacquireRequested' && typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? { ...payload, revision } : payload)
  }
  expect(good).not.toHaveBeenCalled()
  expect(other).not.toHaveBeenCalled()
  const url = 'https://192.168.1.10/redirect'
  const args = method === 'onReacquireRequested' ? [url, revision] : [url]
  event({}, { lease: RECEIPT.lease, url, revision })
  expect(good).toHaveBeenCalledExactlyOnceWith(...args)
  expect(other).not.toHaveBeenCalled()
  expect(reported).toHaveBeenCalledOnce()
  detachBad()
  detachGood()
  detachGood()
  event({}, { lease: RECEIPT.lease, url, revision })
  event({}, { lease: otherLease, url, revision })
  expect(good).toHaveBeenCalledOnce()
  expect(other).toHaveBeenCalledExactlyOnceWith(...args)
  const prefix = 'https://example.test/'
  const boundedUrl = prefix + 'x'.repeat(16 * 1024 - prefix.length)
  event({}, { lease: otherLease, url: boundedUrl, revision })
  expect(other).toHaveBeenLastCalledWith(...(method === 'onReacquireRequested' ? [boundedUrl, revision] : [boundedUrl]))
  const replacement = vi.fn()
  const detachReplacement = bridge[method](RECEIPT.lease, replacement)
  onTestFinished(detachReplacement)
  detachGood()
  event({}, { lease: RECEIPT.lease, url, revision })
  expect(replacement).toHaveBeenCalledExactlyOnceWith(...args)
})

it('requires a nonnegative safe integer revision only for reacquisition notices, leaving popup arguments unchanged', () => {
  const bridge = createDesktopBrowserBridge()
  const reacquire = vi.fn()
  const popup = vi.fn()
  const detachReacquire = bridge.onReacquireRequested(RECEIPT.lease, reacquire)
  const detachPopup = bridge.onOpenRequested(RECEIPT.lease, popup)
  onTestFinished(() => { detachReacquire(); detachPopup() })
  const reacquireEvent = ipc.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.browserReacquireRequested)?.[1]
  const popupEvent = ipc.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.browserOpenRequested)?.[1]
  if (reacquireEvent === undefined || popupEvent === undefined) throw new Error('Lease event subscription missing')
  const request = { lease: RECEIPT.lease, url: 'https://192.168.1.10/redirect' }
  reacquireEvent({}, request)
  popupEvent({}, request)
  expect(reacquire).not.toHaveBeenCalled()
  expect(popup).toHaveBeenCalledExactlyOnceWith(request.url)
  for (const revision of [undefined, null, '1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    reacquireEvent({}, { ...request, revision })
    popupEvent({}, { ...request, revision })
    expect(reacquire).not.toHaveBeenCalled()
    expect(popup).toHaveBeenLastCalledWith(request.url)
  }
  for (const revision of [0, Number.MAX_SAFE_INTEGER]) {
    reacquireEvent({}, { ...request, revision })
    expect(reacquire).toHaveBeenLastCalledWith(request.url, revision)
  }
  expect(reacquire).toHaveBeenCalledTimes(2)
  expect(popup).toHaveBeenCalledTimes(9)
})

it('contains one failing request consumer and still invalidates the remaining consumers', () => {
  const bridge = createDesktopBrowserBridge()
  const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() =>{  reported.mockRestore() })
  const good = vi.fn()
  const detachBad = bridge.requests.onChanged(() => { throw new Error('Consumer failed') })
  const detachGood = bridge.requests.onChanged(good)
  onTestFinished(() => { detachBad(); detachGood() })
  const event = ipc.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.websiteRequestsChanged)?.[1]
  if (event === undefined) throw new Error('Preload event subscription missing')
  event({})
  expect(good).toHaveBeenCalledOnce()
  expect(reported).toHaveBeenCalledWith('Website request listener failed', expect.any(Error))
})
