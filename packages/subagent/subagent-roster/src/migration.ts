/**
 * The one-shot load-time migration that carries a stored pre-roster
 * configuration into the roster document.
 *
 * It reads the two namespaces the roster replaces — the Command Code package's
 * `commandcode-delegation` lanes and `tool-subagent`'s
 * `subagent-model-selection` authority — projects them through the pure
 * {@link migrateSubagentSettings}, validates the result, and writes it once.
 * Both halves are read from each namespace's resolved value, so a value the
 * user never wrote still contributes the defaults its owner resolves.
 *
 * The write is additive. Every legacy value stays exactly where it was stored,
 * the per-workspace `projects` overrides included, so a user can inspect the
 * old configuration or revert by editing the new document: nothing is deleted,
 * rewritten, truncated, or cleared.
 *
 * A namespace nobody registered, one whose stored section cannot be read, and
 * one holding nothing are all the ordinary "nothing to migrate" outcome rather
 * than an error, because a deployment mounts the legacy plugins only when it
 * offers their feature.
 *
 * The [roster migration Agent Note](../../../../.agents/notes/implemented/feature/2026-09-16-subagent-roster-legacy-migration.md)
 * records what this migration reads, what it refuses to write, and why the two
 * namespace names are declared here.
 *
 * @module @deepseek-ai/dsh-subagent-roster/migration
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsDescriptor, SettingsProvider } from '@deepseek-ai/dsh-settings'
import { DEFAULT_SUBAGENT_AUTOMATIC_ROUTING } from './defaults.ts'
import { migrateSubagentSettings } from './migrate.ts'
import type {
  LegacyCommandCodeDelegation,
  LegacySubagentConfiguration,
  LegacySubagentModelSelection,
} from './migrate.ts'
import { SUBAGENT_ROSTER_NAMESPACE, validateSubagentSettings } from './settings.ts'

/**
 * Settings namespace the pre-roster Command Code lanes are stored in.
 *
 * Declared here rather than imported from `@deepseek-ai/dsh-subagent-commandcode`:
 * this package composes with every profile, and that one is a single product's
 * backend. The composition test in that package mounts both rows and fails if
 * the two names ever disagree.
 */
export const LEGACY_COMMAND_CODE_NAMESPACE = 'commandcode-delegation'

/**
 * Settings namespace the pre-roster automatic-routing authority is stored in.
 *
 * Declared here rather than imported from
 * `@deepseek-ai/dsh-tool-subagent/model-selection-settings` for the same reason
 * as {@link LEGACY_COMMAND_CODE_NAMESPACE}.
 */
export const LEGACY_MODEL_SELECTION_NAMESPACE = 'subagent-model-selection'

/** Whether a value is a plain data object rather than an array or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one namespace's stored user section, which is what says whether this
 * user configured anything there. The resolved value is the same for every
 * user of a namespace, so it cannot answer that question.
 * @param descriptor - the namespace's descriptor, absent while nobody registers it.
 * @returns the stored section, or `undefined` for an absent, unreadable, or empty one.
 */
function storedSection(descriptor: SettingsDescriptor | undefined): Record<string, unknown> | undefined {
  const user = descriptor?.user
  return isRecord(user) && Object.keys(user).length > 0 ? user : undefined
}

/** Whether a stored map holds plain data objects only, so a projection may dereference its entries. */
function isRecordMap(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.values(value).every(isRecord)
}

/**
 * Read the Command Code document the projection consumes.
 *
 * The check covers the containers the projection dereferences before any
 * validation could judge the result: a value failing here is one the owning
 * namespace's schema never produced. Every field inside is copied into a
 * document that {@link validateSubagentSettings} judges before anything
 * persists, so no field is trusted past that check.
 * @param value - the namespace's resolved value.
 * @returns the legacy document, or `undefined` when it has another structure.
 */
function legacyCommandCode(value: unknown): LegacyCommandCodeDelegation | undefined {
  if (!isRecord(value)) return undefined
  const lanes = value['lanes']
  const projects = value['projects']
  if (!Array.isArray(lanes) || !lanes.every(isRecord)) return undefined
  if (!isRecordMap(projects)) return undefined
  if (!Object.values(projects).every(project => isRecord(project) && isRecordMap(project['lanes']))) return undefined
  return value as unknown as LegacyCommandCodeDelegation
}

