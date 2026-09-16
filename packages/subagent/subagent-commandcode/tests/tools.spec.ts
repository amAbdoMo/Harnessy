import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHooks, JobStart } from '@deepseek-ai/dsh-jobs'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { DEFAULT_COMMAND_CODE_LANES, resolveLanes } from '../src/lanes.ts'
import { installCommandCodeTools } from '../src/tools.ts'
import { COMMAND_CODE_DELEGATE_TOOL, COMMAND_CODE_LANES_TOOL } from '../src/tools.ts'
import type { CommandCodeDelegationApi } from '../src/tools.ts'
import type {
  CommandCodeDelegationSettings,
  CommandCodeHealth,
  CommandCodeRunSpec,
  ResolvedCommandCodeLane,
} from '../src/types.ts'

const WORKSPACE = process.cwd()

/** The CLI states the tool's preflight can report. */
const HEALTHY: CommandCodeHealth = { command: 'cmdc', installed: true, authenticated: true }
const MISSING: CommandCodeHealth = {
  command: 'cmdc', installed: false, authenticated: false, detail: 'Install Command Code.',
}
const SIGNED_OUT: CommandCodeHealth = {
  command: 'cmdc', installed: true, authenticated: false, detail: 'Run "cmdc login".',
}

interface Harness {
  readonly tools: Map<string, ToolDefinition>
  readonly jobs: JobStart[]
  /** The hooks the Job runtime received, one per registered job. */
  readonly started: JobHooks[]
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
function harness(options: {
  settings?: Partial<CommandCodeDelegationSettings>
  health?: CommandCodeHealth
  start?: (request: { readonly signal: AbortSignal }, spec: CommandCodeRunSpec) => SubagentRun
  /** Hold the CLI probe until the test releases it or the job is cancelled. */
  holdPreflight?: boolean
  /** Hold concurrency admission until the test releases it or the job is cancelled. */
  holdPermit?: boolean
  /** Register the job, returning its id; the default registers and runs it. */
  jobStart?: (spec: JobStart) => string
} = {}): Harness {
  const tools = new Map<string, ToolDefinition>()
  const jobs: JobStart[] = []
  const started: JobHooks[] = []
  const specs: CommandCodeRunSpec[] = []
  let permits = 0
  let preflightCalls = 0
  let acquireCalls = 0
  let releasePreflight: (() => void) | undefined
  let releasePermit: (() => void) | undefined
  const release = vi.fn(() => { permits -= 1 })
  const health: CommandCodeHealth = options.health ?? HEALTHY
  const lanes = options.settings?.lanes ?? DEFAULT_COMMAND_CODE_LANES.map(lane => ({ ...lane }))
  const resolved: ResolvedCommandCodeLane[] = resolveLanes({
    maxConcurrentRuns: 2,
    timeoutMs: 3_600_000,
    maxTurns: 60,
    lanes,
    projects: options.settings?.projects ?? {},
  }, null)
  const api: CommandCodeDelegationApi = {
    viewFor: () => ({
      workspaceKey: null,
      maxConcurrentRuns: 2,
      timeoutMs: 3_600_000,
      maxTurns: 60,
      lanes: resolved,
    }),
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
    start: (request, spec) => {
      specs.push(spec)
      return options.start?.(request, spec) ?? completedRun('done')
    },
    onStartError: () => {},
  }
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { tools.set(definition.name, definition); return () => {} } },
    get: (name: string) => name === 'jobs'
      ? {
        start: (spec: JobStart) => {
          if (options.jobStart !== undefined) return options.jobStart(spec)
          jobs.push(spec)
          // The real registry runs the starter synchronously before it returns.
          started.push(spec.run())
          return `commandcode-${jobs.length}`
        },
      }
      : undefined,
  } as unknown as Context
  installCommandCodeTools(ctx, api)
  return {
    tools,
    jobs,
    started,
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

function execution(stub: Partial<ToolExecution> = {}): ToolExecution {
  const agent = { session: { header: { cwd: WORKSPACE } } } as unknown as Agent
  return { agent, signal: new AbortController().signal, ...stub } as unknown as ToolExecution
}

/** Invoke one registered tool's executor. */
async function call(
  target: Harness,
  name: string,
  args: Record<string, unknown>,
  exec: ToolExecution = execution(),
): Promise<unknown> {
  const definition = target.tools.get(name)
  if (definition?.execute === undefined) throw new Error(`tool ${name} has no executor`)
  return await definition.execute(args, exec as never)
}

/** The JSON-Schema object a `defineTool` call normalizes its parameters into. */
function propertiesOf(target: Harness, name: string): Record<string, unknown> {
  const parameters = target.tools.get(name)?.parameters as { properties?: Record<string, unknown> } | undefined
  return parameters?.properties ?? {}
}

describe('model-facing tool schemas', () => {
  it('registers exactly the two token-stable tools', () => {
    const { tools } = harness()
    expect([...tools.keys()].sort()).toEqual([COMMAND_CODE_DELEGATE_TOOL, COMMAND_CODE_LANES_TOOL])
  })

  it('exposes only a lane, a task, and the background choice', () => {
    const target = harness()
    expect(Object.keys(propertiesOf(target, COMMAND_CODE_DELEGATE_TOOL)).sort())
      .toEqual(['lane', 'run_in_background', 'task'])
  })

  it('takes no parameters at all for lane discovery', () => {
    const target = harness()
    expect(Object.keys(propertiesOf(target, COMMAND_CODE_LANES_TOOL))).toEqual([])
  })
})

describe('list_commandcode_lanes', () => {
  it('reports the enabled directory and nothing else', async () => {
    const target = harness()
    const lanes = await call(target, COMMAND_CODE_LANES_TOOL, {}) as Array<Record<string, unknown>>
    expect(lanes).toHaveLength(6)
    expect(Object.keys(lanes[0] ?? {}).sort())
      .toEqual(['access', 'effort', 'id', 'model', 'name', 'purpose'])
  })

  it('omits a disabled lane', async () => {
    const target = harness({
      settings: { lanes: DEFAULT_COMMAND_CODE_LANES.map(lane => lane.id === 'docs' ? { ...lane, enabled: false } : { ...lane }) },
    })
    const lanes = await call(target, COMMAND_CODE_LANES_TOOL, {}) as Array<{ id: string }>
    expect(lanes.map(lane => lane.id)).not.toContain('docs')
  })
})

describe('commandcode_delegate in the background', () => {
  it('registers a job and returns its id before the CLI probe resolves', async () => {
    const target = harness({ holdPreflight: true })
    const value = await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    expect(value).toEqual({ kind: 'background', jobId: 'commandcode-1' })
    expect(target.jobs).toHaveLength(1)
    expect(target.started).toHaveLength(1)
    // The task is already probing, and the CLI has not been started.
    expect(target.preflightCalls()).toBe(1)
    expect(target.specs).toHaveLength(0)

    target.resolvePreflight()
    await waitFor(() => target.specs.length === 1)
    await expect(target.started[0]!.done).resolves.toEqual({ status: 'completed', output: 'done' })
  })

  it('registers a job and returns its id while the concurrency permit is still queued', async () => {
    const target = harness({ holdPermit: true })
    const value = await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    expect(value).toEqual({ kind: 'background', jobId: 'commandcode-1' })
    expect(target.jobs).toHaveLength(1)
    expect(target.acquireCalls()).toBe(1)
    // Admission is pending, so neither the probe nor the CLI has run.
    expect(target.preflightCalls()).toBe(0)
    expect(target.specs).toHaveLength(0)

    target.resolvePermit()
    await waitFor(() => target.specs.length === 1)
    await expect(target.started[0]!.done).resolves.toEqual({ status: 'completed', output: 'done' })
    expect(target.permits()).toBe(0)
  })

  it('settles a kill while probing as killed without starting the CLI', async () => {
    const target = harness({ holdPreflight: true })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    target.started[0]!.cancel('no longer needed')

    await expect(target.started[0]!.done).resolves.toEqual({ status: 'killed' })
    expect(target.specs).toHaveLength(0)
    // The permit it took while probing is returned.
    expect(target.release).toHaveBeenCalledTimes(1)
    expect(target.permits()).toBe(0)
  })

  it('settles a kill while queued as killed and never takes a permit', async () => {
    const target = harness({ holdPermit: true })
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
    const target = harness({
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
    const target = harness({ health: MISSING })
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
    const target = harness({ health: SIGNED_OUT })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    const outcome = await target.started[0]!.done
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('the Command Code CLI is not signed in')
    expect(target.specs).toHaveLength(0)
    expect(target.permits()).toBe(0)
  })

  it('fails the job with bounded product-owned detail when the process cannot start', async () => {
    const target = harness({ start: () => { throw new Error('spawn EINVAL at C:\\host\\path') } })
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
    const target = harness()
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    await expect(target.started[0]!.done).resolves.toEqual({ status: 'completed', output: 'done' })
    expect(target.release).toHaveBeenCalledTimes(1)
    expect(target.permits()).toBe(0)
  })

  it('makes the final answer readable through the job hook after settlement', async () => {
    const target = harness({ start: () => completedRun('the answer') })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    const hooks = target.started[0]!
    await hooks.done
    // The registry only reaches a producer's `output` when no `readOutput` is
    // exposed, so the terminal text has to come from the hook itself.
    expect(hooks.readOutput?.()).toBe('the answer')
    expect(hooks.readOutput?.()).toBe('the answer')
  })

  it('makes the failure diagnostic and partial answer readable through the job hook', async () => {
    const target = harness({
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
    await hooks.done
    expect(hooks.readOutput?.()).toContain('Product delegation failure')
    expect(hooks.readOutput?.()).toContain('partial findings')
  })

  it('makes a start-time failure detail readable through the job hook', async () => {
    const target = harness({ health: MISSING })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    const hooks = target.started[0]!
    await hooks.done
    expect(hooks.readOutput?.()).toContain('the Command Code CLI is not installed')
  })

  it('shows nothing after a killed background job', async () => {
    const target = harness({ holdPreflight: true })
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    const hooks = target.started[0]!
    hooks.cancel()
    await expect(hooks.done).resolves.toEqual({ status: 'killed' })
    expect(hooks.readOutput?.()).toBe('')
  })

  it('labels the job, caps its output, and carries the lane the user configured', async () => {
    const target = harness()
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

  it('streams only a coarse activity while the background run is live', async () => {
    const target = harness()
    await call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'Review it.' })
    expect(target.started[0]!.readOutput?.()).toBe('')
    await target.started[0]!.done
  })

  it('requires a valid enabled lane and never auto-classifies', async () => {
    const target = harness()
    await expect(call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'ghost', task: 'x' }))
      .rejects.toThrow(/no Command Code lane "ghost" exists/u)
    const disabled = harness({
      settings: { lanes: [{ ...DEFAULT_COMMAND_CODE_LANES[1]!, enabled: false }] },
    })
    await expect(call(disabled, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'x' }))
      .rejects.toThrow(/is disabled/u)
    expect(target.jobs).toHaveLength(0)
    expect(disabled.jobs).toHaveLength(0)
  })

  it('refuses to delegate without a session workspace', async () => {
    const target = harness()
    const agent = { session: { header: {} } } as unknown as Agent
    await expect(call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'x' }, execution({ agent })))
      .rejects.toThrow(/needs a session workspace/u)
    expect(target.jobs).toHaveLength(0)
  })

  it('takes no permit when the Job cannot be registered', async () => {
    const target = harness({ jobStart: () => { throw new Error('no controller attached') } })
    await expect(call(target, COMMAND_CODE_DELEGATE_TOOL, { lane: 'review', task: 'x' }))
      .rejects.toThrow(/no controller attached/u)
    expect(target.acquireCalls()).toBe(0)
    expect(target.release).not.toHaveBeenCalled()
  })
})

