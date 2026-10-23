/** Bounded Host activation ownership and cancellable read-only preparation. */

/**
 * Stop waiting for read-only preparation on API teardown, observing late settlement.
 * Caller cancellation does not release the activation's capacity until preparation settles.
 * @param pending - read-only preparation, never writable Agent resume.
 * @param signal - API owner teardown, not the phone reply lifetime.
 * @param release - dispose a resource that arrives after teardown.
 * @returns the prepared value, or the API teardown failure.
 */
export function awaitActivationPreparation<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  release?: (abandoned: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void pending.then((prepared) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) release?.(prepared)
      else resolve(prepared)
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
  })
}
