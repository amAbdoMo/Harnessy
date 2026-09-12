// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountsState } from '@deepseek-ai/dsh-api-remotes/client'
import {
  AccountsManagerCard, type AccountsManagerCardProps, type AccountsManagerOperations,
} from '../src/client/AccountsManagerCard.tsx'
import { en } from '../src/client/locales.ts'

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
      accountCount: 1, activeAccountId: 'codex-1', usageAvailable: true,
    },
    { id: 'zai', label: 'GLM', authMode: 'api-key', available: true, accountCount: 0, usageAvailable: false },
  ],
  accounts: [{
    id: 'codex-1', provider: 'openai-codex', name: 'Abdo', detail: 'abdo@example.com · plus',
    initials: 'AM', active: true, authMode: 'oauth',
  }],
}

function operations(overrides: Partial<AccountsManagerOperations> = {}): AccountsManagerOperations {
  return {
    describe: vi.fn(async () => ({ state: baseState })),
    addOAuth: vi.fn(async () => ({ authorized: false })),
    addApiKey: vi.fn(async () => ({ state: baseState })),
    activate: vi.fn(async () => ({ state: baseState })),
    rename: vi.fn(async () => ({ state: baseState })),
    remove: vi.fn(async () => ({ state: baseState })),
    refreshUsage: vi.fn(async () => ({ state: baseState })),
    ...overrides,
  }
}

function renderManager(value: AccountsManagerOperations, presentModal = vi.fn(() => vi.fn())) {
  return {
    ...render(<AccountsManagerCard
      {...({ operations: value, t, presentModal } as unknown as AccountsManagerCardProps)} />),
    presentModal,
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

  it('renders animated Codex usage and activates another saved account', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    const twoAccounts: AccountsState = {
      ...baseState,
      providers: [{ ...baseState.providers[0]!, accountCount: 2 }],
      accounts: [
        { ...baseState.accounts[0]!, usage: { windows: [{ id: '5h', label: '5h', usedPercent: 40 }] } },
        {
          id: 'codex-2', provider: 'openai-codex', name: 'Spare', initials: 'SP', active: false,
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
