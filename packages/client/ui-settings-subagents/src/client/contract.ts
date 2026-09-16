/**
 * Browser-safe vocabulary of the `subagent-roster` settings section.
 *
 * This module imports nothing from the Host half, so the browser bundle inlines
 * it whole. The namespace name and the option lists are the facts the Client and
 * the Host registration must agree on; each list carries a `satisfies` clause so
 * the compiler proves it still covers the stored domain, and the id pattern is
 * the one the Host's own validator applies.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-subagents/contract
 */

import type { SubagentDefinition } from '@deepseek-ai/dsh-api-remotes/client'

/** Settings namespace owning the subagent role directory. */
export const SUBAGENT_ROSTER_NAMESPACE = 'subagent-roster'

/** The access vocabulary one definition may name, `inherit` included, in editor order. */
export const SUBAGENT_ACCESS_MODES = [
  'inherit', 'read-only', 'workspace-write', 'danger-full-access',
] as const satisfies readonly SubagentDefinition['access'][]

/** One definition's sandbox access as the editor offers it. */
export type SubagentAccessMode = SubagentDefinition['access']

/** How the parent agent may invoke one role, in editor order. */
export const SUBAGENT_INVOCATION_POLICIES = [
  'automatic', 'ask-first', 'manual',
] as const satisfies readonly SubagentDefinition['invocation'][]

/** One definition's invocation policy as the editor offers it. */
export type SubagentInvocationPolicy = SubagentDefinition['invocation']

/** How one role's execution schedule is fixed, in editor order. */
export const SUBAGENT_BACKGROUND_POLICIES = ['auto', 'foreground', 'background'] as const satisfies readonly SubagentDefinition['execution']['background'][]

/** One definition's background policy as the editor offers it. */
export type SubagentBackgroundPolicy = SubagentDefinition['execution']['background']

/**
 * Role ids are argv-safe tokens the model names verbatim. Mirrors the Host's
 * `SUBAGENT_ID_PATTERN`, so an id this page derives is one the Host accepts.
 */
export const SUBAGENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u

/**
 * Backend a definition this page creates starts on. Mirrors the Host's
 * `DEFAULT_SUBAGENT_BACKEND`: the in-process spawn provider every deployment
 * composes, so a definition the page adds is one the Host can act on.
 */
export const SUBAGENT_DEFAULT_BACKEND = 'spawn'

/**
 * Backend whose model ids come from its own CLI catalog rather than from the
 * composed Harnessy runtime.
 *
 * Mirrors the fixed registry name `dsh-subagent-commandcode` registers on
 * `ctx.subagents`, because a stored role's `execution.backend` names it and the
 * model picker has to recognize it to read the catalog its routes belong to.
 */
export const COMMAND_CODE_BACKEND = 'commandcode'