/**
 * Read the model-selection document the projection consumes.
 * @param value - the namespace's resolved value.
 * @returns the legacy document, or `undefined` when it has another structure.
 */
function legacyModelSelection(value: unknown): LegacySubagentModelSelection | undefined {
  if (!isRecord(value)) return undefined
  const allowedModels = value['allowedModels']
  if (!Array.isArray(allowedModels) || !allowedModels.every(isRecord)) return undefined
  return value as unknown as LegacySubagentModelSelection
}

/**
 * Read the configuration there is to migrate, or `undefined` when there is none.
 *
 * The lanes are required: they are the roles being carried, and a document
 * without them would replace the shipped roles with nothing. The routing
 * authority is optional because a deployment may mount the lane namespace alone,
 * and a deployment that authorizes no explicit route selection resolves exactly
 * the shipped default.
 * @param sections - every registered namespace's descriptor, keyed by name.
 * @returns the two legacy documents, or `undefined` when there is nothing to carry.
 */
function legacyConfiguration(
  sections: ReadonlyMap<string, SettingsDescriptor>,
): LegacySubagentConfiguration | undefined {
  const commandCodeSection = sections.get(LEGACY_COMMAND_CODE_NAMESPACE)
  const modelSelectionSection = sections.get(LEGACY_MODEL_SELECTION_NAMESPACE)
  const commandCode = legacyCommandCode(commandCodeSection?.value)
  if (commandCode === undefined) return undefined
  if (storedSection(commandCodeSection) === undefined && storedSection(modelSelectionSection) === undefined) {
    return undefined
  }
  return {
    commandCode,
    modelSelection: legacyModelSelection(modelSelectionSection?.value)
      ?? { ...DEFAULT_SUBAGENT_AUTOMATIC_ROUTING, allowedModels: [] },
  }
}

/** The message of a caught failure, which the diagnostic must keep to one line. */
function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Carry one stored pre-roster configuration into the roster document, once.
 *
 * The migration runs when the lane namespace is registered and the user stored
 * something in either legacy namespace, and never while the roster section
 * already holds a document of the user's own — a stored roster, even one whose
 * role list the user emptied, is never replaced.
 *
 * Each outcome is reported once through the Host log: a carried document, an
 * absent one, and a stored one this projection cannot turn into a valid roster.
 * None of them throws, so no stored legacy value can fail the load.
 * @param ctx - Host context whose logger receives the migration's outcome line.
 * @param settings - the settings service the roster section is registered with.
 * @returns fulfillment once the migration settled, whether or not it wrote.
 */
export async function migrateStoredSubagentConfiguration(
  ctx: Context,
  settings: SettingsProvider,
): Promise<void> {
  const sections = new Map(settings.describe().map(descriptor => [String(descriptor.ns), descriptor]))
  if (storedSection(sections.get(SUBAGENT_ROSTER_NAMESPACE)) !== undefined) {
    ctx.logger.info('subagent-roster: the stored roster is this user\'s own document; no legacy migration ran')
    return
  }
  const configuration = legacyConfiguration(sections)
  if (configuration === undefined) {
    ctx.logger.info('subagent-roster: no stored legacy subagent configuration to migrate')
    return
  }
  const document = migrateSubagentSettings(configuration)
  try {
    validateSubagentSettings(document)
  } catch (error: unknown) {
    ctx.logger.warn(
      'subagent-roster: kept the shipped roster; the stored legacy configuration projects to an invalid document: %s',
      detail(error),
    )
    return
  }
  try {
    await settings.replace(SUBAGENT_ROSTER_NAMESPACE, document)
  } catch (error: unknown) {
    ctx.logger.warn('subagent-roster: the migrated roster document could not be written: %s', detail(error))
    return
  }
  ctx.logger.info(
    'subagent-roster: migrated %d legacy subagent role(s); the commandcode-delegation and subagent-model-selection sections are unchanged',
    document.subagents.length,
  )
}
