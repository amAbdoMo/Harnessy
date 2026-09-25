/**
 * The unified subagent roster: one live `subagent-roster` settings section
 * owning the role directory, the resolved per-workspace view, the shared run
 * gate, the two model-facing tools (`list_subagents` and `delegate`), the
 * one-shot migration of a stored pre-roster configuration, and the Remote
 * surface the Subagents Settings page reads.
 *
 * The plugin starts no child while loading. Every delegation and every Remote
 * read goes through the settings section, so a saved edit applies to the next
 * call from an already-running Session.
 *
 * @module @deepseek-ai/dsh-subagent-roster
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SubagentRunLimiter } from './limiter.ts'
import { migrateStoredSubagentConfiguration } from './migration.ts'
import {
  SubagentSettingsFields,
  automaticRoutingAuthority,
  resolvedSubagentRoster,
  resolveSubagentConcurrencyLimit,
  storedSubagentRoster,
  subagentRosterView,
  validateSubagentSettings,
} from './settings.ts'
import { installRosterTools } from './tools.ts'
import type {
  SubagentAutomaticRouting,
  SubagentSettings,
  SubagentStoredRoster,
  SubagentWorkspaceRoster,
} from './types.ts'
import { delegationAuthorityProjectionDefinition } from './authority.ts'

export * from './types.ts'
export {
  ADAPTIVE_SUBAGENT_CONCURRENCY,
  DEFAULT_SUBAGENT_BACKEND,
  DEFAULT_SUBAGENT_DEFINITIONS,
  DEFAULT_SUBAGENT_LIMITS,
  DEFAULT_SUBAGENT_MAX_CONCURRENT_RUNS,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  MAX_SUBAGENT_CONCURRENT_RUNS,
  defaultSubagentDefinitions,
  defaultSubagentSettings,
  defaultWhenToUse,
} from './defaults.ts'
export {
  SUBAGENT_ID_PATTERN,
  SUBAGENT_ROSTER_NAMESPACE,
  SubagentSettingsSchema,
  automaticRoutingAuthority,
  canonicalWorkspaceKey,
  requireEnabledSubagent,
  resolveSubagentRoster,
  resolvedSubagentRoster,
  resolveSubagentConcurrencyLimit,
  storedSubagentRoster,
  subagentRosterView,
  validateSubagentSettings,
} from './settings.ts'
export { renderSubagentDirectory, subagentDirectory } from './directory.ts'
export { SubagentRunLimiter } from './limiter.ts'
export { DELEGATE_TOOL, LIST_SUBAGENTS_TOOL, installRosterTools } from './tools.ts'
export type { SubagentRosterApi } from './tools.ts'
export {
  delegationAuthorityProjectionDefinition,
  delegationAuthorityWindow,
  requireDirectHuman,
} from './authority.ts'
export type { DelegationAuthorityWindow } from './authority.ts'
export {
  MIGRATED_SUBAGENT_BACKEND,
  migrateSubagentSettings,
} from './migrate.ts'
export type {
  LegacyCommandCodeDelegation,
  LegacyCommandCodeLane,
  LegacyCommandCodeProject,
  LegacySubagentConfiguration,
  LegacySubagentModelSelection,
} from './migrate.ts'
export {
  LEGACY_COMMAND_CODE_NAMESPACE,
  LEGACY_MODEL_SELECTION_NAMESPACE,
  migrateStoredSubagentConfiguration,
} from './migration.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the roster Remote namespace. */
    subagentRosterController: SubagentRosterController
  }
}

/** What the Remote surface reads from the plugin that owns the live settings. */
export interface SubagentRosterControllerConfig {
  /** Read the live settings section the model-facing tools also read. */
  readonly readSettings: () => SubagentSettings
}

/**
 * Host service backing the generated `ctx.remote.subagentRoster` namespace.
 *
 * It reads the same live settings section the two model-facing tools read, so
 * the page and the next delegation cannot disagree about a saved edit. Every
 * method returns role policy and run bounds only: no credential, provider
 * token, host path, or process output crosses it.
 */
