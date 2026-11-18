/** Electron-native inactivity deadlines for updater checks, full downloads, and blockmap requests. */
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from 'electron'

/** Retains electron-updater transport and proxy handling while bounding silent connections. */
export class DesktopUpdateHttpExecutor extends ElectronHttpExecutor {
  override createRequest(
    options: ClientRequestConstructorOptions,
    callback: Parameters<ElectronHttpExecutor['createRequest']>[1],
  ): ClientRequest {
    const range = Object.entries(options.headers ?? {}).find(([name]) => name.toLowerCase() === 'range')?.[1]
    if (options.headers !== undefined) {
      options.headers = Object.fromEntries(Object.entries(options.headers)
        .filter(([name]) => name.toLowerCase() !== 'x-user-staging-id'))
    }
    if (typeof range !== 'string') return super.createRequest(options, callback)
    const requested = /^bytes=(\d+)-(\d+)$/u.exec(range)
    const request = super.createRequest(options, (response: IncomingMessage) => {
      const [contentRange, contentType] = ['content-range', 'content-type'].map((name) => {
        const value = response.headers[name]
        return Array.isArray(value) ? value[0] : value
      })
      const returned = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(contentRange ?? '')
      const partial = requested === null
        ? contentType?.startsWith('multipart/byteranges') === true
        : returned !== null && requested[1] === returned[1] && requested[2] === returned[2]
          && Number(returned[2]) - Number(returned[1]) + 1 < Number(returned[3])
      if (response.statusCode !== 206 || !partial) {
        // Abort before passing the body to the range downloader.
        request.emit('error', new Error('The update server did not return a partial file'))
        request.abort()
        return
      }
      callback(response)
    })
    return request
  }

  /**
   * @param idleTimeoutMs - Maximum silence before headers or between response chunks, not a total download deadline.
   * @param proxyLogin - Existing updater login event forwarding.
   */
  constructor(private readonly idleTimeoutMs: number, proxyLogin?: ConstructorParameters<typeof ElectronHttpExecutor>[0]) {
    super(proxyLogin)
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1000 || idleTimeoutMs > 2_147_483_647) {
      throw new Error('desktop update: HTTP idle timeout must be an integer from 1000 through 2147483647')
    }
  }

  override addErrorAndTimeoutHandlers(request: ClientRequest, reject: (error: Error) => void): void {
    // The upstream socket timer is for Node HTTP; Electron ClientRequest has response/close events instead.
    super.addErrorAndTimeoutHandlers(request, reject, this.idleTimeoutMs)
    let response: IncomingMessage | undefined
    let timer: ReturnType<typeof setTimeout>
    let stopped = false
    const stop = (): void => {
      stopped = true
      clearTimeout(timer)
      request.off('response', onResponse)
      request.off('abort', stop)
      request.off('error', stop)
      response?.off('data', refresh)
      response?.off('end', stop)
      response?.off('error', stop)
    }
    const refresh = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        stop()
        reject(Object.assign(new Error('Desktop update connection timed out'), { code: 'ETIMEDOUT' }))
        request.abort()
      }, this.idleTimeoutMs)
    }
    const onResponse = (incoming: IncomingMessage): void => {
      if (stopped) return
      response = incoming
      response.on('data', refresh)
      response.once('end', stop)
      response.once('error', stop)
      refresh()
    }
    request.once('response', onResponse)
    // Electron 44 can emit writable close after finish, before response headers arrive.
    request.once('abort', stop)
    request.once('error', stop)
    refresh()
  }
}
