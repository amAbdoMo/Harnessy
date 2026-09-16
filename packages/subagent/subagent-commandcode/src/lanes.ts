/**
 * Lane policy: the built-in lane defaults, the canonical workspace key that
 * project overrides are stored under, and the resolution of the global and
 * project layers into the one directory a run actually uses.
 *
 * @module @deepseek-ai/dsh-subagent-commandcode/lanes
 */

import { resolve } from 'node:path'
import type {
  CommandCodeDelegationSettings,
  CommandCodeLaneOverride,
  CommandCodeLaneSetting,
  CommandCodeLaneSummary,
  ResolvedCommandCodeLane,
} from './types.ts'

/** Lane ids are argv-safe tokens; the model names one verbatim. */
export const COMMAND_CODE_LANE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u

/** Model every built-in lane starts on. */
export const DEFAULT_COMMAND_CODE_MODEL = 'deepseek/deepseek-v4.1-flash'

/** Built-in lanes a fresh Harnessy profile offers. A user may change or remove any of them. */
export const DEFAULT_COMMAND_CODE_LANES: CommandCodeLaneSetting[] = [
  {
    id: 'code',
    name: 'Code',
    purpose: 'Implement a scoped change in this workspace.',
    instructions: '',
    model: DEFAULT_COMMAND_CODE_MODEL,
    effort: 'default',
    access: 'full-access',
    enabled: true,
  },
  {
    id: 'review',
    name: 'Review',
    purpose: 'Review existing changes and report defects, risks, and gaps.',
    instructions: '',
    model: DEFAULT_COMMAND_CODE_MODEL,
    effort: 'default',
    access: 'read-only',
    enabled: true,
  },
  {
    id: 'tests',
    name: 'Tests',
    purpose: 'Add or repair automated tests for a scoped behavior.',
    instructions: '',
    model: DEFAULT_COMMAND_CODE_MODEL,
    effort: 'default',
    access: 'full-access',
    enabled: true,
  },
  {
    id: 'docs',
    name: 'Docs',
    purpose: 'Write or update documentation for a scoped subject.',
    instructions: '',
    model: DEFAULT_COMMAND_CODE_MODEL,
    effort: 'default',
    access: 'full-access',
    enabled: true,
  },
  {
    id: 'research',
    name: 'Research',
    purpose: 'Investigate a question in this workspace and report findings.',
    instructions: '',
    model: DEFAULT_COMMAND_CODE_MODEL,
    effort: 'default',
    access: 'read-only',
    enabled: true,
  },
  {
    id: 'architecture',
    name: 'Architecture',
    purpose: 'Analyze design trade-offs and propose a structure.',
    instructions: '',
    model: DEFAULT_COMMAND_CODE_MODEL,
    effort: 'default',
    access: 'read-only',
    enabled: true,
  },
]

/** Fields a project override may replace on a global lane, in editor order. */
export const COMMAND_CODE_LANE_OVERRIDE_FIELDS = [
  'name',
  'purpose',
  'instructions',
  'model',
  'effort',
  'access',
  'enabled',
] as const satisfies readonly (keyof CommandCodeLaneOverride)[]

/**
 * Canonicalize one workspace path into the settings key its overrides live
 * under, so two spellings of the same directory share one entry.
 * @param workspace - absolute or relative workspace directory.
 * @returns the canonical key.
 */
export function canonicalWorkspaceKey(workspace: string): string {
  const absolute = resolve(workspace)
  // Windows filesystems are case-insensitive, so two casings of one directory
  // must not become two override entries; POSIX paths stay verbatim.
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * Apply one workspace's override layer to the global lanes. Omitted fields are
 * inherited, so an override records only what the user actually changed, and a
 * stale key naming a lane that no longer exists contributes nothing.
 * @param settings - the complete settings section.
 * @param workspaceKey - canonical workspace key, or null without a workspace.
 * @returns every stored lane with its per-field provenance.
 */
export function resolveLanes(
  settings: CommandCodeDelegationSettings,
  workspaceKey: string | null,
): ResolvedCommandCodeLane[] {
  const project = workspaceKey === null ? undefined : settings.projects[workspaceKey]
  return settings.lanes.map((lane) => {
    const override = project?.lanes[lane.id]
    const value = (field: keyof CommandCodeLaneOverride): boolean =>
      override !== undefined && override[field] !== undefined
    return {
      id: lane.id,
      name: override?.name ?? lane.name,
      purpose: override?.purpose ?? lane.purpose,
      instructions: override?.instructions ?? lane.instructions,
      model: override?.model ?? lane.model,
      effort: override?.effort ?? lane.effort,
      access: override?.access ?? lane.access,
      enabled: override?.enabled ?? lane.enabled,
      overrides: {
        name: value('name'),
        purpose: value('purpose'),
        instructions: value('instructions'),
        model: value('model'),
        effort: value('effort'),
        access: value('access'),
        enabled: value('enabled'),
      },
    }
  })
}

/**
 * Project resolved lanes into the directory the model reads.
 * @param lanes - resolved lanes for the current workspace.
 * @returns enabled lanes only, with instruction text and storage detail removed.
 */
export function laneDirectory(lanes: readonly ResolvedCommandCodeLane[]): CommandCodeLaneSummary[] {
  return lanes
    .filter(lane => lane.enabled)
    .map(lane => ({
      id: lane.id,
      name: lane.name,
      purpose: lane.purpose,
      model: lane.model,
      effort: lane.effort,
      access: lane.access,
    }))
}

/**
 * Reject a stored lane set the resolver cannot act on. Called from the settings
 * registration so an unusable value fails the write that introduces it rather
 * than the next delegation.
 * @param settings - the section a writer is about to persist.
 * @throws {TypeError} when two lanes share an id, or a model is blank.
 */
export function assertCommandCodeDelegationSettings(settings: CommandCodeDelegationSettings): void {
  const ids = new Set<string>()
  for (const lane of settings.lanes) {
    if (ids.has(lane.id)) throw new TypeError(`commandcode-delegation: duplicate lane id "${lane.id}"`)
    ids.add(lane.id)
    // A model is passed to the CLI verbatim, so whitespace is unusable rather
    // than an acceptable value to discover at delegation time.
    if (lane.model.trim().length === 0) {
      throw new TypeError(`commandcode-delegation: lane "${lane.id}" needs a non-blank model`)
    }
  }
  for (const [workspace, project] of Object.entries(settings.projects)) {
    if (workspace.length === 0) {
      throw new TypeError('commandcode-delegation: a project override key must not be empty')
    }
    for (const [laneId, lane] of Object.entries(project.lanes)) {
      if (lane.model !== undefined && lane.model.trim().length === 0) {
        throw new TypeError(
          `commandcode-delegation: the override for lane "${laneId}" needs a non-blank model`,
        )
      }
    }
  }
}

/**
 * Build the brief one delegated run receives: the lane's own instructions,
 * then the caller's self-contained task. Lane instructions are policy, so they
 * are read from the resolved lane rather than supplied by the model.
 * @param instructions - the lane's configured instructions, when it has any.
 * @param task - the self-contained task the model supplied.
 * @returns the exact text written to the CLI's stdin.
 */
export function composeCommandCodeBrief(instructions: string, task: string): string {
  const trimmed = task.trim()
  if (trimmed.length === 0) throw new TypeError('commandcode_delegate: the task must not be empty')
  const guidance = instructions.trim()
  return guidance.length === 0 ? trimmed : `${guidance}\n\n${trimmed}`
}
