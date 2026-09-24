// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { AccountsState } from '@deepseek-ai/dsh-api-remotes/client'
import {
  AccountsManagerCard, type AccountsManagerCardProps, type AccountsManagerOperations,
} from '../src/client/AccountsManagerCard.tsx'
import { en } from '../src/client/locales.ts'
import { createAccountsMenuStore } from '../src/client/accounts-menu-store.ts'

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
    rename: vi.fn(async () => ({ state: baseState })),
    remove: vi.fn(async () => ({ state: baseState })),
    refreshUsage: vi.fn(async () => ({ state: baseState })),
    ...overrides,
  }
}

function renderManager(value: AccountsManagerOperations, presentModal = vi.fn(() => vi.fn())) {
  const store = createAccountsMenuStore().create()
  const useStore = <Selected,>(selector: (state: ReturnType<typeof store.getSnapshot>) => Selected): Selected =>
    selector(useSyncExternalStore(
      listener => store.subscribe(listener),
      () => store.getSnapshot(),
    ))
  return {
    ...render(<AccountsManagerCard
      {...({
        operations: value, t, presentModal, useStore, actions: store.actions,
      } as unknown as AccountsManagerCardProps)} />),
    presentModal,
    store,
  }
}

describe('Harnessy account manager', () => {
  it('takes exclusive modal ownership and closes the underlying settings panel when finished', async () => {
    const finish = vi.fn()
    const presentModal = vi.fn(() => finish)
    renderManager(operations(), presentModal)

    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    expect(presentModal).toHaveBeenCalledOnce()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(finish).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('refreshes usage automatically whenever the manager opens', async () => {
    const api = operations()
    renderManager(api)
    fireEvent.click(await screen.findByRole('button', { name: en.accountsManage }))
    await waitFor(() => { expect(api.refreshUsage).toHaveBeenCalledTimes(1) })
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

  it('counts down the 5h reset and omits the year from the 7d reset', async () => {
    const now = Date.UTC(2026, 8, 18, 10, 0)
    const fiveHourReset = now + (2 * 60 + 30) * 60_000
    const sevenDayReset = Date.UTC(2026, 8, 24, 22, 41)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const shortSevenDayReset = new Date(sevenDayReset).toLocaleString(undefined, {
      month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
    })
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
    expect(screen.getByText(`${en.accountsResetsPrefix} ${shortSevenDayReset}`)).toBeTruthy()

    vi.mocked(Date.now).mockReturnValue(now + 60 * 60_000)
    fireEvent(window, new Event('focus'))
    expect(await screen.findByText(`${en.accountsResetsInPrefix} 1h 30m`)).toBeTruthy()
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
})
