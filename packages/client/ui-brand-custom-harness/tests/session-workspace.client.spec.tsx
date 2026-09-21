// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionWorkspaceSettings } from '../src/session-workspace.ts'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  SessionWorkspaceRow,
  type SessionWorkspaceRowInjected,
  type SessionWorkspaceRowProps,
} from '../src/client/SessionWorkspaceRow.tsx'
import { createSessionWorkspaceRowStore } from '../src/client/session-workspace-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function mountRow(snapshot: SettingsScopeSnapshot<SessionWorkspaceSettings>) {
  const store = createSessionWorkspaceRowStore().create()
  store.actions.sync(snapshot)
  const useStore = <Selected,>(selector: (state: ReturnType<typeof store.getSnapshot>) => Selected): Selected =>
    selector(useSyncExternalStore(
      listener => store.subscribe(listener),
      () => store.getSnapshot(),
    ))
  const chooseDirectory = vi.fn<SessionWorkspaceRowInjected['chooseDirectory']>(
    async () => ({ path: 'C:\\Users\\Abdo\\Desktop' }),
  )
  const setMode = vi.fn(async () => {})
  const useRemoteDirectory = vi.fn(async () => {})
  render(<SessionWorkspaceRow {...({
    useStore,
    actions: store.actions,
    t: (key: keyof typeof en) => en[key],
    chooseDirectory,
    setMode,
    useRemoteDirectory,
  } as unknown as SessionWorkspaceRowProps)} />)
  return { chooseDirectory, setMode, useRemoteDirectory }
}

const readySnapshot: SettingsScopeSnapshot<SessionWorkspaceSettings> = {
  status: 'ready',
  value: { mode: 'harnessy-default', remoteRoot: '' },
  base: undefined,
  user: undefined,
  revision: 1,
  writable: true,
  mode: 'host',
}

describe('Harnessy Session workspace row', () => {
  it('chooses a folder before enabling remote website work', async () => {
    const operations = mountRow(readySnapshot)

    fireEvent.click(screen.getByRole('button', { name: /Remote website/ }))

    await waitFor(() => {
      expect(operations.useRemoteDirectory).toHaveBeenCalledWith('C:\\Users\\Abdo\\Desktop')
    })
    expect(operations.setMode).not.toHaveBeenCalled()
  })

  it('changes an existing remote folder and can restore the Harnessy default', async () => {
    const operations = mountRow({
      ...readySnapshot,
      value: { mode: 'remote-website', remoteRoot: 'D:\\Remote Work' },
    })

    expect(screen.getByTitle('D:\\Remote Work')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.sessionWorkspaceChangeFolder }))
    await waitFor(() => { expect(operations.chooseDirectory).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: /Harnessy default/ }))
    await waitFor(() => { expect(operations.setMode).toHaveBeenCalledWith('harnessy-default') })
  })

  it('disables changes when Host settings are unavailable', () => {
    mountRow({ ...readySnapshot, status: 'unavailable', writable: false })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Remote website/ }).disabled).toBe(true)
    expect(screen.getByText(en.sessionWorkspaceUnavailable)).toBeTruthy()
  })
})
