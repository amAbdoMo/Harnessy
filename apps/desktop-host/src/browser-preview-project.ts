/** Resolve the project from Host-owned chat membership and directory metadata. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-workspace'

/** @param ctx - Desktop Host with the workspace registry. @param agent - live browser caller.
 * @returns the owning registered Workspace, including for delegated work.
 */
export async function browserPreviewProject(ctx: Context, agent: Agent): Promise<WorkspaceId | undefined> {
  const workspaces = ctx.workspaceRegistry.list()
  let session = agent.session
  let project = workspaces.find(workspace => workspace.sessionIds.includes(session.id))
  const seen = new Set([session.id])
  for (let parent = session.header.parentSession; parent !== undefined && !seen.has(parent); parent = session.header.parentSession) {
    seen.add(parent)
    project = workspaces.find(workspace => workspace.sessionIds.includes(parent)) ?? project
    const live = ctx.agents.get(parent)?.session
    if (live === undefined) break
    session = live
  }
  if (project !== undefined) return project.id
  const directory = session.header.cwd
  if (directory === undefined || workspaces.length === 0) return undefined
  try { return (await ctx.workspaceRegistry.resolveByPath(directory))?.id }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}
