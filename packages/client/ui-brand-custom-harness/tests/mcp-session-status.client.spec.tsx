// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpManagerState, McpServerView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createAccountsMenuStore } from '../src/client/accounts-menu-store.ts'
import { en } from '../src/client/locales.ts'
import { McpSessionStatus, type McpSessionStatusProps } from '../src/client/McpSessionStatus.tsx'
import type { McpStatusSnapshot } from '../src/client/mcp-status.ts'

afterEach(cleanup)

function server(status: McpServerView['status']): McpServerView {
  return {
    id: 'wordpress', name: 'WordPress', serverName: 'wordpress', transport: 'stdio',
    enabled: status !== 'disabled', endpoint: 'npx', args: [], status, tools: ['get_posts'],
    authenticationConfigured: true, environmentKeys: ['WP_API_URL'], updatedAt: 1,
  }
}

function mount(status: McpServerView['status']) {
  const menu = createAccountsMenuStore().create()
  const registry: McpManagerState = { available: true, writable: true, servers: [server(status)] }
  const mcpStatus = createSnapshotStore<McpStatusSnapshot>({ state: registry, error: undefined, refreshing: false })
  const reconnect = vi.fn(async () => undefined)
  const useStore: McpSessionStatusProps['useStore'] = selector => selector(useSyncExternalStore(
    listener => menu.subscribe(listener),
    () => menu.getSnapshot(),
  ))
  const useMcpStatus: McpSessionStatusProps['useMcpStatus'] = selector => selector(useSyncExternalStore(
    listener => mcpStatus.subscribe(listener),
    () => mcpStatus.getSnapshot(),
  ))
  const useConversation: McpSessionStatusProps['useConversation'] = selector => selector({
    views: { get: () => undefined }, activeTargets: new Set(),
  })
  render(<McpSessionStatus {...({
    useStore,
    actions: menu.actions,
    useMcpStatus,
    useConversation,
    reconnect,
    openConversationEvent: vi.fn(),
    t: (key: keyof typeof en, values?: Record<string, unknown>) => {
      let copy: string = en[key]
      for (const [name, value] of Object.entries(values ?? {})) copy = copy.replace(`{${name}}`, String(value))
      return copy
    },
  } as unknown as McpSessionStatusProps)} />)
  return { menu, reconnect }
}

describe('MCP Session status', () => {
  it('shows connected servers and routes Manage MCP to its settings section', () => {
    const mounted = mount('connected')
    expect(screen.getByText(en.mcpSessionShortLabel)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Open MCP server status: 1 connected/u }))
    expect(screen.getByRole('dialog', { name: en.mcpSessionTitle })).toBeTruthy()
    expect(screen.getByText('WordPress')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.mcpSessionManage }))
    expect(mounted.menu.getSnapshot().sectionRequested).toBe('custom-harness-mcp')
  })

  it('offers reconnect only for a failed enabled server', () => {
    const mounted = mount('error')
    fireEvent.click(screen.getByRole('button', { name: /need attention/u }))
    fireEvent.click(screen.getByRole('button', { name: en.mcpSessionReconnect }))
    expect(mounted.reconnect).toHaveBeenCalledWith('wordpress')
  })
})
