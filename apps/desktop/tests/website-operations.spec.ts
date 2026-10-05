/** Private IPC validates bounded packets and retains cancellation correlation until native settlement. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type {
  DesktopWebsiteHostSnapshot, DesktopWebsiteOperationCommand, DesktopWebsiteOperationId,
  DesktopWebsiteOperationResponse, DesktopWebsitePageInfo, DesktopWebsiteBrowserOperation, DesktopWebsiteBrowserResult,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import {
  DesktopWebsiteOperations, isWebsiteOperationCommand, websitePageOrigin, websitePageTitle,
} from '../src/website-operations.ts'

const snapshot: DesktopWebsiteHostSnapshot = {
  id: '38ac2aa4-f8ce-4b37-951c-80a4c0c117ce' as DesktopWebsiteHostSnapshot['id'],
  profile: 'cd1b6493-c881-4967-a544-b0a49f2d847f' as DesktopWebsiteHostSnapshot['profile'],
  sessionId: 'owner-session' as DesktopWebsiteHostSnapshot['sessionId'], epoch: 7, status: 'granted',
}
const value: DesktopWebsitePageInfo = { origin: 'https://portal.example.test', title: 'Account portal', titleTruncated: false }
function command(id = 1): Extract<DesktopWebsiteOperationCommand, { type: 'website-operation' }> {
  return { type: 'website-operation', operationId: id as DesktopWebsiteOperationId, snapshot: { ...snapshot }, operation: 'page-info' }
}
function cancel(id = 1): DesktopWebsiteOperationCommand {
  return { type: 'website-operation-cancel', operationId: id as DesktopWebsiteOperationId }
}

describe('private website operation packets', () => {
  it.each([
    null, [], {}, { ...command(), operationId: 0 }, { ...command(), operationId: -1 },
    { ...command(), operationId: 1.5 }, { ...command(), operationId: Number.MAX_SAFE_INTEGER + 1 },
    { ...command(), operationId: '1' }, { ...command(), operation: 'screenshot' },
    { ...command(), target: 'other-guest' }, { ...cancel(), snapshot },
    { ...command(), snapshot: { ...snapshot, id: 'not-a-request' } },
    { ...command(), snapshot: { ...snapshot, profile: 'not-a-profile' } },
    { ...command(), snapshot: { ...snapshot, epoch: 0 } },
    { ...command(), snapshot: { ...snapshot, sessionId: '' } },
    { ...command(), snapshot: { ...snapshot, sessionId: 'x\u202ey' } },
    { ...command(), snapshot: { ...snapshot, sessionId: '界'.repeat(683) } },
    { ...command(), snapshot: { ...snapshot, sessionId: '"'.repeat(2048) } },
    { ...command(), snapshot: { ...snapshot, terminal: true } },
    { ...command(), snapshot: { ...snapshot, status: 'active' } },
    { ...command(), snapshot: { ...snapshot, status: { toString: () => 'granted' } } },
    { ...command(), snapshot: { ...snapshot, guestId: 17 } },
  ])('refuses malformed or oversized private input %j', (packet) => {
    expect(isWebsiteOperationCommand(packet)).toBe(false)
  })

  it('accepts bounded start/cancel and terminal revoked packets without granting authority', () => {
    expect(isWebsiteOperationCommand(command())).toBe(true)
    expect(isWebsiteOperationCommand(cancel())).toBe(true)
    expect(isWebsiteOperationCommand({ ...command(), snapshot: { ...snapshot, status: 'revoked', terminal: true } })).toBe(true)
  })

  it.each(['file:///secret', 'about:blank', 'https://user:secret@portal.example.test/', 'https://portal.example.test/\nsecret']) (
    'refuses unsafe native origin %s', (address) => { expect(() => websitePageOrigin(address)).toThrow() },
  )

  it('projects only origin and strips controls while truncating titles on UTF-8 codepoints', () => {
    expect(websitePageOrigin('https://PORTAL.example.test:443/private?token=secret#account')).toBe(value.origin)
    expect(websitePageTitle('a\n\t\u202e😀\u0000b')).toEqual({ title: 'a😀b', titleTruncated: false })
    expect(websitePageTitle('界'.repeat(170) + '😀')).toEqual({ title: '界'.repeat(170), titleTruncated: true })
    expect(websitePageTitle('😀'.repeat(128))).toEqual({ title: '😀'.repeat(128), titleTruncated: false })
    expect(websitePageTitle('\ud800')).toEqual({ title: '�', titleTruncated: false })
  })
})

describe('captured-child native operation settlement', () => {
  it('installs cancellation correlation before the callback microtask', async () => {
    const native = vi.fn(async () => value)
    const terminal = Promise.withResolvers<DesktopWebsiteOperationResponse>()
    const operations = new DesktopWebsiteOperations(native, terminal.resolve, () => {})
    onTestFinished(() => operations.close())
    operations.receive(command())
    operations.receive(cancel())
    expect(await terminal.promise).toMatchObject({ operationId: 1, outcome: 'rejected', snapshot })
    expect(native).not.toHaveBeenCalled()
  })

  it('holds cancelled operations in the 64-record fence and never reuses older IDs', async () => {
    const physical = Promise.withResolvers<DesktopWebsitePageInfo>()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const completed: PromiseWithResolvers<void> = Promise.withResolvers()
    const recovered = Promise.withResolvers<DesktopWebsiteOperationResponse>()
    const responses: DesktopWebsiteOperationResponse[] = []
    let calls = 0
    const operations = new DesktopWebsiteOperations(async () => {
      calls += 1
      if (calls === 64) entered.resolve()
      return physical.promise
    }, (response) => {
      responses.push(response)
      if (responses.length === 65) completed.resolve()
      if (response.operationId === 66) recovered.resolve(response)
    }, () => {})
    onTestFinished(async () => { physical.resolve(value); await operations.close() })
    for (let id = 1; id <= 64; id += 1) operations.receive(command(id))
    await entered.promise
    operations.receive(cancel())
    operations.receive(command(65))
    operations.receive(command(1))
    expect(responses).toMatchObject([{ operationId: 65, outcome: 'rejected' }])
    expect(calls).toBe(64)
    physical.resolve(value)
    await completed.promise
    expect(responses.find(response => response.operationId === 1)?.outcome).toBe('rejected')
    expect(responses.filter(response => response.outcome === 'success')).toHaveLength(63)
    operations.receive(command(64))
    expect(calls).toBe(64)
    operations.receive(command(66))
    expect(await recovered.promise).toMatchObject({ operationId: 66, outcome: 'success' })
    expect(calls).toBe(65)
  })

  it.each(['cancel', 'authority', 'envelope'] as const)('withholds success after %s changes before publication', async (cause) => {
    const terminal = Promise.withResolvers<DesktopWebsiteOperationResponse>()
    let allowed = true
    const operations = new DesktopWebsiteOperations(async () => {
      if (cause === 'cancel') queueMicrotask(() =>{  operations.receive(cancel()) })
      if (cause === 'authority') allowed = false
      return cause === 'envelope' ? { ...value, title: 'x'.repeat(4096) } : value
    }, terminal.resolve, () => { if (!allowed) throw new Error('revoked') })
    onTestFinished(() => operations.close())
    operations.receive(command())
    expect(await terminal.promise).toMatchObject({ outcome: 'rejected' })
  })

  it('withholds success while closing and publishes rejection only after physical settlement', async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const physical = Promise.withResolvers<DesktopWebsitePageInfo>()
    const publish = vi.fn<(response: DesktopWebsiteOperationResponse) => void>()
    const operations = new DesktopWebsiteOperations(async (_snapshot, signal) => {
      signal.addEventListener('abort', () =>{  operations.receive(command(2)) }, { once: true })
      entered.resolve(signal)
      return physical.promise
    }, publish, () => {})
    onTestFinished(async () => { physical.resolve(value); await operations.close() })
    operations.receive(command())
    const signal = await entered.promise
    let settled = false
    const closing = operations.close().then(() => { settled = true })
    await Promise.resolve()
    expect(signal.aborted).toBe(true)
    expect(settled).toBe(false)
    expect(publish).not.toHaveBeenCalled()
    physical.resolve(value)
    await closing
    expect(publish.mock.calls.map(([response]) => response)).toEqual([
      { type: 'website-operation-result', operationId: 1, snapshot, outcome: 'rejected' },
    ])
  })

  it('captures queued browser arguments and correlation before the received packet can change', async () => {
    const sent: PromiseWithResolvers<DesktopWebsiteOperationResponse> = Promise.withResolvers()
    const observed: DesktopWebsiteBrowserOperation[] = []
    const operations = new DesktopWebsiteOperations(async () => value, (response) =>{  sent.resolve(response) }, () => {},
      async (_snapshot, _signal, operation): Promise<DesktopWebsiteBrowserResult> => {
        observed.push(operation)
        return { kind: 'screenshot', png: 'native-png', width: 10, height: 20 }
      })
    onTestFinished(() => operations.close())
    const packet = { ...command(), snapshot: { ...snapshot }, operation: { kind: 'screenshot' as const, clip: { x: 0, y: 0, width: 10, height: 20 } } }
    operations.receive(packet)
    packet.operationId = 2 as DesktopWebsiteOperationId
    packet.snapshot.epoch = 9
    packet.operation.clip.width = 999
    expect(await sent.promise).toEqual({ type: 'website-operation-result', operationId: 1, snapshot, outcome: 'success',
      value: { kind: 'screenshot', png: 'native-png', width: 10, height: 20 } })
    expect(observed).toEqual([{ kind: 'screenshot', clip: { x: 0, y: 0, width: 10, height: 20 } }])
    await expect(operations.close()).resolves.toBeUndefined()
  })

  it('contains transport exceptions after physical completion', async () => {
    const sent: PromiseWithResolvers<void> = Promise.withResolvers()
    const operations = new DesktopWebsiteOperations(async () => value, () => {
      sent.resolve(); throw new Error('disconnected')
    }, () => {})
    onTestFinished(() => operations.close())
    operations.receive(command())
    await sent.promise
    await expect(operations.close()).resolves.toBeUndefined()
  })
})
