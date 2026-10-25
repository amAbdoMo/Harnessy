/** File transport selected once per plugin activation; sources only receive prepared operations. */
import type { DesktopFileDrag, FileDragHandle } from '@deepseek-ai/dsh-file-drag'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { resolveDragFileName, FILE_DRAG_TOKEN_TYPE, type FileDragSource, type PreparedFileDrag } from '@deepseek-ai/dsh-client-ui-primitives'

/** Application-local browser transfer owner, including detached source-node drag end. */
export class FileTransfers {
  private active: { token: string; file: File; end: () => void } | undefined
  private readonly prepared = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private disposed = false

  /** @param desktop - verified native bridge, absent in Web. @param reportFailure - localized plugin feedback. */
  constructor(private readonly desktop: DesktopFileDrag | undefined, private readonly reportFailure: () => void) {}

  /**
   * Resolve this instance's active transfer.
   * @param transfer - browser drop data.
   * @returns retained bytes only for this instance's current token.
   */
  read(transfer: DataTransfer): File | undefined {
    return this.active?.token === transfer.getData(FILE_DRAG_TOKEN_TYPE) ? this.active.file : undefined
  }

  private assertOpen(signal: AbortSignal): void {
    if (this.disposed) throw new Error('File transfers disposed')
    signal.throwIfAborted()
  }

  /**
   * Prepare bytes or borrow an authorized native file.
   * @param source - content plus export naming.
   * @param callerSignal - caller cancellation.
   * @returns synchronous drag startup and preparation release.
   */
  async prepare(source: FileDragSource, callerSignal: AbortSignal): Promise<PreparedFileDrag> {
    this.assertOpen(callerSignal)
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal])
    const desktop = this.desktop
    if (desktop === undefined) {
      const file = await this.readSource(source, signal)
      this.assertOpen(signal)
      return this.browser(file)
    }
    let handle: FileDragHandle | undefined
    try {
      if (source.resourceAddress !== undefined) {
        const bytes = source.kind === 'blob' ? await source.blob.arrayBuffer() : undefined
        const hash = bytes === undefined ? undefined
          : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
        this.assertOpen(signal)
        handle = await desktop.prepare({
          kind: 'resource', address: source.resourceAddress, name: source.name,
          mediaType: source.mediaType, outputExtension: source.outputExtension,
          ...(hash === undefined ? {} : { sha256: hash }),
          ...(source.kind === 'blob' ? { size: source.blob.size } : {}),
        })
      }
      if (handle === undefined) {
        const file = await this.readSource(source, signal)
        handle = await desktop.prepare({ kind: 'bytes', bytes: new Uint8Array(await file.arrayBuffer()),
          name: file.name, mediaType: file.type, outputExtension: source.outputExtension })
        if (handle === undefined) throw new Error('File preparation unavailable')
      }
      this.assertOpen(signal)
      return this.native(desktop, handle)
    } catch (error) {
      if (handle !== undefined) desktop.release(handle)
      throw error
    }
  }

  private async readSource(source: FileDragSource, signal: AbortSignal): Promise<File> {
    this.assertOpen(signal)
    let content: Blob
    if (source.kind === 'url') {
      const response = await fetch(source.url, { signal, referrerPolicy: 'no-referrer' })
      if (!response.ok) throw new Error('File read failed')
      content = await response.blob()
    } else content = source.blob
    this.assertOpen(signal)
    const mediaType = source.mediaType || content.type
    return new File([content], resolveDragFileName({ ...source, mediaType }), { type: mediaType })
  }

  private native(desktop: DesktopFileDrag, nativeHandle: FileDragHandle): PreparedFileDrag {
    let starting: Promise<void> | undefined
    const release = (): void => {
      if (!this.prepared.delete(release)) return
      if (starting === undefined) desktop.release(nativeHandle)
      else void starting.then(() => { desktop.release(nativeHandle) })
    }
    this.prepared.add(release)
    return {
      start: () => {
        if (!this.prepared.has(release)) return false
        starting = desktop.start(nativeHandle).then(
          (started) => { if (!started && !this.disposed) this.reportFailure() },
          () => { if (!this.disposed) this.reportFailure() },
        )
        return false
      },
      release,
    }
  }

  private browser(file: File): PreparedFileDrag {
    const url = URL.createObjectURL(file)
    let released = false
    let started = false
    const releaseUrl = (): void => { this.prepared.delete(release); URL.revokeObjectURL(url) }
    const release = (): void => { released = true; if (!started) releaseUrl() }
    this.prepared.add(release)
    return {
      start: (transfer, source) => {
        if (released || this.disposed) return false
        this.active?.end()
        started = true
        const token = randomUUID()
        const end = (): void => {
          if (this.active?.token !== token) return
          source.removeEventListener('dragend', end)
          window.removeEventListener('drop', dropped)
          this.active = undefined
          started = false
          if (released) releaseUrl()
        }
        const dropped = (): void => { queueMicrotask(end) }
        this.active = { token, file, end }
        source.addEventListener('dragend', end, { once: true })
        window.addEventListener('drop', dropped, { once: true })
        transfer.items.clear()
        transfer.effectAllowed = 'copy'
        transfer.setData(FILE_DRAG_TOKEN_TYPE, token)
        transfer.setData('DownloadURL', `${file.type}:${file.name}:${url}`)
        return true
      },
      release,
    }
  }

  /** End active transfers and retire every preparation, including sources detached during dragging. */
  dispose(): void {
    this.disposed = true
    this.lifetime.abort()
    this.active?.end()
    for (const release of this.prepared) release()
  }
}
