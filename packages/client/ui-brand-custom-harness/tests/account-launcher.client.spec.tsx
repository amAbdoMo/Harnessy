// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountsState } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AccountLauncher, type AccountLauncherProps } from '../src/client/AccountLauncher.tsx'
import { createAccountsMenuStore } from '../src/client/accounts-menu-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const accountState: AccountsState = {
  writable: true,
  providers: [{
    id: 'openai-codex', label: 'Codex', authMode: 'oauth', available: true,
    accountCount: 1, activeAccountId: 'codex-1', usageAvailable: true, autoSwitchOnLimit: false,
  }],
  accounts: [{
    id: 'codex-1', ownerId: 'owner-abdo', provider: 'openai-codex', name: 'Abdo Mohamed',
    detail: 'abdo@example.com · plus', initials: 'AM', active: true, authMode: 'oauth',
  }],
}

const refreshedAccountState: AccountsState = {
  ...accountState,
  accounts: [{
    ...accountState.accounts[0]!,
    usage: { windows: [
      { id: 'codex-primary', label: '5h', usedPercent: 52 },
      { id: 'codex-secondary', label: '7d', usedPercent: 24 },
    ] },
  }],
}

function mountLauncher(initialState: AccountsState | undefined = refreshedAccountState) {
  const store = createAccountsMenuStore().create()
  const accountUsage = createSnapshotStore<AccountsState | undefined>(initialState)
  const openSettings = vi.fn()
  const openSection = vi.fn()
  const refreshAccounts = vi.fn()
  const useStore = <Selected,>(selector: (state: ReturnType<typeof store.getSnapshot>) => Selected): Selected =>
    selector(useSyncExternalStore(
      listener => store.subscribe(listener),
      () => store.getSnapshot(),
    ))
  const useAccountUsage = <Selected,>(selector: (state: AccountsState | undefined) => Selected): Selected =>
    selector(useSyncExternalStore(
      listener => accountUsage.subscribe(listener),
      () => accountUsage.getSnapshot(),
    ))
  const props = {
    wide: true,
    openSettings,
    openSection,
    useAccountUsage,
    refreshAccounts,
    useStore,
    actions: store.actions,
    t: (key: keyof typeof en) => en[key],
  } as unknown as AccountLauncherProps
  render(<AccountLauncher {...props} />)
  return { accountUsage, openSection, openSettings, refreshAccounts, store }
}

describe('Harnessy account launcher', () => {
  it('opens a settings section requested by another Harnessy surface', async () => {
    const launcher = mountLauncher()
    act(() => { launcher.store.actions.requestSection('custom-harness-mcp') })
    await waitFor(() => { expect(launcher.openSection).toHaveBeenCalledWith('custom-harness-mcp') })
    expect(launcher.store.getSnapshot().sectionRequested).toBeUndefined()
  })

  it('refreshes and displays the current account quota with an uppercase plan', async () => {
    mountLauncher()
    const trigger = await screen.findByRole('button', {
      name: /Abdo Mohamed, PLUS · Codex, 5h 52% used, 7d 24% used/,
    })

    expect(within(trigger).getByText('PLUS · Codex')).toBeTruthy()
    expect(within(trigger).getByText('52%')).toBeTruthy()
    expect(within(trigger).getByText('24%')).toBeTruthy()
  })

  it('updates the displayed meters when a refreshed account snapshot arrives', async () => {
    const launcher = mountLauncher(accountState)
    expect(screen.getByRole('button', { name: /Abdo Mohamed, PLUS · Codex/ })).toBeTruthy()

    act(() => { launcher.accountUsage.set(refreshedAccountState) })
    const trigger = await screen.findByRole('button', { name: /5h 52% used, 7d 24% used/ })
    const fills = trigger.querySelectorAll('[data-level]')
    expect(fills[0]?.getAttribute('style')).toContain('width: 52%')
    expect(fills[1]?.getAttribute('style')).toContain('width: 24%')
  })

  it('opens the saved-account menu and routes its account row to Accounts', async () => {
    const launcher = mountLauncher()
    const trigger = await screen.findByRole('button', { name: /Abdo Mohamed/ })

    fireEvent.click(trigger)
    expect(launcher.refreshAccounts).toHaveBeenCalledOnce()
    const menu = screen.getByRole('menu', { name: en.accountsMenuLabel })
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Abdo Mohamed/ }))

    expect(launcher.openSection).toHaveBeenCalledWith('models')
    expect(launcher.store.getSnapshot().managerRequested).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps Settings as the secondary popup action', async () => {
    const launcher = mountLauncher()
    fireEvent.click(await screen.findByRole('button', { name: /Abdo Mohamed/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.accountsSettings }))

    expect(launcher.openSettings).toHaveBeenCalledOnce()
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  })
})
