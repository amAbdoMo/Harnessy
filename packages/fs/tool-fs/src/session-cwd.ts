/**
 * Resolution options for filesystem calls in the current execution directory.
 * Non-agent calls leave directory defaults to the filesystem provider.
 * @module @deepseek-ai/dsh-tool-fs/session-cwd
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'

/**
 * Validate the calling Agent's current directory without changing its permission root.
 * @param ctx - tool plugin context declaring the working-directory injection.
 * @param exec - tool execution supplying the Agent and cancellation.
 * @returns filesystem resolution options for this call.
 */
export async function sessionResolveOptions(
  ctx: Context,
  exec: Pick<ToolExecution, 'agent' | 'signal'>,
): Promise<{ cwd?: string; signal?: AbortSignal }> {
  const cwd = exec.agent === undefined
    ? undefined
    : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  return { ...cwd === undefined ? {} : { cwd }, signal: exec.signal }
}
