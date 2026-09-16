/**
 * The live `subagent-roster` settings section: global role definitions,
 * per-workspace role overrides, the automatic-routing authority, and the run
 * bounds. Everything here is read through on every delegation, so a saved edit
 * applies to the next one without a restart.
 *
 * @module @deepseek-ai/dsh-subagent-roster/settings
 */

import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { AllowedModelRouteSchema } from '@deepseek-ai/dsh-tool-subagent/model-selection'
import {
  DEFAULT_SUBAGENT_AUTOMATIC_ROUTING,
  DEFAULT_SUBAGENT_LIMITS,
  defaultSubagentDefinitions,
  MAX_SUBAGENT_CONCURRENT_RUNS,
} from './defaults.ts'
import type {
  ResolvedSubagentDefinition,
  SubagentAutomaticRouting,
  SubagentBackgroundPolicy,
  SubagentDefinition,
  SubagentDefinitionOverride,
  SubagentModelMode,
  SubagentRosterView,
  SubagentSettings,
  SubagentStoredRoster,
  SubagentWorkspaceOverride,
  SubagentWorkspaceRoster,
} from './types.ts'

/** Settings namespace owning the subagent role directory. */
export const SUBAGENT_ROSTER_NAMESPACE = 'subagent-roster'

/** Role ids are argv-safe tokens; the model names one verbatim. */
export const SUBAGENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u

/** The access vocabulary one definition may name, `inherit` included. */
const SUBAGENT_ACCESS_MODES = ['inherit', 'read-only', 'workspace-write', 'danger-full-access'] as const

/**
 * The object one route schema resolves to. An omitted route is stored as an
 * absent key, and schemastery types a default by its declared shape, so this
 * names the shape whose omission an `undefined` default preserves.
 */
type RouteFields = { provider: string; model: string; reasoningEffort: string }

/** The object the model-policy schema resolves to, one route included. */
type ModelPolicyFields = { mode: SubagentModelMode; route: RouteFields }

/** The object the execution schema resolves to. */
type ExecutionFields = { backend: string; background: SubagentBackgroundPolicy; timeoutMs: number }

/** What one stored tool restriction resolves to, absent when the user named none. */
type ToolRestrictionFields = { allow: string[]; deny: string[] }

/**
 * The object one stored definition resolves to. schemastery types every
 * declared key as present even where omission is the intended value, so this
 * names the shape the omissions are cast against.
 */
type DefinitionFields = Omit<SubagentDefinition, 'model' | 'tools' | 'maxDepth' | 'execution'> & {
  model: ModelPolicyFields
  tools: ToolRestrictionFields
  maxDepth: number
  execution: ExecutionFields
}

const modelRouteSchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  // Omitted means the selected model resolves its own default effort.
  reasoningEffort: z.string(),
})

// Omission is the whole point of this field: a `fixed` definition that names no
// route contributes none, so the child inherits the parent's resolved route
// without the parent being able to change it.
const modelPolicySchema = z.object({
  mode: z.union(['fixed', 'automatic'] as const).default('fixed'),
  route: modelRouteSchema.default(undefined as unknown as RouteFields),
})

// Preserve omission; an empty `{ allow: [] }` would deny every tool.
const toolRestrictionSchema = z.object({
  allow: z.array(z.string()).default(undefined as unknown as string[]),
  deny: z.array(z.string()).default(undefined as unknown as string[]),
}).default(undefined as unknown as ToolRestrictionFields)

const executionSchema = z.object({
  backend: z.string().required(),
  background: z.union(['auto', 'foreground', 'background'] as const).default('auto'),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS),
})

