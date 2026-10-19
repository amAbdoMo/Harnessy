import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobHooks, JobSpec } from '@deepseek-ai/dsh-jobs'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { ToolDefinition, ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { DEFAULT_COMMAND_CODE_LANES, canonicalWorkspaceKey } from '../src/lanes.ts'
import { commandCodeDelegationView } from '../src/settings.ts'
import { agentHarness, barrier, directoryFixture } from './agent-harness.ts'
import { installCommandCodeTools } from '../src/tools.ts'
import { COMMAND_CODE_DELEGATE_TOOL, COMMAND_CODE_LANES_TOOL } from '../src/tools.ts'
import type { CommandCodeDelegationApi } from '../src/tools.ts'
import type {
  CommandCodeDelegationSettings,
  CommandCodeHealth,
  CommandCodeRunSpec,
} from '../src/types.ts'

const WORKSPACE = process.cwd()
let nextCall = 0

/** The CLI states the tool's preflight can report. */
const HEALTHY: CommandCodeHealth = { command: 'cmdc', installed: true, authenticated: true }
const MISSING: CommandCodeHealth = {
  command: 'cmdc', installed: false, authenticated: false, detail: 'Install Command Code.',
}
const SIGNED_OUT: CommandCodeHealth = {
  command: 'cmdc', installed: true, authenticated: false, detail: 'Run "cmdc login".',
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly createAgent: (id: SessionId) => Promise<Agent>
  readonly tools: Map<string, ToolDefinition>
  readonly jobs: JobSpec[]
  /** The hooks the Job runtime received, one per registered job. */
  readonly started: JobHooks[]
  readonly progress: string[]
  readonly specs: CommandCodeRunSpec[]
  readonly api: CommandCodeDelegationApi
  readonly release: ReturnType<typeof vi.fn>
  readonly permits: () => number
  readonly preflightCalls: () => number
  readonly acquireCalls: () => number
  readonly resolvePreflight: () => void
  readonly resolvePermit: () => void
}

/** A tool registry and Job runtime the tools under test can be driven through. */
async function harness(options: {
  settings?: Partial<CommandCodeDelegationSettings>
  health?: CommandCodeHealth
  start?: (
    request: { readonly signal: AbortSignal; readonly cwd: string },
    spec: CommandCodeRunSpec,
    onActivity: (activity: 'thinking' | 'reading' | 'editing' | 'command' | 'finalizing') => void,
  ) => SubagentRun
  /** Hold the CLI probe until the test releases it or the job is cancelled. */
  holdPreflight?: boolean
  /** Hold concurrency admission until the test releases it or the job is cancelled. */
  holdPermit?: boolean
  /** Leave the real registry without a controller to exercise admission failure. */
  controllerAttached?: boolean
} = {}): Promise<Harness> {
  const { ctx, agents } = await agentHarness()
  const agent = await agents.create(SessionId('commandcode-tool'), {}, { cwd: WORKSPACE })
  await ctx.plugin(LocalJobRegistry)
  if (options.controllerAttached !== false) ctx.effect(() => ctx.jobs.attachController('commandcode-test'))
  const tools = new Map<string, ToolDefinition>()
  const jobs: JobSpec[] = []
  const started: JobHooks[] = []
  const specs: CommandCodeRunSpec[] = []
  const progress: string[] = []
  let permits = 0
  let preflightCalls = 0
  let acquireCalls = 0
  let releasePreflight: (() => void) | undefined
  let releasePermit: (() => void) | undefined
  const release = vi.fn(() => { permits -= 1 })
  const health: CommandCodeHealth = options.health ?? HEALTHY
  const lanes = options.settings?.lanes ?? DEFAULT_COMMAND_CODE_LANES.map(lane => ({ ...lane }))
  const settings: CommandCodeDelegationSettings = {
    maxConcurrentRuns: 2,
    timeoutMs: 3_600_000,
    maxTurns: 60,
    ...options.settings,
    lanes,
    projects: options.settings?.projects ?? {},
  }
  const api: CommandCodeDelegationApi = {
    viewFor: workspace => commandCodeDelegationView(settings, workspace),
    preflight: async (signal) => {
      preflightCalls += 1
      if (options.holdPreflight === true) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
          releasePreflight = resolve
        })
      }
      // The real probe is bounded by its own signal and reports an unusable CLI
      // when that signal aborts.
      return signal.aborted
        ? { command: health.command, installed: false, authenticated: false, detail: 'Command Code was not found.' }
        : health
    },
    acquire: async (signal) => {
      acquireCalls += 1
      if (options.holdPermit === true) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled'))
          }
          signal.addEventListener('abort', onAbort, { once: true })
          releasePermit = () => {
            signal.removeEventListener('abort', onAbort)
            resolve()
          }
        })
      }
      signal.throwIfAborted()
      permits += 1
      return release
    },
    start: (request, spec, onActivity) => {
      specs.push(spec)
      return options.start?.(request, spec, onActivity) ?? completedRun('done')
    },
    onStartError: () => {},
  }
  const register = ctx.jobs.start.bind(ctx.jobs)
  ctx.jobs.start = spec => register({
    ...spec,
    run: (job) => {
      jobs.push(spec)
      const hooks = spec.run(job)
      started.push(hooks)
      return hooks
    },
  })
  ctx.jobs.events.subscribe({ owner: agent.id }, (event) => {
    if (event.type === 'progress' && event.job.progress !== undefined) progress.push(event.job.progress)
  })
  installCommandCodeTools(ctx, api)
  for (const name of [COMMAND_CODE_DELEGATE_TOOL, COMMAND_CODE_LANES_TOOL]) {
    const definition = ctx.tools.get(name)
    if (definition === undefined) throw new Error(`missing registered tool ${name}`)
    tools.set(name, definition)
  }
  return {
    ctx,
    agent,
    createAgent: id => agents.create(id),
    tools,
    jobs,
    started,
    progress,
    specs,
    api,
    release,
    permits: () => permits,
    preflightCalls: () => preflightCalls,
    acquireCalls: () => acquireCalls,
    resolvePreflight: () => { releasePreflight?.() },
    resolvePermit: () => { releasePermit?.() },
  }
}

