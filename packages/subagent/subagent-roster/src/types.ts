/**
 * Public vocabulary for the unified subagent roster: the role a user edits in
 * Settings, the resolved role one workspace actually delegates through, and
 * the compact directory entry the model reads.
 *
 * Role policy is user data, so every resolved value carries its own
 * provenance: {@link SubagentDefinition} is what is stored, and
 * {@link ResolvedSubagentDefinition} is what one workspace runs.
 *
 * @module @deepseek-ai/dsh-subagent-roster/types
 */

import type { SubagentAccess } from '@deepseek-ai/dsh-subagent/client'
import type { AllowedModelRoute } from '@deepseek-ai/dsh-tool-subagent/types'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools/types'

/** How the parent agent may invoke one subagent. */
export type SubagentInvocationPolicy = 'automatic' | 'ask-first' | 'manual'

/**
 * Where one subagent's model comes from. `fixed` is the default: the user owns
 * the route, and only an explicit per-definition `automatic` opt-in lets the
 * parent agent choose one.
 */
export type SubagentModelMode = 'fixed' | 'automatic'

/** How one definition's execution schedule is fixed. */
export type SubagentBackgroundPolicy = 'auto' | 'foreground' | 'background'

/**
 * One exact LLM route plus the reasoning effort that belongs to it. The effort
 * travels with the route because changing the model must re-validate it.
 */
export interface SubagentModelRoute extends AllowedModelRoute {
  /** Adapter-owned reasoning effort; omission uses the selected model's own default. */
  readonly reasoningEffort?: string
}

/** Where one subagent's model comes from and, when fixed, which route it is. */
export interface SubagentModelPolicy {
  /** Defaults to `fixed`, which leaves the parent no say; `automatic` is an opt-in per definition. */
  readonly mode: SubagentModelMode
  /**
   * The exact route a `fixed` definition pins. An omitted route contributes
   * none, so the child inherits the calling parent's resolved route while the
   * parent still may not choose another.
   */
  readonly route?: SubagentModelRoute
}

/** Where one subagent's work physically runs. */
export interface SubagentExecution {
  /** The `ctx.subagents` provider name that establishes the child. */
  readonly backend: string
  /** Which schedule the parent's `run_in_background` defaults to, and what it may force. */
  readonly background: SubagentBackgroundPolicy
  /** Wall-clock bound in milliseconds for one delegation; omission uses the run limit. */
  readonly timeoutMs?: number
}

/** One subagent role as stored in the user's settings document. */
export interface SubagentDefinition {
  /** Stable id the model names; immutable across renames. */
  readonly id: string
  /** Display name shown in Settings and in background job labels. */
  readonly name: string
  /** Whether the role is offered in the directory and accepted for delegation. */
  readonly enabled: boolean
  /** One-line purpose the directory reports. */
  readonly purpose: string
  /** Routing guidance telling the parent when this role is the right one. */
  readonly whenToUse: string
  /** How the parent may invoke this role. */
  readonly invocation: SubagentInvocationPolicy
  /** This role's model policy. */
  readonly model: SubagentModelPolicy
  /** Sandbox access the child is narrowed to; `inherit` keeps the parent's effective mode. */
  readonly access: SubagentAccess
  /** Tool scoping applied to the child; omission leaves its tool set unscoped. */
  readonly tools?: ToolRestriction
  /** Standing instructions delivered as the child's persona. */
  readonly instructions: string
  /** Optional absolute delegation-depth cap for the child. */
  readonly maxDepth?: number
  /** Backend and schedule. */
  readonly execution: SubagentExecution
}

/** Fields one workspace may override on a global definition; omitted fields are inherited. */
export type SubagentDefinitionOverride = Partial<Omit<SubagentDefinition, 'id'>>

/** One workspace's overrides, keyed by the global definition id they patch. */
export interface SubagentWorkspaceOverride {
  /** Global definition id to the field patch replacing that definition's global values. */
  readonly subagents: Record<string, SubagentDefinitionOverride>
  /** Definition ids this workspace removes entirely. */
  readonly removed?: readonly string[]
}

