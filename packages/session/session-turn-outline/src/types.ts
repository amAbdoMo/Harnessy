/**
 * Pure types of the turn-outline domain: the ONE home of the `turnOutline`
 * projection-key declaration, free of this package's host-side value imports
 * (zod, the projection definition). Host consumers import `./types`; client
 * aggregates import `./client`, which re-exports this module.
 *
 * @module @deepseek-ai/dsh-session-turn-outline/types
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'

export {}

/** User-facing outcome of a settled turn. */
export type TurnOutlineOutcome = 'completed' | 'stopped' | 'failed'

/** Latest started turn and its terminal outcome; null before the first turn. */
export type TurnOutcomeProjection = {
  readonly turn: number
  /** Absent until the latest started turn settles. */
  readonly outcome?: TurnOutlineOutcome | undefined
} | null

/** One started turn's outline facts, independent of what a client has paged in. */
export interface TurnOutlineEntry {
  /** Host-assigned turn number (the `turn/start` payload). */
  readonly turn: number
  /** The turn's `turn/start` event seq — paging a window back through this seq loads the whole turn. */
  readonly seq: SessionSeq
  /** Bounded first-human-prompt preview (one rail-card line); `''` until an eligible prompt lands. */
  readonly prompt: string
  /** Bounded final-response preview (up to three rail-card lines); `''` until the turn ends with assistant text. */
  readonly response: string
  /** Terminal outcome; absent while this turn is still open. */
  readonly outcome?: TurnOutlineOutcome | undefined
}

/**
 * Fold state: the served entries plus the open turn's response draft. The
 * draft buffers the newest text-bearing assistant message until `turn/end`
 * commits it, and the wire view projects only `turns` — draft-only applies
 * keep that array's identity, so the change feed stays quiet between turn
 * boundaries.
 */
export interface TurnOutlineState {
  /** Started turns in ascending turn order. */
  readonly turns: readonly TurnOutlineEntry[]
  /** Newest text-bearing assistant preview of the open turn; `''` outside one. */
  readonly draft: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Constant-size latest-turn state for lifecycle notifications. */
    turnOutcome: TurnOutcomeProjection
    /** Whole-log turn outline fold state (entries plus the open turn's response draft). */
    turnOutline: TurnOutlineState
  }
  interface SessionProjectionMap {
    /** Latest started turn and recorded outcome, included in list summaries. */
    turnOutcome: TurnOutcomeProjection
    /**
     * Every started turn with its `turn/start` seq and bounded previews,
     * strictly increasing by turn; see {@link TurnOutlineEntry}. Excluded from
     * Session summary payloads: the outline grows with the whole log and no
     * list row renders it.
     */
    turnOutline: SessionProjectionSummaryExcluded<readonly TurnOutlineEntry[]>
  }
}
