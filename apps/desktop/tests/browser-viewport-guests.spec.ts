/** Real Main lease policy with controlled Electron lifecycle and CDP transport. */
import { EventEmitter } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import type { DesktopWebsiteProfileId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

const electron = vi.hoisted(() => ({ partitions: new Map<string, object>() }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: Object.assign(new EventEmitter(), { isPackaged: false }),
    session: { fromPartition: (partition: string) => {
      let storage = electron.partitions.get(partition)
      if (storage === undefined) {
        storage = Object.assign(new EventEmitter(), {
          setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
          setDisplayMediaRequestHandler: vi.fn(), webRequest: { onBeforeRequest: vi.fn() },
        })
        electron.partitions.set(partition, storage)
      }
      return storage
    } },
    webContents: { getAllWebContents: () => [] },
  }
})
const { DesktopBrowserGuests } = await import('../src/browser-guests.ts')
const { session } = await import('electron')

function fixture(profile?: DesktopWebsiteProfileId) {
  const guests = new DesktopBrowserGuests(() => undefined)
  // Electron objects at this native event boundary expose only the members used by lease policy.
  let ownerDestroyed = false
  const ownerPartial: Partial<WebContents> = { isDestroyed: () => ownerDestroyed, send: vi.fn() }
  const owner = Object.assign(new EventEmitter(), ownerPartial) as WebContents
  const reservation = profile === undefined ? guests.acquire(owner, 'viewport-workspace') : guests.acquireProfile(owner, profile)
  let destroyed = false
  let attached = false
  const debuggerApi = Object.assign(new EventEmitter(), {
    attach: vi.fn(() => { attached = true }), isAttached: () => attached,
    sendCommand: vi.fn(async () => ({})),
  })
  const guest = Object.assign(new EventEmitter(), {
    hostWebContents: owner, session: session.fromPartition(reservation.partition),
    getType: () => 'webview', getURL: () => `about:blank#${reservation.lease}`, isDestroyed: () => destroyed,
    isDevToolsOpened: () => false, debugger: debuggerApi, setWindowOpenHandler: vi.fn(),
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
    loadURL: vi.fn(async (_url: string) => {}), reload: vi.fn(),
    close: vi.fn(() => { destroyed = true; guest.emit('destroyed') }),
  })
  guests.bind({ webContents: owner } as BrowserWindow, () => () => {})
  owner.emit('will-attach-webview', { preventDefault: vi.fn() }, {},
    { src: `about:blank#${reservation.lease}`, partition: reservation.partition })
  owner.emit('did-attach-webview', {}, guest)
  return { guests, owner, guest, debuggerApi, reservation,
    command: (input: unknown) => guests.command(owner, reservation.lease, input),
    async dispose() {
      await guests.release(owner, reservation.lease)
      ownerDestroyed = true
      owner.emit('destroyed')
      await nextTurn()
      electron.partitions.delete(reservation.partition)
    },
  }
}

it('rejects saved-account preview before its revision can displace Human navigation', async () => {
  const f = fixture('viewport-saved' as DesktopWebsiteProfileId)
  try {
    await expect(f.command({ kind: 'preview-viewport', viewport: { width: 390, height: 844, scale: 1 }, revision: 999 }))
      .rejects.toThrow('native command failed')
    await f.command({ kind: 'navigate', url: 'https://example.test/', revision: 0 })
    expect(f.guest.loadURL).toHaveBeenCalledExactlyOnceWith('https://example.test/')
    expect(f.debuggerApi.attach).not.toHaveBeenCalled()
  } finally { await f.dispose() }
})

it('cancels only the captured ordinary guest and ignores foreign-owner, replacement and late cancellation', async () => {
  const f = fixture()
  try {
    await f.command({ kind: 'preview-viewport', viewport: { width: 390, height: 844, scale: 1 } })
    const guest = f.guests.inspectPreview(f.owner, f.reservation.lease)
    expect(guest).toBeDefined()
    if (guest === undefined) throw new Error('Expected an attached preview guest')
    const foreignPartial: Partial<WebContents> = { isDestroyed: () => false }
    const foreign = foreignPartial as WebContents
    f.guests.cancelPreview(foreign, f.reservation.lease, guest)
    f.guests.cancelPreview(f.owner, f.reservation.lease, foreign)
    expect(f.guest.close).not.toHaveBeenCalled()
    f.guests.cancelPreview(f.owner, f.reservation.lease, guest)
    expect(f.guest.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false })
    expect(f.guests.inspectPreview(f.owner, f.reservation.lease)).toBeUndefined()
    f.guests.cancelPreview(f.owner, f.reservation.lease, guest)
    expect(f.guest.close).toHaveBeenCalledOnce()
  } finally { await f.dispose() }
})