function completedRun(text: string): SubagentRun {
  return {
    id: 'run-1' as SubagentRun['id'],
    localAgent: undefined,
    result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
    dispose: () => Promise.resolve(),
  }
}

/** A run that settles as aborted when its task signal fires, as a real one does. */
function cancellableRun(signal: AbortSignal): SubagentRun {
  const settled = Promise.withResolvers<SubagentResult>()
  const abort = (): void => { settled.resolve({ output: [], stopReason: 'aborted' }) }
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  return {
    id: 'run-cancellable' as SubagentRun['id'],
    localAgent: undefined,
    result: settled.promise,
    dispose: () => Promise.resolve(),
  }
}

/** Wait until the task under test reached a state, without racing the event loop. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
  throw new Error('the awaited condition never held')
}

/** Invoke one registered tool's executor. */
async function call(
  target: Harness,
  name: string,
  args: Record<string, unknown>,
  exec: Partial<ToolExecutionInput> = {},
): Promise<unknown> {
  const result = await target.ctx.tools.execute({
    callId: ToolCallId(`commandcode-${++nextCall}`),
    agent: target.agent,
    signal: new AbortController().signal,
    name,
    arguments: args,
    ...exec,
  })
  if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(''))
  return result.value
}

/** The JSON-Schema object a `defineTool` call normalizes its parameters into. */
function propertiesOf(target: Harness, name: string): Record<string, unknown> {
  const parameters = target.tools.get(name)?.parameters as { properties?: Record<string, unknown> } | undefined
  return parameters?.properties ?? {}
}

