/**
 * Pure edits over one `subagent-roster` settings section.
 *
 * The page renders these results and the settings scope persists them, so every
 * rule about what a field edit, an add, a duplicate, a delete, an override, and
 * a reset mean is testable without React. Overrides stay field-level: an
 * override records only what the user changed, and resetting prunes the emptied
 * entry so a definition returns to fully inherited instead of keeping a patch
 * that says nothing.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-subagents/edit
 */

import type {
  SubagentDefinition,
  SubagentDefinitionOverride,
  SubagentExecution,
  SubagentSettings,
  SubagentWorkspaceOverride,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SubagentBackgroundPolicy } from './contract.ts'

/** Fields one workspace may override on a global definition. */
export type SubagentOverrideField = keyof SubagentDefinitionOverride

/**
 * Fields a workspace override may carry, in editor order. The editor lists every
 * one of them, so a workspace that has never overridden anything still has a
 * control that can create its first override.
 */
export const SUBAGENT_OVERRIDE_FIELDS = [
  'enabled',
  'name',
  'purpose',
  'whenToUse',
  'model',
  'access',
  'invocation',
  'instructions',
  'tools',
  'maxDepth',
  'execution',
] as const satisfies readonly SubagentOverrideField[]

/**
 * Copy one definition into its stored form, dropping an optional field that was
 * cleared. Omission is a stored value here, not a missing one: an empty
 * `tools` object would deny every tool, and an absent `maxDepth` is what lets a
 * definition inherit the run bound.
 * @param definition - the definition to normalize.
 * @returns the definition with cleared optional fields absent.
 */
function storedDefinition(definition: SubagentDefinition): SubagentDefinition {
  return {
    id: definition.id,
    name: definition.name,
    enabled: definition.enabled,
    purpose: definition.purpose,
    whenToUse: definition.whenToUse,
    invocation: definition.invocation,
    model: definition.model,
    access: definition.access,
    instructions: definition.instructions,
    execution: definition.execution,
    ...definition.tools === undefined ? {} : { tools: definition.tools },
    ...definition.maxDepth === undefined ? {} : { maxDepth: definition.maxDepth },
  }
}

/** Replace one stored definition in place, keeping every other definition's order. */
function replaceDefinition(
  settings: SubagentSettings,
  id: string,
  next: SubagentDefinition,
): SubagentSettings {
  return {
    ...settings,
    subagents: settings.subagents.map(definition => (definition.id === id ? next : definition)),
  }
}

/** Read one workspace entry, or undefined when the workspace overrides nothing. */
function workspaceEntry(
  settings: SubagentSettings,
  workspaceKey: string | null,
): SubagentWorkspaceOverride | undefined {
  return workspaceKey === null ? undefined : settings.overrides[workspaceKey]
}

/** Copy a record without one key. */
function omitKey<T extends Record<string, unknown>>(record: T, key: string): T {
  return Object.fromEntries(
    Object.entries(record).filter(([candidate]) => candidate !== key),
  ) as T
}

/**
 * Store one workspace's entry, dropping the entry when nothing is left in it.
 * @param settings - the complete section.
 * @param workspaceKey - canonical workspace key.
 * @param entry - the overrides left for that workspace.
 * @returns the section with that workspace's layer replaced.
 */
function replaceWorkspace(
  settings: SubagentSettings,
  workspaceKey: string,
  entry: SubagentWorkspaceOverride,
): SubagentSettings {
  if (Object.keys(entry.subagents).length === 0 && (entry.removed ?? []).length === 0) {
    return { ...settings, overrides: omitKey(settings.overrides, workspaceKey) }
  }
  return { ...settings, overrides: { ...settings.overrides, [workspaceKey]: entry } }
}

/**
 * Read the definition with this id.
 * @param settings - the complete section.
 * @param id - the definition to read.
 * @returns the stored definition, or undefined when no definition has that id.
 */
export function definitionById(settings: SubagentSettings, id: string): SubagentDefinition | undefined {
  return settings.subagents.find(definition => definition.id === id)
}

