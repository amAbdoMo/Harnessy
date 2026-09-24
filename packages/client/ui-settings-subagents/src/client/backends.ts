/**
 * The backends the roster can route a role to, which of them report for
 * themselves, and what each one's own model space accepts.
 *
 * A role names its backend in `execution.backend`, and whether Harnessy can ask
 * that backend about its own readiness is a property of the deployment rather
 * than of the roster: some backends answer with their own installation and
 * sign-in state and some have no such surface at all. Keeping the row set a
 * pure projection of those two facts is what stops the page from inventing
 * readiness for a backend that cannot report it.
 *
 * A backend that owns its model space also owns the reasoning-effort vocabulary
 * its models accept, because its listing states no levels of its own. That
 * vocabulary lives here beside the backend name rather than in the picker, so a
 * second such backend states its own levels in one more table row.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-subagents/backends
 */

import { COMMAND_CODE_BACKEND } from './contract.ts'
import type { SubagentsKey } from './locales.ts'

/** One backend a role routes to, and whether this deployment answers for it. */
export interface SubagentBackendRow {
  /** Backend name, as a role's `execution.backend` stores it. */
  readonly backend: string
  /** Whether a composed probe reports this backend's own readiness. */
  readonly probed: boolean
}

/**
 * Pair the backends the document names with the backends this deployment
 * answers for, so the block lists every backend a role routes to exactly once.
 * @param named - backends named by the stored roles, in document order.
 * @param probed - backends a composed probe reports, in probe order.
 * @returns one row per backend, probed backends first.
 */
export function subagentBackendRows(
  named: readonly string[],
  probed: readonly string[],
): SubagentBackendRow[] {
  const rows = probed.map((backend): SubagentBackendRow => ({ backend, probed: true }))
  const seen = new Set(probed)
  for (const backend of named) {
    if (seen.has(backend)) continue
    seen.add(backend)
    rows.push({ backend, probed: false })
  }
  return rows
}

/** One reasoning effort a backend's own model space accepts. */
export interface SubagentBackendEffort {
  /** Id the backend accepts verbatim. */
  readonly id: string
  /** Dictionary key of this page's visible label for the level. */
  readonly label: SubagentsKey
}

/**
 * Id standing for the backend's own default: a route carrying it stores no
 * `reasoningEffort`, so the backend runs the level it would otherwise pick.
 *
 * The picker's model-default option means exactly this, so the id never becomes
 * a level of its own and the stored route stays free of a value the backend
 * would only translate back into `--effort`'s absence.
 */
export const SUBAGENT_BACKEND_DEFAULT_EFFORT = 'default'

/** Effort vocabulary each backend fixes for its own model space, in editor order. */
const BACKEND_EFFORTS: Readonly<Record<string, readonly SubagentBackendEffort[]>> = {
  [COMMAND_CODE_BACKEND]: [
    { id: SUBAGENT_BACKEND_DEFAULT_EFFORT, label: 'effortDefault' },
    { id: 'low', label: 'effortLow' },
    { id: 'medium', label: 'effortMedium' },
    { id: 'high', label: 'effortHigh' },
  ],
}

/**
 * The reasoning efforts one backend's own model space accepts.
 *
 * A backend whose routes resolve through Harnessy has no vocabulary here: its
 * levels come from each model's own catalog entry instead.
 * @param backend - the backend a role's `execution.backend` names.
 * @returns that backend's vocabulary in editor order, empty when this page does
 * not own its levels.
 */
export function subagentBackendEfforts(backend: string): readonly SubagentBackendEffort[] {
  return BACKEND_EFFORTS[backend] ?? []
}
