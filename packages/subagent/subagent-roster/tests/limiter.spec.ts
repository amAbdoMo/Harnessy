/**
 * The shared run gate: the bounded admission every delegation passes through,
 * including the cancellation and release paths that keep it from wedging.
 */

import { describe, expect, it } from 'vitest'
import { SubagentRunLimiter } from '../src/limiter.ts'

/** Let any queued admission settle, without depending on a timer. */
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

describe('SubagentRunLimiter', () => {
  it('admits up to the live cap and then holds the next caller', async () => {
    const cap = 2
    const limiter = new SubagentRunLimiter(() => cap)
    const signal = new AbortController().signal
    const first = await limiter.acquire(signal)
    const second = await limiter.acquire(signal)
    let third = false
    const pending = limiter.acquire(signal).then((release) => { third = true; return release })
    await tick()
    expect(third).toBe(false)

    first()
    const thirdRelease = await pending
    expect(third).toBe(true)

    second()
    thirdRelease()
  })

  it('releases once no matter how often the permit is invoked', async () => {
    const limiter = new SubagentRunLimiter(() => 1)
    const signal = new AbortController().signal
    const release = await limiter.acquire(signal)
    release()
    release()
    const next = await limiter.acquire(signal)
    expect(typeof next).toBe('function')
    next()
  })

  it('refuses to admit work for an already-cancelled caller', async () => {
    const limiter = new SubagentRunLimiter(() => 1)
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(limiter.acquire(controller.signal)).rejects.toThrow('cancelled')
  })

  it('stops waiting when the caller cancels, naming the cancellation', async () => {
    const limiter = new SubagentRunLimiter(() => 1)
    const held = await limiter.acquire(new AbortController().signal)
    const controller = new AbortController()
    const waiting = limiter.acquire(controller.signal)
    controller.abort(new Error('cancelled while waiting'))
    await expect(waiting).rejects.toThrow('cancelled while waiting')
    held()
  })

  it('publishes a stable failure for a caller that aborts with a non-Error reason', async () => {
    const limiter = new SubagentRunLimiter(() => 1)
    const held = await limiter.acquire(new AbortController().signal)
    const controller = new AbortController()
    const waiting = limiter.acquire(controller.signal)
    controller.abort('no longer needed')
    await expect(waiting).rejects.toThrow('subagent-roster: delegation cancelled')
    held()
  })

  it('leaves no slot behind for a caller that cancelled while queued', async () => {
    const limiter = new SubagentRunLimiter(() => 1)
    const signal = new AbortController().signal
    const held = await limiter.acquire(signal)
    const abandoned = new AbortController()
    const waiting = limiter.acquire(abandoned.signal)
    abandoned.abort(new Error('gave up'))
    await expect(waiting).rejects.toThrow('gave up')

    // The abort freed nothing extra: one release still admits exactly one caller.
    held()
    const admitted = await limiter.acquire(signal)
    let second = false
    const blocked = limiter.acquire(signal).then((release) => { second = true; return release })
    await tick()
    expect(second).toBe(false)
    admitted()
    ;(await blocked)()
  })

  it('reads the cap on every admission, so lowering it applies to the next run', async () => {
    let cap = 3
    const limiter = new SubagentRunLimiter(() => cap)
    const signal = new AbortController().signal
    const held = [await limiter.acquire(signal), await limiter.acquire(signal), await limiter.acquire(signal)]
    cap = 1
    let admitted = false
    const pending = limiter.acquire(signal).then((release) => { admitted = true; return release })
    await tick()
    expect(admitted).toBe(false)
    // A lowered cap admits nothing until in-flight work drains below it.
    held[0]?.()
    held[1]?.()
    await tick()
    expect(admitted).toBe(false)
    held[2]?.()
    const release = await pending
    expect(admitted).toBe(true)
    release()
  })

  it('admits queued callers in the order they arrived', async () => {
    const limiter = new SubagentRunLimiter(() => 1)
    const signal = new AbortController().signal
    const held = await limiter.acquire(signal)
    const order: string[] = []
    const first = limiter.acquire(signal).then((release) => { order.push('first'); return release })
    const second = limiter.acquire(signal).then((release) => { order.push('second'); return release })
    await tick()
    expect(order).toEqual([])

    held()
    const firstRelease = await first
    await tick()
    expect(order).toEqual(['first'])
    firstRelease()
    const secondRelease = await second
    expect(order).toEqual(['first', 'second'])
    secondRelease()
  })

  it('admits a fresh caller once every held slot is released', async () => {
    const limiter = new SubagentRunLimiter(() => 1)
    const signal = new AbortController().signal
    const first = await limiter.acquire(signal)
    first()
    const second = await limiter.acquire(signal)
    expect(typeof second).toBe('function')
    second()
  })
})
