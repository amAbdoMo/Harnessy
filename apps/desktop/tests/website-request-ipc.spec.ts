/** Renderer packets require the authenticated native owner and exact request/Session/lease receipts. */
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type {
  DesktopBrowserLeaseId, DesktopWebsiteHostSnapshot, DesktopWebsiteProfileId,
  DesktopWebsiteRequestId, DesktopWebsiteRequestReceipt, DesktopWebsiteVisibilityId,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { websiteAuthorityFixture } from './website-authority-fixture.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { installWebsiteRequestIpc, parseWebsiteRequestPreparation, parseWebsiteRequestReceipt, parseWebsiteRequestSession } from '../src/website-request-ipc.ts'

const ID = '38ac2aa4-f8ce-4b37-951c-80a4c0c117ce' as DesktopWebsiteRequestId
const LEASE = '8d7584ac-c562-44eb-a867-0d21e80cbb05' as DesktopBrowserLeaseId
const PROFILE = 'cd1b6493-c881-4967-a544-b0a49f2d847f' as DesktopWebsiteProfileId
const SESSION = 'owner-session' as DesktopWebsiteHostSnapshot['sessionId']
const RECEIPT: DesktopWebsiteRequestReceipt = { requestId: ID, lease: LEASE, epoch: 0,
  visibility: 'e0405382-c2af-4cce-bff6-009fe742e7f8' as DesktopWebsiteVisibilityId }

function fixture() {
  const native = websiteAuthorityFixture()
  native.prepare()
  const { owner, authority } = native
  const requests = authority.requests
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const ipc: Pick<IpcMain, 'handle' | 'removeHandler'> = {
    handle: vi.fn<IpcMain['handle']>((channel, handler) => { handlers.set(channel, handler) }),
    removeHandler: vi.fn<IpcMain['removeHandler']>((channel) => { handlers.delete(channel) }),
  }
  const authorize = vi.fn((event: IpcMainInvokeEvent) => {
    if (event.sender !== owner) throw new Error('Unowned renderer')
  })
  const detach = installWebsiteRequestIpc(ipc, authorize, authority)
  onTestFinished(async () => { detach(); await requests.close(ID) })
  const invoke = (channel: string, args: unknown[] = [], sender = owner): unknown => {
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error('Website request handler is not registered')
    return handler({ sender } as IpcMainInvokeEvent, ...args)
  }
  return { ...native, requests, ipc, handlers, authorize, detach, invoke }
}

it('prepares only an already owned Session/request/lease and grants nothing until explicit receipt-bound Resume', async () => {
  const f = fixture()
  expect(f.invoke(DESKTOP_IPC.websiteRequestsList, [SESSION])).toEqual([{ id: ID, profile: PROFILE, sessionId: SESSION, epoch: 1, status: 'pending' }])
  const receipt = f.invoke(DESKTOP_IPC.websiteRequestsPrepare, [
    { requestId: ID, sessionId: SESSION, lease: LEASE },
  ]) as DesktopWebsiteRequestReceipt
  expect(f.snapshot().status).toBe('pending')
  const observe = vi.fn(async () => 'observed')
  await expect(f.requests.run(f.host, receipt.requestId, new AbortController().signal, observe)).rejects.toThrow('stale')
  const grant = await f.invoke(DESKTOP_IPC.websiteRequestsResume, [receipt]) as DesktopWebsiteRequestReceipt
  expect(f.snapshot().status).toBe('granted')
  expect(await f.requests.run(f.host, grant.requestId, new AbortController().signal, observe)).toBe('observed')
  await f.invoke(DESKTOP_IPC.websiteRequestsTakeover, [ID])
  await expect(f.requests.run(f.host, grant.requestId, new AbortController().signal, observe)).rejects.toThrow('stale')
})

it('does not parse or mutate any authority before renderer authentication', () => {
  const f = fixture()
  expect(() => f.invoke(DESKTOP_IPC.websiteRequestsPrepare, [null], { isDestroyed: () => false } as WebContents)).toThrow('Unowned renderer')
  expect(f.snapshot().status).toBe('pending')
  expect(f.invoke(DESKTOP_IPC.websiteRequestsPrepare, [{ requestId: ID, sessionId: SESSION, lease: LEASE }]))
    .toMatchObject({ requestId: ID, lease: LEASE })
})

it('refuses a Session substitution before attaching or revealing a native guest', () => {
  const f = fixture()
  expect(() => f.invoke(DESKTOP_IPC.websiteRequestsPrepare, [{ requestId: ID, sessionId: 'other', lease: LEASE }]))
    .toThrow('another Session')
  expect(f.invoke(DESKTOP_IPC.websiteRequestsPrepare, [{ requestId: ID, sessionId: SESSION, lease: LEASE }]))
    .toMatchObject({ requestId: ID, lease: LEASE })
})

it('revokes on hide and requires a fresh occurrence and acknowledgement after showing again', async () => {
  const f = fixture()
  const receipt = f.invoke(DESKTOP_IPC.websiteRequestsPrepare, [
    { requestId: ID, sessionId: SESSION, lease: LEASE },
  ]) as DesktopWebsiteRequestReceipt
  const grant = await f.invoke(DESKTOP_IPC.websiteRequestsResume, [receipt]) as DesktopWebsiteRequestReceipt
  expect(f.invoke(DESKTOP_IPC.websiteRequestsVisible, [ID, false])).toBeUndefined()
  await expect(f.requests.run(f.host, grant.requestId, new AbortController().signal, async () => 'forbidden')).rejects.toThrow('stale')
  await f.requests.revoke(ID)
  await expect(f.invoke(DESKTOP_IPC.websiteRequestsResume, [receipt])).rejects.toThrow('stale')
  const shown = f.invoke(DESKTOP_IPC.websiteRequestsVisible, [ID, true]) as DesktopWebsiteRequestReceipt
  expect(shown.visibility).not.toBe(receipt.visibility)
  await expect(f.invoke(DESKTOP_IPC.websiteRequestsResume, [shown])).rejects.toThrow('not acknowledged')
  f.invoke(DESKTOP_IPC.websiteRequestsAcknowledge, [shown])
  await f.invoke(DESKTOP_IPC.websiteRequestsResume, [shown])
})

it('removes every handler with its owner and rolls back partial registration failure', () => {
  const f = fixture()
  expect(f.handlers.size).toBe(6)
  f.detach()
  expect(f.handlers.size).toBe(0)
  f.detach()
  const failing: Pick<IpcMain, 'handle' | 'removeHandler'> = {
    handle: vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('IPC conflict') }),
    removeHandler: vi.fn(),
  }
  expect(() => installWebsiteRequestIpc(failing, f.authorize, f.authority)).toThrow('IPC conflict')
  expect(failing.removeHandler).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.websiteRequestsList)
})

it.each([null, [], { requestId: ID, sessionId: SESSION, lease: 'guessed' },
  { requestId: ID, sessionId: SESSION, lease: LEASE, agent: {} }])('rejects malformed guest-association packets (%j)', (packet) => {
  expect(() => parseWebsiteRequestPreparation(packet)).toThrow()
})

it.each([null, [], { ...RECEIPT, epoch: -1 }, { ...RECEIPT, epoch: Number.MAX_SAFE_INTEGER + 1 },
  { ...RECEIPT, visibility: 'guessed' }, { ...RECEIPT, profile: PROFILE }])('rejects malformed receipt packets (%j)', (packet) => {
  expect(() => parseWebsiteRequestReceipt(packet)).toThrow()
})

it.each(['', 'bad\nidentity', '界'.repeat(1366), 7])('bounds Session routing inputs without granting Agent identity (%j)', (session) => {
  expect(() => parseWebsiteRequestSession(session)).toThrow()
})
