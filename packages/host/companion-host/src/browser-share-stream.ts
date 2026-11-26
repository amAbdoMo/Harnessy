/** Continuous native browser frames for one authenticated companion channel. */
import { setTimeout as delay } from 'node:timers/promises'
import type { ApplicationResult, BrowserShareId, MobileRequestId } from '@deepseek-ai/dsh-companion-protocol'
import type { BrowserShareHandler } from './types.ts'

const FRAME_PERIOD_MS = 67
const DISCOVERY_PERIOD_MS = 250

interface Stream {
  readonly id: MobileRequestId
  readonly controller: AbortController
}

/**
 * Sample a Desktop-authorized share with one capture and send in flight per channel.
 * @param context - exact channel lifetime, frame provider and bounded sender.
 * @returns Start, exact cancellation and awaited teardown for the phone viewer.
 */
export function createBrowserShareStream(context: {
  readonly signal: AbortSignal
  readonly provider: BrowserShareHandler | undefined
  readonly requireCurrent: () => void
  readonly send: (result: ApplicationResult) => Promise<void>
  readonly allowFrame?: (jpeg: string) => boolean
}) {
  let current: Stream | undefined
  let worker: Promise<void> | undefined

  const stop = (id?: MobileRequestId): void => {
    if (current === undefined || (id !== undefined && id !== current.id)) return
    current.controller.abort()
    current = undefined
  }

  async function watch(stream: Stream, provider: BrowserShareHandler): Promise<void> {
    const signal = AbortSignal.any([context.signal, stream.controller.signal])
    let shareId: BrowserShareId | undefined
    let jpeg: string | undefined
    let pause = FRAME_PERIOD_MS
    while (!signal.aborted) {
      await delay(pause, undefined, { signal, ref: false })
      const started = performance.now()
      context.requireCurrent()
      const result = await provider({ kind: 'watch', ...(shareId === undefined ? {} : { shareId }) }, signal)
      signal.throwIfAborted()
      context.requireCurrent()
      if (result.status === 'frame' && (shareId === undefined || result.shareId === shareId)) {
        if ((shareId !== result.shareId || jpeg !== result.jpeg) && context.allowFrame?.(result.jpeg) !== false) {
          await context.send({ v: 1, type: 'browserShare', requestId: stream.id, ...result })
          jpeg = result.jpeg
          shareId = result.shareId
        }
      } else if (shareId !== undefined && result.status !== 'busy') {
        shareId = undefined
        jpeg = undefined
        await context.send({ v: 1, type: 'browserShare', requestId: stream.id, status: 'ended' })
      }
      const period = shareId === undefined && result.status !== 'frame' ? DISCOVERY_PERIOD_MS : FRAME_PERIOD_MS
      pause = Math.max(1, period - (performance.now() - started))
    }
  }

  async function run(provider: BrowserShareHandler): Promise<void> {
    while (current !== undefined) {
      const stream = current
      try { await watch(stream, provider) }
      catch (_error: unknown) {
        // Channel retirement or a failed send leaves no active subscriber.
      }
      if (current === stream) current = undefined
    }
  }

  function ensureWorker(provider: BrowserShareHandler): void {
    worker ??= run(provider).finally(() => {
      worker = undefined
      if (current !== undefined) ensureWorker(provider)
    })
  }

  return {
    start(id: MobileRequestId): void {
      stop()
      const provider = context.provider
      if (provider === undefined || context.signal.aborted) return
      current = { id, controller: new AbortController() }
      ensureWorker(provider)
    },
    stop,
    async close(): Promise<void> {
      stop()
      await worker
    },
  }
}
