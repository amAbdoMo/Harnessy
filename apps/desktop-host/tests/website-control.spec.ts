/** Private IPC validates bounded control packets and rechecks its controller after queued work. */
import type { DesktopWebsiteHostCommand, DesktopWebsiteProfileId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { WebsiteRequestId, WebsiteRequestSnapshot, WebsiteRequestsController } from '../src/website-requests.ts'
import { installWebsiteControlReceiver, parseWebsiteHostCommand } from '../src/website-control.ts'
import { expect, it, vi } from 'vitest'

const ID = '38ac2aa4-f8ce-4b37-951c-80a4c0c117ce' as WebsiteRequestId
const PROFILE = 'cd1b6493-c881-4967-a544-b0a49f2d847f' as DesktopWebsiteProfileId
const PAIRING = { id: PROFILE, name: 'Portal', accountLabel: 'operator', url: 'https://portal.example.test/',
  serverName: 'portal', mcpBinding: { identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/mcp' } }

function fixture() {
  const snapshot: WebsiteRequestSnapshot = { requestId: ID, profileId: PROFILE, serverName: 'portal',
    sessionId: 'owner' as WebsiteRequestSnapshot['sessionId'], epoch: 1, status: 'pending', signal: new AbortController().signal }
  const controller = {
    syncProfiles: vi.fn(), profiles: () => [PAIRING], assertCurrent: vi.fn(), assertDrained: vi.fn(),
    create: vi.fn(() => snapshot), handoff: async (receipt, capture) => capture(receipt.signal), validate: vi.fn(async () => snapshot),
    commit: vi.fn<WebsiteRequestsController['commit']>(async () => ({ ...snapshot, status: 'granted' })),
    revoke: vi.fn<WebsiteRequestsController['revoke']>(() => ({ ...snapshot, epoch: 2, status: 'revoked' })), drain: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    run: (_execution, _id, _epoch, operation) => operation(new AbortController().signal),
  } satisfies WebsiteRequestsController
  let current: WebsiteRequestsController | undefined = controller
  const delivered: PromiseWithResolvers<object> = Promise.withResolvers()
  const send = vi.fn(async (message: object) => { delivered.resolve(message) })
  const receive = installWebsiteControlReceiver(() => current, send)
  return { controller, receive, send, delivered, stop: () => { current = undefined } }
}

it.each([
  { action: 'sync', profiles: [PAIRING] }, { action: 'validate', id: ID, epoch: 1 },
  { action: 'commit', id: ID, epoch: 1 }, { action: 'revoke', id: ID }, { action: 'drain', id: ID }, { action: 'remove', id: ID },
] satisfies DesktopWebsiteHostCommand[])('accepts only supported typed control fields for $action', (command) => {
  expect(parseWebsiteHostCommand(command)).toEqual(command)
})

it.each([
  null, [], { action: 'sync', profiles: [PAIRING, PAIRING] },
  { action: 'sync', profiles: Array.from({ length: 65 }, () => PAIRING) },
  { action: 'sync', profiles: [{ ...PAIRING, mcpBinding: { identity: 'a', endpoint: 'https://portal.example.test/' } }] },
  { action: 'sync', profiles: [PAIRING], untrusted: '界'.repeat(100_000) },
  { action: 'inspect', id: ID }, { action: 'validate', id: 'guessed', epoch: 1 },
  { action: 'validate', id: ID, epoch: -1 }, { action: 'commit', id: ID, epoch: Number.MAX_SAFE_INTEGER + 1 },
])('rejects malformed, unsupported or oversized private control packets (%j)', (command) => {
  expect(() => parseWebsiteHostCommand(command)).toThrow()
})

it('revokes synchronously before queuing its response and never exposes live owner or cancellation objects', async () => {
  const f = fixture()
  expect(f.receive({ type: 'website-control', requestId: 7, command: { action: 'revoke', id: ID } })).toBe(true)
  expect(f.controller.revoke).toHaveBeenCalledExactlyOnceWith(ID)
  expect(f.send).not.toHaveBeenCalled()
  expect(await f.delivered.promise).toEqual({ type: 'website-control', requestId: 7,
    snapshot: { id: ID, profile: PROFILE, sessionId: 'owner', epoch: 2, status: 'revoked' } })
})

it('rejects a control result that finishes after controller replacement', async () => {
  const f = fixture()
  const validation: PromiseWithResolvers<WebsiteRequestSnapshot> = Promise.withResolvers()
  vi.mocked(f.controller.validate).mockImplementation(() => validation.promise)
  f.receive({ type: 'website-control', requestId: 8, command: { action: 'validate', id: ID, epoch: 1 } })
  f.stop()
  validation.resolve({ requestId: ID, profileId: PROFILE, serverName: 'portal', sessionId: 'owner' as WebsiteRequestSnapshot['sessionId'],
    epoch: 1, status: 'pending', signal: new AbortController().signal })
  expect(await f.delivered.promise).toEqual({ type: 'website-control', requestId: 8, error: 'Website request Host changed during control' })
})

it('rechecks revoked generations immediately before sending a queued grant response', async () => {
  const f = fixture()
  vi.mocked(f.controller.assertCurrent).mockImplementation(() => { throw new Error('Request was revoked before publication') })
  f.receive({ type: 'website-control', requestId: 10, command: { action: 'commit', id: ID, epoch: 1 } })
  expect(await f.delivered.promise).toEqual({ type: 'website-control', requestId: 10, error: 'Request was revoked before publication' })
  expect(f.controller.assertCurrent).toHaveBeenCalledOnce()
})

it('refuses stale drainage acknowledgements after renewal', async () => {
  const f = fixture()
  vi.mocked(f.controller.assertDrained).mockImplementation(() => { throw new Error('Drainage was renewed') })
  f.receive({ type: 'website-control', requestId: 11, command: { action: 'drain', id: ID } })
  expect(await f.delivered.promise).toEqual({ type: 'website-control', requestId: 11, error: 'Drainage was renewed' })
})

it('ignores another channel and returns a correlated error for malformed website commands', async () => {
  const f = fixture()
  expect(f.receive({ type: 'other', requestId: 1 })).toBe(false)
  expect(f.receive({ type: 'website-control', requestId: -1, command: {} })).toBe(true)
  expect(f.controller.syncProfiles).not.toHaveBeenCalled()
  f.receive({ type: 'website-control', requestId: 9, command: {} })
  expect(await f.delivered.promise).toEqual({ type: 'website-control', requestId: 9, error: 'Invalid website request identity' })
})
