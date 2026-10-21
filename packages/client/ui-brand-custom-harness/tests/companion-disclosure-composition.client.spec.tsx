// @vitest-environment jsdom
/** Compact companion disclosure mounted through the client Loader and real settings renderer. */
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, vi } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { ClientRoster, createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { loadPluginModules } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/modules.ts'
import type { NativeCompanion } from '../src/client/companion.ts'
import { en } from '../src/client/locales.ts'
import manifest from '../package.json'

const roster = ClientRoster.of([...webApp.rows, {
  name: manifest.name, inject: manifest.dsh.client.inject, immediately: false,
}]).closure([manifest.name, '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-settings-general'])
const it = createClientTest({ roster }, { mount: true })

// Importing the settings roster is suite setup, not native dialog latency.
beforeAll(async () => {
  await loadPluginModules({ roster: roster.without(['@deepseek-ai/dsh-api-remotes']) })
}, 60_000)

beforeEach(() => {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en'])
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'custom-harness')
  vi.stubEnv('DSH_CLIENT_PRODUCT_NAME', 'Harnessy')
  vi.stubEnv('DSH_CLIENT_PRODUCT_URL', 'https://example.com/product')
  vi.stubEnv('DSH_CLIENT_SUPPORT_URL', 'https://example.com/support')
  vi.stubEnv('DSH_CLIENT_VERSION', 'test')
  vi.stubEnv('DSH_CLIENT_ICON_PATH', '/harnessy.png')
  vi.stubEnv('DSH_CLIENT_MARK_PATH', '/harnessy-mark.png')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('keeps native errors visible while setup and permissions are collapsed in General settings', async ({ mock, start }) => {
  mock.remote.accounts.describe.mockResolvedValue(ok({ writable: true, accounts: [], providers: [] }))
  mock.remote.accounts.refreshCachedUsage.mockResolvedValue(ok({ writable: true, accounts: [], providers: [] }))
  mock.remote.mcpManager.describe.mockResolvedValue(ok({ available: true, writable: true, servers: [] }))
  const native: NativeCompanion = {
    describe: async () => ({ available: false, connected: false, pairedCount: 2 }),
    open: async () => { throw new Error('private native failure') },
  }
  vi.stubGlobal('dshDesktop', { companion: native })
  const client = await start()
  await client.flush()
  fireEvent.click(await screen.findByRole('button', { name: /No accounts saved/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.accountsSettings }))
  await client.flush()
  const row = screen.getByRole('region', { name: en.companionTitle })
  const summary = within(row).getByText(en.companionRequirements).closest('summary')!
  const disclosure = summary.parentElement as HTMLDetailsElement
  expect(disclosure.open).toBe(false)
  expect(within(row).getAllByRole('button').map(button => button.textContent))
    .toEqual([en.companionOpen, en.companionRefresh])
  within(row).getByText(en.companionSetupAttention)
  expect(within(row).getByRole('status').textContent).toBe(en.companionUnavailable)
  fireEvent.click(summary)
  expect(disclosure.open).toBe(true)
  for (const copy of [en.companionUnavailableDetails, en.companionPairing,
    en.companionAuthority, en.companionKeepAwake]) {
    expect(within(row).getByText(copy).closest('details')).toBe(disclosure)
  }
  fireEvent.click(summary)
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name: en.companionOpen })) })
  await client.flush()
  expect(disclosure.open).toBe(false)
  expect(within(row).getByRole('alert').textContent).toBe(en.companionOpenFailed)
  expect(within(row).getByRole('alert').closest('details')).toBeNull()
  expect(within(row).getByRole('status').textContent).toBe(en.companionUnavailable)
  expect(within(row).queryByText(en.companionPairedCount.replace('{count}', '2'))).toBeNull()
})
