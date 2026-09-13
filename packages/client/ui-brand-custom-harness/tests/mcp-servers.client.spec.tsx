// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpManagerState } from '@deepseek-ai/dsh-api-remotes/client'
import {
  McpServersSection, type McpManagerOperations, type McpServersSectionProps,
} from '../src/client/McpServersSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

const connectedState: McpManagerState = {
  available: true,
  writable: true,
  servers: [{
    id: 'wordpress-id',
    name: 'WordPress tools',
    serverName: 'wordpress',
    transport: 'streamable-http',
    enabled: true,
    endpoint: 'https://tools.example/mcp',
    headerName: 'X-API-Key',
    args: [],
    status: 'connected',
    tools: ['inspect-site', 'update-page'],
    authenticationConfigured: true,
    environmentKeys: [],
    updatedAt: 1,
  }],
}

function operations(overrides: Partial<McpManagerOperations> = {}): McpManagerOperations {
  return {
    describe: vi.fn(async () => ({ state: connectedState })),
    save: vi.fn(async () => ({ state: connectedState })),
    setEnabled: vi.fn(async () => ({ state: connectedState })),
    reconnect: vi.fn(async () => ({ state: connectedState })),
    remove: vi.fn(async () => ({ state: { ...connectedState, servers: [] } })),
    ...overrides,
  }
}

function mount(api: McpManagerOperations): void {
  render(<McpServersSection {...({ operations: api, t } as unknown as McpServersSectionProps)} />)
}

describe('Harnessy MCP server settings', () => {
  it('shows live status and discovered tools without rendering saved authentication', async () => {
    mount(operations())
    expect(await screen.findByText('WordPress tools')).toBeTruthy()
    expect(screen.getByText(en.mcpStatusConnected)).toBeTruthy()
    fireEvent.click(screen.getByText(`2 ${en.mcpTools}`))
    expect(screen.getByText('inspect-site')).toBeTruthy()
    expect(screen.getByText('update-page')).toBeTruthy()
    expect(document.body.textContent).not.toContain('X-API-Key')
  })

  it('adds a remote server while keeping the authentication value inside the password field', async () => {
    const save = vi.fn(async () => ({ state: connectedState }))
    const api = operations({
      describe: vi.fn(async () => ({ state: { ...connectedState, servers: [] } })),
      save,
    })
    mount(api)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(en.mcpAdd, 'u') }))
    fireEvent.change(screen.getByLabelText(en.mcpDisplayName), { target: { value: 'WordPress tools' } })
    fireEvent.change(screen.getByLabelText(en.mcpToolNamespace), { target: { value: 'wordpress' } })
    fireEvent.change(screen.getByLabelText(en.mcpUrl), { target: { value: 'https://tools.example/mcp' } })
    fireEvent.change(screen.getByLabelText(en.mcpHeaderValue), { target: { value: 'secret-token' } })
    expect(screen.getByLabelText<HTMLInputElement>(en.mcpHeaderValue).type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: en.mcpSave }))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith(expect.objectContaining({
        name: 'WordPress tools', serverName: 'wordpress', authorization: 'secret-token',
      }))
    })
    expect(document.body.textContent).not.toContain('secret-token')
  })

  it('preserves safe editable connection fields and routes test, disable, and remove actions', async () => {
    const state: McpManagerState = {
      ...connectedState,
      servers: [{
        id: 'wordpress-id', name: 'WordPress tools', serverName: 'wordpress',
        transport: 'stdio', enabled: true, endpoint: 'npx',
        args: ['-y', '@example/server'], cwd: 'C:\\Sites', status: 'connected',
        tools: ['inspect-site', 'update-page'], authenticationConfigured: true,
        environmentKeys: ['API_TOKEN'], updatedAt: 1,
      }],
    }
    const save = vi.fn(async () => ({ state }))
    const setEnabled = vi.fn(async () => ({ state }))
    const reconnect = vi.fn(async () => ({ state }))
    const remove = vi.fn(async () => ({ state: { ...state, servers: [] } }))
    mount(operations({ describe: vi.fn(async () => ({ state })), save, setEnabled, reconnect, remove }))

    fireEvent.click(await screen.findByRole('button', { name: en.mcpEdit }))
    expect(screen.getByLabelText<HTMLInputElement>(en.mcpCommand).value).toBe('npx')
    expect(screen.getByLabelText<HTMLTextAreaElement>(en.mcpArguments).value).toBe('-y\n@example/server')
    expect(screen.getByLabelText<HTMLInputElement>(en.mcpWorkingDirectory).value).toBe('C:\\Sites')
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))

    fireEvent.click(screen.getByRole('button', { name: en.mcpTest }))
    await waitFor(() => { expect(reconnect).toHaveBeenCalledWith('wordpress-id') })
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => { expect(setEnabled).toHaveBeenCalledWith('wordpress-id', false) })
    fireEvent.click(screen.getByRole('button', { name: en.mcpRemove }))
    fireEvent.click(screen.getAllByRole('button', { name: en.mcpRemove }).at(-1)!)
    await waitFor(() => { expect(remove).toHaveBeenCalledWith('wordpress-id') })
  })
})
