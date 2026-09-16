import { describe, expect, it } from 'vitest'
import { CommandCodeRunLimiter } from '../src/limiter.ts'
import {
  CommandCodeDelegationSchema,
  commandCodeDelegationView,
  DEFAULT_COMMAND_CODE_MAX_CONCURRENT_RUNS,
  DEFAULT_COMMAND_CODE_MAX_TURNS,
  DEFAULT_COMMAND_CODE_TIMEOUT_MS,
  requireEnabledLane,
} from '../src/settings.ts'
import type { CommandCodeDelegationSettings } from '../src/types.ts'

/** Validate one raw settings document through the namespace schema. */
function parse(value: object): CommandCodeDelegationSettings {
  // The schema's input position is typed as the resolved section; these tests
  // deliberately feed the raw, partially specified documents a user writes.
  return CommandCodeDelegationSchema(value as CommandCodeDelegationSettings)
}

describe('CommandCodeDelegationSchema', () => {
  it('supplies the documented defaults for an empty document', () => {
    const settings = parse({})
    expect(settings.maxConcurrentRuns).toBe(DEFAULT_COMMAND_CODE_MAX_CONCURRENT_RUNS)
    expect(settings.timeoutMs).toBe(DEFAULT_COMMAND_CODE_TIMEOUT_MS)
    expect(settings.maxTurns).toBe(DEFAULT_COMMAND_CODE_MAX_TURNS)
    expect(settings.lanes.map(lane => lane.id))
      .toEqual(['code', 'review', 'tests', 'docs', 'research', 'architecture'])
    expect(settings.projects).toEqual({})
  })

  it('rejects a concurrency cap outside the supported range', () => {
    expect(() => parse({ maxConcurrentRuns: 0 })).toThrow()
    expect(() => parse({ maxConcurrentRuns: 99 })).toThrow()
  })

  it('rejects a lane id that is not an argv-safe token', () => {
    expect(() => parse({ lanes: [{ id: 'Not Ok', name: 'x', purpose: 'y', model: 'm' }] })).toThrow()
  })

  it('keeps a user lane and its workspace override', () => {
    const settings = parse({
      lanes: [{ id: 'perf', name: 'Perf', purpose: 'Measure.', model: 'local/m', effort: 'high', access: 'full-access' }],
      projects: { '/work': { lanes: { perf: { model: 'local/other' } } } },
    })
    expect(settings.lanes[0]?.effort).toBe('high')
    expect(settings.projects['/work']?.lanes.perf?.model).toBe('local/other')
    expect(settings.projects['/work']?.lanes.perf?.access).toBeUndefined()
  })
})

describe('commandCodeDelegationView', () => {
  it('resolves one workspace and reports its canonical key', () => {
    const view = commandCodeDelegationView(parse({}), '/tmp')
    expect(view.workspaceKey).toBe(view.workspaceKey?.toLowerCase() ?? view.workspaceKey)
    expect(view.lanes).toHaveLength(6)
    expect(view.maxTurns).toBe(DEFAULT_COMMAND_CODE_MAX_TURNS)
  })

  it('carries no workspace key when the session has no workspace', () => {
    expect(commandCodeDelegationView(parse({}), null).workspaceKey).toBeNull()
  })
})

describe('requireEnabledLane', () => {
  it('returns an enabled lane', () => {
    const view = commandCodeDelegationView(parse({}), null)
    expect(requireEnabledLane(view, 'review').access).toBe('read-only')
  })

  it('rejects an unknown lane and names the configured ones', () => {
    const view = commandCodeDelegationView(parse({}), null)
    expect(() => requireEnabledLane(view, 'nope')).toThrow(/no Command Code lane "nope" exists; configured lanes: code/u)
  })

  it('rejects a disabled lane', () => {
    const view = commandCodeDelegationView(
      parse({ lanes: [{ id: 'code', name: 'Code', purpose: 'p', model: 'm', enabled: false }] }),
      null,
    )
    expect(() => requireEnabledLane(view, 'code')).toThrow(/is disabled/u)
  })

  it('rejects a lane with no model', () => {
    const view = commandCodeDelegationView(
      parse({ lanes: [{ id: 'code', name: 'Code', purpose: 'p', model: 'm' }] }),
      null,
    )
    expect(() => requireEnabledLane({ ...view, lanes: view.lanes.map(lane => ({ ...lane, model: ' ' })) }, 'code'))
      .toThrow(/no model/u)
  })
})

describe('CommandCodeRunLimiter', () => {
  it('admits up to the live cap and then waits', async () => {
    let cap = 2
    const limiter = new CommandCodeRunLimiter(() => cap)
    const signal = new AbortController().signal
    const first = await limiter.acquire(signal)
    const second = await limiter.acquire(signal)
    let third = false
    const pending = limiter.acquire(signal).then((release) => { third = true; return release })
    await Promise.resolve()
    expect(third).toBe(false)

    first()
    const thirdRelease = await pending
    expect(third).toBe(true)

    second()
    thirdRelease()
    cap = 2
  })

  it('releases once no matter how often the permit is invoked', async () => {
    const limiter = new CommandCodeRunLimiter(() => 1)
    const signal = new AbortController().signal
    const release = await limiter.acquire(signal)
    release()
    release()
    const next = limiter.acquire(signal)
    await expect(next).resolves.toBeTypeOf('function')
    ;(await next)()
  })

  it('refuses to admit work for an already-cancelled caller', async () => {
    const limiter = new CommandCodeRunLimiter(() => 1)
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(limiter.acquire(controller.signal)).rejects.toThrow(/cancelled/u)
  })

  it('stops waiting when the caller cancels', async () => {
    const limiter = new CommandCodeRunLimiter(() => 1)
    const held = await limiter.acquire(new AbortController().signal)
    const controller = new AbortController()
    const waiting = limiter.acquire(controller.signal)
    controller.abort(new Error('cancelled while waiting'))
    await expect(waiting).rejects.toThrow(/cancelled while waiting/u)
    held()
  })

  it('reads the cap on every admission, so lowering it applies to the next run', async () => {
    let cap = 3
    const limiter = new CommandCodeRunLimiter(() => cap)
    const signal = new AbortController().signal
    const held = [await limiter.acquire(signal), await limiter.acquire(signal), await limiter.acquire(signal)]
    cap = 1
    let admitted = false
    const pending = limiter.acquire(signal).then((release) => { admitted = true; return release })
    await Promise.resolve()
    expect(admitted).toBe(false)
    // A lowered cap admits nothing until in-flight work drains below it.
    held[0]?.()
    held[1]?.()
    await Promise.resolve()
    expect(admitted).toBe(false)
    held[2]?.()
    const release = await pending
    expect(admitted).toBe(true)
    release()
  })
})
