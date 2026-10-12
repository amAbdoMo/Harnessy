/** In-memory ws network boundary; callbacks remain explicitly owned by each socket. */
import { EventEmitter } from 'node:events'

/** Outbound socket substitute; no internal Companion or Session code is replaced. */
export class SocketTransport extends EventEmitter {
  static readonly OPEN = 1
  static readonly instances: SocketTransport[] = []
  readyState = SocketTransport.OPEN
  bufferedAmount = 0
  readonly packets: Record<string, unknown>[] = []
  readonly closed: Promise<void>
  private finishClose: () => void = () => {}
  private readonly pending: ((error?: Error) => void)[] = []
  blocked = false
  flushOnTerminate = true

  constructor(readonly url: string, readonly options: object) {
    super()
    this.closed = new Promise((resolve) => { this.finishClose = resolve })
    SocketTransport.instances.push(this)
  }

  /** @param value - Relay JSON delivered through the actual connector parser. */
  receive(value: object): void { this.emit('message', Buffer.from(JSON.stringify(value)), false) }

  /** @param text - Serialized outbound frame. @param _options - ws send flags. @param complete - Owned completion callback. */
  send(text: string, _options: object, complete: (error?: Error) => void): void {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected relay object')
    this.packets.push(value as Record<string, unknown>)
    const size = Buffer.byteLength(text)
    this.bufferedAmount += size
    let released = false
    const callback = (error?: Error): void => {
      if (!released) {
        released = true
        if (this.readyState !== 3) this.bufferedAmount -= size
      }
      complete(error)
    }
    if (this.blocked) this.pending.push(callback)
    else callback()
  }

  /** Release transport callbacks, including callbacks captured before termination. */
  flush(): void { for (const complete of this.pending.splice(0)) complete() }

  /** @returns One captured callback, which may be delivered repeatedly or after close to test ownership. */
  takeCallback(): (error?: Error) => void {
    const complete = this.pending.shift()
    if (complete === undefined) throw new Error('No captured transport write')
    return complete
  }

  /** Termination emits close even when the sender deliberately withholds its callbacks. */
  terminate(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.bufferedAmount = 0
    if (this.flushOnTerminate) this.flush()
    this.emit('close')
    this.finishClose()
  }
}
