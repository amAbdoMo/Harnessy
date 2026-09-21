import { describe, expect, it } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  commandCodeFailureDiagnostic,
  commandCodeResultText,
  startCommandCodeRun,
} from '../src/run.ts'
import type { CommandCodeRunDeps, CommandCodeRunRequest } from '../src/run.ts'
import type { CommandCodeRunSpec } from '../src/types.ts'
import { fakeChild, type FakeChild } from './fake-child.ts'

/** A lane that finishes in one turn with no effort flag and read-only access. */
function spec(overrides: Partial<CommandCodeRunSpec> = {}): CommandCodeRunSpec {
  return {
    laneName: 'Review',
    model: 'deepseek/deepseek-v4.1-flash',
    effort: 'default',
    access: 'read-only',
    maxTurns: 60,
    timeoutMs: 3_600_000,
    ...overrides,
  }
}

function request(overrides: Partial<CommandCodeRunRequest> = {}): CommandCodeRunRequest {
  return {
    brief: 'Review the change.',
    cwd: process.cwd(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

interface Harness {
  readonly spawned: FakeChild[]
  readonly deps: CommandCodeRunDeps
}

function harness(options: { settleOnTerminate?: boolean } = {}): Harness {
  const spawned: FakeChild[] = []
  return {
    spawned,
    deps: {
      spawn: (spawnSpec: SubprocessSpawnSpec) => {
        const child = fakeChild(spawnSpec, options)
        spawned.push(child)
        return child.handle
      },
      invocation: { program: 'cmdc', prefix: [], source: 'path' },
      graceMs: 3_000,
    },
  }
}

function successFrame(text: string): string {
  return `${JSON.stringify({ type: 'result', subtype: 'success', finalText: text })}\n`
}

async function settled<T>(promise: Promise<T>): Promise<T> {
  return await promise
}

describe('startCommandCodeRun', () => {
  it('runs the lane flags in the delegating workspace and answers with the CLI final text', async () => {
    const { deps, spawned } = harness()
    const run = startCommandCodeRun(request(), spec(), deps)
    const child = spawned[0]!
    expect(child.spec.cwd).toBe(process.cwd())
    expect(child.spec.argv).toEqual([
      'cmdc', '-p', '--output-format', 'json', '--no-session', '--skip-onboarding',
      '--no-auto-update', '--max-turns', '60', '--model', 'deepseek/deepseek-v4.1-flash',
      '--permission-mode', 'plan',
    ])

    child.stdout(successFrame('the review'))
    child.exit()
    const result = await settled(run.result)
    expect(result.stopReason).toBe('completed')
    expect(commandCodeResultText(result)).toBe('the review')
    await run.dispose()
  })

  it('writes the brief to stdin and keeps it out of argv', async () => {
    const { deps, spawned } = harness()
    const run = startCommandCodeRun(request({ brief: 'SECRET BRIEF' }), spec(), deps)
    const child = spawned[0]!
    child.exit()
    await run.result
    expect(Buffer.concat(child.stdin).toString('utf8')).toBe('SECRET BRIEF')
    expect(child.spec.argv.join(' ')).not.toContain('SECRET BRIEF')
    await run.dispose()
  })

  it('starts the run with the CLI update system switched off', async () => {
    const { deps, spawned } = harness()
    const run = startCommandCodeRun(request(), spec(), deps)
    const child = spawned[0]!
    child.exit()
    await run.result

    // `--no-auto-update` covers this run's argv; the environment pin covers the
    // same CLI process before its argument parser exists, so nothing a
    // harness-owned process starts can reach the detached `npm i -g` updater
    // whose console Windows will not hide.
    expect(child.spec.argv).toContain('--no-auto-update')
    expect(child.spec.env).toMatchObject({ COMMANDCODE_SKIP_UPDATES: '1' })
    await run.dispose()
  })

  it('flattens a non-zero exit into a bounded product diagnostic', async () => {
    const { deps, spawned } = harness()
    const run = startCommandCodeRun(request(), spec(), deps)
    spawned[0]!.exit({ exitCode: 3, signal: null })
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('not signed in')
    expect(result.diagnostic).toContain('exit code: 3')
    await run.dispose()
  })

  it('treats truncated output without a result frame as a protocol failure', async () => {
    const { deps, spawned } = harness()
    const run = startCommandCodeRun(request(), spec(), deps)
    spawned[0]!.stdout('{"type":"event","event":{"type":"tool_run')
    spawned[0]!.exit()
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('before producing a final result')
    await run.dispose()
  })

  it('reports a max-turn stop as a failure that preserves the partial answer', async () => {
    const { deps, spawned } = harness()
    const run = startCommandCodeRun(request(), spec(), deps)
    spawned[0]!.stdout(`${JSON.stringify({ type: 'result', subtype: 'max_turns', finalText: 'partial' })}\n`)
    spawned[0]!.exit()
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(commandCodeResultText(result)).toBe('partial')
    expect(result.diagnostic).toContain('turn limit')
    await run.dispose()
  })

  it('refuses to call an empty success a completed answer', async () => {
    const { deps, spawned } = harness()
    const run = startCommandCodeRun(request(), spec(), deps)
    spawned[0]!.stdout(successFrame('   '))
    spawned[0]!.exit()
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('without a final answer')
    await run.dispose()
  })

  it('stops a run that outlives its lane timeout', async () => {
    const { deps, spawned } = harness()
    const run = startCommandCodeRun(request(), spec({ timeoutMs: 5 }), deps)
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('time limit')
    expect(spawned[0]!.terminated()).toBe(true)
    await run.dispose()
  })

  it('settles caller cancellation as aborted and tears the process tree down', async () => {
    const { deps, spawned } = harness()
    const controller = new AbortController()
    const run = startCommandCodeRun(request({ signal: controller.signal }), spec(), deps)
    controller.abort(new Error('user cancelled'))
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(spawned[0]!.terminated()).toBe(true)
    await run.dispose()
  })

  it('bounds the parent-visible text before it can reach the Session', async () => {
    const { deps, spawned } = harness()
    const run = startCommandCodeRun(request(), spec(), deps)
    spawned[0]!.stdout(successFrame('x'.repeat(200_000)))
    spawned[0]!.exit()
    const result = await run.result
    const text = commandCodeResultText(result)
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(12 * 1024)
    expect(text).toContain('[Command Code output truncated]')
    await run.dispose()
  })

  it('reports a spawn failure loudly and publishes no run', () => {
    const deps: CommandCodeRunDeps = {
      spawn: () => { throw new Error('EINVAL') },
      invocation: { program: 'cmdc', prefix: [], source: 'path' },
      graceMs: 3_000,
    }
    expect(() => startCommandCodeRun(request(), spec(), deps)).toThrow(/EINVAL/u)
  })

  it('reports coarse activity without leaking transcript detail', async () => {
    const { deps, spawned } = harness()
    const seen: string[] = []
    const run = startCommandCodeRun(request(), spec(), {
      ...deps,
      onActivity: activity => seen.push(activity),
    })
    spawned[0]!.stdout('{"type":"event","event":{"type":"tool_running","toolName":"edit_file","description":"contents"}}\n')
    spawned[0]!.stdout(successFrame('done'))
    spawned[0]!.exit()
    await run.result
    // Only the two coarse categories, never the tool's description.
    expect(seen).toEqual(['editing', 'finalizing'])
    await run.dispose()
  })

  it('waits for the managed range before returning from disposal', async () => {
    const { deps, spawned } = harness({ settleOnTerminate: false })
    const run = startCommandCodeRun(request(), spec(), deps)
    const child = spawned[0]!
    let released = false
    const disposal = run.dispose().then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)
    child.exit()
    await disposal
    expect(released).toBe(true)
  })
})

describe('commandCodeFailureDiagnostic', () => {
  it('states only fixed facts and the process outcome', () => {
    const text = commandCodeFailureDiagnostic({
      stage: 'run',
      category: 'not-authenticated',
      outcome: { exitCode: 3, signal: null },
    })
    expect(text).toBe(
      'Product delegation failure (product: Command Code; stage: run; cause: the Command Code CLI is not signed in; exit code: 3)',
    )
  })

  it('names the terminating signal when the child was killed', () => {
    const text = commandCodeFailureDiagnostic({
      stage: 'run',
      category: 'timeout',
      outcome: { exitCode: null, signal: 'SIGTERM' },
    })
    expect(text).toContain('signal: SIGTERM')
  })
})
