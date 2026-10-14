/** Explicit deployment budgets; no deployment-varying value has an implicit default. */
import z from '@deepseek-ai/schemastery'
import { parseHttpsOrigin } from '@deepseek-ai/dsh-companion-protocol'

/** Relay deployment identity and admission, retention, byte and time budgets. */
export interface Config {
  /** Canonical public HTTPS origin; the managed reverse proxy owns TLS. */
  httpsOrigin: string
  /** Total admitted sockets, including anonymous sockets. */
  maxConnections: number
  /** Admitted sockets from one transport-source IP. */
  maxConnectionsPerIp: number
  /** Global sockets awaiting registration or identity-key proof. */
  maxPending: number
  /** Sockets awaiting registration or identity-key proof from one transport-source IP. */
  maxPendingPerIp: number
  /** Global PC sockets, including pending identities. */
  maxRoutes: number
  /** PC sockets from one transport-source IP, including pending identities. */
  maxRoutesPerIp: number
  /** Global phone sockets, including pending identities. */
  maxPhones: number
  /** Phone sockets from one transport-source IP, including pending identities. */
  maxPhonesPerIp: number
  /** Non-stopping phones targeting one PC, including phones awaiting identity-key proof. */
  maxPhonesPerPc: number
  /** Maximum retained IP buckets, including recently disconnected anonymous clients. */
  maxIpBuckets: number
  /** Maximum complete UTF-8 JSON frame bytes; at most 2147483647 for ws preassembly enforcement. */
  maxFrameBytes: number
  /** In-flight send-byte limit per socket, also checked against WebSocket bufferedAmount. */
  maxOutboundQueueBytes: number
  /** In-flight send bytes per channel direction; saturation retires the phone, not its shared PC socket. */
  maxChannelQueueBytes: number
  /** Global receive/send token-bucket capacity in bytes and refill rate in bytes per second. */
  bytesPerSecond: number
  /** Receive/send token-bucket capacity and bytes-per-second refill rate for one transport-source IP. */
  bytesPerSecondPerIp: number
  /** Receive/send token-bucket capacity and bytes-per-second refill rate for one socket. */
  bytesPerSecondPerSocket: number
  /** Global upgrade-attempt token capacity, refilled over upgradeWindowMs; charged before header and admission checks. */
  upgradesPerWindow: number
  /** Upgrade-attempt token capacity for one transport-source IP, refilled over upgradeWindowMs. */
  upgradesPerWindowPerIp: number
  /** Milliseconds to refill an empty upgrade token bucket to its configured capacity. */
  upgradeWindowMs: number
  /** Milliseconds since the last upgrade attempt or disconnect before a socket-free IP bucket expires. */
  ipBucketTtlMs: number
  /** Milliseconds from socket admission to completion of registration and identity-key proof. */
  registrationTimeoutMs: number
  /** Milliseconds from challenge creation to receipt of its identity-key proof, also bounded by registrationTimeoutMs. */
  challengeTimeoutMs: number
  /** Separate millisecond limits after phone authentication for hello and after channel creation for PC welcome. */
  channelHandshakeTimeoutMs: number
  /** Milliseconds without accepted inbound JSON before a socket expires; native ping/pong does not extend it. */
  idleTimeoutMs: number
  /** Absolute socket lifetime in milliseconds from admission, regardless of activity. */
  maxConnectionLifetimeMs: number
  /** Millisecond interval for retiring expired sockets and removing inactive IP buckets. */
  sweepIntervalMs: number
}

const positive = () => z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required()

/** Loader validation requires every deployment budget and a canonical HTTPS origin. */
export const Config: z<Config> = z.object({
  httpsOrigin: z.transform(z.string().required(), value => parseHttpsOrigin(value)),
  maxConnections: positive(), maxConnectionsPerIp: positive(),
  maxPending: positive(), maxPendingPerIp: positive(),
  maxRoutes: positive(), maxRoutesPerIp: positive(),
  maxPhones: positive(), maxPhonesPerIp: positive(), maxPhonesPerPc: positive(),
  maxIpBuckets: positive(), maxFrameBytes: z.number().step(1).min(1).max(2_147_483_647).required(),
  maxOutboundQueueBytes: positive(), maxChannelQueueBytes: positive(),
  bytesPerSecond: positive(), bytesPerSecondPerIp: positive(), bytesPerSecondPerSocket: positive(),
  upgradesPerWindow: positive(), upgradesPerWindowPerIp: positive(), upgradeWindowMs: positive(),
  ipBucketTtlMs: positive(), registrationTimeoutMs: positive(), challengeTimeoutMs: positive(),
  channelHandshakeTimeoutMs: positive(), idleTimeoutMs: positive(), maxConnectionLifetimeMs: positive(),
  sweepIntervalMs: positive(),
})

/**
 * Validate cross-field constraints before routes or sockets exist.
 * @param config - Loader-validated configuration.
 */
export function validateConfig(config: Config): void {
  parseHttpsOrigin(config.httpsOrigin)
  // Native timers clamp larger intervals to 1 ms; reject instead of changing deployment policy.
  for (const [field, value] of Object.entries(config)) {
    if (field === 'httpsOrigin') continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1
      || ((field.endsWith('Ms') || field === 'maxFrameBytes') && value > 2_147_483_647)) throw new Error(`companion-relay: invalid ${field}`)
  }
  const pairs: readonly [number, number][] = [
    [config.maxConnectionsPerIp, config.maxConnections], [config.maxPendingPerIp, config.maxPending],
    [config.maxRoutesPerIp, config.maxRoutes], [config.maxPhonesPerIp, config.maxPhones],
    [config.maxPhonesPerPc, config.maxPhones], [config.maxPending, config.maxConnections],
    [config.maxRoutes, config.maxConnections], [config.maxPhones, config.maxConnections],
    [config.bytesPerSecondPerSocket, config.bytesPerSecondPerIp],
    [config.bytesPerSecondPerIp, config.bytesPerSecond],
    [config.upgradesPerWindowPerIp, config.upgradesPerWindow],
    [config.maxChannelQueueBytes, config.maxOutboundQueueBytes],
    [config.maxFrameBytes, config.maxChannelQueueBytes],
    [config.challengeTimeoutMs, config.registrationTimeoutMs],
    [config.registrationTimeoutMs, config.maxConnectionLifetimeMs],
    [config.channelHandshakeTimeoutMs, config.maxConnectionLifetimeMs],
    [config.sweepIntervalMs, config.challengeTimeoutMs],
    [config.sweepIntervalMs, config.idleTimeoutMs],
  ]
  if (pairs.some(([part, whole]) => part > whole)) throw new Error('companion-relay: inconsistent deployment budgets')
}