/** Which LLM routes a parent may select for an `automatic` role. */
export interface SubagentAutomaticRouting {
  /** Whether an explicit route selection is accepted at all. */
  readonly enabled: boolean
  /** Exact routes an explicit selection must resolve to. */
  readonly allowedModels: AllowedModelRoute[]
}

/** Run bounds shared by every role. */
export interface SubagentRunLimits {
  /** Delegations allowed in flight together, foreground and background. */
  readonly maxConcurrentRuns: number
  /** Wall-clock bound used by a definition that names none. */
  readonly defaultTimeoutMs: number
}

/** The complete subagent roster settings section. */
export interface SubagentSettings {
  /** Global role definitions. */
  readonly subagents: SubagentDefinition[]
  /** Per-workspace role overrides keyed by canonical workspace path. */
  readonly overrides: Record<string, SubagentWorkspaceOverride>
  /** Authority for `automatic` model selection. */
  readonly automaticRouting: SubagentAutomaticRouting
  /** Run bounds. */
  readonly limits: SubagentRunLimits
}

/** Per-field provenance of one resolved definition, so an editor can offer a reset. */
export interface SubagentDefinitionOverrides {
  name: boolean
  purpose: boolean
  whenToUse: boolean
  invocation: boolean
  model: boolean
  access: boolean
  tools: boolean
  instructions: boolean
  maxDepth: boolean
  execution: boolean
  enabled: boolean
}

/** One definition after the global and workspace layers are applied. */
export interface ResolvedSubagentDefinition extends SubagentDefinition {
  /** Which fields the current workspace overrides rather than inherits. */
  readonly overrides: SubagentDefinitionOverrides
}

/** Everything one workspace's tools and Settings read. */
export interface SubagentRosterView {
  /** Canonical workspace key the roster was resolved for; null without a workspace. */
  readonly workspaceKey: string | null
  /** Every stored definition with this workspace's overrides applied, including disabled ones. */
  readonly subagents: ResolvedSubagentDefinition[]
  /** Effective automatic-routing authority. */
  readonly automaticRouting: SubagentAutomaticRouting
  /** Effective run bounds. */
  readonly limits: SubagentRunLimits
}

/**
 * One enabled role as a configuration surface reads it: the values a
 * delegation would actually run with, plus the provenance that tells an editor
 * which of them came from the workspace override layer.
 */
export interface SubagentRoleView {
  /** Stable id the model names and the override layer keys on. */
  id: string
  /** Display name, after the workspace layer is applied. */
  name: string
  /** One-line purpose, after the workspace layer is applied. */
  purpose: string
  /** Routing guidance, after the workspace layer is applied. */
  whenToUse: string
  /** Invocation policy, after the workspace layer is applied. */
  invocation: SubagentInvocationPolicy
  /** Resolved model policy: the mode plus the route it pins, when it pins one. */
  model: SubagentModelPolicy
  /** Resolved sandbox access. */
  access: SubagentAccess
  /** Resolved backend and schedule. */
  execution: SubagentExecution
  /** Which fields this workspace overrides rather than inherits. */
  overrides: SubagentDefinitionOverrides
}

/** Every enabled role of one workspace, resolved against that workspace's override layer. */
export interface SubagentWorkspaceRoster {
  /** Canonical workspace key the roles were resolved for; null without a workspace. */
  workspaceKey: string | null
  /** Enabled roles only; a disabled definition stays in the stored document. */
  subagents: SubagentRoleView[]
}

/** The stored document a configuration surface edits: every definition and the run bounds. */
export interface SubagentStoredRoster {
  /** Every stored definition, enabled or not. */
  subagents: SubagentDefinition[]
  /** Stored run bounds. */
  limits: SubagentRunLimits
}

/** One directory row the model reads, with instruction text and storage detail removed. */
export interface SubagentDirectoryEntry {
  id: string
  name: string
  purpose: string
  whenToUse: string
  invocation: SubagentInvocationPolicy
  /** The exact resolved route, or `inherit` when the definition contributes none. */
  model: string
  /** The route's reasoning effort, when the resolved route names one. */
  reasoningEffort?: string
  /** The access the child is narrowed to, or `inherit`. */
  access: SubagentAccess
  background: SubagentBackgroundPolicy
}
