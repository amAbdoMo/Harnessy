/**
 * Browser-safe view of the `commandcode-delegation` settings section.
 *
 * This module imports nothing from the Host half, so the browser bundle inlines
 * it whole; the shared namespace name and section shape are the two facts the
 * Client and the Host registration must agree on.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-commandcode/contract
 */

/** Settings namespace owned by Harnessy's Command Code delegation plugin. */
export const COMMAND_CODE_DELEGATION_NAMESPACE = 'commandcode-delegation'

/**
 * Model every lane starts on, mirroring the Host's default. The editor uses it
 * to create a lane before this browser has read the CLI's advisory catalog, so
 * a new lane is usable without one.
 */
export const DEFAULT_COMMAND_CODE_MODEL = 'deepseek/deepseek-v4.1-flash'

/** Reasoning effort levels the Command Code CLI accepts beyond its model default. */
export const COMMAND_CODE_EFFORTS = ['default', 'low', 'medium', 'high'] as const

/** One lane's reasoning-effort selection. */
export type CommandCodeEffort = typeof COMMAND_CODE_EFFORTS[number]

/** How much access one delegated run gets. */
export const COMMAND_CODE_ACCESS_MODES = ['read-only', 'full-access'] as const

/** One lane's access level. */
export type CommandCodeAccess = typeof COMMAND_CODE_ACCESS_MODES[number]

/** One stored lane. */
export interface CommandCodeLaneSetting {
  id: string
  name: string
  purpose: string
  instructions: string
  model: string
  effort: CommandCodeEffort
  access: CommandCodeAccess
  enabled: boolean
}

/** Fields a workspace override may replace on a global lane. */
export type CommandCodeLaneOverride = Partial<Omit<CommandCodeLaneSetting, 'id'>>

/** One workspace's overrides, keyed by global lane id. */
export interface CommandCodeProjectOverrideSetting {
  lanes: Record<string, CommandCodeLaneOverride>
}

/** The complete stored delegation section. */
export interface CommandCodeDelegationSettings {
  maxConcurrentRuns: number
  timeoutMs: number
  maxTurns: number
  lanes: CommandCodeLaneSetting[]
  projects: Record<string, CommandCodeProjectOverrideSetting>
}

function isEffort(value: unknown): value is CommandCodeEffort {
  return typeof value === 'string' && (COMMAND_CODE_EFFORTS as readonly string[]).includes(value)
}

function isAccess(value: unknown): value is CommandCodeAccess {
  return typeof value === 'string' && (COMMAND_CODE_ACCESS_MODES as readonly string[]).includes(value)
}

function decodeLane(value: unknown): CommandCodeLaneSetting | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const lane = value as Record<string, unknown>
  if (
    typeof lane.id !== 'string' || lane.id.length === 0
    || typeof lane.name !== 'string'
    || typeof lane.purpose !== 'string'
    || typeof lane.instructions !== 'string'
    || typeof lane.model !== 'string'
    || typeof lane.enabled !== 'boolean'
    || !isEffort(lane.effort)
    || !isAccess(lane.access)
  ) {
    return undefined
  }
  return {
    id: lane.id,
    name: lane.name,
    purpose: lane.purpose,
    instructions: lane.instructions,
    model: lane.model,
    effort: lane.effort,
    access: lane.access,
    enabled: lane.enabled,
  }
}

function decodeProject(value: unknown): CommandCodeProjectOverrideSetting | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const lanes = (value as Record<string, unknown>).lanes
  if (typeof lanes !== 'object' || lanes === null || Array.isArray(lanes)) return undefined
  return { lanes: lanes as Record<string, CommandCodeLaneOverride> }
}

/**
 * Narrow an untrusted settings section to the delegation shape.
 * @param value - settings value received from the Host.
 * @returns the decoded section, or `undefined` when the value is malformed.
 */
export function decodeCommandCodeDelegationSettings(
  value: unknown,
): CommandCodeDelegationSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const section = value as Record<string, unknown>
  if (
    typeof section.maxConcurrentRuns !== 'number'
    || typeof section.timeoutMs !== 'number'
    || typeof section.maxTurns !== 'number'
    || !Array.isArray(section.lanes)
    || typeof section.projects !== 'object' || section.projects === null || Array.isArray(section.projects)
  ) {
    return undefined
  }
  const lanes: CommandCodeLaneSetting[] = []
  for (const candidate of section.lanes) {
    const lane = decodeLane(candidate)
    if (lane === undefined) return undefined
    lanes.push(lane)
  }
  const projects: Record<string, CommandCodeProjectOverrideSetting> = {}
  for (const [key, candidate] of Object.entries(section.projects as Record<string, unknown>)) {
    const project = decodeProject(candidate)
    if (project === undefined) return undefined
    projects[key] = project
  }
  return {
    maxConcurrentRuns: section.maxConcurrentRuns,
    timeoutMs: section.timeoutMs,
    maxTurns: section.maxTurns,
    lanes,
    projects,
  }
}
