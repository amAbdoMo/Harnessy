/** Private Host transport for native preview requests and explicit UI-owned launcher stops. */
import { randomUUID } from 'node:crypto'
import type {
  DevicePreviewHostRequest, DevicePreviewId, DevicePreviewProjectId, DevicePreviewRequestId, DevicePreviewResponse,
  DevicePreviewRetirement,
} from '@deepseek-ai/dsh-client-ui-device-preview/types'
import { isDevicePreviewHostRequest } from './device-preview-protocol.ts'

function stopResponse(input: unknown): input is DevicePreviewResponse {
  if (typeof input !== 'object' || input === null || !('type' in input) || input.type !== 'device-preview-result'
    || !('requestId' in input) || typeof input.requestId !== 'string' || input.requestId.length !== 36
    || !('ok' in input) || typeof input.ok !== 'boolean') return false
  if (!input.ok) return 'error' in input && typeof input.error === 'string'
    && Buffer.byteLength(JSON.stringify(input), 'utf8') <= 4096
  return 'result' in input && typeof input.result === 'object' && input.result !== null
    && 'kind' in input.result && input.result.kind === 'stopped' && 'projectId' in input.result
    && typeof input.result.projectId === 'string' && input.result.projectId.length === 36
    && Buffer.byteLength(JSON.stringify(input), 'utf8') <= 4096
}

/** Routes one Host generation; a closed transport never grants or retains a preview operation. */
export class DesktopDevicePreviewHost {
  private listener: ((request: DevicePreviewHostRequest) => Promise<DevicePreviewResponse | undefined>) | undefined
  private readonly stops = new Map<DevicePreviewRequestId, {
    readonly projectId: DevicePreviewProjectId
    readonly resolve: () => void
    readonly reject: (error: Error) => void
  }>()
  private closed = false

  /** @param send - exact current child channel; rejects when that Host is unavailable. */
  constructor(private readonly send: (message: object) => Promise<void>) {}

  /** @param listener - sole native owner installed before child startup. @returns registration disposer. */
  register(listener: (request: DevicePreviewHostRequest) => Promise<DevicePreviewResponse | undefined>): () => void {
    if (this.listener !== undefined || this.closed) throw new Error('Device preview native owner is unavailable')
    this.listener = listener
    return () => { if (this.listener === listener) this.listener = undefined }
  }

  /** @param message - untrusted private child event. @param reply - exact child-generation response channel.
   * @returns whether the event belongs to the preview protocol; malformed preview events throw.
   */
  receive(message: unknown, reply: (response: DevicePreviewResponse) => Promise<void>): boolean {
    if (typeof message !== 'object' || message === null || !('type' in message) || typeof message.type !== 'string'
      || !message.type.startsWith('device-preview-')) return false
    if (message.type === 'device-preview-result') {
      if (!stopResponse(message)) throw new Error('Device preview Host stop response rejected')
      const stop = this.stops.get(message.requestId)
      if (stop === undefined) return true
      if (!message.ok) stop.reject(new Error(message.error))
      else if (message.result.kind !== 'stopped' || message.result.projectId !== stop.projectId) stop.reject(new Error('Device preview Host stopped a different launcher'))
      else stop.resolve()
      return true
    }
    if (!isDevicePreviewHostRequest(message)) throw new Error('Device preview Host request rejected')
    const listener = this.closed ? undefined : this.listener
    if (listener === undefined) {
      if (message.type !== 'device-preview-cancel') void reply({ type: 'device-preview-result', requestId: message.requestId,
        ok: false, error: 'Device preview is unavailable' }).catch((error: unknown) => { console.error('Device preview rejection could not be delivered', error) })
      return true
    }
    void listener(message).then(async (response) => {
      if (response !== undefined) await reply(response)
    }).catch((error: unknown) => { console.error('Device preview native operation failed', error) })
    return true
  }

  /** @param projectId - owned launcher from a displayed preview. @returns after the Host confirms physical process settlement. */
  async stop(projectId: DevicePreviewProjectId): Promise<void> {
    if (this.closed) throw new Error('Device preview Host is unavailable')
    const requestId = randomUUID() as DevicePreviewRequestId
    const completion = Promise.withResolvers<void>()
    // Channel closure may reject while the sender is still settling; the awaited original retains that failure.
    void completion.promise.catch((error: unknown) => { void error })
    this.stops.set(requestId, { projectId, resolve: completion.resolve, reject: completion.reject })
    try {
      await this.send({ type: 'device-preview-stop', requestId, projectId })
      await completion.promise
    } finally { this.stops.delete(requestId) }
  }

  /** @param previewId - Main-retired occurrence, not a launcher.
   * @returns after delivery to this exact Host generation; channel loss also removes its observation records.
   */
  async retire(previewId: DevicePreviewId): Promise<void> {
    if (this.closed) return
    const message: DevicePreviewRetirement = { type: 'device-preview-retired', previewId }
    await this.send(message)
  }

  /** @param error - Host shutdown or channel failure; synchronously reject outstanding Stop requests. */
  close(error: Error): void {
    this.closed = true
    this.listener = undefined
    for (const stop of this.stops.values()) stop.reject(error)
    this.stops.clear()
  }
}
