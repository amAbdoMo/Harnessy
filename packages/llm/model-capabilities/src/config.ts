/**
 * The `model-capabilities` settings section: whether the public metadata layer
 * runs, when it refreshes, and how long a fetch stays fresh.
 *
 * The section resolves under the composition entry as its base and the user's
 * `settings.yaml` section over it, so a deployment states a default and a user
 * overrides it without a migration.
 *
 * @module @deepseek-ai/dsh-model-capabilities/config
 */

import z from '@deepseek-ai/schemastery'
import type { PublicMetadataRefreshMode } from './store.ts'

/** Settings namespace this package owns. */
export const MODEL_CAPABILITIES_NAMESPACE = 'model-capabilities'

/**
 * Largest accepted cache TTL, in milliseconds: one year.
 *
 * A TTL is a refresh cadence, not a duration to express in units nobody reads,
 * so the accepted range is bounded to what a refresh policy could mean.
 */
export const MAX_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000

/** Units a configured `cacheTtl` may state, in milliseconds. */
const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
}

/** One configured duration: a positive integer followed by a unit. */
const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/

/**
 * Parse one configured duration into milliseconds.
 *
 * The repository states every other interval as a `…Ms` number, but a refresh
 * cadence is configured in days and a bare millisecond count there is a hazard,
 * so this section accepts the compact `7d` form. The grammar is deliberately
 * narrow — a positive integer and one unit, no fractions, no compounds, no
 * whitespace — so there is exactly one reading of any accepted value.
 * @param value - the configured text, e.g. `7d`.
 * @returns milliseconds.
 * @throws When the text is not a duration this grammar accepts, or is out of range.
 */
export function parseCacheTtl(value: string): number {
  const match = DURATION_PATTERN.exec(value)
  if (match === null) {
    throw new Error(`cacheTtl ${JSON.stringify(value)} must be a positive integer with one unit: ms, s, m, h, or d`)
  }
  const amount = Number(match[1])
  const milliseconds = amount * (DURATION_UNITS[match[2] as string] as number)
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > MAX_CACHE_TTL_MS) {
    throw new Error(`cacheTtl ${JSON.stringify(value)} must be greater than 0 and at most 365d`)
  }
  return milliseconds
}

/**
 * The `publicMetadata` section as configuration states it.
 *
 * `cacheTtl` is a string so a deployment can write `7d`; resolution converts it
 * once, so no consumer parses it again.
 */
export interface PublicMetadataConfig {
  /**
   * Whether the public metadata layer runs at all. `false` disables every tier
   * — live, cache, and bundled — so no public claim reaches a consumer and no
   * request is made.
   */
  readonly enabled: boolean
  /**
   * When this deployment fetches. `auto` refreshes what is missing or expired,
   * `manual` never fetches on its own, and `never` refuses network access.
   */
  readonly refresh: PublicMetadataRefreshMode
  /** How long a fetched catalog stays fresh, e.g. `7d`. */
  readonly cacheTtl: string
}

/** The whole section, which is `modelCapabilities` in a settings document. */
export interface ModelCapabilitiesConfig {
  /** The public metadata layer's configuration. */
  readonly publicMetadata: PublicMetadataConfig
}

/**
 * Composition-entry defaults: conservative in every direction that removes
 * surprise. Public metadata is on because the bundled snapshot makes it useful
 * offline, it refreshes in the background on the cadence the Agent Note chose,
 * and a week is long enough that a deployment makes one request per database
 * per week.
 */
export const MODEL_CAPABILITIES_DEFAULTS: ModelCapabilitiesConfig = {
  publicMetadata: { enabled: true, refresh: 'auto', cacheTtl: '7d' },
}

/** The section schema. */
export const ModelCapabilitiesConfigSchema: z<ModelCapabilitiesConfig> = z.object({
  publicMetadata: z.object({
    enabled: z.boolean().default(MODEL_CAPABILITIES_DEFAULTS.publicMetadata.enabled),
    refresh: z.union(['auto', 'manual', 'never']).default(MODEL_CAPABILITIES_DEFAULTS.publicMetadata.refresh),
    cacheTtl: z.string().default(MODEL_CAPABILITIES_DEFAULTS.publicMetadata.cacheTtl),
  }).default(MODEL_CAPABILITIES_DEFAULTS.publicMetadata),
})

/**
 * Resolve the configured section into the policy the store reads.
 *
 * Validating here rather than at the point of use is what makes a malformed TTL
 * a refused write instead of a refresh that silently never runs.
 * @param config - the resolved section.
 * @returns the policy fields, with the TTL converted once.
 * @throws When `cacheTtl` is not a duration this grammar accepts.
 */
export function resolvePolicy(config: ModelCapabilitiesConfig): {
  readonly enabled: boolean
  readonly refresh: PublicMetadataRefreshMode
  readonly cacheTtlMs: number
} {
  return {
    enabled: config.publicMetadata.enabled,
    refresh: config.publicMetadata.refresh,
    cacheTtlMs: parseCacheTtl(config.publicMetadata.cacheTtl),
  }
}

/**
 * Assert that a resolved section can be served, for the settings seam's
 * write-time validation hook.
 * @param config - the resolved section.
 * @throws When the section states a duration this build cannot read.
 */
export function assertServiceableConfig(config: ModelCapabilitiesConfig): void {
  parseCacheTtl(config.publicMetadata.cacheTtl)
}
