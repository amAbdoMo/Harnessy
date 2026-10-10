// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AccountResetCreditId, AccountsState } from '@deepseek-ai/dsh-api-remotes/client'
import {
  AccountsManagerCard, type AccountsManagerCardProps, type AccountsManagerOperations,
} from '../src/client/AccountsManagerCard.tsx'
import { en, zh } from '../src/client/locales.ts'
import { BillingReminderToast, type BillingReminderNotice } from '../src/client/ManualBillingReminder.tsx'
import { createAccountsMenuStore } from '../src/client/accounts-menu-store.ts'
import { slotTestProps } from './slot-test-props.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t = (key: keyof typeof en): string => en[key]

const baseState: AccountsState = {
  writable: true,
  providers: [
    {
      id: 'openai-codex', label: 'Codex', authMode: 'oauth', available: true,
      accountCount: 1, activeAccountId: 'codex-1', usageAvailable: true, autoSwitchOnLimit: false,
    },
    {
      id: 'zai', label: 'GLM', authMode: 'api-key', available: true,
      accountCount: 0, usageAvailable: false, autoSwitchOnLimit: false,
    },
  ],
  accounts: [{
    id: 'codex-1', ownerId: 'owner-abdo', provider: 'openai-codex', name: 'Abdo', detail: 'abdo@example.com · plus',
    initials: 'AM', active: true, authMode: 'oauth',
  }],
}

function operations(overrides: Partial<AccountsManagerOperations> = {}): AccountsManagerOperations {
  return {
    describe: vi.fn(async () => ({ state: baseState })),
    addOAuth: vi.fn(async () => ({ authorized: false })),
    addApiKey: vi.fn(async () => ({ state: baseState })),
    activate: vi.fn(async () => ({ state: baseState })),
    setAutoSwitch: vi.fn(async () => ({ state: baseState })),
    setManualBillingDate: vi.fn(async () => ({ state: baseState })),
    listResetCredits: vi.fn(async () => ({ list: { credits: [] } })),
    consumeResetCredit: vi.fn(async () => ({ outcome: 'reset' as const, state: baseState })),
    rename: vi.fn(async () => ({ state: baseState })),
    remove: vi.fn(async () => ({ state: baseState })),
    refreshUsage: vi.fn(async () => ({ state: baseState })),
    ...overrides,
  }
}

/** Operations wrapped the way the browser plugin wires them: results publish to the shared snapshot. */
function publishing(
  value: AccountsManagerOperations,
  accounts: ReturnType<typeof createSnapshotStore<AccountsState | undefined>>,
): AccountsManagerOperations {
  const publish = async <T extends { readonly state?: AccountsState }>(result: T): Promise<T> => {
    if (result.state !== undefined) accounts.set(result.state)
    return result
  }
  return {
    describe: async () => publish(await value.describe()),
    addOAuth: (provider, signal) => value.addOAuth(provider, signal),
    addApiKey: async (provider, name, key) => publish(await value.addApiKey(provider, name, key)),
    activate: async (provider, accountId) => publish(await value.activate(provider, accountId)),
    setAutoSwitch: async (provider, enabled) => publish(await value.setAutoSwitch(provider, enabled)),
    setManualBillingDate: async (provider, accountId, date) => publish(await value.setManualBillingDate(provider, accountId, date)),
    listResetCredits: (accountId, signal) => value.listResetCredits(accountId, signal),
    consumeResetCredit: async (accountId, creditId) =>
      publish(await value.consumeResetCredit(accountId, creditId)),
    rename: async (provider, accountId, name) => publish(await value.rename(provider, accountId, name)),
    remove: async (provider, accountId) => publish(await value.remove(provider, accountId)),
    refreshUsage: async signal => publish(await value.refreshUsage(signal)),
  }
}

