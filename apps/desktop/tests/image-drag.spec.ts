import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent, NativeImage, WebContents, WebFrameMain } from 'electron'
import { DESKTOP_IPC, assertDesktopSender } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  handle: vi.fn(), removeHandler: vi.fn(), getPath: vi.fn(), getFileIcon: vi.fn(),
}))
vi.mock('electron', () => ({ app: electron, ipcMain: electron }))
const { installDesktopFileDrag } = await import('../src/file-drag.ts')
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers() })

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-file-drag-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  electron.getPath.mockReturnValue(root)
  const icon = {} as NativeImage
  electron.getFileIcon.mockResolvedValue(icon)
  const frame = Object.assign({} as WebFrameMain, { url: 'dsh-app://app/' })
  const window = Object.assign({} as BrowserWindow, { isDestroyed: () => false,
    webContents: Object.assign({} as WebContents, { mainFrame: frame, startDrag: vi.fn() }) })
  let current: BrowserWindow | undefined = window
  let host: object = {}
  const resolve = vi.fn<Parameters<typeof installDesktopFileDrag>[1]>(async () => null)
  const owner = (event: IpcMainInvokeEvent) => {
    assertDesktopSender(event, ['app'])
    if (current === undefined || event.sender !== current.webContents || event.senderFrame !== frame) throw new Error('Unowned file drag request')
    return { window: current, host }
  }
  const dispose = installDesktopFileDrag(owner, resolve)
  onTestFinished(dispose)
  const handlers = new Map<string, Handler>(electron.handle.mock.calls.map(([channel, handler]) => [channel, handler]))
  const event = Object.assign({} as IpcMainInvokeEvent, { sender: window.webContents, senderFrame: frame })
  const call = (channel: string, ...args: unknown[]) => (handlers.get(channel) as Handler)(event, ...args)
  const prepare = (bytes: Uint8Array, name = 'original.pdf', mediaType = 'application/pdf') =>
    call(DESKTOP_IPC.fileDragPrepare, { kind: 'bytes', bytes, name, mediaType })
  return {
    root, window, frame, event, icon, call, prepare, dispose, resolve,
    detach: () => { current = undefined }, rotateHost: () => { host = {} },
  }
}

it('delivers original PDF bytes and filename through native copy drag', async () => {
  const f = await fixture()
  const bytes = new TextEncoder().encode('%PDF-1.4\noriginal\n%%EOF')
  const handle = await f.prepare(bytes, '报告.pdf')
  expect(f.window.webContents.startDrag).not.toHaveBeenCalled()
  expect(await f.call(DESKTOP_IPC.fileDragStart, handle)).toBe(true)
  const [request] = f.window.webContents.startDrag.mock.calls[0] as [{ file: string; icon: NativeImage }]
  expect(request.icon).toBe(f.icon)
  expect(request.file).toContain('报告.pdf')
  expect(new Uint8Array(await readFile(request.file))).toEqual(bytes)
  await f.call(DESKTOP_IPC.fileDragRelease, handle)
  expect(new Uint8Array(await readFile(request.file))).toEqual(bytes)
  expect(await f.call(DESKTOP_IPC.fileDragStart, handle)).toBe(false)
  await f.dispose()
  expect(await readdir(f.root)).toEqual([])
})

it('uses shared sender authorization and releases failed native starts', async () => {
  const f = await fixture()
  expect(await f.call(DESKTOP_IPC.fileDragStart, 'foreign')).toBe(false)
  const handle = await f.prepare(new Uint8Array([1]))
  f.window.webContents.startDrag.mockImplementationOnce(() => { throw new Error('OS rejected drag') })
  expect(await f.call(DESKTOP_IPC.fileDragStart, handle)).toBe(false)
  await vi.waitFor(async () => { expect(await readdir(f.root)).toEqual([]) })
  f.frame.url = 'https://other.test/'
  await expect(f.call(DESKTOP_IPC.fileDragStart, handle)).rejects.toThrow('unowned renderer')
  f.frame.url = 'dsh-app://app/'
  Object.assign(f.event, { senderFrame: { url: 'dsh-app://app/' } })
  await expect(f.call(DESKTOP_IPC.fileDragStart, handle)).rejects.toThrow('Unowned file drag request')
  Object.assign(f.event, { senderFrame: f.frame, sender: {} })
  await expect(f.call(DESKTOP_IPC.fileDragStart, handle)).rejects.toThrow('Unowned file drag request')
  f.detach()
  await expect(f.call(DESKTOP_IPC.fileDragStart, handle)).rejects.toThrow('Unowned file drag request')
})

it('cancels icon preparation on shutdown without waiting for the icon service', async () => {
  const f = await fixture()
  const pending = Promise.withResolvers<NativeImage>()
  electron.getFileIcon.mockReturnValue(pending.promise)
  const rejected = expect(f.prepare(new Uint8Array([1]))).rejects.toThrow('File transfer closed')
  await vi.waitFor(() => { expect(electron.getFileIcon).toHaveBeenCalledOnce() })
  await f.dispose()
  await rejected
  pending.resolve(f.icon)
  await pending.promise
  expect(await readdir(f.root)).toEqual([])
})

