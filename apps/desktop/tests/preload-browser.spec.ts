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
  expect(Object.keys(bridge).sort()).toEqual(['acquire', 'command', 'onOpenRequested', 'profiles', 'release', 'requests'])
  expect(Object.keys(bridge.requests).sort()).toEqual(['acknowledge', 'list', 'onChanged', 'prepare', 'resume', 'takeover', 'visible'])
  await bridge.command(RECEIPT.lease, { kind: 'navigate', url: 'https://portal.example.test/next' })
  expect(ipc.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.browserCommand, RECEIPT.lease,
    { kind: 'navigate', url: 'https://portal.example.test/next' })
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