const definitionSchema = z.object({
  id: z.string().required().pattern(SUBAGENT_ID_PATTERN),
  name: z.string().required(),
  enabled: z.boolean().default(true),
  purpose: z.string().required(),
  whenToUse: z.string().default(''),
  invocation: z.union(['automatic', 'ask-first', 'manual'] as const).default('automatic'),
  model: modelPolicySchema,
  access: z.union(SUBAGENT_ACCESS_MODES).default('inherit'),
  tools: toolRestrictionSchema,
  instructions: z.string().default(''),
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER),
  execution: executionSchema,
})

// Every field is optional: an override records only what the user changed, and
// omission is what makes the field inherit from the global definition. None of
// these fields carries a default, because a defaulted field would overwrite the
// global value it exists to inherit from.
const definitionOverrideSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  purpose: z.string(),
  whenToUse: z.string(),
  invocation: z.union(['automatic', 'ask-first', 'manual'] as const),
  model: z.object({
    mode: z.union(['fixed', 'automatic'] as const).default('fixed'),
    route: modelRouteSchema.default(undefined as unknown as RouteFields),
  }).default(undefined as unknown as ModelPolicyFields),
  access: z.union(SUBAGENT_ACCESS_MODES),
  tools: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }).default(undefined as unknown as ToolRestrictionFields),
  instructions: z.string(),
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER),
  execution: z.object({
    backend: z.string(),
    background: z.union(['auto', 'foreground', 'background'] as const),
    timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS),
  }).default(undefined as unknown as ExecutionFields),
})

const workspaceOverrideSchema = z.object({
  subagents: z.dict(definitionOverrideSchema).default({}),
  removed: z.array(z.string()),
})

/**
 * Schema shared by the Host registration and the settings transport. The cast
 * states the one place schemastery's inferred type cannot describe the domain
 * type: a stored tool restriction holds readonly name arrays, which the
 * schema's `string[]` cannot express, while a stored value is always read from
 * that schema in the first place.
 */
export const SubagentSettingsSchema: z<SubagentSettings> = z.object({
  subagents: z.array(definitionSchema).default(defaultSubagentDefinitions() as unknown as DefinitionFields[]),
  overrides: z.dict(workspaceOverrideSchema).default({}),
  automaticRouting: z.object({
    enabled: z.boolean().default(DEFAULT_SUBAGENT_AUTOMATIC_ROUTING.enabled),
    allowedModels: z.array(AllowedModelRouteSchema).default([]),
  }).default(DEFAULT_SUBAGENT_AUTOMATIC_ROUTING),
  limits: z.object({
    maxConcurrentRuns: z.number().step(1).min(1).max(MAX_SUBAGENT_CONCURRENT_RUNS)
      .default(DEFAULT_SUBAGENT_LIMITS.maxConcurrentRuns),
    defaultTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS)
      .default(DEFAULT_SUBAGENT_LIMITS.defaultTimeoutMs),
  }).default(DEFAULT_SUBAGENT_LIMITS),
}) as unknown as z<SubagentSettings>

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
 * Apply one workspace's override layer to the global definitions. Omitted
 * fields are inherited, so an override records only what the user actually
 * changed, a stale key naming a definition that no longer exists contributes
 * nothing, and a `removed` id disappears for this workspace alone.
 * @param settings - the complete settings section.
 * @param workspaceKey - canonical workspace key, or null without a workspace.
 * @returns every stored definition with its per-field provenance.
 */
