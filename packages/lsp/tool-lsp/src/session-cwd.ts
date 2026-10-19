/**
 * Resolve an `lsp` call in the calling Session's current directory.
 * Agentless calls fail as `LSP_WORKSPACE_REQUIRED`; the provider validates
 * the resolved directory before starting a language server.
 * @module @deepseek-ai/dsh-tool-lsp/session-cwd
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * The session workspace cwd for this call, or `undefined` when none applies.
 * @param ctx - consumer context injecting the working-directory service.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the calling agent's current directory, or undefined for a non-agent caller.
 */
export function sessionCwd(ctx: Context, exec: ToolExecution): string | undefined {
  return exec.agent === undefined ? undefined : ctx.workingDirectory.get(exec.agent.session)
}
