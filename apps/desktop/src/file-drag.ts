/** Native copy drags authorized only for the product main frame and the active Host. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type NativeImage } from 'electron'
import { resolveDragFileName, type DesktopFileSource, type FileDragHandle } from '@deepseek-ai/dsh-file-drag'
import { DESKTOP_IPC } from './ipc.ts'
import { DragFiles } from './file-drag-files.ts'

interface LocalResource { readonly path: string; readonly size: number; readonly sha256: string }

/** Native window and exact Host generation authorized for one preparation. */
export interface FileDragOwner {
  readonly window: BrowserWindow
  readonly host: object
}

// Empty files still consume preparation handles and native icon requests.
const MAX_PREPARED_FILE_DRAGS = 32

function requestOf(value: unknown): DesktopFileSource {
  if (typeof value !== 'object' || value === null || !('kind' in value)
    || !('mediaType' in value) || typeof value.mediaType !== 'string'
    || ('name' in value && value.name !== undefined && typeof value.name !== 'string')
    || ('outputExtension' in value && value.outputExtension !== undefined && typeof value.outputExtension !== 'string')) throw new Error('Invalid file drag request')
  const naming = {
    mediaType: value.mediaType, name: 'name' in value ? value.name as string | undefined : undefined,
    outputExtension: 'outputExtension' in value ? value.outputExtension as string | undefined : undefined,
  }
  if (value.kind === 'bytes' && 'bytes' in value && value.bytes instanceof Uint8Array) return { kind: 'bytes', bytes: value.bytes, ...naming }
  if (value.kind === 'resource' && 'address' in value && typeof value.address === 'string'
    && (!('sha256' in value) || (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256)))
    && (!('size' in value) || (typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0))) {
    return { kind: 'resource', address: value.address, ...naming,
      ...('sha256' in value ? { sha256: value.sha256 as string } : {}),
      ...('size' in value ? { size: value.size as number } : {}) }
  }
  throw new Error('Invalid file drag request')
}

async function unchanged(resource: LocalResource): Promise<boolean> {
  const info = await stat(resource.path)
  if (!info.isFile() || info.size !== resource.size) return false
  const hash = createHash('sha256')
  const stream = createReadStream(resource.path)
  const chunks: AsyncIterable<unknown> = stream
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new Error('File stream returned non-binary data')
    hash.update(chunk)
  }
  const after = await stat(resource.path)
  return info.dev === after.dev && info.ino === after.ino && info.mtimeMs === after.mtimeMs
    && after.size === resource.size && hash.digest('hex') === resource.sha256
}

/** Bound the native icon service wait and release its deadline when the transfer closes. */
async function fileDragIcon(file: string, closed: Promise<void>): Promise<NativeImage | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      app.getFileIcon(file, { size: 'normal' }), closed.then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('File drag icon lookup timed out')) }, 10_000)
        timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Register file preparation and native dragging.
 * @param owner - shared product sender authorization, returning its window and exact Host generation.
 * @param resolveResource - private Host authorization; renderer paths are never used directly.
 * @returns cleanup awaiting tracked writes/removals without waiting for the system icon service.
 */
export function installDesktopFileDrag(
  owner: (event: IpcMainInvokeEvent) => FileDragOwner,
  resolveResource: (address: string) => Promise<LocalResource | null>,
): () => Promise<void> {
  let disposed = false
  const closed = Promise.withResolvers<void>()
  const files = new DragFiles(app.getPath('temp'))
  const pending = new Set<Promise<FileDragHandle | undefined>>()
  const icons = new Map<string, NativeImage>()
  const borrowed = new Map<string, LocalResource>()
  const preparedOwners = new Map<string, FileDragOwner>()
  const authorize = (event: IpcMainInvokeEvent, expected?: FileDragOwner): FileDragOwner => {
    if (disposed) throw new Error('File transfer closed')
    const current = owner(event)
    if (expected !== undefined && (current.host !== expected.host || current.window !== expected.window)) {
      throw new Error('File drag owner changed')
    }
    return current
  }
  const prepare = async (event: IpcMainInvokeEvent, value: unknown): Promise<FileDragHandle | undefined> => {
    const current = authorize(event)
    if (pending.size + icons.size >= MAX_PREPARED_FILE_DRAGS) throw new Error('File drag preparation limit')
    const source = requestOf(value)
    let handle: FileDragHandle
    if (source.kind === 'bytes') handle = await files.prepare(source.bytes, source)
    else {
      const resource = await resolveResource(source.address)
      authorize(event, current)
      if (resource === null || basename(resource.path) !== resolveDragFileName(source)
        || (source.sha256 !== undefined && source.sha256 !== resource.sha256)
        || (source.size !== undefined && source.size !== resource.size) || !await unchanged(resource)) return undefined
      handle = files.borrow(resource.path)
      borrowed.set(handle, resource)
    }
    try {
      const file = files.take(handle, false)
      if (file === undefined) throw new Error('File transfer closed')
      const icon = await fileDragIcon(file, closed.promise)
      authorize(event, current)
      if (icon === undefined) throw new Error('File transfer closed')
      icons.set(handle, icon)
      preparedOwners.set(handle, current)
      return handle
    } catch (error) {
      borrowed.delete(handle)
      await files.release(handle)
      throw error
    }
  }
  ipcMain.handle(DESKTOP_IPC.fileDragPrepare, (event, source: unknown) => {
    const operation = prepare(event, source)
    pending.add(operation)
    void operation.then(() => { pending.delete(operation) }, () => { pending.delete(operation) })
    return operation
  })
  ipcMain.handle(DESKTOP_IPC.fileDragStart, async (event, handle: unknown) => {
    authorize(event)
    const icon = typeof handle === 'string' ? icons.get(handle) : undefined
    if (icon === undefined || typeof handle !== 'string') return false
    const file = files.take(handle, false)
    if (file === undefined) return false
    try {
      const current = preparedOwners.get(handle)
      if (current === undefined) return false
      authorize(event, current)
      const resource = borrowed.get(handle)
      if (resource !== undefined && !await unchanged(resource)) throw new Error('File changed before dragging')
      authorize(event, current)
      current.window.webContents.startDrag({ file, icon })
      files.take(handle)
      icons.delete(handle)
      borrowed.delete(handle)
      preparedOwners.delete(handle)
      return true
    } catch (_error) {
      icons.delete(handle)
      borrowed.delete(handle)
      preparedOwners.delete(handle)
      void files.release(handle).catch((error: unknown) => { console.error(error) })
      return false
    }
  })
  ipcMain.handle(DESKTOP_IPC.fileDragRelease, async (event, handle: unknown) => {
    authorize(event)
    if (typeof handle === 'string') { icons.delete(handle); borrowed.delete(handle); preparedOwners.delete(handle) }
    await files.release(handle)
  })
  return async () => {
    if (!disposed) {
      disposed = true
      closed.resolve()
      ipcMain.removeHandler(DESKTOP_IPC.fileDragPrepare)
      ipcMain.removeHandler(DESKTOP_IPC.fileDragStart)
      ipcMain.removeHandler(DESKTOP_IPC.fileDragRelease)
    }
    await Promise.allSettled(pending)
    icons.clear()
    borrowed.clear()
    preparedOwners.clear()
    await files.dispose()
  }
}
