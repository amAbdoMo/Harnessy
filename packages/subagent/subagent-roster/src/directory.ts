/**
 * The model-facing directory projection: one workspace's resolved roles
 * reduced to what the parent needs in order to route, and rendered as the exact
 * text the model reads.
 *
 * Ordering follows the stored definitions and no value here varies between two
 * reads of the same settings, so the block is stable across calls and stays
 * friendly to prefix caching.
 *
 * @module @deepseek-ai/dsh-subagent-roster/directory
 */

import type { SubagentDirectoryEntry, SubagentRosterView } from './types.ts'

/** The model's word for a role that contributes no route of its own. */
const INHERITED_ROUTE = 'inherit'

/**
 * Project the enabled roles of one workspace into directory rows.
 * @param view - the workspace's resolved roster view.
 * @returns one row per enabled definition.
 */
export function subagentDirectory(view: SubagentRosterView): SubagentDirectoryEntry[] {
  return view.subagents
    .filter(definition => definition.enabled)
    .map((definition) => {
      const route = definition.model.route
      const reasoningEffort = route?.reasoningEffort
      return {
        id: definition.id,
        name: definition.name,
        purpose: definition.purpose,
        whenToUse: definition.whenToUse,
        invocation: definition.invocation,
        model: route === undefined ? INHERITED_ROUTE : `${route.provider}/${route.model}`,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
        access: definition.access,
        background: definition.execution.background,
      }
    })
}

/**
 * Render directory rows as the compact block the model reads.
 * @param entries - the enabled directory rows for one workspace.
 * @returns one line per row, or a single line saying none are enabled.
 */
export function renderSubagentDirectory(entries: readonly SubagentDirectoryEntry[]): string {
  if (entries.length === 0) return '(no subagents are enabled for this workspace)'
  return entries.map((entry) => {
    const effort = entry.reasoningEffort === undefined ? '' : ` at ${entry.reasoningEffort}`
    const when = entry.whenToUse.length === 0 ? '' : ` When to use: ${entry.whenToUse}`
    return `${entry.id} — ${entry.name} (invocation ${entry.invocation}, access ${entry.access}, `
      + `model ${entry.model}${effort}, runs ${entry.background}): ${entry.purpose}${when}`
  }).join('\n')
}
