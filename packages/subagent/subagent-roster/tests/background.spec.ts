/**
 * Background and parallel delegation: the job registers before any await, the
 * shared run gate bounds everything in flight, and every settlement path hands
 * its permit back.
 */

import { describe, expect, it } from 'vitest'
import { JobId } from '@deepseek-ai/dsh-jobs'
import {
  bootRoster,
  delegate,
  definition,
  documentOf,
  stubAgent,
  text,
  waitFor,
} from './harness.ts'
import type { Roster } from './harness.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** The `kind` discriminator of one delegation result, for schedule assertions. */
function outcomeKind(value: JsonValue | undefined): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'kind' in value
    ? value.kind
    : undefined
}

/** A registered root agent the job registry can attribute ownership to. */
let ownerCounter = 0
function owner(roster: Roster) {
  const stub = stubAgent(roster.ctx, `owner-${++ownerCounter}`)
  roster.ctx.agents.register(stub.agent)
  return stub.agent
}

describe('background delegation', () => {
  it('registers the job and returns its id before any admission happens', async () => {
    const roster = await bootRoster({
      jobs: true,
      holdPermit: true,
      settings: documentOf([definition({ id: 'code', execution: { backend: 'spawn', background: 'background' } })]),
    })
    const agent = owner(roster)
    const result = await delegate(roster, { subagent: 'code', task: 'Work.' }, agent)
    expect(result.value).toEqual({ kind: 'background', jobId: 'subagent-1' })
    expect(roster.acquireCalls()).toBe(1)
    // The job exists, the run gate is still holding, and no child was started.
    expect(roster.ctx.jobs.get(JobId('subagent-1'), agent).status).toBe('running')
    expect(roster.requests).toHaveLength(0)

    roster.releasePermit()
    await waitFor(() => roster.requests.length === 1)
    await roster.dispose()
  })

  it.each([
    ['background', 'background', undefined, 'background'],
    ['foreground', 'foreground', undefined, 'foreground'],
    ['auto', 'auto', true, 'background'],
    ['auto', 'auto', false, 'foreground'],
  ] as const)('resolves the %s schedule from the definition and the call', async (_label, background, requested, expected) => {
    const roster = await bootRoster({
      jobs: true,
      settings: documentOf([definition({ id: 'code', execution: { backend: 'spawn', background } })]),
    })
    const result = await delegate(roster, {
      subagent: 'code',
      task: 'Work.',
      ...requested === undefined ? {} : { run_in_background: requested },
    }, owner(roster))
    expect(result.isError).toBe(false)
    expect(outcomeKind(result.value)).toBe(expected)
    await roster.dispose()
  })

  it('refuses a call that puts a foreground definition in the background', async () => {
    const roster = await bootRoster({
      jobs: true,
      settings: documentOf([definition({ id: 'code', execution: { backend: 'spawn', background: 'foreground' } })]),
    })
    const result = await delegate(
      roster,
      { subagent: 'code', task: 'Work.', run_in_background: true },
      owner(roster),
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('runs in the foreground')
    await roster.dispose()
  })

  it('returns the child text in the foreground and never registers a job', async () => {
    const roster = await bootRoster({
      jobs: true,
      settings: documentOf([definition({ id: 'code', execution: { backend: 'spawn', background: 'foreground' } })]),
    })
    const result = await delegate(roster, { subagent: 'code', task: 'Work.' }, owner(roster))
    expect(result.value).toEqual({ kind: 'foreground', text: 'scripted child reply' })
    expect(roster.ctx.jobs.list()).toHaveLength(0)
    expect(roster.inFlight()).toBe(0)
    await roster.dispose()
  })

  it('refuses to run in the background without a job registry', async () => {
    const roster = await bootRoster({
      settings: documentOf(
        [definition({ id: 'code', execution: { backend: 'spawn', background: 'auto' } })],
      ),
    })
    const result = await delegate(
      roster,
      { subagent: 'code', task: 'Work.', run_in_background: true },
      owner(roster),
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('background jobs unavailable')
    expect(roster.acquireCalls()).toBe(0)
    await roster.dispose()
  })

  it('settles a refused background start as a failed job', async () => {
    const roster = await bootRoster({
      jobs: true,
      children: [{ name: 'spawn', refuse: { failure: 'error' } }],
      settings: documentOf(
        [definition({ id: 'code', execution: { backend: 'spawn', background: 'background' } })],
        { limits: { maxConcurrentRuns: 1, defaultTimeoutMs: 3_600_000 } },
      ),
    })
    const agent = owner(roster)
    await delegate(roster, { subagent: 'code', task: 'Work.' }, agent)
    await waitFor(() => roster.ctx.jobs.get(JobId('subagent-1'), agent).status === 'failed')
    expect(roster.ctx.jobs.get(JobId('subagent-1'), agent).detail)
      .toContain('the child failed to start')
    await waitFor(() => roster.inFlight() === 0)
    await roster.dispose()
  })

  it('keeps a cancelled failed cleanup a failure rather than a clean kill', async () => {
    const roster = await bootRoster({
      jobs: true,
      children: [{ name: 'spawn', refuse: { failure: 'aggregate', afterAbort: true } }],
      settings: documentOf(
        [definition({ id: 'code', execution: { backend: 'spawn', background: 'background' } })],
        { limits: { maxConcurrentRuns: 1, defaultTimeoutMs: 3_600_000 } },
      ),
    })
    const agent = owner(roster)
    await delegate(roster, { subagent: 'code', task: 'Work.' }, agent)
    await waitFor(() => roster.requests.length === 1)

    roster.ctx.jobs.kill(JobId('subagent-1'), agent, 'no longer needed')
    await waitFor(() => roster.ctx.jobs.get(JobId('subagent-1'), agent).status === 'failed')
    await waitFor(() => roster.inFlight() === 0)
    await roster.dispose()
  })

  it('advertises a synchronous start through the job label and kind', async () => {
    const roster = await bootRoster({
      jobs: true,
      settings: documentOf([definition({
        id: 'code',
        name: 'Code',
        execution: { backend: 'spawn', background: 'background' },
      })]),
    })
    const agent = owner(roster)
    await delegate(roster, { subagent: 'code', task: 'Work.' }, agent)
    const snapshot = roster.ctx.jobs.get(JobId('subagent-1'), agent)
    expect(snapshot.kind).toBe('subagent')
    expect(snapshot.label).toBe('Code · code')
    await roster.dispose()
  })
})

describe('the shared run gate', () => {
  const held = documentOf(
    [definition({ id: 'code', execution: { backend: 'spawn', background: 'background' } })],
    { limits: { maxConcurrentRuns: 1, defaultTimeoutMs: 3_600_000 } },
  )

  it('admits one delegation at a time and admits the next as the first settles', async () => {
    const roster = await bootRoster({ jobs: true, holdPermit: true, settings: held })
    const agent = owner(roster)
    const first = await delegate(roster, { subagent: 'code', task: 'One.' }, agent)
    const second = await delegate(roster, { subagent: 'code', task: 'Two.' }, agent)
    expect(first.value).toEqual({ kind: 'background', jobId: 'subagent-1' })
    expect(second.value).toEqual({ kind: 'background', jobId: 'subagent-2' })
    // Both reached the gate; only the first may pass it.
    expect(roster.acquireCalls()).toBe(2)
    expect(roster.inFlight()).toBe(0)

    roster.releasePermit()
    await waitFor(() => roster.inFlight() === 1)
    roster.releasePermit()
    await waitFor(() => roster.requests.length === 2)
    await roster.dispose()
  })

  it('holds a background delegation behind the running foreground one', async () => {
    const roster = await bootRoster({
      jobs: true,
      holdPermit: true,
      settings: documentOf(
        [definition({ id: 'code', execution: { backend: 'spawn', background: 'auto' } })],
        { limits: { maxConcurrentRuns: 1, defaultTimeoutMs: 3_600_000 } },
      ),
    })
    const agent = owner(roster)
    const foreground = delegate(
      roster,
      { subagent: 'code', task: 'Foreground.', run_in_background: false },
      agent,
    )
    await waitFor(() => roster.acquireCalls() === 1)
    const background = await delegate(
      roster,
      { subagent: 'code', task: 'Background.', run_in_background: true },
      agent,
    )
    // The job registered immediately while the foreground run still owns the gate.
    expect(background.value).toEqual({ kind: 'background', jobId: 'subagent-1' })
    expect(roster.acquireCalls()).toBe(2)

    roster.releasePermit()
    await waitFor(() => roster.inFlight() === 1)
    roster.releasePermit()
    await expect(foreground).resolves.toMatchObject({ value: { kind: 'foreground' } })
    await waitFor(() => roster.requests.length === 2)
    await roster.dispose()
  })
})

describe('permit release on every settlement path', () => {
  it('bounds a run by its own wall clock and releases the permit', async () => {
    const roster = await bootRoster({
      children: [{ name: 'spawn', hold: true }],
      settings: documentOf([definition({
        id: 'code',
        execution: { backend: 'spawn', background: 'foreground', timeoutMs: 5 },
      })]),
    })
    const result = await delegate(roster, { subagent: 'code', task: 'Work.' }, owner(roster))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('subagent run killed')
    expect(roster.inFlight()).toBe(0)
    await roster.dispose()
  })

  it('returns the permit after a completed foreground run', async () => {
    const roster = await bootRoster({
      settings: documentOf([definition({ id: 'code', execution: { backend: 'spawn', background: 'foreground' } })]),
    })
    await delegate(roster, { subagent: 'code', task: 'Work.' }, owner(roster))
    expect(roster.inFlight()).toBe(0)
    const again = await delegate(roster, { subagent: 'code', task: 'Again.' }, owner(roster))
    expect(again.isError).toBe(false)
    await roster.dispose()
  })

  it('returns the permit after a failed foreground run and still admits the next one', async () => {
    const roster = await bootRoster({
      children: [{ name: 'spawn', stopReason: 'error', diagnostic: 'the child failed' }],
      settings: documentOf([definition({ id: 'code', execution: { backend: 'spawn', background: 'foreground' } })]),
    })
    const failed = await delegate(roster, { subagent: 'code', task: 'Work.' }, owner(roster))
    expect(failed.isError).toBe(true)
    expect(roster.inFlight()).toBe(0)

    const next = await delegate(roster, { subagent: 'code', task: 'Again.' }, owner(roster))
    expect(next.isError).toBe(true)
    // Admitted, so the gate is not stuck: the second run reached the backend.
    expect(roster.requests).toHaveLength(2)
    expect(roster.inFlight()).toBe(0)
    await roster.dispose()
  })

  it('returns the permit when the backend cannot be started at all', async () => {
    const roster = await bootRoster({
      settings: documentOf([definition({
        id: 'code',
        execution: { backend: 'missing', background: 'foreground' },
      })]),
    })
    const result = await delegate(roster, { subagent: 'code', task: 'Work.' }, owner(roster))
    expect(result.isError).toBe(true)
    expect(roster.inFlight()).toBe(0)
    expect(roster.acquireCalls()).toBe(0)
    await roster.dispose()
  })

  it('returns the permit after a killed background job', async () => {
    const roster = await bootRoster({
      jobs: true,
      children: [{ name: 'spawn', hold: true }],
      settings: documentOf(
        [definition({ id: 'code', execution: { backend: 'spawn', background: 'background' } })],
        { limits: { maxConcurrentRuns: 1, defaultTimeoutMs: 3_600_000 } },
      ),
    })
    const agent = owner(roster)
    const started = await delegate(roster, { subagent: 'code', task: 'Work.' }, agent)
    await waitFor(() => roster.requests.length === 1)
    expect(roster.inFlight()).toBe(1)

    expect(roster.ctx.jobs.kill(JobId('subagent-1'), agent, 'no longer needed')).toBe('requested')
    await waitFor(() => roster.ctx.jobs.get(JobId('subagent-1'), agent).status === 'killed')
    await waitFor(() => roster.inFlight() === 0)
    expect(started.value).toEqual({ kind: 'background', jobId: 'subagent-1' })

    // The freed permit admits the next delegation.
    const next = await delegate(roster, { subagent: 'code', task: 'Again.' }, agent)
    expect(next.isError).toBe(false)
    await waitFor(() => roster.requests.length === 2)
    expect(roster.inFlight()).toBe(1)
    await roster.dispose()
  })

  it('settles a kill while the run is queued as killed without starting the child', async () => {
    const roster = await bootRoster({
      jobs: true,
      holdPermit: true,
      settings: documentOf(
        [definition({ id: 'code', execution: { backend: 'spawn', background: 'background' } })],
        { limits: { maxConcurrentRuns: 1, defaultTimeoutMs: 3_600_000 } },
      ),
    })
    const agent = owner(roster)
    await delegate(roster, { subagent: 'code', task: 'Work.' }, agent)
    await waitFor(() => roster.acquireCalls() === 1)
    expect(roster.requests).toHaveLength(0)

    roster.ctx.jobs.kill(JobId('subagent-1'), agent, 'no longer needed')
    await waitFor(() => roster.ctx.jobs.get(JobId('subagent-1'), agent).status === 'killed')
    expect(roster.requests).toHaveLength(0)
    expect(roster.inFlight()).toBe(0)
    await roster.dispose()
  })

  it('returns the permit after a failed background job', async () => {
    const roster = await bootRoster({
      jobs: true,
      children: [{ name: 'spawn', stopReason: 'error', diagnostic: 'the child failed' }],
      settings: documentOf(
        [definition({ id: 'code', execution: { backend: 'spawn', background: 'background' } })],
        { limits: { maxConcurrentRuns: 1, defaultTimeoutMs: 3_600_000 } },
      ),
    })
    const agent = owner(roster)
    await delegate(roster, { subagent: 'code', task: 'Work.' }, agent)
    await waitFor(() => roster.ctx.jobs.get(JobId('subagent-1'), agent).status === 'failed')
    await waitFor(() => roster.inFlight() === 0)

    const next = await delegate(roster, { subagent: 'code', task: 'Again.' }, agent)
    expect(next.isError).toBe(false)
    await waitFor(() => roster.ctx.jobs.get(JobId('subagent-2'), agent).status === 'failed')
    await roster.dispose()
  })
})
