/** The management page's bulk removal: one request, one readback, one settled outcome. */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ScheduleDeleteInactiveResult } from '@deepseek-ai/dsh-schedule/client'
import { createClearEnded } from '../src/client/clear-ended.ts'

const failure: RemoteResult<ScheduleDeleteInactiveResult> = {
  ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}),
}

/**
 * Wire the helper to one fake Remote answer and one readback spy.
 * @param answer - what the removal call answers, or the reason it rejects.
 * @param refresh - the readback the helper calls after an acknowledged removal.
 * @returns the callback under test with its dependencies' spies.
 */
function setup(
  answer: RemoteResult<ScheduleDeleteInactiveResult> | Error,
  refresh = vi.fn(async () => {}),
) {
  const removeInactive = vi.fn(async () => {
    if (answer instanceof Error) throw answer
    return answer
  })
  return { clearEnded: createClearEnded({ removeInactive, refresh }), removeInactive, refresh }
}

describe('createClearEnded', () => {
  it('reads the catalog back after an acknowledged removal and reports how many rows went', async () => {
    const { clearEnded, removeInactive, refresh } = setup({ ok: true, value: { deleted: 3 } })

    await expect(clearEnded()).resolves.toEqual({ cleared: true, count: 3 })

    expect(removeInactive).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    // The readback is what makes the list agree with the count, so it settles
    // before the outcome is published.
    expect(removeInactive.mock.invocationCallOrder[0])
      .toBeLessThan(refresh.mock.invocationCallOrder[0]!)
  })

  it('reports an acknowledged removal that found nothing as a cleared outcome', async () => {
    const { clearEnded, refresh } = setup({ ok: true, value: { deleted: 0 } })

    await expect(clearEnded()).resolves.toEqual({ cleared: true, count: 0 })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('reports a refused removal and reads nothing back', async () => {
    const { clearEnded, refresh } = setup(failure)

    await expect(clearEnded()).resolves.toEqual({ cleared: false })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('reports a rejected removal and reads nothing back', async () => {
    const { clearEnded, refresh } = setup(new Error('connection lost'))

    await expect(clearEnded()).resolves.toEqual({ cleared: false })
    expect(refresh).not.toHaveBeenCalled()
  })
})
