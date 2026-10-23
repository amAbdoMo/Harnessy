/** Caller cancellation for PC-owned model lookups and already-admitted persistence work. */
/* oxlint-disable typescript/prefer-promise-reject-errors -- Abort and PC-operation rejections retain their exact identity. */

/**
 * Withdraw a caller's wait without permitting a late continuation to admit a model change.
 * The operation's PC service retains its underlying work; late rejection is observed and abort listeners are removed.
 * Callers must recheck authority before any effect. Cancelling a wait never undoes a committed event or cancels its flush.
 * @param operation - Read-only model lookup or independently PC-owned persistence operation.
 * @param signal - Caller lifetime; omitted waits for ordinary completion.
 * @returns the operation result, or rejection when the caller's lifetime ends first.
 */
export async function settleModelWait<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const pending = operation()
  if (signal === undefined) return pending
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void pending.then((value) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
  })
}
