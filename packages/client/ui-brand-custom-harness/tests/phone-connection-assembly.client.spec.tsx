// @vitest-environment jsdom
/** Phone settings contribution driven through the real client Loader and slot renderer. */
import { readFileSync } from 'node:fs'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, onTestFinished, vi } from 'vitest'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import {
  ClientRoster, createClientTest, webApp, type TestClient,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { NativePhoneConnection } from '../src/client/phone-connection.ts'
import { en } from '../src/client/locales.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  readonly name: string
  readonly dsh: { readonly client: { readonly inject: readonly string[] } }
}
const BRAND = manifest.name
const roster = ClientRoster.of([...webApp.rows, {
  name: BRAND, inject: manifest.dsh.client.inject, immediately: false,
}])
const it = createClientTest({ roster }, { mount: true })
const ROOT = 'https://pc.example.ts.net/'
const ROW = 'custom-harness-phone-connection'
const TOAST = 'custom-harness-phone-connection-result'

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
  mock.remote.mcpManager.describe.mockResolvedValue(ok({ available: true, writable: true, servers: [] }))
}

async function openGeneral(client: TestClient): Promise<void> {
  await client.flush()
  fireEvent.click(await screen.findByRole('button', { name: /No accounts saved/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.accountsSettings }))
  await client.flush()
}

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