describe('model-facing tool schemas', () => {
  it('registers exactly the two token-stable tools', async () => {
    const { tools } = await harness()
    expect([...tools.keys()].sort()).toEqual([COMMAND_CODE_DELEGATE_TOOL, COMMAND_CODE_LANES_TOOL])
  })

  it('exposes only a lane, a task, and the background choice', async () => {
    const target = await harness()
    expect(Object.keys(propertiesOf(target, COMMAND_CODE_DELEGATE_TOOL)).sort())
      .toEqual(['lane', 'run_in_background', 'task'])
  })

  it('takes no parameters at all for lane discovery', async () => {
    const target = await harness()
    expect(Object.keys(propertiesOf(target, COMMAND_CODE_LANES_TOOL))).toEqual([])
  })
})

describe('list_commandcode_lanes', () => {
  it('reports the enabled directory and nothing else', async () => {
    const target = await harness()
    const lanes = await call(target, COMMAND_CODE_LANES_TOOL, {}) as Array<Record<string, unknown>>
    expect(lanes).toHaveLength(6)
    expect(Object.keys(lanes[0] ?? {}).sort())
      .toEqual(['access', 'effort', 'id', 'model', 'name', 'purpose'])
  })

  it('omits a disabled lane', async () => {
    const target = await harness({
      settings: { lanes: DEFAULT_COMMAND_CODE_LANES.map(lane => lane.id === 'docs' ? { ...lane, enabled: false } : { ...lane }) },
    })
    const lanes = await call(target, COMMAND_CODE_LANES_TOOL, {}) as Array<{ id: string }>
    expect(lanes.map(lane => lane.id)).not.toContain('docs')
  })
})

