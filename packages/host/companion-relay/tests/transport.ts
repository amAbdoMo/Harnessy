/** Network-boundary doubles: no listener binds, while real WebServer and Loader retain lifecycle ownership. */
import { EventEmitter } from 'node:events'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

export class HttpTransport extends EventEmitter {
  static readonly instances: HttpTransport[] = []
  constructor() { super(); HttpTransport.instances.push(this) }
  listen(_port: number, _host: string, ready: () => void): void { ready() }
  address(): { address: string; family: string; port: number } {
    return { address: '127.0.0.1', family: 'IPv4', port: 1 }
  }
  close(done: () => void): void { queueMicrotask(done) }
  closeAllConnections(): void {}
}

export class SocketTransport extends EventEmitter {
  static readonly OPEN = 1
  static readonly instances: SocketTransport[] = []
  readonly packets: unknown[] = []
  readonly callbacks: ((error?: Error) => void)[] = []
  readyState = 1
  bufferedAmount = 0
  blocked = false
  readonly closed: Promise<void>

  constructor(private readonly raw: Duplex) {
    super()
    this.closed = new Promise(resolve => raw.once('close', () => {
      this.readyState = 3
      this.flush()
      this.emit('close')
      resolve()
    }))
    SocketTransport.instances.push(this)
  }
  send(text: string, _options: object, done: (error?: Error) => void): void {
    this.packets.push(JSON.parse(text))
    if (this.blocked) this.callbacks.push(done)
    else queueMicrotask(() => { done() })
  }
  terminate(): void {
    if (this.readyState === 3) return
    this.readyState = 2
    this.raw.destroy()
  }
  flush(): void { for (const done of this.callbacks.splice(0)) done(new Error('transport closed')) }
  receive(wire: unknown): void { this.emit('message', Buffer.from(JSON.stringify(wire)), false) }
  last(): unknown { return this.packets.at(-1) }
}

export class WebSocketTransport {
  handleUpgrade(_req: IncomingMessage, socket: Duplex, _head: Buffer, accepted: (ws: SocketTransport) => void): void {
    accepted(new SocketTransport(socket))
  }
  close(done: () => void): void { queueMicrotask(done) }
}

export function upgradeRequest(path: string, origin?: string, ip = '127.0.0.1'): IncomingMessage {
  const raw = new Socket()
  Object.defineProperty(raw, 'remoteAddress', { value: ip })
  const request = new IncomingMessage(raw)
  request.url = path
  request.method = 'GET'
  request.headers = { host: 'relay.invalid' }
  request.rawHeaders = ['Host', 'relay.invalid']
  if (origin !== undefined) {
    request.headers.origin = origin
    request.rawHeaders.push('Origin', origin)
  }
  return request
}
