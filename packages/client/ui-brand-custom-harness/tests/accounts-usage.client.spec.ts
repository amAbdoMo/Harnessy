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
  it.each(['describe', 'refresh', 'mutation'] as const)('keeps pushed usage when an older %s response arrives', async (read) => {
    const pending = Promise.withResolvers<{ state: AccountsState }>()
    const operations = {
      describe: vi.fn(() => read === 'describe' ? pending.promise : Promise.resolve({ state: describedState })),
      refreshUsage: vi.fn<(signal: AbortSignal) => Promise<{ state?: AccountsState }>>()
        .mockImplementationOnce(() => read === 'refresh' ? pending.promise : Promise.resolve({}))
        .mockResolvedValue({}),
    }
    const controller = new AccountsUsageController(operations)
    const dispose = controller.start()
    try {
      await settle()
      const mutation = read === 'mutation' ? controller.request(() => pending.promise) : undefined
      controller.publish(refreshedState)
      expect(controller.state.getSnapshot()).toEqual(refreshedState)
      pending.resolve({ state: describedState })
      await mutation
      await settle()
      expect(controller.state.getSnapshot()).toEqual(refreshedState)
    } finally {
      pending.resolve({ state: describedState })
      dispose()
    }
  })

  it.each(['older-first', 'newer-first'] as const)('keeps the newer operation response when replies arrive %s without a push', async (order) => {
    const older = Promise.withResolvers<{ state: AccountsState }>()
    const newer = Promise.withResolvers<{ state: AccountsState }>()
    const controller = new AccountsUsageController({ describe: async () => ({}), refreshUsage: async () => ({}) })
    const stop = controller.start()
    try {
      await settle()
      const oldRead = controller.request(() => older.promise)
      const newMutation = controller.request(() => newer.promise)
      if (order === 'older-first') {
        older.resolve({ state: describedState })
        await oldRead
      }
      newer.resolve({ state: refreshedState })
      await newMutation
      older.resolve({ state: describedState })
      await oldRead
      expect(controller.state.getSnapshot()).toEqual(refreshedState)
    } finally {
      older.resolve({ state: describedState })
      newer.resolve({ state: refreshedState })
      stop()
    }
  })

  it('follows an in-flight read with a fresh check when a Codex account is added', async () => {
    const pending = Promise.withResolvers<{ state: AccountsState }>()
    const operations = {
      describe: vi.fn(async () => ({ state: describedState })),
      refreshUsage: vi.fn<(signal: AbortSignal) => Promise<{ state: AccountsState }>>()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue({ state: refreshedState }),
    }
    const controller = new AccountsUsageController(operations)
    const stop = controller.start()
    try {
      await vi.waitFor(() => { expect(operations.refreshUsage).toHaveBeenCalledOnce() })
      controller.publish({ ...refreshedState, accounts: refreshedState.accounts.map(({ usage: _usage, ...account }) => account) })
      void controller.refresh()
      void controller.refresh()
      expect(operations.refreshUsage).toHaveBeenCalledOnce()
      pending.resolve({ state: describedState })
      await vi.waitFor(() => {
        expect(operations.refreshUsage).toHaveBeenCalledTimes(2)
        expect(controller.state.getSnapshot()).toEqual(refreshedState)
      })
    } finally {
      pending.resolve({ state: describedState })
      stop()
    }
  })

  it('retains a fresh manager or sign-in check even when the account membership is unchanged', async () => {
    const pending = Promise.withResolvers<{ state: AccountsState }>()
    const newerState: AccountsState = {
      ...refreshedState,
      accounts: refreshedState.accounts.map(account => ({ ...account, usage: { windows: [{ id: 'primary', label: '5h', usedPercent: 79 }] } })),
    }
    const operations = {
      describe: vi.fn(async () => ({ state: refreshedState })),
      refreshUsage: vi.fn<(signal: AbortSignal) => Promise<{ state: AccountsState }>>()
        .mockImplementationOnce(() => pending.promise).mockResolvedValue({ state: newerState }),
    }
    const controller = new AccountsUsageController(operations)
    const stop = controller.start()
    try {
      await vi.waitFor(() => { expect(operations.refreshUsage).toHaveBeenCalledOnce() })
      const shared = controller.refresh()
      expect(controller.refresh(true)).toBe(shared)
      expect(controller.refresh(true)).toBe(shared)
      pending.resolve({ state: refreshedState })
      await vi.waitFor(() => {
        expect(operations.refreshUsage).toHaveBeenCalledTimes(2)
        expect(controller.state.getSnapshot()).toEqual(newerState)
      })
    } finally {
      pending.resolve({ state: refreshedState })
      stop()
    }
  })

  it('rejects a previous lifecycle mutation without invalidating the restart describe', async () => {
    const mutation = Promise.withResolvers<{ state: AccountsState }>()
    const restarted = Promise.withResolvers<{ state: AccountsState }>()
    const operations = {
      describe: vi.fn<() => Promise<{ state: AccountsState }>>()
        .mockResolvedValueOnce({ state: describedState }).mockImplementationOnce(() => restarted.promise),
      refreshUsage: vi.fn(async () => ({})),
    }
    const controller = new AccountsUsageController(operations)
    const stopFirst = controller.start()
    await settle()
    const abandoned = controller.request(() => mutation.promise)
    stopFirst()
    const stopSecond = controller.start()
    try {
      mutation.resolve({ state: describedState })
      await abandoned
      restarted.resolve({ state: refreshedState })
      await settle()
      expect(controller.state.getSnapshot()).toEqual(refreshedState)
    } finally {
      mutation.resolve({ state: describedState })
      restarted.resolve({ state: refreshedState })
      stopSecond()
    }
  })

  it('starts a fresh read after disposal without accepting an abandoned response', async () => {
    const pending = Promise.withResolvers<{ state: AccountsState }>()
    const operations = {
      describe: vi.fn(async () => ({ state: describedState })),
      refreshUsage: vi.fn<(signal: AbortSignal) => Promise<{ state: AccountsState }>>()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue({ state: refreshedState }),
    }
    const controller = new AccountsUsageController(operations)
    const stopFirst = controller.start()
    await settle()
    const firstSignal = operations.refreshUsage.mock.calls[0]?.[0]
    stopFirst()
    expect(firstSignal?.aborted).toBe(true)
    const stopSecond = controller.start()
    try {
      await settle()
      expect(controller.state.getSnapshot()).toEqual(refreshedState)
      pending.resolve({ state: describedState })
      await settle()
      expect(controller.state.getSnapshot()).toEqual(refreshedState)
    } finally {
      pending.resolve({ state: describedState })
      stopSecond()
    }
  })

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
