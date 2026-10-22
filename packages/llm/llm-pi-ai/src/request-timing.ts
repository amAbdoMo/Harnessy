/** Local, content-free timing records for one provider attempt. */

import { randomUUID } from 'node:crypto'

type Phase = 'started' | 'credential-reference-resolved' | 'context-ready' | 'payload-ready'
  | 'response-headers' | 'first-output' | 'settled'
type Outcome = 'completed' | 'error' | 'aborted' | 'closed'

/** Per-attempt checkpoints; elapsed times include consumer backpressure after output begins. */
export class RequestTiming {
  private readonly request = randomUUID()
  private readonly started = performance.now()
  private previous = this.started
  private readonly recorded = new Set<Phase>()

  constructor(
    private readonly log: (message: string) => void,
    private readonly detail: { api: string; transport: string; fastMode: boolean },
  ) {
    this.mark('started')
  }

  /**
   * Log the first occurrence of a checkpoint without inspecting provider data.
   * @param phase - observed checkpoint, not an inferred network operation.
   * @param outcome - final attempt status, only supplied at settlement.
   */
  mark(phase: Phase, outcome?: Outcome): void {
    if (this.recorded.has(phase)) return
    this.recorded.add(phase)
    const now = performance.now()
    const message = `llm-pi-ai request-timing ${JSON.stringify({
      request: this.request,
      ...this.detail,
      phase,
      elapsedMs: Math.round((now - this.started) * 100) / 100,
      sincePreviousMs: Math.round((now - this.previous) * 100) / 100,
      ...outcome === undefined ? {} : { outcome },
    })}`
    this.previous = now
    try { this.log(message) }
    catch (_error: unknown) { /* A diagnostic sink failure must not change the model attempt. */ }
  }
}
