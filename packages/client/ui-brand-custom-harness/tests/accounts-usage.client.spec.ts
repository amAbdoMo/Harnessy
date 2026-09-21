// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountsState } from '@deepseek-ai/dsh-api-remotes/client'
import { AccountsUsageController } from '../src/client/accounts-usage.ts'

const describedState: AccountsState = {
  writable: true,
  providers: [],
  accounts: [],
}

const refreshedState: AccountsState = {
  ...describedState,
  providers: [{
    id: 'openai-codex', label: 'Codex', authMode: 'oauth', available: true,
    accountCount: 1, activeAccountId: 'codex-1', usageAvailable: true, autoSwitchOnLimit: false,
  }],
  accounts: [{
    id: 'codex-1', ownerId: 'owner-abdo', provider: 'openai-codex', name: 'Abdo Mohamed', initials: 'AM',
    active: true, authMode: 'oauth',
    usage: { windows: [{ id: 'primary', label: '5h', usedPercent: 28 }] },
  }],
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('Harnessy automatic account usage', () => {
  it('refreshes at startup, every visible minute, and when the window regains focus', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const operations = {
      describe: vi.fn(async () => ({ state: describedState })),
      refreshUsage: vi.fn(async () => ({ state: refreshedState })),
    }
    const controller = new AccountsUsageController(operations)
    const dispose = controller.start()
    await settle()

    expect(controller.state.getSnapshot()).toEqual(refreshedState)
    expect(operations.refreshUsage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(operations.refreshUsage).toHaveBeenCalledTimes(2)
    visibility.mockReturnValue('hidden')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(operations.refreshUsage).toHaveBeenCalledTimes(2)
    visibility.mockReturnValue('visible')
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(operations.refreshUsage).toHaveBeenCalledTimes(3)

    dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    window.dispatchEvent(new Event('focus'))
    expect(operations.refreshUsage).toHaveBeenCalledTimes(3)
  })

  it('shares one in-flight refresh across automatic triggers', async () => {
    vi.useFakeTimers()
    let finishRefresh: ((outcome: { state: AccountsState }) => void) | undefined
    const pendingRefresh = new Promise<{ state: AccountsState }>((resolve) => { finishRefresh = resolve })
    const operations = {
      describe: vi.fn(async () => ({ state: describedState })),
      refreshUsage: vi.fn(() => pendingRefresh),
    }
    const controller = new AccountsUsageController(operations)
    const dispose = controller.start()
    await settle()

    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(operations.refreshUsage).toHaveBeenCalledTimes(1)

    finishRefresh?.({ state: refreshedState })
    await settle()
    expect(controller.state.getSnapshot()).toEqual(refreshedState)
    dispose()
  })
})