describe('commandcode_delegate in the background', () => {
  it('registers a job and returns its id before the CLI probe resolves', async () => {
    const target = await harness({ holdPreflight: true })
    const value = await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    expect(value).toEqual({ kind: 'background', jobId: 'commandcode-1' })
    expect(target.jobs).toHaveLength(1)
    expect(target.started).toHaveLength(1)
    // The task is already probing, and the CLI has not been started.
    expect(target.preflightCalls()).toBe(1)
    expect(target.specs).toHaveLength(0)

    target.resolvePreflight()
    await waitFor(() => target.specs.length === 1)
    await expect(target.started[0]!.done).resolves.toEqual({ status: 'completed', result: 'done' })
  })

  it('registers a job and returns its id while the concurrency permit is still queued', async () => {
    const target = await harness({ holdPermit: true })
    const value = await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    expect(value).toEqual({ kind: 'background', jobId: 'commandcode-1' })
    expect(target.jobs).toHaveLength(1)
    expect(target.acquireCalls()).toBe(1)
    // Admission is pending, so neither the probe nor the CLI has run.
    expect(target.preflightCalls()).toBe(0)
    expect(target.specs).toHaveLength(0)

    target.resolvePermit()
    await waitFor(() => target.specs.length === 1)
    await expect(target.started[0]!.done).resolves.toEqual({ status: 'completed', result: 'done' })
    expect(target.permits()).toBe(0)
  })

  it('settles a kill while probing as killed without starting the CLI', async () => {
    const target = await harness({ holdPreflight: true })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    target.started[0]!.cancel('no longer needed')

    await expect(target.started[0]!.done).resolves.toEqual({ status: 'killed' })
    expect(target.specs).toHaveLength(0)
    // The permit it took while probing is returned.
    expect(target.release).toHaveBeenCalledTimes(1)
    expect(target.permits()).toBe(0)
  })

  it('settles a kill while queued as killed and never takes a permit', async () => {
    const target = await harness({ holdPermit: true })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    expect(target.permits()).toBe(0)
    target.started[0]!.cancel()

    await expect(target.started[0]!.done).resolves.toEqual({ status: 'killed' })
    expect(target.specs).toHaveLength(0)
    expect(target.preflightCalls()).toBe(0)
    expect(target.release).not.toHaveBeenCalled()
    expect(target.permits()).toBe(0)
  })

  it('settles a cancelled live run as killed once its process tree is gone', async () => {
    const target = await harness({
      holdPreflight: true,
      start: request => cancellableRun(request.signal),
    })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    target.resolvePreflight()
    await waitFor(() => target.specs.length === 1)

    target.started[0]!.cancel()
    await expect(target.started[0]!.done).resolves.toEqual({ status: 'killed' })
    expect(target.permits()).toBe(0)
    expect(target.release).toHaveBeenCalledTimes(1)
  })

  it('fails the job without a fallback when the CLI is missing', async () => {
    const target = await harness({ health: MISSING })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    const outcome = await target.started[0]!.done
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('Product delegation failure')
    expect(outcome.detail).toContain('the Command Code CLI is not installed')
    expect(target.specs).toHaveLength(0)
    expect(target.permits()).toBe(0)
    expect(target.release).toHaveBeenCalledTimes(1)
  })

  it('fails the job without a fallback when the CLI is not signed in', async () => {
    const target = await harness({ health: SIGNED_OUT })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    const outcome = await target.started[0]!.done
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('the Command Code CLI is not signed in')
    expect(target.specs).toHaveLength(0)
    expect(target.permits()).toBe(0)
  })

  it('fails the job with bounded product-owned detail when the process cannot start', async () => {
    const target = await harness({ start: () => { throw new Error('spawn EINVAL at C:\\host\\path') } })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    const outcome = await target.started[0]!.done
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('the Command Code process could not be started')
    // The host cause never reaches the job's detail.
    expect(outcome.detail).not.toContain('EINVAL')
    expect(outcome.detail).not.toContain('C:\\host\\path')
    expect(target.permits()).toBe(0)
    expect(target.release).toHaveBeenCalledTimes(1)
  })

  it('reports the completed output and returns the permit', async () => {
    const target = await harness()
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    await expect(target.started[0]!.done).resolves.toEqual({ status: 'completed', result: 'done' })
    expect(target.release).toHaveBeenCalledTimes(1)
    expect(target.permits()).toBe(0)
  })

  it('returns the final answer in the terminal job outcome', async () => {
    const target = await harness({ start: () => completedRun('the answer') })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    const hooks = target.started[0]!
    await expect(hooks.done).resolves.toEqual({ status: 'completed', result: 'the answer' })
  })

  it('returns the failure diagnostic and partial answer in the terminal outcome', async () => {
    const target = await harness({
      start: () => ({
        id: 'run-failed' as SubagentRun['id'],
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: 'partial findings' }],
          diagnostic: 'Product delegation failure (product: Command Code; stage: run; cause: the delegation failed)',
          stopReason: 'error',
        }),
        dispose: () => Promise.resolve(),
      }),
    })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    const hooks = target.started[0]!
    const outcome = await hooks.done
    expect(outcome.result).toContain('Product delegation failure')
    expect(outcome.result).toContain('partial findings')
  })

  it('returns a start-time failure detail in the terminal outcome', async () => {
    const target = await harness({ health: MISSING })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    const hooks = target.started[0]!
    expect((await hooks.done).result).toContain('the Command Code CLI is not installed')
  })

  it('shows nothing after a killed background job', async () => {
    const target = await harness({ holdPreflight: true })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    const hooks = target.started[0]!
    hooks.cancel()
    await expect(hooks.done).resolves.toEqual({ status: 'killed' })
  })

  it('labels the job, caps its output, and carries the lane the user configured', async () => {
    const target = await harness()
    const value = await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'docs', task: 'Document it.' })
    expect(value).toEqual({ kind: 'background', jobId: 'commandcode-1' })
    expect(target.jobs[0]?.kind).toBe('commandcode')
    expect(target.jobs[0]?.label).toBe('Command Code · Docs')
    expect(target.jobs[0]?.outputLimitBytes).toBe(12 * 1024)

    await waitFor(() => target.specs.length === 1)
    expect(target.specs[0]).toEqual({
      laneName: 'Docs',
      model: 'deepseek/deepseek-v4.1-flash',
      effort: 'default',
      access: 'full-access',
      maxTurns: 60,
      timeoutMs: 3_600_000,
    })
  })

  it('reports coarse activity through the job handle while the run is live', async () => {
    const target = await harness({
      start: (_request, _spec, onActivity) => {
        onActivity('reading')
        return completedRun('done')
      },
    })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    await target.started[0]!.done
    expect(target.progress).toEqual(['Command Code · Review: reading'])
  })

  it('requires a valid enabled lane and never auto-classifies', async () => {
    const target = await harness()
    await expect(call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'ghost', task: 'x' }))
      .rejects.toThrow(/no Command Code lane "ghost" exists/u)
    const disabled = await harness({
      settings: { lanes: [{ ...DEFAULT_COMMAND_CODE_LANES[1]!, enabled: false }] },
    })
    await expect(call(disabled, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'x' }))
      .rejects.toThrow(/is disabled/u)
    expect(target.jobs).toHaveLength(0)
    expect(disabled.jobs).toHaveLength(0)
  })

  it('uses the directory-service fallback without an original project', async () => {
    const target = await harness()
    const agent = await target.createAgent(SessionId('commandcode-no-project'))
    await expect(call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'x' }, { agent }))
      .resolves.toEqual({ kind: 'background', jobId: 'commandcode-1' })
    await expect(target.started[0]!.done).resolves.toMatchObject({ status: 'completed' })
    expect(agent.session.header.cwd).toBeUndefined()
  })

  it.each([false, true])('captures cwd before admission while preserving project lane policy (background=%s)', async (background) => {
    const directories = await directoryFixture()
    const preflight = barrier()
    const permit = barrier()
    const starts: string[] = []
    const target = await harness({
      settings: {
        projects: {
          [canonicalWorkspaceKey(WORKSPACE)]: { lanes: { review: { model: 'original-model', access: 'read-only' } } },
          [canonicalWorkspaceKey(directories.captured)]: { lanes: { review: { model: 'other-model', access: 'full-access' } } },
        },
      },
      start: (request) => { starts.push(request.cwd); return completedRun('done') },
    })
    const probe = target.api.preflight.bind(target.api)
    const acquire = target.api.acquire.bind(target.api)
    target.api.preflight = async (signal) => { await preflight.wait(); return probe(signal) }
    target.api.acquire = async (signal) => { await permit.wait(); return acquire(signal) }
    const captured = await target.ctx.workingDirectory.set(target.agent, directories.captured)
    const pending = call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'x', run_in_background: background })
    const first = background ? permit : preflight
    const second = background ? preflight : permit
    try {
      await first.entered
      expect(starts).toEqual([])
      await target.ctx.workingDirectory.set(target.agent, directories.preflight)
      first.release()
      await second.entered
      expect(starts).toEqual([])
      const current = await target.ctx.workingDirectory.set(target.agent, directories.permit)
      second.release()
      await pending
      if (background) await target.started[0]!.done
      expect(starts).toEqual([captured])
      expect(target.specs[0]).toMatchObject({ model: 'original-model', access: 'read-only' })
      expect(target.agent.session.header.cwd).toBe(WORKSPACE)
      expect(target.ctx.workingDirectory.get(target.agent.session)).toBe(current)
      expect(target.permits()).toBe(0)
    } finally {
      preflight.release()
      permit.release()
      await pending
      if (background) await target.started[0]?.done
    }
  })

  it('takes no permit when the Job cannot be registered', async () => {
    const target = await harness({ controllerAttached: false })
    await expect(call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'x' }))
      .rejects.toThrow(/no job controller serves this agent/u)
    expect(target.acquireCalls()).toBe(0)
    expect(target.release).not.toHaveBeenCalled()
  })
})

