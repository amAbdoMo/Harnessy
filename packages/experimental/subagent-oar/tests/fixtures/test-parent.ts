/** Production parent Agents owned by the calling fixture context. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Mount the parent services and create an idle Agent in the requested workspace.
 * @param ctx - Context whose fixture must dispose it.
 * @param cwd - Parent's existing working directory.
 * @returns The real parent Agent.
 */
export async function externalTestParent(ctx: Context, cwd: string) {
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx)
  return (await mountAgentLoopTestHarness(ctx)).create(SessionId(randomUUID()), {}, { cwd })
}
