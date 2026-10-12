/** Endpoint-local resource budgets for serialized cryptographic work and transport writes. */
import { exactRecord } from './bytes.ts'

/** Explicit endpoint limits; these are deployment data, not negotiated wire fields. */
export interface ChannelBudget {
  readonly maxQueuedSendBytes: number
  readonly maxQueuedReceiveBytes: number
  readonly maxPendingSends: number
  readonly maxPendingReceives: number
  readonly sendTimeoutMs: number
}

function positiveInteger(input: unknown, maximum: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > maximum) {
    throw new Error('Invalid companion channel resource budget')
  }
  return input
}

/** Validate queue and write-time budgets before creating handshake state.
 * @param input - Complete endpoint deployment budget.
 * @returns Frozen explicit limits; throws on absent, extra, fractional, or oversized values.
 */
export function parseChannelBudget(input: unknown): ChannelBudget {
  const fields = exactRecord(input, ['maxQueuedSendBytes', 'maxQueuedReceiveBytes', 'maxPendingSends', 'maxPendingReceives', 'sendTimeoutMs'])
  return Object.freeze({
    maxQueuedSendBytes: positiveInteger(fields.maxQueuedSendBytes, 16_777_216),
    maxQueuedReceiveBytes: positiveInteger(fields.maxQueuedReceiveBytes, 16_777_216),
    maxPendingSends: positiveInteger(fields.maxPendingSends, 1024),
    maxPendingReceives: positiveInteger(fields.maxPendingReceives, 1024),
    sendTimeoutMs: positiveInteger(fields.sendTimeoutMs, 60_000),
  })
}
