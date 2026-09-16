/**
 * Public vocabulary for Harnessy's Command Code delegation feature: the lane
 * policy a user edits, the execution parameters one lane resolves to, and the
 * bounded health and catalog facts the Settings page reads.
 *
 * Lane policy is user data, so every resolved value here carries its own
 * provenance: `CommandCodeLaneSetting` is what is stored, and
 * {@link ResolvedCommandCodeLane} is what one workspace actually runs.
 *
 * @module @deepseek-ai/dsh-subagent-commandcode/types
 */

/** Reasoning effort levels the Command Code CLI accepts beyond its model default. */
export const COMMAND_CODE_EFFORTS = ['default', 'low', 'medium', 'high'] as const

/** One lane's reasoning-effort selection. */
export type CommandCodeEffort = typeof COMMAND_CODE_EFFORTS[number]

/** How much access one delegated run gets. */
export const COMMAND_CODE_ACCESS_MODES = ['read-only', 'full-access'] as const

/** One lane's access level. */
export type CommandCodeAccess = typeof COMMAND_CODE_ACCESS_MODES[number]

/**
 * Coarse activity categories reported while a run is in flight. They name what
 * the delegated agent is doing without carrying tool inputs, commands, file
 * contents, or any other Command Code transcript detail.
 */
export const COMMAND_CODE_ACTIVITIES = ['thinking', 'reading', 'editing', 'command', 'finalizing'] as const

/** One coarse activity category. */
export type CommandCodeActivity = typeof COMMAND_CODE_ACTIVITIES[number]

/** One lane definition as stored in the user's settings document. */
export interface CommandCodeLaneSetting {
  /** Stable lane id the model names; immutable across renames. */
  id: string
  /** Display name shown in Settings and in background job labels. */
  name: string
  /** One-line purpose the lane discovery tool reports. */
  purpose: string
  /** Instructions prepended to every delegated brief; empty adds none. */
  instructions: string
  /** Exact Command Code model id. */
  model: string
  /** Reasoning effort requested from the CLI; `default` omits the flag. */
  effort: CommandCodeEffort
  /** Access level; `full-access` runs the CLI with `--yolo`. */
  access: CommandCodeAccess
  /** Whether the lane is offered to the model and accepted for delegation. */
  enabled: boolean
}

/** Fields one project may override on a global lane; omitted fields are inherited. */
export type CommandCodeLaneOverride = Partial<Omit<CommandCodeLaneSetting, 'id'>>

/** One workspace's overrides, keyed by the global lane id they patch. */
export interface CommandCodeProjectOverrideSetting {
  /** Global lane id to the field patch replacing that lane's global values. */
  lanes: Record<string, CommandCodeLaneOverride>
}

/** The complete Command Code delegation settings section. */
export interface CommandCodeDelegationSettings {
  /** Maximum Command Code runs in flight across foreground and background calls. */
  maxConcurrentRuns: number
  /** Wall-clock bound in milliseconds for one delegated run. */
  timeoutMs: number
  /** Conversation-turn bound passed to the CLI's `--max-turns`. */
  maxTurns: number
  /** Global lane definitions. */
  lanes: CommandCodeLaneSetting[]
  /** Per-workspace lane overrides keyed by canonical workspace path. */
  projects: Record<string, CommandCodeProjectOverrideSetting>
}

/** Per-field provenance of one resolved lane, so an editor can offer a reset. */
export interface CommandCodeLaneOverrides {
  name: boolean
  purpose: boolean
  instructions: boolean
  model: boolean
  effort: boolean
  access: boolean
  enabled: boolean
}

/** One lane after global and project layers are applied. */
export interface ResolvedCommandCodeLane extends CommandCodeLaneSetting {
  /** Which fields the current workspace overrides rather than inherits. */
  overrides: CommandCodeLaneOverrides
}

/** What the model and Settings read for one workspace. */
export interface CommandCodeDelegationView {
  /** Canonical workspace key the resolved lanes were read for; null without a workspace. */
  workspaceKey: string | null
  /** Effective concurrency cap, read through on every run. */
  maxConcurrentRuns: number
  /** Effective timeout, read through on every run. */
  timeoutMs: number
  /** Effective turn cap, read through on every run. */
  maxTurns: number
  /** Every stored lane with this workspace's overrides applied, including disabled lanes. */
  lanes: ResolvedCommandCodeLane[]
}

/** The directory entry the lane discovery tool reports, and nothing more. */
export interface CommandCodeLaneSummary {
  id: string
  name: string
  purpose: string
  model: string
  effort: CommandCodeEffort
  access: CommandCodeAccess
}

/**
 * Facts one delegated run needs after lane resolution. The model never sees or
 * supplies these; a lane the user disabled, or a field the user changed, is
 * read through at call time.
 */
export interface CommandCodeRunSpec {
  /** Lane the run belongs to, for the background job label only. */
  readonly laneName: string
  /** Exact Command Code model id, or omitted to let the CLI run on its own configured default. */
  readonly model?: string
  /** Reasoning effort; `default` omits the CLI flag. */
  readonly effort: CommandCodeEffort
  /** Access level selecting `--yolo` or `--permission-mode plan`. */
  readonly access: CommandCodeAccess
  /** Turn cap passed to `--max-turns`. */
  readonly maxTurns: number
  /** Wall-clock bound for the run. */
  readonly timeoutMs: number
}

/** Installation and authentication state of the user's own Command Code CLI. */
export interface CommandCodeHealth {
  /** Executable name this build looks for. */
  readonly command: string
  /** Whether the executable was found and answered `--version`. */
  readonly installed: boolean
  /** Reported version, when the executable answered. */
  readonly version?: string
  /** Whether `status` reported an authenticated account. */
  readonly authenticated: boolean
  /** Bounded, product-owned explanation for a missing or unauthenticated CLI. */
  readonly detail?: string
}

/** One model advertised by the local CLI's catalog. */
export interface CommandCodeModelSummary {
  /** Exact model id accepted by `--model`. */
  readonly id: string
  /** Human-readable description the catalog printed next to the id. */
  readonly description: string
}

/** The local CLI's advisory model catalog. */
export interface CommandCodeCatalog {
  /** Catalog rows; empty when the catalog could not be read. */
  readonly models: CommandCodeModelSummary[]
  /** Bounded explanation when the catalog is empty or incomplete. */
  readonly detail?: string
}

/** Why one delegated run could not produce a final answer. */
export type CommandCodeFailureCategory =
  | 'not-installed'
  | 'not-authenticated'
  | 'access-denied'
  | 'rate-limited'
  | 'network'
  | 'service'
  | 'credits'
  | 'max-turns'
  | 'no-answer'
  | 'timeout'
  | 'cancelled'
  | 'protocol'
  | 'spawn'
  | 'teardown'
  | 'unknown'