function renderManager(
  value: AccountsManagerOperations,
  presentModal = vi.fn(() => vi.fn()),
  translate: (key: keyof typeof en) => string = t,
) {
  const store = createAccountsMenuStore().create()
  const accounts = createSnapshotStore<AccountsState | undefined>(undefined)
  const useStore = <Selected,>(selector: (state: ReturnType<typeof store.getSnapshot>) => Selected): Selected =>
    selector(useSyncExternalStore(
      listener => store.subscribe(listener),
      () => store.getSnapshot(),
    ))
  const useAccounts = <Selected,>(selector: (snapshot: AccountsState | undefined) => Selected): Selected =>
    selector(useSyncExternalStore(
      listener => accounts.subscribe(listener),
      () => accounts.getSnapshot(),
    ))
  // Production loads the shared snapshot at startup through the usage controller.
  const wired = publishing(value, accounts)
  void wired.describe()
  return {
    ...render(<AccountsManagerCard
      {...slotTestProps<AccountsManagerCardProps>({
        operations: wired, t: translate, presentModal, useStore, actions: store.actions, useAccounts,
      })} />),
    presentModal,
    store,
    accounts,
  }
}

function billingState(date?: string): AccountsState {
  return {
    ...baseState,
    accounts: baseState.accounts.map(account => ({ ...account, ...(date === undefined ? {} : { manualBillingDate: date }) })),
  }
}

