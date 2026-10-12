/** Explicit optional-product deployment policy; no synthesized relay origin or budget defaults. */
import z from '@deepseek-ai/schemastery'
import { MAX_NORMALIZED_RELAY_FRAME_BYTES, parseApplicationBudget, parseChannelBudget, parseHttpsOrigin } from '@deepseek-ai/dsh-companion-protocol'
import type { ApplicationBudget, ChannelBudget, HttpsOrigin } from '@deepseek-ai/dsh-companion-protocol'

/** All limits are required when an actual origin is configured. */
export interface HostBudgets {
  readonly application: ApplicationBudget
  /** Cryptographic send/receive queue limits and transport write deadline. */
  readonly channel: ChannelBudget
  readonly maxChannels: number
  readonly maxChannelAttempts: number
  readonly maxCandidates: number
  readonly maxGrants: number
  readonly maxRecordBytes: number
  /** Complete relay JSON receive/send limit; at least 96 KiB so valid phone traffic cannot close shared ws preassembly. */
  readonly maxFrameBytes: number
  readonly maxSendQueuedBytes: number
  readonly maxPendingMessages: number
  readonly maxProgressBuffer: number
  readonly bytesPerSecond: number
  readonly invitationLifetimeMs: number
  readonly handshakeTimeoutMs: number
  readonly connectionTimeoutMs: number
  readonly maxConnectionLifetimeMs: number
  readonly idleTimeoutMs: number
  readonly reconnectInitialMs: number
  readonly reconnectMaxMs: number
  /** Attempts per backoff burst; bursts repeat after reconnectMaxMs until the Host owner retires. */
  readonly reconnectAttempts: number
}

/** Omitted origin disables the optional product without creating keys or sockets. */
export interface Config {
  readonly httpsOrigin?: string
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
