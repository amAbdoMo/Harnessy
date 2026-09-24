// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpManagerState } from '@deepseek-ai/dsh-api-remotes/client'
import {
  McpServersSection, type McpManagerOperations, type McpServersSectionProps,
} from '../src/client/McpServersSection.tsx'
import {
  McpConfigurationAction, type McpConfigurationActionProps,
} from '../src/client/McpConfigurationAction.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en, params?: Record<string, unknown>): string => {
  const template: string = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) =>
    name in params ? String(params[name]) : whole)
}

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
    openConfigurationFile: vi.fn(async () => ({})),
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
    const save = vi.fn<McpManagerOperations['save']>(async () => ({ state: connectedState }))
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
    const save = vi.fn<McpManagerOperations['save']>(async () => ({ state }))
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

  it('fills an editable WordPress MCP Adapter template without saving it automatically', async () => {
    const save = vi.fn<McpManagerOperations['save']>(async () => ({ state: connectedState }))
    mount(operations({
      describe: vi.fn(async () => ({ state: { ...connectedState, servers: [] } })),
      save,
    }))

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(en.mcpAdd, 'u') }))
    fireEvent.click(screen.getByRole('button', { name: en.mcpLocal }))
    fireEvent.click(screen.getByRole('button', { name: en.mcpWordPressTemplate }))

    expect(screen.getByLabelText<HTMLInputElement>(en.mcpCommand).value).toBe('npx')
    expect(screen.getByLabelText<HTMLTextAreaElement>(en.mcpArguments).value)
      .toBe('-y\n@automattic/mcp-wordpress-remote@latest')
    expect(screen.getByLabelText<HTMLTextAreaElement>(en.mcpEnvironment).value).toContain(
      'WP_API_URL=https://your-site.example/wp-json/mcp/mcp-adapter-default-server',
    )
    expect(save).not.toHaveBeenCalled()
  })

  it('reviews and imports common JSON profiles without rendering protected values', async () => {
    const save = vi.fn<McpManagerOperations['save']>(async () => ({ state: connectedState }))
    mount(operations({
      describe: vi.fn(async () => ({ state: { ...connectedState, servers: [] } })),
      save,
    }))
    const contents = JSON.stringify({
      mcpServers: {
        wordpress: {
          command: 'npx',
          args: ['-y', '@automattic/mcp-wordpress-remote@latest'],
          env: { WP_API_PASSWORD: 'secret-password' },
        },
        hosted: {
          type: 'http',
          url: 'https://tools.example/mcp',
          headers: { Authorization: 'Bearer secret-token' },
        },
      },
    })
    const file = new File([contents], 'mcp.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => contents })

    fireEvent.change(await screen.findByLabelText(en.mcpImportFile), { target: { files: [file] } })
    expect(await screen.findByRole('region', { name: en.mcpImportReviewTitle })).toBeTruthy()
    expect(screen.getAllByText('wordpress')).toHaveLength(2)
    expect(screen.getAllByText('hosted')).toHaveLength(2)
    expect(document.body.textContent).not.toContain('secret-password')
    expect(document.body.textContent).not.toContain('secret-token')

    fireEvent.click(screen.getByRole('button', { name: en.mcpImportConfirm }))
    await waitFor(() => { expect(save).toHaveBeenCalledTimes(2) })
    expect(save.mock.calls[0]?.[0]).toMatchObject({ transport: 'stdio', serverName: 'wordpress' })
    expect(save.mock.calls[1]?.[0]).toMatchObject({ transport: 'streamable-http', serverName: 'hosted' })
  })
})

describe('Harnessy MCP configuration action', () => {
  it('opens the dedicated MCP document only from the MCP page', async () => {
    const openConfigurationFile = vi.fn(async () => ({}))
    const props = { activeSectionId: 'general', openConfigurationFile, t } as unknown as McpConfigurationActionProps
    const view = render(<McpConfigurationAction {...props} />)
    expect(screen.queryByRole('button', { name: en.mcpOpenConfiguration })).toBeNull()
    view.rerender(<McpConfigurationAction {...props} activeSectionId="custom-harness-mcp" />)
    fireEvent.click(screen.getByRole('button', { name: en.mcpOpenConfiguration }))
    await waitFor(() => { expect(openConfigurationFile).toHaveBeenCalledWith() })
  })
})