describe('manual billing reminders', () => {
  it.each([en, zh])('announces localized saved, cleared, and failed outcomes from the root toast', (copy) => {
    let notice: BillingReminderNotice | undefined
    const props = slotTestProps<Parameters<typeof BillingReminderToast>[0]>({
      t: (key: keyof typeof en) => copy[key], dismiss: vi.fn(),
      useBillingReminderNotice: <T,>(selector: (value: BillingReminderNotice | undefined) => T): T => selector(notice),
    })
    const rendered = render(<BillingReminderToast {...props} />)
    expect(rendered.container.textContent).toBe('')
    for (const [outcome, text] of [
      ['saved', copy.accountsBillingSaved], ['cleared', copy.accountsBillingCleared], ['failed', copy.accountsBillingFailed],
    ] as const) {
      notice = { id: outcome, outcome }
      rendered.rerender(<BillingReminderToast {...props} />)
      expect(screen.getByText(text)).toBeTruthy()
    }
  })

  it('places the reminder beneath email and plan, outside usage and header actions', async () => {
    const state = billingState('2030-02-28')
    renderManager(operations({ describe: async () => ({ state }), refreshUsage: async () => ({ state }) }))
    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    const reminder = await screen.findByRole('group', { name: en.accountsBillingReminder })
    const detail = screen.getByText('abdo@example.com · plus')
    expect(detail.parentElement).toBe(reminder.parentElement)
    expect(detail.nextElementSibling).toBe(reminder)
    expect(within(reminder).getByText('2030-02-28').getAttribute('datetime')).toBe('2030-02-28')
    expect(within(reminder).queryByRole('progressbar')).toBeNull()
    expect(within(reminder).queryByRole('button', { name: en.accountsViewBankedResets })).toBeNull()
  })

  it('cancels without writing, saves the exact date, edits, and explicitly clears with null', async () => {
    let state = billingState()
    const setManualBillingDate = vi.fn<AccountsManagerOperations['setManualBillingDate']>(async (_provider, _id, date) => {
      state = billingState(date === null ? undefined : date)
      return { state }
    })
    const api = operations({ describe: async () => ({ state }), refreshUsage: async () => ({ state }), setManualBillingDate })
    renderManager(api)
    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    fireEvent.click(screen.getByRole('button', { name: en.accountsBillingAdd }))
    const field = screen.getByLabelText(en.accountsBillingDate)
    expect(field.getAttribute('type')).toBe('date')
    expect(screen.getByRole('button', { name: en.accountsSave }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(field, { target: { value: '2032-02-29' } })
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(setManualBillingDate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.accountsBillingAdd }))
    expect(screen.getByLabelText(en.accountsBillingDate).getAttribute('value')).toBe('')
    fireEvent.change(screen.getByLabelText(en.accountsBillingDate), { target: { value: '2032-02-29' } })
    fireEvent.click(screen.getByRole('button', { name: en.accountsSave }))
    await screen.findByRole('button', { name: en.accountsBillingEdit })
    expect(screen.getByText('2032-02-29')).toBeTruthy()
    expect(setManualBillingDate).toHaveBeenLastCalledWith('openai-codex', 'codex-1', '2032-02-29')
    fireEvent.click(screen.getByRole('button', { name: en.accountsBillingEdit }))
    fireEvent.change(screen.getByLabelText(en.accountsBillingDate), { target: { value: '2032-03-01' } })
    fireEvent.click(screen.getByRole('button', { name: en.accountsSave }))
    await screen.findByText('2032-03-01')
    fireEvent.click(screen.getByRole('button', { name: en.accountsBillingEdit }))
    fireEvent.click(screen.getByRole('button', { name: en.accountsBillingClear }))
    await screen.findByRole('button', { name: en.accountsBillingAdd })
    expect(setManualBillingDate).toHaveBeenLastCalledWith('openai-codex', 'codex-1', null)
    expect(screen.queryByText('2032-03-01')).toBeNull()
    expect(api.consumeResetCredit).not.toHaveBeenCalled()
    expect(api.listResetCredits).not.toHaveBeenCalled()
  })

  it('keeps saved data and the draft after failed save or clear, disabling duplicate writes', async () => {
    const state = billingState('2030-01-01')
    const failed = Promise.withResolvers<Awaited<ReturnType<AccountsManagerOperations['setManualBillingDate']>>>()
    const setManualBillingDate = vi.fn<AccountsManagerOperations['setManualBillingDate']>()
      .mockReturnValueOnce(failed.promise).mockResolvedValue({ error: 'storage is read-only' })
    renderManager(operations({ describe: async () => ({ state }), refreshUsage: async () => ({ state }), setManualBillingDate }))
    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    fireEvent.click(screen.getByRole('button', { name: en.accountsBillingEdit }))
    fireEvent.change(screen.getByLabelText(en.accountsBillingDate), { target: { value: '2030-02-01' } })
    fireEvent.click(screen.getByRole('button', { name: en.accountsSave }))
    expect(screen.getByRole('button', { name: en.accountsBillingSaving }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: en.accountsBillingClear }).hasAttribute('disabled')).toBe(true)
    failed.resolve({ error: 'storage is read-only' })
    await screen.findByRole('alert')
    expect(screen.getByText(en.accountsBillingFailed)).toBeTruthy()
    expect(screen.getByText('2030-01-01')).toBeTruthy()
    expect(screen.getByLabelText(en.accountsBillingDate).getAttribute('value')).toBe('2030-02-01')
    fireEvent.click(screen.getByRole('button', { name: en.accountsBillingClear }))
    await waitFor(() => { expect(setManualBillingDate).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(screen.getByRole('button', { name: en.accountsSave }).hasAttribute('disabled')).toBe(false) })
    expect(screen.getByText('2030-01-01')).toBeTruthy()
    expect(screen.getByText(en.accountsBillingFailed)).toBeTruthy()
  })

  it('isolates reminders and drafts between memberships, including late completion after a switch', async () => {
    let state: AccountsState = {
      ...baseState,
      accounts: baseState.accounts.flatMap(account => [
        { ...account, usageScope: 'personal' as const, manualBillingDate: '2030-01-01' },
        { ...account, id: 'codex-workspace', active: false, usageScope: 'workspace' as const, manualBillingDate: '2030-02-01' },
      ]),
    }
    const pending = Promise.withResolvers<Awaited<ReturnType<AccountsManagerOperations['setManualBillingDate']>>>()
    const setManualBillingDate = vi.fn<AccountsManagerOperations['setManualBillingDate']>().mockReturnValueOnce(pending.promise)
      .mockImplementation(async (_provider, id, date) => {
        state = { ...state, accounts: state.accounts.map((account) => {
          if (account.id !== id) return account
          const { manualBillingDate: _previousDate, ...membership } = account
          return date === null ? membership : { ...membership, manualBillingDate: date }
        }) }
        return { state }
      })
    renderManager(operations({ describe: async () => ({ state }), refreshUsage: async () => ({ state }), setManualBillingDate }))
    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    fireEvent.click(screen.getByRole('button', { name: en.accountsBillingEdit }))
    fireEvent.change(screen.getByLabelText(en.accountsBillingDate), { target: { value: '2030-03-01' } })
    fireEvent.click(screen.getByRole('button', { name: en.accountsSave }))
    fireEvent.click(screen.getByRole('button', { name: en.accountsUsageWorkspace }))
    expect(screen.getByText('2030-02-01')).toBeTruthy()
    expect(screen.queryByLabelText(en.accountsBillingDate)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.accountsBillingEdit }))
    fireEvent.change(screen.getByLabelText(en.accountsBillingDate), { target: { value: '2030-04-01' } })
    await act(async () => { pending.resolve({ error: 'failed personal write' }); await pending.promise })
    expect(screen.queryByText(en.accountsBillingFailed)).toBeNull()
    expect(screen.getByLabelText(en.accountsBillingDate).getAttribute('value')).toBe('2030-04-01')
    fireEvent.click(screen.getByRole('button', { name: en.accountsSave }))
    await screen.findByText('2030-04-01')
    expect(setManualBillingDate).toHaveBeenLastCalledWith('openai-codex', 'codex-workspace', '2030-04-01')
    fireEvent.click(screen.getByRole('button', { name: en.accountsUsagePersonal }))
    expect(screen.getByText('2030-01-01')).toBeTruthy()
  })

  it.each([en, zh])('uses localized copy and a date-only value; past dates stay overdue without advancing', async (copy) => {
    const now = new Date(2026, 8, 18, 23, 59).getTime()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const state = billingState('2026-09-18')
    const api = operations({ describe: async () => ({ state }), refreshUsage: async () => ({ state }) })
    renderManager(api, undefined, key => copy[key])
    fireEvent.click(await screen.findByRole('button', { name: copy.accountsManage }))
    const date = screen.getByText('2026-09-18')
    expect(date.tagName).toBe('TIME')
    expect(date.getAttribute('datetime')).toBe('2026-09-18')
    expect(screen.queryByText(copy.accountsBillingOverdue)).toBeNull()
    vi.mocked(Date.now).mockReturnValue(new Date(2026, 8, 19, 0, 1).getTime())
    fireEvent(window, new Event('focus'))
    await screen.findByText(copy.accountsBillingOverdue)
    expect(screen.getByText('2026-09-18')).toBeTruthy()
    expect(api.setManualBillingDate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: copy.accountsBillingEdit }))
    expect(screen.getByLabelText(copy.accountsBillingDate).getAttribute('type')).toBe('date')
    expect(screen.getByText(copy.accountsBillingManualHint)).toBeTruthy()
    screen.getByRole('button', { name: copy.accountsBillingClear })
    screen.getByRole('button', { name: copy.cancel })
  })

  it('blocks empty and invalid calendar values and does not allow writes from read-only state', async () => {
    const api = operations()
    const rendered = renderManager(api)
    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    fireEvent.click(screen.getByRole('button', { name: en.accountsBillingAdd }))
    const field = screen.getByLabelText(en.accountsBillingDate)
    for (const invalid of ['', '2031-02-29', '2030-13-01', '0000-01-01', '2030-01-01T00:00:00Z']) {
      fireEvent.change(field, { target: { value: invalid } })
      expect(screen.getByRole('button', { name: en.accountsSave }).hasAttribute('disabled')).toBe(true)
      fireEvent.submit(field.closest('form') ?? field)
    }
    expect(api.setManualBillingDate).not.toHaveBeenCalled()
    rendered.accounts.set({ ...baseState, writable: false })
    await waitFor(() => { expect(field.hasAttribute('disabled')).toBe(true) })
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(screen.getByRole('button', { name: en.accountsBillingAdd }).hasAttribute('disabled')).toBe(true)
  })
})

