/**
 * The one concurrency gate for delegated runs. Foreground calls and background
 * jobs take their slot from the same limiter, so the configured cap bounds
 * every Command Code process this profile has in flight.
 *
 * @module @deepseek-ai/dsh-subagent-commandcode/limiter
 */

/**
 * FIFO admission gate over a live, read-through capacity.
 *
 * The cap is read on every admission rather than captured, so lowering it in
 * Settings takes effect as running work finishes without disturbing a run that
 * already holds its slot.
 */
export class CommandCodeRunLimiter {
  private active = 0
  private readonly waiting: Array<() => void> = []

  /**
   * Bind the limiter to a live cap.
   * @param capacity - reads the current cap on every admission.
   */
  constructor(private readonly capacity: () => number) {}

  /**
   * Take one slot, waiting for a free one.
   * @param signal - caller cancellation while waiting; rejecting publishes nothing.
   * @returns an idempotent release; the caller must invoke it once the run's process tree is done.
   */
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    while (this.active >= this.capacity()) {
      await new Promise<void>((resolve, reject) => {
        const waiter = (): void => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = (): void => {
          const index = this.waiting.indexOf(waiter)
          if (index >= 0) this.waiting.splice(index, 1)
          reject(signal.reason instanceof Error ? signal.reason : new Error('commandcode: delegation cancelled'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        this.waiting.push(waiter)
      })
    }
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}
