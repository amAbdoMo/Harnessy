/**
 * Pure edits over one delegation section. The section component renders these
 * results and the settings scope persists them, so every rule about what a
 * lane edit, an add, a delete, an override, and a reset mean is testable
 * without React.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-commandcode/edit
 */

import type {
  CommandCodeDelegationSettings,
  CommandCodeLaneOverride,
  CommandCodeLaneSetting,
  CommandCodeProjectOverrideSetting,
} from './contract.ts'

/** Fields a workspace override may carry. */
export type CommandCodeOverrideField = keyof CommandCodeLaneOverride

/**
 * Fields a workspace override may carry, in editor order. The editor renders
 * every one of them, so a workspace that has never overridden anything still
 * has a control that can create its first override.
 */
export const COMMAND_CODE_OVERRIDE_FIELDS = [
  'name',
  'purpose',
  'instructions',
  'model',
  'effort',
  'access',
  'enabled',
] as const satisfies readonly CommandCodeOverrideField[]

/**
 * Read the lane with this id.
 * @param settings - the complete section.
 * @param laneId - the lane to read.
 * @returns the stored lane, or undefined when no lane has that id.
 */
export function laneById(
  settings: CommandCodeDelegationSettings,
  laneId: string,
): CommandCodeLaneSetting | undefined {
  return settings.lanes.find(lane => lane.id === laneId)
}

/**
 * One workspace's stored override for a lane, when the user has created any.
 * @param settings - the complete section.
 * @param workspaceKey - canonical workspace key from the Host.
 * @param laneId - the lane the override patches.
 * @returns the stored patch, or undefined when every field is inherited.
 */
export function projectOverride(
  settings: CommandCodeDelegationSettings,
  workspaceKey: string | null,
  laneId: string,
): CommandCodeLaneOverride | undefined {
  if (workspaceKey === null) return undefined
  return settings.projects[workspaceKey]?.lanes[laneId]
}

/**
 * Whether one lane field is overridden for this workspace.
 * @param settings - the complete section.
 * @param workspaceKey - canonical workspace key, or null without a workspace.
 * @param laneId - the lane to inspect.
 * @param field - the field to inspect.
 * @returns true when the workspace replaces this field rather than inheriting it.
 */
export function isOverridden(
  settings: CommandCodeDelegationSettings,
  workspaceKey: string | null,
  laneId: string,
  field: CommandCodeOverrideField,
): boolean {
  return projectOverride(settings, workspaceKey, laneId)?.[field] !== undefined
}

/**
 * Replace one field of one global lane.
 * @param settings - the complete section.
 * @param laneId - the lane to edit.
 * @param field - the lane field to replace.
 * @param value - the new value for that field.
 * @returns the section with the edit applied.
 */
export function withLaneField<K extends keyof CommandCodeLaneSetting>(
  settings: CommandCodeDelegationSettings,
  laneId: string,
  field: K,
  value: CommandCodeLaneSetting[K],
): CommandCodeDelegationSettings {
  return {
    ...settings,
    lanes: settings.lanes.map(lane => (lane.id === laneId ? { ...lane, [field]: value } : lane)),
  }
}

/**
 * Append one fully specified lane.
 * @param settings - the complete section.
 * @param lane - the lane to append.
 * @returns the section with the new lane last.
 * @throws {Error} when a lane with that id already exists.
 */
export function withNewLane(
  settings: CommandCodeDelegationSettings,
  lane: CommandCodeLaneSetting,
): CommandCodeDelegationSettings {
  if (laneById(settings, lane.id) !== undefined) {
    throw new Error(`a lane with id "${lane.id}" already exists`)
  }
  return { ...settings, lanes: [...settings.lanes, lane] }
}

/**
 * Remove one lane and every workspace override that patched it, so a later lane
 * reusing the id cannot inherit a stale patch.
 * @param settings - the complete section.
 * @param laneId - the lane to remove.
 * @returns the section without that lane or its overrides.
 */
