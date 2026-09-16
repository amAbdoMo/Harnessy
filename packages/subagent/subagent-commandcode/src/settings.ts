/**
 * The live `commandcode-delegation` settings section: global lane definitions,
 * per-workspace lane overrides, and the three run bounds. Everything here is
 * read through on every delegation, so a saved edit applies to the next run
 * without a restart.
 *
 * @module @deepseek-ai/dsh-subagent-commandcode/settings
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertCommandCodeDelegationSettings,
  canonicalWorkspaceKey,
  DEFAULT_COMMAND_CODE_LANES,
  resolveLanes,
} from './lanes.ts'
import { COMMAND_CODE_ACCESS_MODES, COMMAND_CODE_EFFORTS } from './types.ts'
import type {
  CommandCodeDelegationSettings,
  CommandCodeDelegationView,
  CommandCodeLaneOverride,
  CommandCodeLaneSetting,
  ResolvedCommandCodeLane,
} from './types.ts'

/** Settings namespace owning Harnessy's Command Code delegation policy. */
export const COMMAND_CODE_DELEGATION_NAMESPACE = 'commandcode-delegation'

/** Runs allowed in flight when the user changes nothing. */
export const DEFAULT_COMMAND_CODE_MAX_CONCURRENT_RUNS = 2

/** Wall-clock bound for one delegated run when the user changes nothing. */
export const DEFAULT_COMMAND_CODE_TIMEOUT_MS = 3_600_000

/** Turn cap for one delegated run when the user changes nothing. */
export const DEFAULT_COMMAND_CODE_MAX_TURNS = 60

/** Largest concurrency cap the settings schema accepts. */
export const MAX_COMMAND_CODE_CONCURRENT_RUNS = 16

/** Largest turn cap the settings schema accepts. */
export const MAX_COMMAND_CODE_TURNS = 1_000

const laneSchema = z.object({
  id: z.string().required().pattern(/^[a-z][a-z0-9-]{0,39}$/u),
  name: z.string().required(),
  purpose: z.string().required(),
  instructions: z.string().default(''),
  model: z.string().required(),
  effort: z.union([...COMMAND_CODE_EFFORTS]).default('default'),
  access: z.union([...COMMAND_CODE_ACCESS_MODES]).default('read-only'),
  enabled: z.boolean().default(true),
})

// Every field is optional: an override records only what the user changed, and
// omission is what makes the field inherit from the global lane.
const laneOverrideSchema = z.object({
  name: z.string(),
  purpose: z.string(),
  instructions: z.string(),
  model: z.string(),
  effort: z.union([...COMMAND_CODE_EFFORTS]),
  access: z.union([...COMMAND_CODE_ACCESS_MODES]),
  enabled: z.boolean(),
})

/** Schema shared by the Host registration and the settings transport. */
export const CommandCodeDelegationSchema: z<CommandCodeDelegationSettings> = z.object({
  maxConcurrentRuns: z.number().step(1).min(1).max(MAX_COMMAND_CODE_CONCURRENT_RUNS)
    .default(DEFAULT_COMMAND_CODE_MAX_CONCURRENT_RUNS),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_COMMAND_CODE_TIMEOUT_MS),
  maxTurns: z.number().step(1).min(1).max(MAX_COMMAND_CODE_TURNS)
    .default(DEFAULT_COMMAND_CODE_MAX_TURNS),
  lanes: z.array(laneSchema).default(DEFAULT_COMMAND_CODE_LANES),
  projects: z.dict(z.object({ lanes: z.dict(laneOverrideSchema) })).default({}),
})

/**
 * Resolve one workspace's lanes and the three run bounds.
 * @param settings - the complete settings section.
 * @param workspace - the Session's workspace path, or null without one.
 * @returns the resolved lanes with their per-field override provenance.
 */
export function commandCodeDelegationView(
  settings: CommandCodeDelegationSettings,
  workspace: string | null,
): CommandCodeDelegationView {
  const workspaceKey = workspace === null ? null : canonicalWorkspaceKey(workspace)
  return {
    workspaceKey,
    maxConcurrentRuns: settings.maxConcurrentRuns,
    timeoutMs: settings.timeoutMs,
    maxTurns: settings.maxTurns,
    lanes: resolveLanes(settings, workspaceKey),
  }
}

/**
 * Read one enabled lane for the current workspace, or fail loud.
 * @param view - the workspace's resolved delegation view.
 * @param laneId - the lane id the model named.
 * @returns the enabled lane, with its project overrides applied.
 * @throws {Error} when no stored lane has that id, or the lane is disabled.
 */
export function requireEnabledLane(
  view: CommandCodeDelegationView,
  laneId: string,
): ResolvedCommandCodeLane {
  const lane = view.lanes.find(candidate => candidate.id === laneId)
  if (lane === undefined) {
    const known = view.lanes.map(candidate => candidate.id).join(', ')
    throw new Error(
      known.length === 0
        ? `no Command Code lane "${laneId}" exists; no lanes are configured`
        : `no Command Code lane "${laneId}" exists; configured lanes: ${known}`,
    )
  }
  if (!lane.enabled) throw new Error(`Command Code lane "${laneId}" is disabled`)
  if (lane.model.trim().length === 0) {
    throw new Error(`Command Code lane "${laneId}" has no model configured`)
  }
  return lane
}

export type { CommandCodeLaneOverride, CommandCodeLaneSetting }

/**
 * Owner-side validation the schema cannot express.
 * @param value - the section a writer is about to persist.
 */
export function validateCommandCodeDelegation(value: CommandCodeDelegationSettings): void {
  assertCommandCodeDelegationSettings(value)
}