/**
 * Read one workspace's stored override for a definition, when the user has created any.
 * @param settings - the complete section.
 * @param workspaceKey - canonical workspace key, or null without a workspace.
 * @param id - the definition the override patches.
 * @returns the stored patch, or undefined when every field is inherited.
 */
export function workspaceOverride(
  settings: SubagentSettings,
  workspaceKey: string | null,
  id: string,
): SubagentDefinitionOverride | undefined {
  return workspaceEntry(settings, workspaceKey)?.subagents[id]
}

/**
 * Whether one definition field is overridden for this workspace.
 * @param settings - the complete section.
 * @param workspaceKey - canonical workspace key, or null without a workspace.
 * @param id - the definition to inspect.
 * @param field - the field to inspect.
 * @returns true when the workspace replaces this field rather than inheriting it.
 */
export function isDefinitionOverridden(
  settings: SubagentSettings,
  workspaceKey: string | null,
  id: string,
  field: SubagentOverrideField,
): boolean {
  return workspaceOverride(settings, workspaceKey, id)?.[field] !== undefined
}

/**
 * Every field this workspace replaces on one definition.
 * @param settings - the complete section.
 * @param workspaceKey - canonical workspace key, or null without a workspace.
 * @param id - the definition to inspect.
 * @returns the overridden fields, in editor order.
 */
export function overriddenFields(
  settings: SubagentSettings,
  workspaceKey: string | null,
  id: string,
): SubagentOverrideField[] {
  return SUBAGENT_OVERRIDE_FIELDS.filter(field => isDefinitionOverridden(settings, workspaceKey, id, field))
}

/**
 * Apply one workspace's override layer to one definition, so an editor shows the
 * value a delegation in that workspace actually runs with.
 *
 * A field the workspace does not name keeps the global value, which is the rule
 * the Host's own resolution applies.
 * @param settings - the complete section.
 * @param workspaceKey - canonical workspace key, or null without a workspace.
 * @param id - the definition to resolve.
 * @returns the definition with this workspace's overrides applied, or undefined when no definition has that id.
 */
export function effectiveDefinition(
  settings: SubagentSettings,
  workspaceKey: string | null,
  id: string,
): SubagentDefinition | undefined {
  const definition = definitionById(settings, id)
  if (definition === undefined) return undefined
  const override = workspaceOverride(settings, workspaceKey, id)
  if (override === undefined) return definition
  return storedDefinition({ ...definition, ...override })
}

/**
 * Replace one stored definition.
 * @param settings - the complete section.
 * @param id - the definition to replace.
 * @param next - the definition to store in its place.
 * @returns the section with the definition replaced, unchanged when no definition has that id.
 */
export function withDefinition(
  settings: SubagentSettings,
  id: string,
  next: SubagentDefinition,
): SubagentSettings {
  if (definitionById(settings, id) === undefined) return settings
  return replaceDefinition(settings, id, storedDefinition(next))
}

/**
 * Build one execution record, dropping a bound the user cleared.
 * @param base - the execution the edit started from.
 * @param patch - the fields to replace; a present key replaces, an undefined one clears.
 * @returns the execution to store.
 */
export function withExecution(base: SubagentExecution, patch: {
  readonly backend?: string
  readonly background?: SubagentBackgroundPolicy
  readonly timeoutMs?: number | undefined
}): SubagentExecution {
  const timeoutMs = 'timeoutMs' in patch ? patch.timeoutMs : base.timeoutMs
  return {
    backend: patch.backend ?? base.backend,
    background: patch.background ?? base.background,
    ...timeoutMs === undefined ? {} : { timeoutMs },
  }
}

/**
 * Parse one comma-separated tool list.
 * @param text - the user's comma-separated names.
 * @returns the names, trimmed and with blanks dropped.
 */
export function parseToolNames(text: string): string[] {
  return text.split(',').map(name => name.trim()).filter(name => name.length > 0)
}