export class SubagentRosterController extends TypertRemoteService {
  static inject = ['typert']

  private readonly readSettings: () => SubagentSettings

  /**
   * @param ctx - Host context carrying the Typert Gateway binding.
   * @param config - the live settings read the roster plugin owns.
   */
  constructor(ctx: Context, config: SubagentRosterControllerConfig) {
    super(ctx, 'subagentRosterController', { namespace: 'subagentRoster' })
    this.readSettings = config.readSettings
  }

  /**
   * Resolve one workspace's enabled roles, with per-field override source.
   *
   * The read itself is synchronous — it resolves the live settings section —
   * so it carries the caller's signal only to refuse a read that was already
   * cancelled rather than to await anything.
   * @param workspace - the Session's workspace path, or null without one.
   * @param signal - caller lifetime; a superseded or unmounted reader cancels its own read.
   * @returns the enabled roles and the canonical workspace key they resolved for.
   * @throws when the caller's read was already cancelled.
   */
  @Remote
  resolvedRoster(workspace: string | null, signal: AbortSignal): SubagentWorkspaceRoster {
    signal.throwIfAborted()
    return resolvedSubagentRoster(this.readSettings(), workspace)
  }

  /**
   * Read the automatic-routing authority a page renders its authorization
   * control from.
   *
   * The read is synchronous for the same reason as {@link resolvedRoster}.
   * @param signal - caller lifetime; a superseded or unmounted reader cancels its own read.
   * @returns whether explicit route selection is accepted, and which exact routes it must resolve to.
   * @throws when the caller's read was already cancelled.
   */
  @Remote
  automaticRouting(signal: AbortSignal): SubagentAutomaticRouting {
    signal.throwIfAborted()
    return automaticRoutingAuthority(this.readSettings())
  }

  /**
   * Read the stored document a page edits: every definition, enabled or not,
   * plus the run bounds.
   *
   * The read is synchronous for the same reason as {@link resolvedRoster}.
   * @param signal - caller lifetime; a superseded or unmounted reader cancels its own read.
   * @returns the stored definitions and run bounds.
   * @throws when the caller's read was already cancelled.
   */
  @Remote
  storedRoster(signal: AbortSignal): SubagentStoredRoster {
    signal.throwIfAborted()
    return storedSubagentRoster(this.readSettings())
  }
}

/** Plugin name. */
export const name = 'subagent-roster'

/** Live role configuration edited through the profile settings form. */
export type Config = Volatile<SubagentSettings>

/** Every role field is editable without replacing a running Session. */
export const Config = z.object({
  subagents: SubagentSettingsFields.subagents,
  overrides: SubagentSettingsFields.overrides,
  automaticRouting: SubagentSettingsFields.automaticRouting,
  limits: SubagentSettingsFields.limits,
}).volatile()

/** Services the roster's tools and settings section compose with. */
export const inject = ['tools', 'subagents', 'agents', 'sessionProjections']

/**
 * Register the roster settings section, its two model-facing tools, and the
 * Remote surface.
 * @param ctx - Context that owns the registrations.
 */
export function apply(ctx: Context, config: Config): void {
  const source = (): SubagentSettings => config.get() as SubagentSettings
  validateSubagentSettings(source())
  ctx.sessionProjections.register(delegationAuthorityProjectionDefinition)
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
    let active = true
    settingsCtx.effect(() => () => { active = false }, 'subagent-roster.legacyMigration()')
    void settingsCtx.settings.whenInitialImportSettles().then(async () => {
      if (active) await migrateStoredSubagentConfiguration(ctx, settingsCtx.settings)
    }).catch((error: unknown) => { ctx.logger.error(error) })
  })
  const limiter = new SubagentRunLimiter(
    () => resolveSubagentConcurrencyLimit(source().limits.maxConcurrentRuns),
  )
  ctx.plugin(SubagentRosterController, { readSettings: () => source() })
  installRosterTools(ctx, {
    viewFor: workspace => subagentRosterView(source(), workspace),
    acquire: signal => limiter.acquire(signal),
  })
}
