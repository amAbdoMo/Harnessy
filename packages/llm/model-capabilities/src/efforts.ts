/**
 * Reasoning-effort normalization for claims read out of public model
 * databases.
 *
 * The vocabulary and the level rules are not invented here: they are the ones
 * `@deepseek-ai/dsh-llm` already applies to every capability a source claims
 * (`normalizeDiscoveredReasoning`), so a public claim and a Command Code claim
 * cannot disagree about what counts as a usable set. This module reproduces
 * that normalization because the seam's copy is private, and a consumer of this
 * layer needs the normalized levels before it can build a claim to hand back.
 *
 * @module @deepseek-ai/dsh-model-capabilities/efforts
 */

/**
 * Every harness reasoning-effort level, in escalation order, matching
 * `THINKING_LEVELS` in `@deepseek-ai/dsh-llm-pi-ai`. The `Record` key type is a
 * drift gate: an upstream level addition or removal fails compilation here
 * rather than silently narrowing what public metadata may offer.
 */
const LEVEL_GATE: Record<
  'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  true
> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
}

/** Every level this layer may offer, in escalation order. */
const LEVELS: readonly string[] = Object.keys(LEVEL_GATE)

/** The same levels as a membership test, so an unknown token cannot be read as one. */
const OFFERABLE = new Set<string>(LEVELS)

/**
 * Public spellings that name one of {@link LEVELS}.
 *
 * `none` is a published token meaning the absence of reasoning, which the
 * harness spells `off`; dropping it instead would delete every claim whose list
 * is `none` alone. Any other token is left unaliased and therefore dropped,
 * because inventing a neighbouring level would offer an endpoint a value it
 * never stated.
 */
const ALIASES: Readonly<Record<string, string>> = { none: 'off' }

/** One public claim's normalized levels and the tokens that were dropped. */
export interface NormalizedEfforts {
  /**
   * Levels this claim offers, in escalation order, deduplicated by level. Empty
   * when the claim states no level this build can dispatch, which includes a
   * claim offering `off` alone: not thinking is the parameter's absence, not
   * something a selector can offer.
   */
  readonly levels: readonly string[]
  /** Published tokens whose level this layer cannot dispatch, in publication order. */
  readonly dropped: readonly string[]
}

/**
 * Normalize one published effort list into the harness's level vocabulary.
 *
 * A non-list, a non-string member, and an empty member each contribute nothing
 * rather than failing: this runs over third-party JSON, and one malformed claim
 * must not take the whole database out of service.
 * @param values - the effort list as the database published it.
 * @returns the dispatchable levels, and the tokens that were not.
 */
export function normalizeEfforts(values: unknown): NormalizedEfforts {
  if (!Array.isArray(values)) return { levels: [], dropped: [] }
  const found = new Set<string>()
  const dropped: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue
    const level = ALIASES[value] ?? value
    if (OFFERABLE.has(level)) found.add(level)
    else dropped.push(value)
  }
  const levels = LEVELS.filter(level => found.has(level))
  // A set offering only `off` is not a capability, and a claim publishing an
  // unknown token beside a level it also publishes keeps that level.
  return { levels: levels.some(level => level !== 'off') ? levels : [], dropped }
}

/**
 * Normalize one published default effort.
 * @param value - the default as the database published it.
 * @param levels - the normalized levels the same claim offers.
 * @returns the default when it names one of those levels, otherwise undefined.
 */
export function normalizeDefaultEffort(value: unknown, levels: readonly string[]): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const level = ALIASES[value] ?? value
  return levels.includes(level) ? level : undefined
}