it('closes an already-invalidated captured guest while ordinary release is waiting for native metrics', async () => {
  const f = fixture()
  const entered = Promise.withResolvers<undefined>()
  const native = Promise.withResolvers<object>()
  try {
    await f.command({ kind: 'preview-viewport', viewport: { width: 390, height: 844, scale: 1 } })
    const captured = f.guests.inspectPreview(f.owner, f.reservation.lease)
    if (captured === undefined) throw new Error('Expected a captured preview guest')
    f.debuggerApi.sendCommand.mockImplementationOnce(() => { entered.resolve(undefined); return native.promise })
    f.guest.once('destroyed', () => { native.reject(new Error('Native guest closed')) })
    const updating = f.command({ kind: 'preview-viewport', viewport: { width: 844, height: 390, scale: 1 } })
    const updateFailed = expect(updating).rejects.toThrow('native command failed')
    await entered.promise
    const releasing = f.guests.release(f.owner, f.reservation.lease)
    expect(f.guests.inspectPreview(f.owner, f.reservation.lease)).toBeUndefined()
    expect(f.guest.close).not.toHaveBeenCalled()
    f.guests.cancelPreview(f.owner, f.reservation.lease, captured)
    expect(f.guest.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false })
    await Promise.all([releasing, updateFailed])
  } finally { native.resolve({}); await f.dispose() }
})

it('never closes a saved-account guest through preview cancellation', async () => {
  const f = fixture('viewport-cancel-saved' as DesktopWebsiteProfileId)
  try {
    const inspected = f.guests.inspectWebsite(f.owner, f.reservation.lease)
    expect(inspected).toBeDefined()
    if (inspected === undefined) throw new Error('Expected an attached saved-account guest')
    f.guests.cancelPreview(f.owner, f.reservation.lease, inspected.guest)
    expect(f.guest.close).not.toHaveBeenCalled()
    expect(f.guests.inspectWebsite(f.owner, f.reservation.lease)).toBeDefined()
  } finally { await f.dispose() }
})

it('reapplies retained ordinary metrics on native DOM readiness and navigation without IPC', async () => {
  const f = fixture()
  try {
    await f.command({ kind: 'preview-viewport', viewport: { width: 390, height: 844, scale: 0.5 }, revision: 0 })
    f.guest.emit('dom-ready')
    f.guest.emit('did-navigate', {}, 'https://example.test/')
    await vi.waitFor(() => { expect(f.debuggerApi.sendCommand).toHaveBeenCalledTimes(3) })
    expect(f.debuggerApi.attach).toHaveBeenCalledOnce()
  } finally { await f.dispose() }
})

it('initiates native destruction before awaiting an in-flight metrics acknowledgement', async () => {
  const f = fixture()
  const entered = Promise.withResolvers<undefined>()
  const acknowledgement = Promise.withResolvers<object>()
  f.debuggerApi.sendCommand.mockImplementationOnce(async () => { entered.resolve(undefined); return acknowledgement.promise })
  const close = f.guest.close.getMockImplementation()
  if (close === undefined) throw new Error('Native closure missing')
  f.guest.close.mockImplementation(() => {
    close()
    acknowledgement.reject(new Error('Native guest closed'))
  })
  const command = f.command({ kind: 'preview-viewport', viewport: { width: 390, height: 844, scale: 1 }, revision: 0 })
  const rejected = expect(command).rejects.toThrow('native command failed')
  try {
    await entered.promise
    await f.guests.release(f.owner, f.reservation.lease)
    await rejected
    expect(f.guest.close).toHaveBeenCalledOnce()
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledOnce()
  } finally { acknowledgement.resolve({}); await f.dispose() }
})
