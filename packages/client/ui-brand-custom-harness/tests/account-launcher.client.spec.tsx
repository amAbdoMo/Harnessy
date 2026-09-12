// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountsState } from '@deepseek-ai/dsh-api-remotes/client'
import { AccountLauncher, type AccountLauncherProps } from '../src/client/AccountLauncher.tsx'
import { createAccountsMenuStore } from '../src/client/accounts-menu-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const accountState: AccountsState = {
  writable: true,
  providers: [{
    id: 'openai-codex', label: 'Codex', authMode: 'oauth', available: true,
    accountCount: 1, activeAccountId: 'codex-1', usageAvailable: true,
  }],
  accounts: [{
    id: 'codex-1', provider: 'openai-codex', name: 'Abdo Mohamed',
    detail: 'abdo@example.com · plus', initials: 'AM', active: true, authMode: 'oauth',
  }],
}

function mountLauncher() {
  const store = createAccountsMenuStore().create()
  const openSettings = vi.fn()
  const openSection = vi.fn()
  const useStore = <Selected,>(selector: (state: ReturnType<typeof store.getSnapshot>) => Selected): Selected =>
    selector(useSyncExternalStore(
      listener => store.subscribe(listener),
      () => store.getSnapshot(),
    ))
  const props = {
    wide: true,
    openSettings,
    openSection,
    operations: { describe: vi.fn(async () => ({ state: accountState })) },
    useStore,
    actions: store.actions,
    t: (key: keyof typeof en) => en[key],
  } as unknown as AccountLauncherProps
  render(<AccountLauncher {...props} />)
  return { openSection, openSettings, store }
}

describe('Harnessy account launcher', () => {
  it('opens the saved-account menu and routes its account row to Accounts', async () => {
    const launcher = mountLauncher()
    const trigger = await screen.findByRole('button', { name: /Abdo Mohamed/ })

    fireEvent.click(trigger)
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