describe('commandcode_delegate in the foreground', () => {
  it('waits for the same one-shot run when asked to', async () => {
    const target = await harness({ start: () => completedRun('reviewed') })
    const value = await call(target, COMMAND_CODE_DELEGATE_TOOL, {
      lane: 'review', task: 'Review it.', run_in_background: false,
    })
    expect(value).toEqual({ kind: 'foreground', text: 'reviewed' })
    expect(target.jobs).toHaveLength(0)
    expect(target.release).toHaveBeenCalledTimes(1)
    expect(target.permits()).toBe(0)
  })

  it('refuses to delegate when the Command Code CLI is missing, with no fallback', async () => {
    const target = await harness({ health: MISSING })
    await expect(call(target, COMMAND_CODE_DELEGATE_TOOL, {
      lane: 'review', task: 'x', run_in_background: false,
    })).rejects.toThrow(/Install Command Code\./u)
    expect(target.specs).toHaveLength(0)
    expect(target.jobs).toHaveLength(0)
  })

  it('refuses to delegate when the CLI is not signed in', async () => {
    const target = await harness({ health: SIGNED_OUT })
    await expect(call(target, COMMAND_CODE_DELEGATE_TOOL, {
      lane: 'review', task: 'x', run_in_background: false,
    })).rejects.toThrow(/cmdc login/u)
    expect(target.specs).toHaveLength(0)
  })

  it('reports a failed foreground run with its bounded diagnostic', async () => {
    const target = await harness({
      start: () => ({
        id: 'run-2' as SubagentRun['id'],
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: 'partial' }],
          diagnostic: 'Product delegation failure (product: Command Code; stage: run; cause: the delegation failed)',
          stopReason: 'error',
        }),
        dispose: () => Promise.resolve(),
      }),
    })
    await expect(call(target, COMMAND_CODE_DELEGATE_TOOL, {
      lane: 'review', task: 'x', run_in_background: false,
    })).rejects.toThrow(/Product delegation failure.*partial/su)
    expect(target.release).toHaveBeenCalledTimes(1)
  })

  it('returns the concurrency permit when the run cannot be started', async () => {
    const target = await harness({ start: () => { throw new Error('spawn failed') } })
    await expect(call(target, COMMAND_CODE_DELEGATE_TOOL, {
      lane: 'review', task: 'x', run_in_background: false,
    })).rejects.toThrow(/spawn failed/u)
    expect(target.permits()).toBe(0)
    expect(target.release).toHaveBeenCalledTimes(1)
  })

  it('awaits the run result before disposing it, so a live run is never cancelled by cleanup', async () => {
    const settled = Promise.withResolvers<SubagentResult>()
    let disposed = false
    const target = await harness({
      start: () => ({
        id: 'run-live' as SubagentRun['id'],
        localAgent: undefined,
        result: settled.promise,
        dispose: () => {
          disposed = true
          // Disposal terminates the managed range, so a run that has not
          // answered yet settles as aborted exactly as a real process does.
          settled.resolve({ output: [], stopReason: 'aborted' })
          return Promise.resolve()
        },
      }),
    })

    const pending = call(target, COMMAND_CODE_DELEGATE_TOOL, {
      lane: 'review', task: 'x', run_in_background: false,
    })
    await waitFor(() => target.specs.length === 1)

    // The run is still working; disposing it here would have cancelled it.
    expect(disposed).toBe(false)
    settled.resolve({ output: [{ type: 'text', text: 'answered' }], stopReason: 'completed' })

    await expect(pending).resolves.toEqual({ kind: 'foreground', text: 'answered' })
    expect(disposed).toBe(true)
    expect(target.permits()).toBe(0)
    expect(target.release).toHaveBeenCalledTimes(1)
  })

  it('reports a disposal failure without hiding an independent run failure', async () => {
    const target = await harness({
      start: () => ({
        id: 'run-both' as SubagentRun['id'],
        localAgent: undefined,
        result: Promise.resolve({
          output: [],
          diagnostic: 'Product delegation failure (product: Command Code; stage: run; cause: the delegation failed)',
          stopReason: 'error',
        }),
        dispose: () => Promise.reject(new Error('teardown failed')),
      }),
    })
    await expect(call(target, COMMAND_CODE_DELEGATE_TOOL, {
      lane: 'review', task: 'x', run_in_background: false,
    })).rejects.toThrow(/Product delegation failure[\s\S]*teardown failed/u)
    expect(target.release).toHaveBeenCalledTimes(1)
  })
})