it('borrows only authorized unchanged files with the requested export name, never deleting the source', async () => {
  const f = await fixture()
  const bytes = Buffer.from('original PDF bytes')
  const path = join(f.root, 'report.pdf')
  await writeFile(path, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  f.resolve.mockResolvedValue({ path, size: bytes.length, sha256 })
  const request = { kind: 'resource', address: 'dsh-resource://file/session/s/report.pdf', name: 'report.pdf', mediaType: 'application/pdf', sha256, size: bytes.length }
  const handle = await f.call(DESKTOP_IPC.fileDragPrepare, request)
  expect(f.resolve).toHaveBeenCalledWith(request.address)
  expect(await readdir(f.root)).toEqual(['report.pdf'])
  expect(await f.call(DESKTOP_IPC.fileDragStart, handle)).toBe(true)
  expect(f.window.webContents.startDrag).toHaveBeenCalledWith({ file: path, icon: f.icon })
  await f.dispose()
  expect(await readFile(path)).toEqual(bytes)
})

it('requests a copy for renamed, changed, and nonlocal resources', async () => {
  const f = await fixture()
  const path = join(f.root, 'report.pdf')
  const bytes = Buffer.from('PDF')
  await writeFile(path, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  f.resolve.mockResolvedValue({ path, size: bytes.length, sha256 })
  const request = { kind: 'resource', address: 'dsh-resource://file/session/s/report.pdf', name: 'renamed.pdf', mediaType: 'application/pdf' }
  expect(await f.call(DESKTOP_IPC.fileDragPrepare, request)).toBeUndefined()
  expect(await f.call(DESKTOP_IPC.fileDragPrepare, { ...request, name: 'report.pdf', sha256: '0'.repeat(64) })).toBeUndefined()
  expect(await f.call(DESKTOP_IPC.fileDragPrepare, { ...request, name: 'report.pdf', size: 100 })).toBeUndefined()
  const handle = await f.call(DESKTOP_IPC.fileDragPrepare, { ...request, name: 'report.pdf' })
  await writeFile(path, 'changed')
  expect(await f.call(DESKTOP_IPC.fileDragStart, handle)).toBe(false)
  f.resolve.mockResolvedValue(null)
  expect(await f.call(DESKTOP_IPC.fileDragPrepare, request)).toBeUndefined()
})

it.each([null, {}, { kind: 'bytes', bytes: '/private/path', mediaType: 'text/plain' }, { kind: 'resource', address: '/private/path', mediaType: 1 }])('rejects malformed wire requests', async (value) => {
  const f = await fixture()
  await expect(f.call(DESKTOP_IPC.fileDragPrepare, value)).rejects.toThrow('Invalid file drag request')
})

it('rejects an icon preparation completed for a replaced Host', async () => {
  const f = await fixture()
  const pending = Promise.withResolvers<NativeImage>()
  electron.getFileIcon.mockReturnValue(pending.promise)
  const preparing = f.prepare(new Uint8Array([1]))
  const rejected = expect(preparing).rejects.toThrow('owner changed')
  try {
    await vi.waitFor(() => { expect(electron.getFileIcon).toHaveBeenCalledOnce() })
    f.rotateHost()
  } finally {
    pending.resolve(f.icon)
    await rejected
  }
  expect(await readdir(f.root)).toEqual([])
})

it('refuses a prepared native start after Host replacement', async () => {
  const f = await fixture()
  const handle = await f.prepare(new Uint8Array([1]))
  f.rotateHost()
  expect(await f.call(DESKTOP_IPC.fileDragStart, handle)).toBe(false)
  expect(f.window.webContents.startDrag).not.toHaveBeenCalled()
  await f.dispose()
  expect(await readdir(f.root)).toEqual([])
})

it('bounds simultaneous preparations even when every file is empty', async () => {
  const f = await fixture()
  const results = await Promise.allSettled(Array.from({ length: 33 }, () => f.prepare(new Uint8Array())))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(32)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  await f.dispose()
  expect(await readdir(f.root)).toEqual([])
})

it('releases a preparation when the native icon service misses its deadline', async () => {
  const f = await fixture()
  const requested = Promise.withResolvers<undefined>()
  const icon = Promise.withResolvers<NativeImage>()
  electron.getFileIcon.mockImplementation(() => { requested.resolve(undefined); return icon.promise })
  vi.useFakeTimers()
  const preparing = f.prepare(new Uint8Array([1]))
  const rejected = expect(preparing).rejects.toThrow('icon lookup timed out')
  try {
    await requested.promise
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
  } finally {
    icon.resolve(f.icon)
    await Promise.allSettled([preparing])
  }
  expect(await readdir(f.root)).toEqual([])
})
