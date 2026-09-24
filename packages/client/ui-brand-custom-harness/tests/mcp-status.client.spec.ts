// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { McpManagerState, McpServerView } from '@deepseek-ai/dsh-api-remotes/client'
import type { McpManagerOperations } from '../src/client/McpServersSection.tsx'
import { McpStatusController } from '../src/client/mcp-status.ts'
import type { HarnessNotificationEvent } from '../src/client/notification-history.ts'

function server(status: McpServerView['status'], updatedAt: number): McpServerView {
  return {
    id: 'wordpress',
    name: 'WordPress',
    serverName: 'wordpress',
    transport: 'stdio',
    enabled: true,
    endpoint: 'npx',
    args: [],
    status,
    tools: [],
    authenticationConfigured: true,
    environmentKeys: ['WP_API_URL'],
    updatedAt,
  }
}

function state(status: McpServerView['status'], updatedAt: number): McpManagerState {
  return { available: true, writable: true, servers: [server(status, updatedAt)] }
}

function operations(): McpManagerOperations {
  return {
    describe: async () => ({ state: state('connected', 1) }),
    save: async () => ({ state: state('connected', 1) }),
    setEnabled: async () => ({ state: state('connected', 1) }),
    reconnect: async () => ({ state: state('connected', 1) }),
    remove: async () => ({ state: { available: true, writable: true, servers: [] } }),
    openConfigurationFile: async () => ({}),
  }
}

describe('MCP status observer', () => {
  it('suppresses initial state and reports one terminal failure followed by recovery', () => {
    const notifications: HarnessNotificationEvent[] = []
    const controller = new McpStatusController(operations(), (event) => { notifications.push(event) })
    controller.publish(state('connected', 1))
    expect(notifications).toEqual([])

    controller.publish(state('error', 2))
    controller.publish(state('error', 2))
    controller.publish(state('connected', 3))

    expect(notifications.map(event => event.kind)).toEqual([
      'mcp-connection-failed',
      'mcp-connection-recovered',
    ])
  })

  it('publishes a reconnect response immediately', async () => {
    const controller = new McpStatusController(operations(), vi.fn())
    expect(await controller.reconnect('wordpress')).toBeUndefined()
    expect(controller.snapshot.getSnapshot().state?.servers[0]?.status).toBe('connected')
  })
})
