/**
 * Pure projection of the two stored namespaces the unified roster replaces —
 * `commandcode-delegation` lanes and `subagent-model-selection` — into one
 * {@link SubagentSettings} document.
 *
 * The projection is total and side-effect free: it reads its input, builds a
 * new document, and never mutates or aliases anything it was handed, so a
 * caller may run it repeatedly and compare the results. The legacy namespaces
 * stay on disk untouched; writing the projected document is the caller's step,
 * and {@link validateSubagentSettings} judges it before anything persists.
 *
 * @module @deepseek-ai/dsh-subagent-roster/migrate
 */

import type { SubagentAccess } from '@deepseek-ai/dsh-subagent'
import { defaultWhenToUse } from './defaults.ts'
import type {
  SubagentDefinition,
  SubagentDefinitionOverride,
  SubagentSettings,
  SubagentWorkspaceOverride,
} from './types.ts'

/** Backend the migrated roles keep: the Command Code CLI lane runner. */
export const MIGRATED_SUBAGENT_BACKEND = 'commandcode'

/** One lane as the `commandcode-delegation` section stores it. */
export interface LegacyCommandCodeLane {
  readonly id: string
  readonly name: string
  readonly purpose: string
  readonly instructions: string
  readonly model: string
  readonly effort: string
  readonly access: string
  readonly enabled: boolean
}

/** One workspace's lane patches as the `commandcode-delegation` section stores them. */
export interface LegacyCommandCodeProject {
  readonly lanes: Record<string, Partial<Omit<LegacyCommandCodeLane, 'id'>>>
}

/** The `commandcode-delegation` settings section as stored before the roster. */
export interface LegacyCommandCodeDelegation {
  readonly maxConcurrentRuns: number
  readonly timeoutMs: number
  readonly lanes: readonly LegacyCommandCodeLane[]
  readonly projects: Record<string, LegacyCommandCodeProject>
}

/** The `subagent-model-selection` settings section as stored before the roster. */
export interface LegacySubagentModelSelection {
  readonly enabled: boolean
  readonly allowedModels: readonly { readonly provider: string; readonly model: string }[]
}

/** The two stored namespaces one migration reads. */
export interface LegacySubagentConfiguration {
  readonly commandCode: LegacyCommandCodeDelegation
  readonly modelSelection: LegacySubagentModelSelection
}

/** The only legacy access level that is not already a sandbox mode. */
const LEGACY_FULL_ACCESS = 'full-access'

/**
 * Project one legacy lane access onto the sandbox vocabulary. The lane's
 * `full-access` is the CLI's unrestricted mode, which is `danger-full-access`
 * here; every other value is already a mode name.
 * @param access - the stored lane access string.
 * @returns the equivalent subagent access.
 */
function migrateAccess(access: string): SubagentAccess {
  return access === LEGACY_FULL_ACCESS ? 'danger-full-access' : 'read-only'
}

/**
 * Project one legacy lane model id onto an exact route. A lane's model id is
 * the Command Code catalog's own identifier and the backend passes it to its
 * CLI verbatim: an id shaped `<vendor>/<name>` is ONE opaque id, not a provider
 * and a model. Splitting it would truncate the id the CLI is asked for, so the
 * whole string is the route's model and the backend that owns that model space
 * is its provider. The value is inert until something delegates through the
 * migrated definition.
 * @param model - the stored lane model id.
 * @param effort - the stored lane effort.
 * @returns the exact route for that id.
 */
function migrateRoute(model: string, effort: string): NonNullable<SubagentDefinition['model']['route']> {
  return {
    provider: MIGRATED_SUBAGENT_BACKEND,
    model,
    // `default` means "the model's own default", which here is an omitted effort.
    ...effort === 'default' ? {} : { reasoningEffort: effort },
  }
}

/** Project one legacy lane into a definition. */
function migrateLane(lane: LegacyCommandCodeLane): SubagentDefinition {
  return {
    id: lane.id,
    name: lane.name,
    enabled: lane.enabled,
    purpose: lane.purpose,
    // The old lanes had no routing guidance; a built-in id keeps its shipped text.
    whenToUse: defaultWhenToUse(lane.id) ?? '',
    invocation: 'automatic',
    model: { mode: 'fixed', route: migrateRoute(lane.model, lane.effort) },
    access: migrateAccess(lane.access),
    instructions: lane.instructions,
    execution: { backend: MIGRATED_SUBAGENT_BACKEND, background: 'auto' },
  }
}

/**
 * Project one workspace's lane patches into definition overrides. A patch that
 * names either half of the legacy lane's route is projected as one whole route
 * carrying the values that lane would have resolved to, because the definition
 * stores provider, model, and effort together.
 * @param lanes - the stored lane patches.
 * @param byId - the global lanes their ids resolve against.
 * @returns the override layer for one workspace.
 */
function migrateProject(
  lanes: Record<string, Partial<Omit<LegacyCommandCodeLane, 'id'>>>,
  byId: ReadonlyMap<string, LegacyCommandCodeLane>,
): SubagentWorkspaceOverride {
  const subagents: Record<string, SubagentDefinitionOverride> = {}
  for (const [id, patch] of Object.entries(lanes)) {
    const lane = byId.get(id)
    const route = patch.model === undefined && patch.effort === undefined
      ? undefined
      : migrateRoute(patch.model ?? lane?.model ?? '', patch.effort ?? lane?.effort ?? 'default')
    subagents[id] = {
      ...patch.name === undefined ? {} : { name: patch.name },
      ...patch.purpose === undefined ? {} : { purpose: patch.purpose },
      ...patch.instructions === undefined ? {} : { instructions: patch.instructions },
      ...patch.enabled === undefined ? {} : { enabled: patch.enabled },
      ...patch.access === undefined ? {} : { access: migrateAccess(patch.access) },
      ...route === undefined ? {} : { model: { mode: 'fixed', route } },
    }
  }
  return { subagents }
}

/**
 * Project the stored pre-roster configuration into a roster document.
 * @param configuration - the two stored namespaces as read from disk.
 * @returns a new roster document; the input is never mutated or aliased.
 */
export function migrateSubagentSettings(configuration: LegacySubagentConfiguration): SubagentSettings {
  const { commandCode, modelSelection } = configuration
  const byId = new Map(commandCode.lanes.map(lane => [lane.id, lane]))
  const overrides: Record<string, SubagentWorkspaceOverride> = {}
  for (const [workspace, project] of Object.entries(commandCode.projects)) {
    overrides[workspace] = migrateProject(project.lanes, byId)
  }
  return {
    subagents: commandCode.lanes.map(migrateLane),
    overrides,
    automaticRouting: {
      enabled: modelSelection.enabled,
      allowedModels: modelSelection.allowedModels.map(route => ({ provider: route.provider, model: route.model })),
    },
    limits: {
      maxConcurrentRuns: commandCode.maxConcurrentRuns,
      defaultTimeoutMs: commandCode.timeoutMs,
    },
  }
}