/**
 * Build the stored tool restriction from the two edited lists.
 *
 * Both lists empty clears the restriction instead of storing an empty one: an
 * empty `allow` list would deny every tool rather than leave the set unscoped.
 * @param allow - the allowed-tools control's text.
 * @param deny - the denied-tools control's text.
 * @returns the restriction to store, or undefined when the user named no tool.
 */
export function toolRestriction(allow: string, deny: string): SubagentDefinition['tools'] {
  const allowed = parseToolNames(allow)
  const denied = parseToolNames(deny)
  if (allowed.length === 0 && denied.length === 0) return undefined
  return {
    ...allowed.length === 0 ? {} : { allow: allowed },
    ...denied.length === 0 ? {} : { deny: denied },
  }
}

/**
 * Append one fully specified definition.
 * @param settings - the complete section.
 * @param definition - the definition to append.
 * @returns the section with the new definition last.
 * @throws {Error} when a definition with that id already exists.
 */
export function withNewDefinition(
  settings: SubagentSettings,
  definition: SubagentDefinition,
): SubagentSettings {
  if (definitionById(settings, definition.id) !== undefined) {
    throw new Error(`a subagent with id "${definition.id}" already exists`)
  }
  return { ...settings, subagents: [...settings.subagents, storedDefinition(definition)] }
}

/**
 * Copy one definition under a fresh id and name.
 *
 * The copy starts disabled: it carries the same purpose as the role it came
 * from, so enabling it silently would hand the parent agent a second live route
 * for the same job before the user has reviewed it.
 * @param settings - the complete section.
 * @param id - the definition to copy.
 * @returns the section with the copy last, unchanged when no definition has that id.
 */
export function duplicateDefinition(settings: SubagentSettings, id: string): SubagentSettings {
  const source = definitionById(settings, id)
  if (source === undefined) return settings
  const name = `${source.name} copy`
  return withNewDefinition(settings, {
    ...storedDefinition(source),
    id: deriveSubagentId(settings, name),
    name,
    enabled: false,
  })
}

/**
 * Remove one definition and every workspace override that named it, so a later
 * definition reusing the id cannot inherit a stale patch or a stale removal.
 * @param settings - the complete section.
 * @param id - the definition to remove.
 * @returns the section without that definition or its overrides.
 */
export function withoutDefinition(settings: SubagentSettings, id: string): SubagentSettings {
  const overrides: Record<string, SubagentWorkspaceOverride> = {}
  for (const [key, entry] of Object.entries(settings.overrides)) {
    const subagents = omitKey(entry.subagents, id)
    const removed = (entry.removed ?? []).filter(candidate => candidate !== id)
    const next: SubagentWorkspaceOverride = {
      subagents,
      ...removed.length === 0 ? {} : { removed },
    }
    if (Object.keys(subagents).length === 0 && removed.length === 0) continue
    overrides[key] = next
  }
  return {
    ...settings,
    subagents: settings.subagents.filter(definition => definition.id !== id),
    overrides,
  }
}

/**
 * Record one value inside the selected workspace's override for one definition.
 *
 * A value of undefined clears the override rather than recording an empty one:
 * an override entry is a claim that this workspace replaces the global field,
 * and "replaced with nothing" is exactly what resetting means.
 * @param settings - the complete section.
 * @param workspaceKey - canonical workspace key.
 * @param id - the definition the override patches.
 * @param field - the definition field this workspace replaces.
 * @param value - the value this workspace uses instead of the global one.
 * @returns the section with the override recorded.
 */
export function withWorkspaceField(
  settings: SubagentSettings,
  workspaceKey: string,
  id: string,
  field: SubagentOverrideField,
  value: unknown,
): SubagentSettings {
  if (value === undefined) return resetWorkspaceField(settings, workspaceKey, id, field)
  const entry = workspaceEntry(settings, workspaceKey) ?? { subagents: {} }
  const definition = { ...entry.subagents[id], [field]: value } as SubagentDefinitionOverride
  return replaceWorkspace(settings, workspaceKey, {
    ...entry,
    subagents: { ...entry.subagents, [id]: definition },
  })
}

