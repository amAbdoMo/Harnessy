/**
 * The backends the roster can route a role to, and which of them report for
 * themselves.
 *
 * A role names its backend in `execution.backend`, and whether Harnessy can ask
 * that backend about its own readiness is a property of the deployment rather
 * than of the roster: some backends answer with their own installation and
 * sign-in state and some have no such surface at all. Keeping the row set a
 * pure projection of those two facts is what stops the page from inventing
 * readiness for a backend that cannot report it.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-subagents/backends
 */

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