export function withoutLane(
  settings: CommandCodeDelegationSettings,
  laneId: string,
): CommandCodeDelegationSettings {
  const projects: Record<string, CommandCodeProjectOverrideSetting> = {}
  for (const [key, project] of Object.entries(settings.projects)) {
    const lanes = Object.fromEntries(
      Object.entries(project.lanes).filter(([id]) => id !== laneId),
    )
    if (Object.keys(lanes).length > 0) projects[key] = { lanes }
  }
  return {
    ...settings,
    lanes: settings.lanes.filter(lane => lane.id !== laneId),
    projects,
  }
}

/**
 * Record one value inside the selected workspace's override for one lane.
 * @param settings - the complete section.
 * @param workspaceKey - canonical workspace key.
 * @param laneId - the lane the override patches.
 * @param field - the lane field this workspace replaces.
 * @param value - the value this workspace uses instead of the global one.
 * @returns the section with the override recorded.
 */
export function withProjectField(
  settings: CommandCodeDelegationSettings,
  workspaceKey: string,
  laneId: string,
  field: CommandCodeOverrideField,
  value: unknown,
): CommandCodeDelegationSettings {
  const current = settings.projects[workspaceKey]?.lanes ?? {}
  const lane = { ...current[laneId], [field]: value } as CommandCodeLaneOverride
  return {
    ...settings,
    projects: {
      ...settings.projects,
      [workspaceKey]: { lanes: { ...current, [laneId]: lane } },
    },
  }
}

/** Copy one record without one key. */
function omitKey<T extends Record<string, unknown>>(record: T, key: string): T {
  return Object.fromEntries(
    Object.entries(record).filter(([candidate]) => candidate !== key),
  ) as T
}

/**
 * Drop the selected workspace's override for one field. The field then
 * re-inherits the global lane, and the lane's override entry disappears once
 * its last field is reset or the workspace entry empties entirely.
 * @param settings - the complete section.
 * @param workspaceKey - canonical workspace key.
 * @param laneId - the lane to reset.
 * @param field - the lane field this workspace stops overriding.
 * @returns the section with the override removed.
 */
export function resetProjectField(
  settings: CommandCodeDelegationSettings,
  workspaceKey: string,
  laneId: string,
  field: CommandCodeOverrideField,
): CommandCodeDelegationSettings {
  const workspace = settings.projects[workspaceKey]
  const lane = omitKey(
    (workspace?.lanes[laneId] ?? {}) as Record<string, unknown>,
    field,
  ) as CommandCodeLaneOverride
  const lanes = Object.keys(lane).length === 0
    ? omitKey(workspace?.lanes ?? {}, laneId)
    : { ...workspace?.lanes, [laneId]: lane }
  const projects = Object.keys(lanes).length === 0
    ? omitKey(settings.projects, workspaceKey)
    : { ...settings.projects, [workspaceKey]: { lanes } }
  return { ...settings, projects }
}

/**
 * Drop every override one lane carries for one workspace.
 * @param settings - the complete section.
 * @param workspaceKey - canonical workspace key.
 * @param laneId - the lane to reset.
 * @returns the section with that lane fully inherited again.
 */
export function resetProjectLane(
  settings: CommandCodeDelegationSettings,
  workspaceKey: string,
  laneId: string,
): CommandCodeDelegationSettings {
  const fields = Object.keys(
    settings.projects[workspaceKey]?.lanes[laneId] ?? {},
  ) as CommandCodeOverrideField[]
  return fields.reduce(
    (current, field) => resetProjectField(current, workspaceKey, laneId, field),
    settings,
  )
}

/**
 * Derive a lane id from a display name, unique within the current section.
 * @param settings - the complete section.
 * @param name - the user's proposed display name.
 * @returns a lower-case, hyphenated id not already in use.
 */
export function deriveLaneId(settings: CommandCodeDelegationSettings, name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 32)
  const stem = base === '' || !/^[a-z]/u.test(base) ? `lane-${base}` : base
  let candidate = stem.slice(0, 40)
  let suffix = 2
  while (laneById(settings, candidate) !== undefined) {
    const tail = `-${String(suffix)}`
    candidate = `${stem.slice(0, 40 - tail.length)}${tail}`
    suffix += 1
  }
  return candidate
}
