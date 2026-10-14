/** Explicit optional-product deployment policy; no synthesized relay origin or budget defaults. */
import z from '@deepseek-ai/schemastery'
import { MAX_NORMALIZED_RELAY_FRAME_BYTES, parseApplicationBudget, parseChannelBudget, parseHttpsOrigin } from '@deepseek-ai/dsh-companion-protocol'
import type { ApplicationBudget, ChannelBudget, HttpsOrigin } from '@deepseek-ai/dsh-companion-protocol'

/** All limits are required when an actual origin is configured. */
export interface HostBudgets {
  /** Application UTF-8 byte, result-count, per-grant operation and read/subscription time limits. */
  readonly application: ApplicationBudget
  /** Cryptographic send/receive queue limits and transport write deadline. */
  readonly channel: ChannelBudget
  /** Concurrent phone channels, including channels still completing teardown. */
  readonly maxChannels: number
  /** Total admitted channel opens per ready relay connection; closing a channel does not restore an attempt. */
  readonly maxChannelAttempts: number
  /** Pending locally approvable pairing candidates; at most 64 and no more than maxChannels. */
  readonly maxCandidates: number
  /** Persisted phone grants; at most 64. Enrollment fails when the record is full. */
  readonly maxGrants: number
  /** UTF-8 JSON bytes in the private identity/grant payload, excluding its credential wrapper; at most 1 MiB. */
  readonly maxRecordBytes: number
  /** Complete relay JSON receive/send limit; at least 96 KiB so valid phone traffic cannot close shared ws preassembly. */
  readonly maxFrameBytes: number
  /** Shared relay write-byte limit, checked against both retained writes and WebSocket bufferedAmount. */
  readonly maxSendQueuedBytes: number
  /** Count limit applied separately to management work, shared relay work/writes and each channel's application requests. */
  readonly maxPendingMessages: number
  /** Queued progress results per live subscription; overflow terminates that subscription with a limit error. */
  readonly maxProgressBuffer: number
  /** Shared relay receive/send token-bucket capacity in bytes, refilled at this many bytes per second. */
  readonly bytesPerSecond: number
  /** Milliseconds from invitation creation until expiry; expiry withdraws its pending candidates. */
  readonly invitationLifetimeMs: number
  /** Milliseconds from channel open through mutual encrypted key confirmation, including local pairing approval. */
  readonly handshakeTimeoutMs: number
  /** Millisecond deadline for WSS establishment and relay authentication, measured from connection creation. */
  readonly connectionTimeoutMs: number
  /** Absolute relay socket lifetime in milliseconds from connection creation. */
  readonly maxConnectionLifetimeMs: number
  /** Milliseconds without rate-admitted relay receive/send traffic before the shared socket retires. */
  readonly idleTimeoutMs: number
  /** Initial retry delay in milliseconds within a reconnect burst; subsequent delays double up to reconnectMaxMs. */
  readonly reconnectInitialMs: number
  /** Maximum within-burst retry delay and the pause between reconnect bursts, in milliseconds. */
  readonly reconnectMaxMs: number
  /** Attempts per backoff burst; bursts repeat after reconnectMaxMs until the Host owner retires. */
  readonly reconnectAttempts: number
}

/** Omitted origin disables the optional product without creating keys or sockets. */
export interface Config {
  /** Canonical public HTTPS relay origin, pinned in stored identity; omission disables the feature. */
  readonly httpsOrigin?: string
  /** Complete explicit limits, required with httpsOrigin and rejected without it; no defaults are supplied. */
  readonly budgets?: HostBudgets | undefined
}

const positive = () => z.number().step(1).min(1).max(2_147_483_647).required()
const application = z.object({
  maxRequestBytes: positive(), maxResultBytes: positive(), maxTextBytes: positive(), maxTitleBytes: positive(),
  maxRows: positive(), maxSessions: positive(), maxSubscriptionsPerGrant: positive(),
  maxPendingSubmissionsPerGrant: positive(), readTimeoutMs: positive(), subscriptionLifetimeMs: positive(),
}).required()

/** Loader schema accepts only explicit positive integer budgets. */
export const Config: z<Config> = z.object({
  httpsOrigin: z.string(),
  budgets: z.union([z.const(undefined), z.object({
    channel: z.object({
      maxQueuedSendBytes: positive(), maxQueuedReceiveBytes: positive(),
      maxPendingSends: positive(), maxPendingReceives: positive(), sendTimeoutMs: positive(),
    }).required(),
    application, maxChannels: positive(), maxChannelAttempts: positive(), maxCandidates: positive().max(64),
    maxGrants: positive().max(64), maxRecordBytes: positive(),
    maxFrameBytes: positive().min(MAX_NORMALIZED_RELAY_FRAME_BYTES).max(262_144), maxSendQueuedBytes: positive(),
    maxPendingMessages: positive(), maxProgressBuffer: positive(), bytesPerSecond: positive(),
    invitationLifetimeMs: positive(), handshakeTimeoutMs: positive(), connectionTimeoutMs: positive(),
    maxConnectionLifetimeMs: positive(), idleTimeoutMs: positive(), reconnectInitialMs: positive(),
    reconnectMaxMs: positive(), reconnectAttempts: positive(),
  })]),
})

/**
 * Resolve the optional feature before acquiring ownership or credentials.
 * @param config - Untrusted deployment configuration.
 * @returns Disabled or fully validated deployment parameters; invalid present configuration throws.
 */
export function resolveConfig(config: Config): { readonly origin: HttpsOrigin; readonly budgets: HostBudgets } | undefined {
  if (config.httpsOrigin === undefined) {
    if (config.budgets !== undefined) throw new Error('companion-host: budgets require httpsOrigin')
    return undefined
  }
  const origin = parseHttpsOrigin(config.httpsOrigin)
  const budgets = config.budgets
  if (budgets === undefined) throw new Error('companion-host: configured origin requires all budgets')
  for (const [name, value] of Object.entries(budgets)) {
    if (name === 'application' || name === 'channel') continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new Error(`companion-host: invalid ${name}`)
    }
  }
  const checked = parseApplicationBudget(budgets.application)
  const channel = parseChannelBudget(budgets.channel)
  if (budgets.maxGrants > 64 || budgets.maxCandidates > 64
    || budgets.maxCandidates > budgets.maxChannels || budgets.maxChannels > budgets.maxChannelAttempts
    || budgets.maxFrameBytes > budgets.maxSendQueuedBytes || budgets.maxFrameBytes < checked.maxResultBytes * 2 + 2048
    || budgets.maxFrameBytes < MAX_NORMALIZED_RELAY_FRAME_BYTES
    || budgets.maxFrameBytes > 262_144 || budgets.maxRecordBytes > 1_048_576
    || budgets.reconnectInitialMs > budgets.reconnectMaxMs || budgets.connectionTimeoutMs > budgets.maxConnectionLifetimeMs
    || budgets.handshakeTimeoutMs > budgets.maxConnectionLifetimeMs) {
    throw new Error('companion-host: inconsistent budgets')
  }
  return { origin, budgets: Object.freeze({ ...budgets, application: checked, channel }) }
}
