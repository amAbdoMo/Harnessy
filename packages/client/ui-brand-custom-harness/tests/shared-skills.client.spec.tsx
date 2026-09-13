// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  SharedSkillsRow,
  type SharedSkillsRowInjected,
  type SharedSkillsRowProps,
} from '../src/client/SharedSkillsRow.tsx'
import { createSharedSkillsRowStore } from '../src/client/shared-skills-store.ts'
import { en } from '../src/client/locales.ts'
import type { SharedSkillsSettings } from '../src/shared-skills.ts'

afterEach(cleanup)

function mountRow(snapshot: SettingsScopeSnapshot<SharedSkillsSettings>) {
  const store = createSharedSkillsRowStore().create()
  store.actions.sync(snapshot)
  const useStore = <Selected,>(selector: (state: ReturnType<typeof store.getSnapshot>) => Selected): Selected =>
    selector(useSyncExternalStore(
      listener => store.subscribe(listener),
      () => store.getSnapshot(),
    ))
  const chooseDirectory = vi.fn<SharedSkillsRowInjected['chooseDirectory']>(
    async () => ({ path: 'D:\\Shared Skills' }),
  )
  const setDirectory = vi.fn(async () => {})
  const resetDirectory = vi.fn(async () => {})
  const setEnabled = vi.fn(async () => {})
  const props = {
    useStore,
    actions: store.actions,
    t: (key: keyof typeof en) => en[key],
    chooseDirectory,
    setDirectory,
    resetDirectory,
    setEnabled,
  } as unknown as SharedSkillsRowProps
  render(<SharedSkillsRow {...props} />)
  return { chooseDirectory, setDirectory, resetDirectory, setEnabled }
}

const readySnapshot: SettingsScopeSnapshot<SharedSkillsSettings> = {
  status: 'ready',
  value: { enabled: true, directory: 'D:\\Custom Skills' },
  base: { enabled: true, directory: 'C:\\Users\\Abdo\\.agents\\skills' },
  user: { directory: 'D:\\Custom Skills' },
  revision: 2,
  writable: true,
  mode: 'host',
}

describe('Harnessy shared-skills row', () => {
  it('shows the active path and routes folder, reset, and toggle choices', async () => {
    const operations = mountRow(readySnapshot)

    expect(screen.getByTitle('D:\\Custom Skills')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.sharedSkillsChoose }))
    await waitFor(() => { expect(operations.setDirectory).toHaveBeenCalledWith('D:\\Shared Skills') })

    fireEvent.click(screen.getByRole('button', { name: en.sharedSkillsUseDefault }))
    await waitFor(() => { expect(operations.resetDirectory).toHaveBeenCalledOnce() })

    fireEvent.click(screen.getByRole('switch', { name: en.sharedSkillsToggle }))
    await waitFor(() => { expect(operations.setEnabled).toHaveBeenCalledWith(false) })
  })

  it('disables changes when Host settings are unavailable', () => {
    mountRow({ ...readySnapshot, status: 'unavailable', writable: false })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.sharedSkillsChoose }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('switch', { name: en.sharedSkillsToggle }).disabled).toBe(true)
    expect(screen.getByText(en.sharedSkillsUnavailable)).toBeTruthy()
  })

  it('does not write when the native folder picker is cancelled', async () => {
    const operations = mountRow({ ...readySnapshot, value: readySnapshot.base as SharedSkillsSettings, user: undefined })
    operations.chooseDirectory.mockResolvedValueOnce({})
    fireEvent.click(screen.getByRole('button', { name: en.sharedSkillsChoose }))
    await waitFor(() => { expect(operations.chooseDirectory).toHaveBeenCalledOnce() })
    expect(operations.setDirectory).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: en.sharedSkillsUseDefault })).toBeNull()
  })
})