describe('Harnessy account manager', () => {
  it('takes exclusive modal ownership and closes the underlying settings panel when finished', async () => {
    const finish = vi.fn()
    const presentModal = vi.fn(() => finish)
    renderManager(operations(), presentModal)

    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    expect(presentModal).toHaveBeenCalledOnce()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.queryByText('Credentials stay in Harnessy’s protected local storage.')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(finish).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('refreshes usage automatically whenever the manager opens', async () => {
    const api = operations()
    renderManager(api)
    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    await waitFor(() => { expect(api.refreshUsage).toHaveBeenCalledTimes(1) })
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    fireEvent.click(screen.getByRole('button', { name: en.accountsManage }))
    await waitFor(() => { expect(api.refreshUsage).toHaveBeenCalledTimes(2) })
  })

  it('opens from a sidebar account-menu request without leaving Settings visible', async () => {
    const finish = vi.fn()
    const presentModal = vi.fn(() => finish)
    const rendered = renderManager(operations(), presentModal)

    rendered.store.actions.requestManager()

    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(presentModal).toHaveBeenCalledOnce()
    expect(rendered.store.getSnapshot().managerRequested).toBe(false)
  })

  it('renders Codex usage immediately and activates another saved account', async () => {
    const twoAccounts: AccountsState = {
      ...baseState,
      providers: [{ ...baseState.providers[0]!, accountCount: 2 }],
      accounts: [
        { ...baseState.accounts[0]!, usage: { windows: [{ id: '5h', label: '5h', usedPercent: 40 }] } },
        {
          id: 'codex-2', ownerId: 'owner-spare', provider: 'openai-codex', name: 'Spare', initials: 'SP', active: false,
          authMode: 'oauth', usage: { windows: [{ id: '5h', label: '5h', usedPercent: 10 }] },
        },
      ],
    }
    const activate = vi.fn(async () => ({ state: twoAccounts }))
    const api = operations({ describe: vi.fn(async () => ({ state: twoAccounts })),
      refreshUsage: vi.fn(async () => ({ state: twoAccounts })), activate })
    renderManager(api)
    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    const progress = await screen.findAllByRole('progressbar')
    expect(progress[0]?.getAttribute('aria-valuenow')).toBe('40')
    expect(progress[0]?.querySelector('span')?.getAttribute('style')).toContain('width: 40%')
    fireEvent.click(screen.getByRole('button', { name: en.accountsSwitch }))
    await waitFor(() => { expect(activate).toHaveBeenCalledWith('openai-codex', 'codex-2') })
  })

  it('switches between Personal and Workspace usage only when both contexts exist', async () => {
    const scopedState: AccountsState = {
      ...baseState,
      providers: [{ ...baseState.providers[0]!, accountCount: 1 }],
      accounts: [
        {
          ...baseState.accounts[0]!, usageScope: 'personal',
          usage: { windows: [{ id: 'personal-5h', label: '5h', usedPercent: 25 }] },
        },
        {
          ...baseState.accounts[0]!, id: 'codex-workspace', active: false, usageScope: 'workspace',
          detail: 'abdo@example.com · BUSINESS',
          usage: { windows: [
            { id: 'workspace-5h', label: '5h', usedPercent: 85 },
            { id: 'workspace-7d', label: '7d', usedPercent: 96 },
          ] },
        },
      ],
    }
    const activate = vi.fn(async () => ({ state: scopedState }))
    renderManager(operations({
      describe: vi.fn(async () => ({ state: scopedState })),
      refreshUsage: vi.fn(async () => ({ state: scopedState })),
      activate,
    }))

    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    const scope = await screen.findByRole('group', { name: en.accountsUsageScope })
    expect(screen.getAllByRole('button', { name: en.accountsRename })).toHaveLength(1)
    expect(within(scope).getByRole('button', { name: en.accountsUsagePersonal }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')

    fireEvent.click(within(scope).getByRole('button', { name: en.accountsUsageWorkspace }))
    const workspaceMeters = screen.getAllByRole('progressbar')
    expect(workspaceMeters.map(meter => meter.getAttribute('aria-valuenow'))).toEqual(['85', '96'])
    expect(workspaceMeters[0]?.querySelector('span')?.getAttribute('data-level')).toBe('warning')
    expect(workspaceMeters[1]?.querySelector('span')?.getAttribute('data-level')).toBe('danger')
    fireEvent.click(screen.getByRole('button', { name: en.accountsSwitch }))
    await waitFor(() => { expect(activate).toHaveBeenCalledWith('openai-codex', 'codex-workspace') })
  })

  it('offers opt-in automatic Codex failover when another membership is saved', async () => {
    const state: AccountsState = {
      ...baseState,
      providers: [{ ...baseState.providers[0]!, accountCount: 2 }],
      accounts: [
        baseState.accounts[0]!,
        {
          ...baseState.accounts[0]!, id: 'codex-2', ownerId: 'owner-spare',
          name: 'Spare', initials: 'SP', active: false,
        },
      ],
    }
    const enabled: AccountsState = {
      ...state,
      providers: [{ ...state.providers[0]!, autoSwitchOnLimit: true }],
    }
    const setAutoSwitch = vi.fn(async () => ({ state: enabled }))
    renderManager(operations({
      describe: vi.fn(async () => ({ state })),
      refreshUsage: vi.fn(async () => ({ state })),
      setAutoSwitch,
    }))

    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    const toggle = await screen.findByRole('switch', { name: en.accountsAutoSwitchToggle })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => { expect(setAutoSwitch).toHaveBeenCalledWith('openai-codex', true) })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('does not show a usage-context switch for a Personal-only account', async () => {
    const state: AccountsState = {
      ...baseState,
      accounts: [{ ...baseState.accounts[0]!, usageScope: 'personal' }],
    }
    renderManager(operations({
      describe: vi.fn(async () => ({ state })),
      refreshUsage: vi.fn(async () => ({ state })),
    }))
    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    expect(screen.queryByRole('group', { name: en.accountsUsageScope })).toBeNull()
  })

  it('counts down both 5h and weekly resets', async () => {
    const now = Date.UTC(2026, 8, 18, 10, 0)
    const fiveHourReset = now + (2 * 60 + 30) * 60_000
    const sevenDayReset = now + ((3 * 24 + 5) * 60 + 12) * 60_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const state: AccountsState = {
      ...baseState,
      accounts: [{
        ...baseState.accounts[0]!,
        usage: { windows: [
          { id: '5h', label: '5h', usedPercent: 40, resetsAtMs: fiveHourReset },
          { id: '7d', label: '7d', usedPercent: 20, resetsAtMs: sevenDayReset },
        ] },
      }],
    }
    renderManager(operations({
      describe: vi.fn(async () => ({ state })),
      refreshUsage: vi.fn(async () => ({ state })),
    }))

    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    expect(await screen.findByText(`${en.accountsResetsInPrefix} 2h 30m`)).toBeTruthy()
    expect(screen.getByText(`${en.accountsResetsInPrefix} 3d 5h 12m`)).toBeTruthy()

    vi.mocked(Date.now).mockReturnValue(now + 60 * 60_000)
    fireEvent(window, new Event('focus'))
    expect(await screen.findByText(`${en.accountsResetsInPrefix} 1h 30m`)).toBeTruthy()
    expect(screen.getByText(`${en.accountsResetsInPrefix} 3d 4h 12m`)).toBeTruthy()
  })

  it('localizes Chinese reset durations without English unit abbreviations', async () => {
    const now = Date.UTC(2026, 8, 18, 10, 0)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const state: AccountsState = {
      ...baseState,
      accounts: [{
        ...baseState.accounts[0]!,
        usage: { windows: [{
          id: '7d', label: '7d', usedPercent: 20, resetsAtMs: now + ((3 * 24 + 5) * 60 + 12) * 60_000,
        }] },
      }],
    }
    renderManager(operations({
      describe: vi.fn(async () => ({ state })),
      refreshUsage: vi.fn(async () => ({ state })),
    }), undefined, key => zh[key])

    fireEvent.click(await screen.findByRole('button', { name: zh.accountsManage }))
    expect(await screen.findByText(`${zh.accountsResetsInPrefix} 3天 5小时 12分钟`)).toBeTruthy()
  })

  it('shows a minutes-only reset countdown under one hour', async () => {
    const now = Date.UTC(2026, 8, 18, 10, 0)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const state: AccountsState = {
      ...baseState,
      accounts: [{
        ...baseState.accounts[0]!,
        usage: { windows: [{ id: '5h', label: '5h', usedPercent: 20, resetsAtMs: now + 25 * 60_000 }] },
      }],
    }
    renderManager(operations({
      describe: vi.fn(async () => ({ state })),
      refreshUsage: vi.fn(async () => ({ state })),
    }))

    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    expect(await screen.findByText(`${en.accountsResetsInPrefix} 25m`)).toBeTruthy()
  })

  it('opens individual resets without redeeming and retries the chosen credit after popup dismissal', async () => {
    const resetState: AccountsState = {
      ...baseState,
      accounts: [{
        ...baseState.accounts[0]!,
        usage: {
          windows: [{ id: '7d', label: '7d', usedPercent: 95 }],
          resetCredits: { availableCount: 1 },
        },
      }],
    }
    const consumedState: AccountsState = {
      ...resetState,
      accounts: [{
        ...resetState.accounts[0]!,
        usage: { windows: [{ id: '7d', label: '7d', usedPercent: 0 }], resetCredits: { availableCount: 0 } },
      }],
    }
    const consumeResetCredit = vi.fn()
      .mockResolvedValueOnce({ error: 'Reset temporarily unavailable.' })
      .mockResolvedValueOnce({ outcome: 'reset' as const, state: consumedState })
    const listResetCredits = vi.fn().mockResolvedValue({ list: { credits: [
      { id: 'earlier' as AccountResetCreditId, resetType: 'codex_rate_limits', status: 'available', expiresAtMs: Date.parse('2030-10-23T00:00:00Z') },
      { id: 'chosen' as AccountResetCreditId, resetType: 'codex_rate_limits', status: 'available', expiresAtMs: Date.parse('2030-10-29T07:31:00Z') },
    ] } })
    renderManager(operations({
      describe: vi.fn(async () => ({ state: resetState })),
      refreshUsage: vi.fn(async () => ({ state: resetState })),
      listResetCredits, consumeResetCredit,
    }))

    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    const resetActionName = en.accountsViewBankedResetsFor.replace('{account}', baseState.accounts[0]!.name)
    fireEvent.click(screen.getByRole('button', { name: resetActionName }))
    const popup = await screen.findByRole('dialog', { name: en.accountsBankedResets })
    const useButtons = await within(popup).findAllByRole('button', { name: /^Use reset —/ })
    expect(useButtons).toHaveLength(2)
    expect(consumeResetCredit).not.toHaveBeenCalled()
    expect(await within(popup).findAllByText(/^Expires /)).toHaveLength(2)
    fireEvent.click(useButtons[1]!)
    await waitFor(() => { expect(consumeResetCredit).toHaveBeenCalledTimes(1) })
    fireEvent.click(within(popup).getByRole('button', { name: en.close }))
    fireEvent.click(screen.getByRole('button', { name: resetActionName }))
    const reopened = await screen.findByRole('dialog', { name: en.accountsBankedResets })
    fireEvent.click((await within(reopened).findAllByRole('button', { name: /^Use reset —/ }))[1]!)
    await waitFor(() => { expect(consumeResetCredit).toHaveBeenCalledTimes(2) })
    expect(consumeResetCredit.mock.calls[0]?.slice(0, 2)).toEqual(['codex-1', 'chosen'])
    expect(consumeResetCredit.mock.calls[1]?.slice(0, 2)).toEqual(['codex-1', 'chosen'])
    await waitFor(() => { expect(screen.queryByRole('button', { name: resetActionName })).toBeNull() })
  })

  it('does not invent expiry or offer unsupported credits, and dispatches only the chosen row', async () => {
    const resetState: AccountsState = { ...baseState, accounts: [{ ...baseState.accounts[0]!, usage: {
      windows: [], resetCredits: { availableCount: 3 },
    } }] }
    const consumeResetCredit = vi.fn(async (_accountId: string, _creditId: string) => ({ error: 'provider temporarily unavailable' }))
    renderManager(operations({
      describe: async () => ({ state: resetState }), refreshUsage: async () => ({ state: resetState }), consumeResetCredit,
      listResetCredits: async () => ({ list: { credits: [
        { id: 'unreported' as AccountResetCreditId, resetType: 'codex_rate_limits', status: 'available' },
        { id: 'later' as AccountResetCreditId, resetType: 'codex_rate_limits', status: 'available', expiresAtMs: Date.parse('2030-10-29T07:31:00Z') },
        { id: 'expired' as AccountResetCreditId, resetType: 'codex_rate_limits', status: 'available', expiresAtMs: 1 },
        { id: 'unsupported' as AccountResetCreditId, resetType: 'other', status: 'available' },
        { id: 'used' as AccountResetCreditId, resetType: 'codex_rate_limits', status: 'redeemed' },
      ] } }),
    }))
    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    fireEvent.click(screen.getByRole('button', { name: en.accountsViewBankedResetsFor.replace('{account}', 'Abdo') }))
    const popup = await screen.findByRole('dialog', { name: en.accountsBankedResets })
    const actions = await within(popup).findAllByRole('button', { name: /^Use reset —/ })
    expect(actions).toHaveLength(3)
    expect((actions[2] as HTMLButtonElement).disabled).toBe(true)
    expect(within(popup).getByText(en.accountsBankedResetExpiryUnknown)).toBeTruthy()
    for (const index of [0, 1, 0]) {
      fireEvent.click(actions[index]!)
      await waitFor(() => { expect((actions[index] as HTMLButtonElement).disabled).toBe(false) })
    }
    expect(consumeResetCredit.mock.calls).toHaveLength(3)
    expect(consumeResetCredit.mock.calls).toEqual([
      ['codex-1', 'unreported'], ['codex-1', 'later'], ['codex-1', 'unreported'],
    ])
  })

  it('collects API keys only in the key form and never renders the value afterward', async () => {
    const addApiKey = vi.fn(async () => ({ state: baseState }))
    const api = operations({ addApiKey })
    renderManager(api)
    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    fireEvent.click(screen.getByRole('button', { name: 'GLM' }))
    fireEvent.click(screen.getByRole('button', { name: en.accountsAdd }))
    fireEvent.change(screen.getByRole('textbox', { name: en.accountsName }), { target: { value: 'Work GLM' } })
    const keyInput = screen.getByLabelText(en.accountsApiKey)
    fireEvent.change(keyInput, { target: { value: 'secret-glm-key' } })
    fireEvent.click(screen.getByRole('button', { name: en.accountsSave }))
    await waitFor(() => { expect(addApiKey).toHaveBeenCalledWith('zai', 'Work GLM', 'secret-glm-key') })
    expect(screen.queryByDisplayValue('secret-glm-key')).toBeNull()
  })

  it('renders provider brand marks instead of letter badges in the rail', async () => {
    renderManager(operations())
    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    const rail = await screen.findByRole('navigation', { name: en.accountsProviderNavigation })
    for (const label of ['Codex', 'GLM']) {
      expect(within(rail).getByRole('button', { name: label }).querySelector('svg')).toBeTruthy()
    }
  })

  it('reflects host-side account changes immediately without another fetch', async () => {
    const api = operations()
    const rendered = renderManager(api)
    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    await waitFor(() => { expect(api.refreshUsage).toHaveBeenCalledTimes(1) })
    expect(screen.queryByText('Spare')).toBeNull()
    rendered.accounts.set({
      ...baseState,
      providers: [{ ...baseState.providers[0]!, accountCount: 2 }],
      accounts: [
        baseState.accounts[0]!,
        {
          ...baseState.accounts[0]!, id: 'codex-2', ownerId: 'owner-spare',
          name: 'Spare', initials: 'SP', active: false,
        },
      ],
    })
    expect(await screen.findByText('Spare')).toBeTruthy()
    expect(api.refreshUsage).toHaveBeenCalledTimes(1)
  })
})
