// @vitest-environment jsdom
/** Built account surfaces consume the same pushed Host snapshot without a manual refresh. */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import type { AccountsState, McpManagerState } from '@deepseek-ai/dsh-api-settings-controller/types'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

const buildEnvironmentModulePath = '../../../scripts/client-build-environment.ts'
const buildEnvironmentModule: unknown = await import(buildEnvironmentModulePath)
if (typeof buildEnvironmentModule !== 'object' || buildEnvironmentModule === null) throw new TypeError('missing build environment module')
const readRecord: unknown = Reflect.get(buildEnvironmentModule, 'readClientBuildRecord')
if (!isBuildRecordReader(readRecord)) throw new TypeError('missing client build record reader')
const record: unknown = readRecord(process.cwd())
if (typeof record !== 'object' || record === null) throw new TypeError('missing client build record')
const environment: unknown = Reflect.get(record, 'environment')
if (typeof environment !== 'object' || environment === null) throw new TypeError('missing client build environment')
const custom = Reflect.get(environment, 'DSH_CLIENT_BUILD_PROFILE') === 'custom-harness'
function isBuildRecordReader(value: unknown): value is (root: string) => unknown {
  return typeof value === 'function'
}

const initial: AccountsState = {
  writable: true,
  providers: [{
    id: 'openai-codex', label: 'Codex', authMode: 'oauth', available: true, accountCount: 1,
    activeAccountId: 'codex-1', usageAvailable: true, autoSwitchOnLimit: false,
  }],
  accounts: [{
    id: 'codex-1', ownerId: 'owner-1', provider: 'openai-codex', name: 'Fixture Account', initials: 'FA',
    detail: 'fixture@example.invalid · PLUS', active: true, authMode: 'oauth',
    usage: { windows: [{ id: 'primary', label: '5h', usedPercent: 28 }] },
  }],
}

it.skipIf(!custom)('updates sidebar and open Accounts together on a pushed usage snapshot', async () => {
  const { mock } = mountAssembledApp({ profile: 'custom-harness' })
  mock.unary('accounts/describe', () => ok(initial))
  mock.unary('accounts/refreshUsage', () => ok(initial))
  mock.unary('mcpManager/describe', () => ok({ available: false, writable: false, servers: [] } satisfies McpManagerState))
  mock.unary('llm/listProviders', () => ok([]))
  mock.unary('llm/listConfigurableProviders', () => ok([]))
  mock.unary('modelCapabilities/inspect', () => ok([]))
  const launcher = await screen.findByRole('button', { name: /Fixture Account.*28% used/ }, { timeout: 10_000 })
  fireEvent.click(launcher)
  fireEvent.click(await screen.findByRole('menuitem', { name: /Fixture Account/ }))
  const dialog = await screen.findByRole('dialog', { name: 'Accounts' })
  expect(within(dialog).queryByRole('button', { name: /refresh/i })).toBeNull()
  expect(await within(dialog).findByText('28% used')).toBeTruthy()
  await waitFor(() => {
    expect(mock.log.calls('accounts/refreshUsage').length).toBeGreaterThanOrEqual(2)
    expect(mock.log.calls('accounts/refreshUsage').every(call => call.state === 'answered')).toBe(true)
  })
  const reads = mock.log.calls('accounts/refreshUsage').length
  const updated: AccountsState = {
    ...initial,
    accounts: [{ ...initial.accounts[0]!, usage: { windows: [{ id: 'primary', label: '5h', usedPercent: 79 }] } }],
  }
  await act(async () => {
    mock.streams.push('$events', { type: 'emit', event: 'accounts/changed', args: [updated] })
    await mock.streams.drained('$events')
  })
  expect(await within(dialog).findByText('79% used')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Fixture Account.*79% used/ })).toBeTruthy()
  expect(mock.log.calls('accounts/refreshUsage')).toHaveLength(reads)
  expect({
    sidebar: screen.getByRole('button', { name: /Fixture Account.*79% used/ }).getAttribute('aria-label'),
    manager: within(dialog).getByText('79% used').textContent,
    refreshButton: within(dialog).queryByRole('button', { name: /refresh/i }),
  }).toMatchInlineSnapshot(`
    {
      "manager": "79% used",
      "refreshButton": null,
      "sidebar": "Fixture Account, PLUS · Codex, 5h 79% used",
    }
  `)
})
