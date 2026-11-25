/** Private Main bridge for authenticated companion browser requests. */
import { randomUUID } from 'node:crypto'
import type { BrowserShareHandler, BrowserShareRequest, BrowserShareResponse } from '@deepseek-ai/dsh-companion-host'

type ShareId = Extract<BrowserShareResponse, { status: 'frame' }>['shareId']

const MAX_FRAME = 24_576
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u

/**
 * Carry one active phone frame and stop request independently to Main.
 * @param signal - lifetime of the exact Desktop Host and its companion.
 * @param send - private child-to-Main channel.
 * @returns Browser operations and the receiver for their acknowledgments.
 */
export function createPhoneBrowserShare(signal: AbortSignal, send: (message: object) => Promise<void>) {
  const pending = new Map<BrowserShareRequest['kind'], { id: string; resolve: (value: BrowserShareResponse) => void }>()
  const close = (): void => { for (const call of pending.values()) call.resolve({ status: 'ended' }) }
  signal.addEventListener('abort', close, { once: true })
  const request: BrowserShareHandler = async ({ kind, shareId }, caller) => {
    signal.throwIfAborted()
    caller.throwIfAborted()
    if (pending.has(kind)) return { status: 'busy' }
    const id = randomUUID()
    const completion = Promise.withResolvers<BrowserShareResponse>()
    const cancel = (): void => { completion.resolve({ status: 'busy' }) }
    pending.set(kind, { id, resolve: completion.resolve })
    const timeout = setTimeout(cancel, 2500)
    caller.addEventListener('abort', cancel, { once: true })
    try {
      void send({ type: kind === 'watch' ? 'phone-browser-share-watch' : 'phone-browser-share-stop', requestId: id, id: shareId })
        .catch(cancel)
      const result = await completion.promise
      signal.throwIfAborted()
      caller.throwIfAborted()
      return result
    } finally {
      pending.delete(kind)
      caller.removeEventListener('abort', cancel)
      clearTimeout(timeout)
    }
  }
  return {
    request,
    receive(message: unknown): boolean {
      if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'phone-browser-share-result') return false
      if (!('requestId' in message)) return true
      const watch = pending.get('watch')
      const stop = pending.get('stop')
      const operation = watch?.id === message.requestId ? watch : stop?.id === message.requestId ? stop : undefined
      if (operation === undefined || !('status' in message)) return true
      const { status } = message
      if (status === 'busy' || status === 'ended' || status === 'idle') operation.resolve({ status })
      if (operation === watch && status === 'frame' && 'shareId' in message && typeof message.shareId === 'string'
        && UUID.test(message.shareId) && 'jpeg' in message && typeof message.jpeg === 'string'
        && message.jpeg.length > 0 && message.jpeg.length <= MAX_FRAME) {
        operation.resolve({ status, shareId: message.shareId as ShareId, jpeg: message.jpeg })
      }
      return true
    },
  }
}
