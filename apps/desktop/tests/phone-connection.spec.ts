/** Main-only pairing credentials and primary-window IPC admission. */

import { inspect } from 'node:util'
import { readFileSync } from 'node:fs'
import type { IpcMain, IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { assertDesktopSender, DESKTOP_IPC } from '../src/ipc.ts'
import { DesktopPhoneConnection, installDesktopPhoneConnectionIpc } from '../src/phone-connection.ts'

const ready = { url: 'http://127.0.0.1:43821/?token=private-token', remoteRoot: 'https://pc.tailnet.ts.net/' }

function fixture() {
  const owner = {}
  let current: object | undefined = owner
  const clipboard = vi.fn<(text: string) => Promise<void>>(async () => {})
  const connection = new DesktopPhoneConnection(() => current, clipboard)
  connection.begin(owner)
  return { owner, clipboard, connection, setCurrent: (host: object | undefined) => { current = host } }
}

describe('Desktop phone pairing', () => {
  it('describes no credentials, copies only the Main-owned remote URL and returns no clipboard data', async () => {
    const f = fixture()
    expect(f.connection.describe()).toEqual({ enabled: false })
    f.connection.ready(f.owner, { url: ready.url })
    await expect(f.connection.copyPairingUrl()).rejects.toThrow('unavailable')
    f.connection.ready(f.owner, ready)
    expect(f.connection.describe()).toEqual({ enabled: true, remoteRoot: ready.remoteRoot })
    await expect(f.connection.copyPairingUrl()).resolves.toBeUndefined()
    expect(f.clipboard.mock.calls).toEqual([['https://pc.tailnet.ts.net/?token=private-token']])
    expect(JSON.stringify(f.connection.describe())).not.toContain('private-token')
    expect(inspect(f.connection)).not.toContain('private-token')
  })

  it('withdraws publication while stopping and prevents retired generations from overwriting a replacement', async () => {
    const f = fixture()
    f.connection.ready(f.owner, ready)
    f.setCurrent(undefined)
    expect(f.connection.describe()).toEqual({ enabled: false })
    await expect(f.connection.copyPairingUrl()).rejects.toThrow('unavailable')
    f.connection.retire(f.owner)
    const replacement = {}
    f.setCurrent(replacement)
    f.connection.begin(replacement)
    f.connection.ready(replacement, { ...ready, url: ready.url.replace('private-token', 'replacement-token') })
    f.connection.retire(f.owner)
    await f.connection.copyPairingUrl()
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith('https://pc.tailnet.ts.net/?token=replacement-token')
    f.connection.ready(f.owner, ready)
    expect(f.connection.describe()).toEqual({ enabled: true, remoteRoot: ready.remoteRoot })
    await f.connection.copyPairingUrl()
    expect(f.clipboard).toHaveBeenLastCalledWith('https://pc.tailnet.ts.net/?token=replacement-token')
  })

  it('checks the captured Host again immediately before the clipboard write', async () => {
    const owner = {}
    let checks = 0
    const clipboard = vi.fn(async () => {})
    const connection = new DesktopPhoneConnection(() => ++checks === 1 ? owner : undefined, clipboard)
    connection.begin(owner)
    connection.ready(owner, ready)
    await expect(connection.copyPairingUrl()).rejects.toThrow('unavailable')
    expect(clipboard).not.toHaveBeenCalled()
  })

  it.each(['not a URL private-token', 'https://127.0.0.1/?token=private-token', 'http://attacker.example/?token=private-token',
    'http://127.0.0.1/?token=', 'http://user:private-token@127.0.0.1/', 'http://127.0.0.1/path?token=private-token'])
  ('rejects unusable ready credentials without returning or dumping their values (%s)', async (url) => {
    const f = fixture()
    f.connection.ready(f.owner, { ...ready, url })
    const operation = f.connection.copyPairingUrl()
    await expect(operation).rejects.toThrow('no valid Host credential')
    expect(f.clipboard).not.toHaveBeenCalled()
    await expect(operation.catch((error: unknown) => inspect(error))).resolves.not.toContain('private-token')
  })

  it('reports asynchronous clipboard failure without native diagnostics and remains retryable', async () => {
    const f = fixture()
    f.connection.ready(f.owner, ready)
    f.clipboard.mockRejectedValueOnce(new Error('native failure: private-token'))
    const operation = f.connection.copyPairingUrl()
    await expect(operation).rejects.toThrow('could not copy the pairing link')
    await expect(operation.catch((error: unknown) => inspect(error))).resolves.not.toContain('private-token')
    await f.connection.copyPairingUrl()
  })

  it('waits for the unabortable native write and refuses success after the captured Host retires', async () => {
    const f = fixture()
    f.connection.ready(f.owner, ready)
    const pending = Promise.withResolvers<undefined>()
    f.clipboard.mockImplementationOnce(() => pending.promise)
    const operation = f.connection.copyPairingUrl()
    onTestFinished(async () => {
      pending.resolve(undefined)
      // Native settlement cannot be cancelled; teardown drains either outcome.
      await operation.then(() => undefined, () => undefined)
    })
    expect(f.clipboard).toHaveBeenCalledOnce()
    f.connection.retire(f.owner)
    pending.resolve(undefined)
    await expect(operation).rejects.toThrow('unavailable')
  })

  it('rejects other windows, subframes and origins; ignores renderer destinations and disposes both IPC channels', async () => {
    const f = fixture()
    f.connection.ready(f.owner, ready)
    const mainFrame = { url: 'dsh-app://app/' } as WebFrameMain
    const sender = { mainFrame } as WebContents
    const owned = { sender, senderFrame: mainFrame } as IpcMainInvokeEvent
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
    const ipc: Pick<IpcMain, 'handle' | 'removeHandler'> = {
      handle: (channel, handler) => { handlers.set(channel, handler) },
      removeHandler: (channel) => { handlers.delete(channel) },
    }
    const detach = installDesktopPhoneConnectionIpc(ipc, (event) => {
      assertDesktopSender(event, ['app'])
      if (event.sender !== sender || event.senderFrame !== mainFrame) throw new Error('Unowned sender')
    }, f.connection)
    onTestFinished(detach)
    const describe = handlers.get(DESKTOP_IPC.phoneConnectionDescribe)
    const copy = handlers.get(DESKTOP_IPC.phoneConnectionCopyPairingUrl)
    if (describe === undefined || copy === undefined) throw new Error('Phone connection IPC not registered')
    for (const event of [
      { sender: {} as WebContents, senderFrame: mainFrame },
      { sender, senderFrame: { url: 'dsh-app://app/' } as WebFrameMain },
      { sender, senderFrame: { url: 'https://pc.tailnet.ts.net/' } as WebFrameMain },
      { sender, senderFrame: null },
    ]) {
      expect(() => { describe(event as IpcMainInvokeEvent) }).toThrow()
      expect(() => { copy(event as IpcMainInvokeEvent, 'https://attacker.example/') }).toThrow()
    }
    expect(f.clipboard).not.toHaveBeenCalled()
    expect(describe(owned)).toEqual({ enabled: true, remoteRoot: ready.remoteRoot })
    const reply: unknown = await copy(owned, 'https://attacker.example/')
    expect(reply).toBeUndefined()
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith('https://pc.tailnet.ts.net/?token=private-token')
    detach()
    expect(handlers.size).toBe(0)
  })

  it('wires Main operations to the primary-frame sender check and captured backend lifecycle without publishing pairing in boot', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).toContain('installDesktopPhoneConnectionIpc(ipcMain, assertProductSender, phoneConnection)')
    expect(main).toContain('backend.host?.phoneOwner')
    expect(main).toContain('phoneConnection.ready(host, ready)')
    expect(main).toContain('phoneConnection.retire(host)')
    expect(main).not.toContain('remoteRoot:')
  })
})
