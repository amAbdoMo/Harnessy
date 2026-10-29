// @vitest-environment jsdom
/** Phone settings contribution driven through the real client Loader and slot renderer. */
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, onTestFinished, vi } from 'vitest'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import {
  ClientRoster, createClientTest, webApp, type TestClient,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { loadPluginModules } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/modules.ts'
import type { NativePhoneConnection } from '../src/client/phone-connection.ts'
import type { NativeCompanion, NativeCompanionStatus } from '../src/client/companion.ts'
import { en } from '../src/client/locales.ts'
import manifest from '../package.json'

const BRAND = manifest.name
const roster = ClientRoster.of([...webApp.rows, {
  name: BRAND, inject: manifest.dsh.client.inject, immediately: false,
}]).closure([BRAND, '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-settings-general'])
const it = createClientTest({ roster }, { mount: true })
const ROOT = 'https://pc.example.ts.net/'
const ROW = 'custom-harness-phone-connection'
const TOAST = 'custom-harness-phone-connection-result'
const COMPANION_ROW = 'custom-harness-companion'

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

function configure(mock: RemoteMock): void {
  mock.remote.accounts.describe.mockResolvedValue(ok({ writable: true, accounts: [], providers: [] }))
  mock.remote.accounts.refreshUsage.mockResolvedValue(ok({ writable: true, accounts: [], providers: [] }))
  mock.remote.accounts.refreshCachedUsage.mockResolvedValue(ok({ writable: true, accounts: [], providers: [] }))
  mock.remote.mcpManager.describe.mockResolvedValue(ok({ available: true, writable: true, servers: [] }))
}

async function openGeneral(client: TestClient): Promise<void> {
  await client.flush()
  fireEvent.click(await screen.findByRole('button', { name: /No accounts saved/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.accountsSettings }))
  await client.flush()
}

describe('assembled native companion settings', () => {
  it.for([
    { available: false, connected: false, pairedCount: 0, text: en.companionUnavailable },
    { available: true, connected: false, pairedCount: 1, text: en.companionDisconnected },
    { available: true, connected: true, pairedCount: 2, text: en.companionConnected },
  ])('prefers native status over legacy setup: $text', async ({ text, ...status }, { mock, start }) => {
    configure(mock)
    const legacy: NativePhoneConnection = {
      describe: vi.fn(async () => ({ enabled: false as const })), copyPairingUrl: vi.fn(async () => {}),
    }
    const companion: NativeCompanion = { describe: async () => status, open: async () => {} }
    vi.stubGlobal('dshDesktop', { companion, phoneConnection: legacy })
    const client = await start()
    await openGeneral(client)
    const row = screen.getByRole('region', { name: en.companionTitle })
    expect(within(row).getByRole('status').textContent).toBe(text)
    const pairedCount = within(row).queryByText(en.companionPairedCount.replace('{count}', String(status.pairedCount)))
    expect(pairedCount !== null).toBe(status.available)
    within(row).getByText(en.companionAuthority)
    within(row).getByText(en.companionPairing)
    within(row).getByText(en.companionKeepAwake)
    within(row).getByRole('button', { name: en.companionOpen })
    expect(screen.queryByText(en.phoneConnectionSetup)).toBeNull()
    expect(screen.queryByText(en.phoneConnectionPrivateServe)).toBeNull()
    expect(screen.queryByRole('region', { name: en.phoneConnectionTitle })).toBeNull()
    expect(screen.queryByRole('button', { name: en.phoneConnectionCopy })).toBeNull()
    expect(legacy.describe).not.toHaveBeenCalled()
    expect(legacy.copyPairingUrl).not.toHaveBeenCalled()
    expect(client.ctx.slots.entries('shell.overlay').some(entry => entry.options.id === TOAST)).toBe(false)
  })

  it('holds native dialog progress across settings remounts and refreshes only after completion', async ({ mock, start }) => {
    configure(mock)
    const dialog = Promise.withResolvers<undefined>()
    const refresh = Promise.withResolvers<NativeCompanionStatus>()
    onTestFinished(() => {
      dialog.resolve(undefined)
      refresh.resolve({ available: true, connected: true, pairedCount: 1 })
    })
    const description = vi.fn<NativeCompanion['describe']>()
      .mockResolvedValueOnce({ available: true, connected: false, pairedCount: 0 })
      .mockImplementationOnce(() => refresh.promise)
    const open = vi.fn(() => dialog.promise)
    vi.stubGlobal('dshDesktop', { companion: { describe: description, open } })
    const client = await start()
    await openGeneral(client)
    fireEvent.click(screen.getByRole('button', { name: en.companionOpen }))
    expect(description).toHaveBeenCalledOnce()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.close }))
    await openGeneral(client)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.companionOpen }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.companionRefresh }).disabled).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    await act(async () => { dialog.resolve(undefined); await dialog.promise })
    expect(description).toHaveBeenCalledTimes(2)
    expect(within(screen.getByRole('region', { name: en.companionTitle })).getByRole('status').textContent).toBe(en.companionDisconnected)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.companionOpen }).disabled).toBe(true)
    await act(async () => {
      refresh.resolve({ available: true, connected: true, pairedCount: 1 })
      await refresh.promise
    })
    await client.flush()
    expect(within(screen.getByRole('region', { name: en.companionTitle })).getByRole('status').textContent).toBe(en.companionConnected)
    screen.getByText(en.companionPairedCount.replace('{count}', '1'))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.companionOpen }).disabled).toBe(false)
  })

  it('retries a safe read failure without falling back to legacy access', async ({ mock, start }) => {
    configure(mock)
    const secretFailure = 'native private details must remain hidden'
    const description = vi.fn<NativeCompanion['describe']>()
      .mockRejectedValueOnce(new Error(secretFailure))
      .mockResolvedValueOnce({ available: true, connected: true, pairedCount: 1 })
    vi.stubGlobal('dshDesktop', { companion: { describe: description, open: async () => {} } })
    const client = await start()
    await openGeneral(client)
    expect(screen.getByRole('alert').textContent).toBe(en.companionReadFailed)
    expect(document.body.textContent).not.toContain(secretFailure)
    expect(screen.queryByText(en.companionUnavailable)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.companionRefresh }))
    await client.flush()
    expect(within(screen.getByRole('region', { name: en.companionTitle })).getByRole('status').textContent).toBe(en.companionConnected)
    expect(screen.queryByText(en.companionReadFailed)).toBeNull()
  })

  it('removes native contributions on reload and unload and drops the old dialog completion', async ({ mock, start }) => {
    configure(mock)
    const dialog = Promise.withResolvers<undefined>()
    onTestFinished(() => { dialog.resolve(undefined) })
    const description = vi.fn<NativeCompanion['describe']>()
      .mockResolvedValue({ available: true, connected: false, pairedCount: 0 })
    vi.stubGlobal('dshDesktop', { companion: { describe: description, open: () => dialog.promise } })
    const client = await start()
    await openGeneral(client)
    fireEvent.click(screen.getByRole('button', { name: en.companionOpen }))
    await act(async () => { await client.reload(BRAND) })
    await client.flush()
    expect(client.ctx.slots.entries('settings.general.item').filter(entry => entry.options.id === COMPANION_ROW)).toHaveLength(1)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.companionOpen }).disabled).toBe(false)
    const readsBefore = description.mock.calls.length
    await act(async () => { dialog.resolve(undefined); await dialog.promise })
    await client.flush()
    expect(description).toHaveBeenCalledTimes(readsBefore)
    await act(async () => { await client.unload(BRAND) })
    expect(client.ctx.slots.entries('settings.general.item').some(entry => entry.options.id === COMPANION_ROW)).toBe(false)
    expect(screen.queryByRole('region', { name: en.companionTitle })).toBeNull()
  })
})

