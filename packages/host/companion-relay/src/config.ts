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
  /** Anonymous sockets globally and per transport-source IP. */
  maxPending: number
  maxPendingPerIp: number
  /** PC sockets, including pending identities, globally and per IP. */
  maxRoutes: number
  maxRoutesPerIp: number
  /** Phone sockets, including pending identities, globally, per IP and per PC. */
  maxPhones: number
  maxPhonesPerIp: number
  maxPhonesPerPc: number
  /** Maximum retained IP buckets, including recently disconnected anonymous clients. */
  maxIpBuckets: number
  /** Maximum complete UTF-8 JSON frame bytes; at most 2147483647 for ws preassembly enforcement. */
  maxFrameBytes: number
  /** Maximum in-flight send bytes per socket and per channel direction. */
  maxOutboundQueueBytes: number
  maxChannelQueueBytes: number
  /** Token-bucket byte capacities and refill rates per second. */
  bytesPerSecond: number
  bytesPerSecondPerIp: number
  bytesPerSecondPerSocket: number
  /** Upgrade token-bucket capacities; refill over upgradeWindowMs. */
  upgradesPerWindow: number
  upgradesPerWindowPerIp: number
  upgradeWindowMs: number
  /** Inactive IP rate buckets expire after this interval. */
  ipBucketTtlMs: number
  /** Registration, challenge, channel handshake, inactivity and absolute lifetime deadlines. */
  registrationTimeoutMs: number
  challengeTimeoutMs: number
  channelHandshakeTimeoutMs: number
  idleTimeoutMs: number
  maxConnectionLifetimeMs: number
  /** Deadline and IP expiry scan interval. */
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
