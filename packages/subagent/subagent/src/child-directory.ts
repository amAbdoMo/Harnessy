/** Child working-directory capture. */
import { isAbsolute } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Capture and validate a child directory before provider preparation.
 * @param parent - The delegating agent.
 * @param requested - Optional child directory.
 * @param signal - Startup cancellation.
 * @returns The absolute directory.
 */
export async function captureChildDirectory(parent: Agent, requested: string | undefined, signal: AbortSignal): Promise<string> {
  const directories = parent.ctx.get('workingDirectory')
  if (directories === undefined) throw new Error('subagents require the working-directory service')
  try {
    if (requested === undefined) return await directories.ensure(parent, signal)
    if (requested.length === 0) throw new Error('subagent directory must not be empty')
    const fs = parent.ctx.get('fs')
    if (fs === undefined) throw new Error('subagents require the filesystem service')
    const base = isAbsolute(requested) ? undefined : await directories.ensure(parent, signal)
    const target = await fs.resolve(requested, { ...base === undefined ? {} : { cwd: base }, signal })
    const info = await fs.stat(target, signal)
    signal.throwIfAborted()
    if (info?.type !== 'directory') throw new Error('subagent directory does not exist')
    return fs.processPath(target)
  } catch (error: unknown) {
    signal.throwIfAborted()
    throw new Error('subagent directory is unavailable', { cause: error })
  }
}