export function resolveSubagentRoster(
  settings: SubagentSettings,
  workspaceKey: string | null,
): ResolvedSubagentDefinition[] {
  const project = workspaceKey === null ? undefined : settings.overrides[workspaceKey]
  const removed = new Set(project?.removed ?? [])
  return settings.subagents
    .filter(definition => !removed.has(definition.id))
    .map((definition) => {
      const override: SubagentDefinitionOverride | undefined = project?.subagents[definition.id]
      const fromOverride = (field: keyof SubagentDefinitionOverride): boolean =>
        override !== undefined && override[field] !== undefined
      const tools = override?.tools ?? definition.tools
      const maxDepth = override?.maxDepth ?? definition.maxDepth
      return {
        id: definition.id,
        name: override?.name ?? definition.name,
        enabled: override?.enabled ?? definition.enabled,
        purpose: override?.purpose ?? definition.purpose,
        whenToUse: override?.whenToUse ?? definition.whenToUse,
        invocation: override?.invocation ?? definition.invocation,
        model: override?.model ?? definition.model,
        access: override?.access ?? definition.access,
        ...tools === undefined ? {} : { tools },
        instructions: override?.instructions ?? definition.instructions,
        ...maxDepth === undefined ? {} : { maxDepth },
        execution: override?.execution ?? definition.execution,
        overrides: {
          name: fromOverride('name'),
          enabled: fromOverride('enabled'),
          purpose: fromOverride('purpose'),
          whenToUse: fromOverride('whenToUse'),
          invocation: fromOverride('invocation'),
          model: fromOverride('model'),
          access: fromOverride('access'),
          tools: fromOverride('tools'),
          instructions: fromOverride('instructions'),
          maxDepth: fromOverride('maxDepth'),
          execution: fromOverride('execution'),
        },
      }
    })
}

/**
 * Read the automatic-routing authority a configuration surface authorizes
 * explicit route selection through.
 * @param settings - the complete settings section.
 * @returns the enabled flag and the authorized routes, detached from the section.
 */
export function automaticRoutingAuthority(settings: SubagentSettings): SubagentAutomaticRouting {
  return {
    enabled: settings.automaticRouting.enabled,
    allowedModels: settings.automaticRouting.allowedModels.map(route => ({ ...route })),
  }
}

/**
 * Resolve one workspace's complete roster view, the read the model-facing
 * tools and every configuration surface share.
 * @param settings - the complete settings section.
 * @param workspace - the Session's workspace path, or null without one.
 * @returns the resolved definitions, routing authority, and run bounds.
 */
export function subagentRosterView(settings: SubagentSettings, workspace: string | null): SubagentRosterView {
  const workspaceKey = workspace === null ? null : canonicalWorkspaceKey(workspace)
  return {
    workspaceKey,
    subagents: resolveSubagentRoster(settings, workspaceKey),
    automaticRouting: automaticRoutingAuthority(settings),
    limits: { ...settings.limits },
  }
}

/**
 * Project one workspace's resolved roster into the roles a configuration
 * surface shows: the enabled ones, each carrying the values a delegation would
 * run with and the per-field provenance an editor offers a reset from.
 *
 * A definition this workspace removed disappears here exactly as it does for
 * the model's directory, because both read the same resolution.
 * @param settings - the complete settings section.
 * @param workspace - the Session's workspace path, or null without one.
 * @returns the enabled roles and the workspace key they resolved for.
 */
export function resolvedSubagentRoster(
  settings: SubagentSettings,
  workspace: string | null,
): SubagentWorkspaceRoster {
  const view = subagentRosterView(settings, workspace)
  return {
    workspaceKey: view.workspaceKey,
    subagents: view.subagents
      .filter(definition => definition.enabled)
      .map(definition => ({
        id: definition.id,
        name: definition.name,
        purpose: definition.purpose,
        whenToUse: definition.whenToUse,
        invocation: definition.invocation,
        model: definition.model,
        access: definition.access,
        execution: definition.execution,
        overrides: definition.overrides,
      })),
  }
}

/**
 * Read the stored document a configuration surface edits: every definition,
 * including one this workspace disabled or removed, plus the run bounds.
 * @param settings - the complete settings section.
 * @returns the stored definitions and run bounds, detached from the section.
 */
export function storedSubagentRoster(settings: SubagentSettings): SubagentStoredRoster {
  return {
    subagents: settings.subagents.map(definition => structuredClone(definition)),
    limits: { ...settings.limits },
  }
}