/**
 * Drop the selected workspace's override for one field. The field then
 * re-inherits the global definition, and the definition's override entry
 * disappears once its last field is reset.
 * @param settings - the complete section.
 * @param workspaceKey - canonical workspace key.
 * @param id - the definition to reset.
 * @param field - the definition field this workspace stops overriding.
 * @returns the section with the override removed.
 */
export function resetWorkspaceField(
  settings: SubagentSettings,
  workspaceKey: string,
  id: string,
  field: SubagentOverrideField,
): SubagentSettings {
  const entry = workspaceEntry(settings, workspaceKey)
  const definition = omitKey(
    (entry?.subagents[id] ?? {}) as Record<string, unknown>,
    field,
  ) as SubagentDefinitionOverride
  const subagents = Object.keys(definition).length === 0
    ? omitKey(entry?.subagents ?? {}, id)
    : { ...entry?.subagents, [id]: definition }
  return replaceWorkspace(settings, workspaceKey, { ...entry, subagents })
}

/**
 * Drop every override one definition carries for one workspace.
 * @param settings - the complete section.
 * @param workspaceKey - canonical workspace key.
 * @param id - the definition to reset.
 * @returns the section with that definition fully inherited again.
 */
export function resetWorkspaceDefinition(
  settings: SubagentSettings,
  workspaceKey: string,
  id: string,
): SubagentSettings {
  const entry = workspaceEntry(settings, workspaceKey)
  return replaceWorkspace(settings, workspaceKey, { ...entry, subagents: omitKey(entry?.subagents ?? {}, id) })
}

/**
 * Drop every override the selected workspace carries, leaving it fully inherited.
 * @param settings - the complete section.
 * @param workspaceKey - canonical workspace key.
 * @returns the section with that workspace's layer removed.
 */
export function resetWorkspace(settings: SubagentSettings, workspaceKey: string): SubagentSettings {
  return { ...settings, overrides: omitKey(settings.overrides, workspaceKey) }
}

/**
 * Replace the automatic-routing authority.
 * @param settings - the complete section.
 * @param routing - the enabled flag and the authorized routes to store.
 * @returns the section with the authority replaced.
 */
export function withAutomaticRouting(
  settings: SubagentSettings,
  routing: SubagentSettings['automaticRouting'],
): SubagentSettings {
  return { ...settings, automaticRouting: routing }
}

/**
 * The top-level fields one edit changed, so a write carries only what moved.
 *
 * Definition edits and workspace-override edits therefore travel as separate
 * writes and cannot overwrite each other even when both are in flight.
 * @param base - the section the edit started from.
 * @param next - the section the edit produced.
 * @returns the changed top-level fields.
 */
export function changedFields(
  base: SubagentSettings,
  next: SubagentSettings,
): Partial<SubagentSettings> {
  const patch: { -readonly [K in keyof SubagentSettings]?: SubagentSettings[K] } = {}
  if (next.subagents !== base.subagents) patch.subagents = next.subagents
  if (next.overrides !== base.overrides) patch.overrides = next.overrides
  if (next.automaticRouting !== base.automaticRouting) patch.automaticRouting = next.automaticRouting
  if (next.limits !== base.limits) patch.limits = next.limits
  return patch
}

/**
 * Derive a definition id from a display name, unique within the current section.
 *
 * The result always matches the Host's `SUBAGENT_ID_PATTERN` (see
 * `contract.ts`): every stem this builds starts with a letter and carries only
 * lower-case letters, digits, and hyphens.
 * @param settings - the complete section.
 * @param name - the user's proposed display name.
 * @returns a lower-case, hyphenated id not already in use.
 */
export function deriveSubagentId(settings: SubagentSettings, name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 32)
  const stem = base === '' || !/^[a-z]/u.test(base) ? `subagent-${base}` : base
  let candidate = stem.slice(0, 40)
  let suffix = 2
  while (definitionById(settings, candidate) !== undefined) {
    const tail = `-${String(suffix)}`
    candidate = `${stem.slice(0, 40 - tail.length)}${tail}`
    suffix += 1
  }
  return candidate
}