describe('commandcode_delegate in the foreground', () => {
  it('waits for the same one-shot run when asked to', async () => {
    const target = harness({ start: () => completedRun('reviewed') })
    const value = await call(target, COMMAND_CODE_DELEGATE_TOOL, {
      lane: 'review', task: 'Review it.', run_in_background: false,
    })
    expect(value).toEqual({ kind: 'foreground', text: 'reviewed' })
    expect(target.jobs).toHaveLength(0)
    expect(target.release).toHaveBeenCalledTimes(1)
    expect(target.permits()).toBe(0)
  })

  it('refuses to delegate when the Command Code CLI is missing, with no fallback', async () => {
    const target = harness({ health: MISSING })
    await expect(call(target, COMMAND_CODE_DELEGATE_TOOL, {
      lane: 'review', task: 'x', run_in_background: false,
    })).rejects.toThrow(/Install Command Code\./u)
    expect(target.specs).toHaveLength(0)
    expect(target.jobs).toHaveLength(0)
  })

  it('refuses to delegate when the CLI is not signed in', async () => {
    const target = harness({ health: SIGNED_OUT })
    await expect(call(target, COMMAND_CODE_DELEGATE_TOOL, {
      lane: 'review', task: 'x', run_in_background: false,
    })).rejects.toThrow(/cmdc login/u)
    expect(target.specs).toHaveLength(0)
  })

  it('reports a failed foreground run with its bounded diagnostic', async () => {
    const target = harness({
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
    const target = harness({ start: () => { throw new Error('spawn failed') } })
    await expect(call(target, COMMAND_CODE_DELEGATE_TOOL, {
      lane: 'review', task: 'x', run_in_background: false,
    })).rejects.toThrow(/spawn failed/u)
    expect(target.permits()).toBe(0)
    expect(target.release).toHaveBeenCalledTimes(1)
  })

  it('awaits the run result before disposing it, so a live run is never cancelled by cleanup', async () => {
    const settled = Promise.withResolvers<SubagentResult>()
    let disposed = false
    const target = harness({
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
    const target = harness({
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
