/** Headless snapshot client that cancels Blast Radius through its public band API. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SerializedNode, SurfaceSnapshot } from '@deepseek-ai/dsh-experimental-claude-code-mods'

interface AgentRun {
  readonly controller: AbortController
  done: Promise<void>
  failure: Error | undefined
}

/** Services supplied by the active DSH composition. */
export const inject = ['claudeCodeMods', 'tools']

function cancellation(snapshot: SurfaceSnapshot): string | undefined {
  return snapshot.tree === null ? undefined : cancellationFromNodes(snapshot.tree)
}

function cancellationFromNodes(nodes: readonly SerializedNode[]): string | undefined {
  for (const node of nodes) {
    if (typeof node === 'string') continue
    if (node.type === 'Button' && node.props.label === 'Cancel' && node.actionId !== undefined) {
      return node.actionId
    }
    const actionId = cancellationFromNodes(node.children)
    if (actionId !== undefined) return actionId
  }
  return undefined
}

/**
 * Mount the test client on the root Agent lifecycle and stop it at disposal.
 * @param ctx - the snapshot composition context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Fixture Bash tool: list the two committed files; reject every other command.',
    parameters: {
      command: { type: 'string', required: true },
      description: { type: 'string' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: ({ command }) => {
      if (command === 'ls -1 .') return Promise.resolve('about.txt\nnotes.txt\n')
      throw new Error(`fixture Bash tool refused unexpected execution: ${command}`)
    },
  })), 'blast-radius-cancel.fixture-bash')
  const runs = new Map<Agent, AgentRun>()
  const disposeCreated = ctx.on('agent/created', ({ agent }) => {
    const controller = new AbortController()
    const run: AgentRun = { controller, done: Promise.resolve(), failure: undefined }
    runs.set(agent, run)
    run.done = (async () => {
      for await (const snapshot of ctx.claudeCodeMods.watchBand(agent, controller.signal)) {
        if (snapshot.tree === null) continue
        const actionId = cancellation(snapshot)
        if (actionId === undefined) continue
        await ctx.claudeCodeMods.pressBand(agent, snapshot.generation, actionId)
        controller.abort()
        return
      }
      if (!controller.signal.aborted) throw new Error('Blast Radius band ended before Cancel was available')
    })().catch((error: unknown) => {
      run.failure = error instanceof Error ? error : new Error(String(error))
      process.exitCode = 1
      console.error(`blast-radius-cancel fixture actor failed: ${run.failure.message}`)
    })
  })
  const disposeAgent = ctx.on('agent/disposed', async ({ agent }) => {
    const run = runs.get(agent)
    if (run === undefined) return
    run.controller.abort()
    try {
      await run.done
    } finally {
      runs.delete(agent)
    }
    if (run.failure !== undefined) throw run.failure
  })
  ctx.effect(() => async () => {
    disposeCreated()
    disposeAgent()
    const active = [...runs.values()]
    for (const run of active) run.controller.abort()
    await Promise.allSettled(active.map(run => run.done))
    runs.clear()
    const failures = active.flatMap(run => run.failure === undefined ? [] : [run.failure])
    if (failures.length > 0) throw new AggregateError(failures, 'Blast Radius fixture actor failed')
  }, 'blast-radius-cancel.fixture-actor')
}
