/**
 * Sandbox mode vocabulary, separated from the service definition so a
 * type-only consumer can name or validate a mode without loading the seam's
 * Cordis service and its Session import.
 *
 * @module @deepseek-ai/dsh-sandbox/types
 */

/**
 * File-effect policy for confined processes. `read-only` permits only required
 * sinks such as `/dev/null`; `workspace-write` also permits the workspace and a
 * backend-defined temp area; `danger-full-access` bypasses confinement. Network
 * and process visibility are outside this vocabulary.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** A confining (non-`danger-full-access`) mode — the modes a {@link SandboxPolicy} can carry. */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
