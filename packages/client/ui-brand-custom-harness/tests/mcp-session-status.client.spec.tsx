// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpManagerState, McpServerView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { en } from '../src/client/locales.ts'
import { McpSessionStatus, type McpSessionStatusProps } from '../src/client/McpSessionStatus.tsx'
import type { McpStatusSnapshot } from '../src/client/mcp-status.ts'
import { slotTestProps } from './slot-test-props.ts'

afterEach(cleanup)

function server(status: McpServerView['status']): McpServerView {
  return {
    id: 'wordpress', name: 'WordPress', serverName: 'wordpress', transport: 'stdio',
    enabled: status !== 'disabled', endpoint: 'npx', args: [], status, tools: ['get_posts'],
    authenticationConfigured: true, environmentKeys: ['WP_API_URL'], updatedAt: 1,
  }
}

function mount(status: McpServerView['status'], name = 'WordPress') {
  const registry: McpManagerState = { available: true, writable: true, servers: [{ ...server(status), name }] }
  const mcpStatus = createSnapshotStore<McpStatusSnapshot>({ state: registry, error: undefined, refreshing: false })
  const reconnect = vi.fn(async () => undefined)
  const manage = vi.fn()
  const useMcpStatus: McpSessionStatusProps['useMcpStatus'] = selector => selector(useSyncExternalStore(
    listener => mcpStatus.subscribe(listener),
    () => mcpStatus.getSnapshot(),
  ))
  const useConversation: McpSessionStatusProps['useConversation'] = selector => selector({
    views: { get: () => undefined, grouped: () => undefined }, activeTargets: new Set(),
  })
  render(<McpSessionStatus {...slotTestProps<McpSessionStatusProps>({
    useMcpStatus,
    useConversation,
    reconnect,
    manage,
    openConversationEvent: vi.fn(),
    t: (key: keyof typeof en, values?: Record<string, unknown>) => {
      let copy: string = en[key]
      for (const [name, value] of Object.entries(values ?? {})) copy = copy.replace(`{${name}}`, String(value))
      return copy
    },
  })} />)
  return { manage, reconnect }
}

describe('MCP Session status', () => {
  it('shows connected servers and routes Manage MCP to its settings section', () => {
    const mounted = mount('connected')
    expect(screen.getByText(en.mcpSessionShortLabel)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Open MCP server status: 1 connected/u }))
    expect(screen.getByRole('dialog', { name: en.mcpSessionTitle })).toBeTruthy()
    expect(screen.getByText('WordPress')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.mcpSessionManage }))
    expect(mounted.manage).toHaveBeenCalledOnce()
  })

  it.each([
    ['connected', en.mcpStatusConnected],
    ['connecting', en.mcpStatusConnecting],
    ['reconnecting', en.mcpStatusReconnecting],
    ['disabled', en.mcpStatusDisabled],
  ] as const)('retains the %s label and usage detail without offering reconnect', (status, label) => {
    const name = 'WordPress MCP Adapter — production editorial workspace with a long server name'
    mount(status, name)
    fireEvent.click(screen.getByRole('button', { name: /^Open MCP server status:/u }))
    expect(screen.getByText(name).getAttribute('title')).toBe(name)
    expect(screen.getByText(label)).toBeTruthy()
    expect(screen.getByText(en.mcpSessionNeverUsed)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.mcpSessionReconnect })).toBeNull()
  })

  it('disables reconnect while the failed server request is pending and restores the action afterward', async () => {
    const mounted = mount('error')
    fireEvent.click(screen.getByRole('button', { name: /need attention/u }))
    expect(screen.getByText(en.mcpStatusError)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.mcpSessionReconnect }))
    expect(mounted.reconnect).toHaveBeenCalledWith('wordpress')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.mcpStatusReconnecting }).disabled).toBe(true)
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: en.mcpSessionReconnect }).disabled).toBe(false)
    })
  })
})
