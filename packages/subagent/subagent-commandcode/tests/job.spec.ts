import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { startCommandCodeJob } from '../src/job.ts'
import type { CommandCodeJobApi } from '../src/job.ts'
import type { CommandCodeActivity, CommandCodeHealth, CommandCodeRunSpec } from '../src/types.ts'

const HEALTHY: CommandCodeHealth = { command: 'cmdc', installed: true, authenticated: true }

const SPEC: CommandCodeRunSpec = {
  laneName: 'Review',
  model: 'deepseek/deepseek-v4.1-flash',
  effort: 'default',
  access: 'read-only',
  maxTurns: 60,
  timeoutMs: 3_600_000,
}

/** A registry with one attached controller, so unowned jobs are admissible. */
async function registry(): Promise<JobRegistry> {
  const ctx = new Context()
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('commandcode-job-spec')
  return ctx.jobs
}

interface LiveRun {
  readonly api: CommandCodeJobApi
  /** Whether the CLI was actually started. */
  readonly started: () => boolean
  /** Deliver one coarse activity change through the run's callback. */
  readonly emit: (activity: CommandCodeActivity) => void
  /** Settle the run with a terminal result. */
  readonly settle: (result: SubagentResult) => void
}

/** A run the test settles by hand, standing in for the CLI process. */
function liveRun(health: CommandCodeHealth = HEALTHY): LiveRun {
  const settled = Promise.withResolvers<SubagentResult>()
  let started = false
  let onActivity: ((activity: CommandCodeActivity) => void) | undefined
  const run: SubagentRun = {
    id: 'run-live' as SubagentRun['id'],
    localAgent: undefined,
    result: settled.promise,
    dispose: () => Promise.resolve(),
  }
  return {
    api: {
      preflight: async () => health,
      acquire: async () => () => {},
      start: (_request, _spec, activity) => {
        started = true
        onActivity = activity
        return run
      },
    },
    started: () => started,
    emit: (activity) => { onActivity?.(activity) },
    settle: (result) => { settled.resolve(result) },
  }
}

/** Register one background job on the real registry and hand back its id. */
function register(jobs: JobRegistry, parts: { api: CommandCodeJobApi; label: string }) {
  return jobs.start({
    kind: 'commandcode',
    label: parts.label,
    outputLimitBytes: 12 * 1024,
    run: () => startCommandCodeJob({
      api: parts.api,
      brief: 'Review the change.',
      workspace: process.cwd(),
      spec: SPEC,
      label: parts.label,
    }),
  })
}

/** Wait until a condition holds, without racing the task's own awaits. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
  throw new Error('the awaited condition never held')
}

describe('background delegation against the real job registry', () => {
  it('yields only new coarse activity while the run is live', async () => {
    const jobs = await registry()
    const live = liveRun()
    const id = register(jobs, { api: live.api, label: 'Command Code · Review' })

    // Nothing has happened yet, so there is nothing new to report.
    expect(jobs.read(id).text).toBe('')
    await waitFor(() => live.started())
    live.emit('reading')
    expect(jobs.read(id).text).toBe('Command Code · Review: reading\n')
    // The same category is not repeated.
    expect(jobs.read(id).text).toBe('')
    live.emit('editing')
    expect(jobs.read(id).text).toBe('Command Code · Review: editing\n')

    live.settle({ output: [{ type: 'text', text: 'the answer' }], stopReason: 'completed' })
    await jobs.wait(id, 1_000)
  })

  it('makes the completed final answer collectible after settlement', async () => {
    const jobs = await registry()
    const live = liveRun()
    const label = 'Command Code · Review'
    const id = register(jobs, { api: live.api, label })

    await waitFor(() => live.started())
    live.emit('finalizing')
    expect(jobs.read(id).text).toBe('Command Code · Review: finalizing\n')

    live.settle({ output: [{ type: 'text', text: 'the final answer' }], stopReason: 'completed' })
    await jobs.wait(id, 1_000)

    expect(jobs.read(id).snapshot.status).toBe('completed')
    expect(jobs.read(id).text).toBe('the final answer')
    // A terminal read is idempotent rather than consumed.
    expect(jobs.read(id).text).toBe('the final answer')
  })

  it('exposes the product-owned diagnostic and the preserved partial answer for a failed run', async () => {
    const jobs = await registry()
    const live = liveRun()
    const id = register(jobs, { api: live.api, label: 'Command Code · Review' })

    live.settle({
      output: [{ type: 'text', text: 'partial review notes' }],
      diagnostic: 'Product delegation failure (product: Command Code; stage: run; cause: the run reached its turn limit before a final answer)',
      stopReason: 'error',
    })
    await jobs.wait(id, 1_000)

    const read = jobs.read(id)
    expect(read.snapshot.status).toBe('failed')
    expect(read.text).toContain('Product delegation failure')
    expect(read.text).toContain('the run reached its turn limit before a final answer')
    expect(read.text).toContain('partial review notes')
  })

  it('shows nothing after a killed run, matching a cancelled foreground call', async () => {
    const jobs = await registry()
    const live = liveRun()
    const id = register(jobs, { api: live.api, label: 'Command Code · Review' })

    live.emit('thinking')
    jobs.kill(id, undefined, 'no longer needed')
    live.settle({ output: [], stopReason: 'aborted' })
    await jobs.wait(id, 1_000)

    expect(jobs.read(id).snapshot.status).toBe('killed')
    expect(jobs.read(id).text).toBe('')
  })

  it('fails the job without ever starting the CLI when the probe refuses', async () => {
    const jobs = await registry()
    const live = liveRun({ command: 'cmdc', installed: false, authenticated: false })
    const id = register(jobs, { api: live.api, label: 'Command Code · Review' })

    await jobs.wait(id, 1_000)
    const read = jobs.read(id)
    expect(read.snapshot.status).toBe('failed')
    expect(read.text).toContain('the Command Code CLI is not installed')
    expect(live.started()).toBe(false)
  })
})