describe('assembled desktop phone settings', () => {
  it.for([
    { label: 'ordinary browser page', desktop: undefined },
    { label: 'desktop without phone capability', desktop: {} },
  ])('does not contribute a phone row or toast on a $label', async ({ label: _label, desktop }, { mock, start }) => {
    configure(mock)
    vi.stubGlobal('dshDesktop', desktop)
    const client = await start()
    await openGeneral(client)
    expect(screen.queryByRole('region', { name: en.phoneConnectionTitle })).toBeNull()
    expect(screen.queryByRole('region', { name: en.companionTitle })).toBeNull()
    expect(client.ctx.slots.entries('settings.general.item').some(entry => entry.options.id === COMPANION_ROW)).toBe(false)
    expect(client.ctx.slots.entries('settings.general.item').some(entry => entry.options.id === ROW)).toBe(false)
    expect(client.ctx.slots.entries('shell.overlay').some(entry => entry.options.id === TOAST)).toBe(false)
  })

  it('renders desktop disabled guidance through General settings', async ({ mock, start }) => {
    configure(mock)
    const native: NativePhoneConnection = {
      describe: async () => ({ enabled: false }), copyPairingUrl: vi.fn(async () => {}),
    }
    vi.stubGlobal('dshDesktop', { phoneConnection: native })
    const client = await start()
    await openGeneral(client)
    screen.getByRole('region', { name: en.phoneConnectionTitle })
    screen.getByText(en.phoneConnectionSetup)
    screen.getByText(en.phoneConnectionPrivateServe)
    expect(screen.queryByRole('button', { name: en.phoneConnectionCopy })).toBeNull()
    expect(native.copyPairingUrl).not.toHaveBeenCalled()
  })

  it('keeps the copy toast after settings close and removes both contributions on HMR and unload', async ({ mock, start }) => {
    configure(mock)
    const pending = Promise.withResolvers<undefined>()
    onTestFinished(() => { pending.resolve(undefined) })
    const native: NativePhoneConnection = {
      describe: async () => ({ enabled: true, remoteRoot: ROOT }), copyPairingUrl: () => pending.promise,
    }
    vi.stubGlobal('dshDesktop', { phoneConnection: native })
    const client = await start()
    await openGeneral(client)
    screen.getByText(ROOT)
    fireEvent.click(screen.getByRole('button', { name: en.phoneConnectionCopy }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.close }))
    expect(screen.queryByRole('region', { name: en.phoneConnectionTitle })).toBeNull()
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(screen.getByRole('alert').textContent).toBe(en.phoneConnectionCopied)

    await act(async () => { await client.reload(BRAND) })
    await client.flush()
    expect(screen.queryByText(en.phoneConnectionCopied)).toBeNull()
    expect(client.ctx.slots.entries('settings.general.item').filter(entry => entry.options.id === ROW)).toHaveLength(1)
    expect(client.ctx.slots.entries('shell.overlay').filter(entry => entry.options.id === TOAST)).toHaveLength(1)
    await act(async () => { await client.unload(BRAND) })
    expect(client.ctx.slots.entries('settings.general.item').some(entry => entry.options.id === ROW)).toBe(false)
    expect(client.ctx.slots.entries('shell.overlay').some(entry => entry.options.id === TOAST)).toBe(false)
  })
})