/**
 * Read one enabled definition for the current workspace, or fail loud.
 * @param view - the workspace's resolved roster view.
 * @param id - the definition id the model named.
 * @returns the enabled definition, with its workspace overrides applied.
 * @throws {Error} when no stored definition has that id, or the definition is disabled.
 */
export function requireEnabledSubagent(view: SubagentRosterView, id: string): ResolvedSubagentDefinition {
  const definition = view.subagents.find(candidate => candidate.id === id)
  if (definition === undefined) {
    const known = view.subagents.map(candidate => candidate.id).join(', ')
    throw new Error(
      known.length === 0
        ? `no subagent "${id}" exists; no subagents are configured`
        : `no subagent "${id}" exists; configured subagents: ${known}`,
    )
  }
  if (!definition.enabled) throw new Error(`subagent "${id}" is disabled`)
  if (definition.execution.backend.trim().length === 0) {
    throw new Error(`subagent "${id}" has no backend configured`)
  }
  return definition
}

/** Reject one definition the resolver cannot act on. */
function assertDefinition(id: string, definition: SubagentDefinition | SubagentDefinitionOverride): void {
  if (!SUBAGENT_ID_PATTERN.test(id)) {
    throw new TypeError(`subagent-roster: "${id}" is not a valid subagent id (expected ${String(SUBAGENT_ID_PATTERN)})`)
  }
  const name = definition.name
  if (name !== undefined && name.trim().length === 0) {
    throw new TypeError(`subagent-roster: subagent "${id}" needs a non-blank name`)
  }
  const purpose = definition.purpose
  if (purpose !== undefined && purpose.trim().length === 0) {
    throw new TypeError(`subagent-roster: subagent "${id}" needs a non-blank purpose`)
  }
  const backend = definition.execution?.backend
  if (backend !== undefined && backend.trim().length === 0) {
    throw new TypeError(`subagent-roster: subagent "${id}" needs a non-blank backend`)
  }
  const route = definition.model?.route
  if (route !== undefined) {
    // A route is passed to an adapter verbatim, so whitespace is unusable
    // rather than an acceptable value to discover at delegation time.
    if (route.provider.trim().length === 0) {
      throw new TypeError(`subagent-roster: subagent "${id}" needs a non-blank route provider`)
    }
    if (route.model.trim().length === 0) {
      throw new TypeError(`subagent-roster: subagent "${id}" needs a non-blank route model`)
    }
  }
}

/**
 * Reject a stored roster the resolver cannot act on. Called from the settings
 * registration, so an unusable value fails the write that introduces it rather
 * than the next delegation.
 * @param settings - the section a writer is about to persist.
 * @throws {TypeError} for a duplicate id, a malformed definition or override, or unusable run bounds.
 */
export function validateSubagentSettings(settings: SubagentSettings): void {
  const ids = new Set<string>()
  for (const definition of settings.subagents) {
    if (ids.has(definition.id)) {
      throw new TypeError(`subagent-roster: duplicate subagent id "${definition.id}"`)
    }
    ids.add(definition.id)
    assertDefinition(definition.id, definition)
  }
  if (settings.automaticRouting.enabled && settings.automaticRouting.allowedModels.length === 0) {
    throw new TypeError('subagent-roster: enabled automatic routing needs at least one allowed model')
  }
  for (const [workspace, project] of Object.entries(settings.overrides)) {
    if (workspace.length === 0) throw new TypeError('subagent-roster: an override key must not be empty')
    assertWorkspaceOverride(workspace, project)
  }
}

/** Reject one workspace's override layer. */
function assertWorkspaceOverride(workspace: string, project: SubagentWorkspaceOverride): void {
  for (const id of project.removed ?? []) {
    if (!SUBAGENT_ID_PATTERN.test(id)) {
      throw new TypeError(`subagent-roster: "${workspace}" removes an invalid subagent id "${id}"`)
    }
  }
  for (const [id, override] of Object.entries(project.subagents)) {
    assertDefinition(id, override)
  }
}
