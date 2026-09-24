/** Shared live MCP status for the settings page, Session header, and notifications. */

import type { McpManagerState, McpServerView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { McpManagerOperations } from './McpServersSection.tsx'
import type { HarnessNotificationEvent } from './notification-history.ts'

const REFRESH_INTERVAL_MS = 3_000

/** Current redacted MCP registry state. */
export interface McpStatusSnapshot {
  readonly state: McpManagerState | undefined
  readonly error: string | undefined
  readonly refreshing: boolean
}

/** Polls MCP health once for every UI consumer and detects terminal outages and recovery. */
export class McpStatusController {
  /** Observable state consumed by the Session header. */
  readonly snapshot: SnapshotStore<McpStatusSnapshot> = createSnapshotStore({
    state: undefined,
    error: undefined,
    refreshing: false,
  })
  private initialized = false
  private refreshing = false
  private previous = new Map<string, McpServerView['status']>()

  constructor(
    private readonly operations: McpManagerOperations,
    private readonly notify: (event: HarnessNotificationEvent) => void,
  ) {}

  /**
   * Start periodic and foreground refreshes.
   * @returns Lifecycle disposer.
   */
  start(): () => void {
    void this.refresh()
    const timer = setInterval(() => { void this.refresh() }, REFRESH_INTERVAL_MS)
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void this.refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }

  /** Refresh the redacted registry without allowing overlapping requests. */
  async refresh(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    this.snapshot.set({ ...this.snapshot.getSnapshot(), refreshing: true })
    try {
      const response = await this.operations.describe()
      if (response.state !== undefined) this.publish(response.state)
      else this.snapshot.set({ ...this.snapshot.getSnapshot(), error: response.error, refreshing: false })
    } finally {
      this.refreshing = false
      const current = this.snapshot.getSnapshot()
      if (current.refreshing) this.snapshot.set({ ...current, refreshing: false })
    }
  }

  /**
   * Ask one failed server to reconnect, then publish the returned registry state.
   * @param serverId - Saved MCP server to reconnect.
   * @returns Error copy when the reconnect fails, otherwise `undefined`.
   */
  async reconnect(serverId: string): Promise<string | undefined> {
    const response = await this.operations.reconnect(serverId)
    if (response.state !== undefined) {
      this.publish(response.state)
      return undefined
    }
    return response.error
  }

  /**
   * Publish a state returned by another MCP mutation.
   * @param state - Latest redacted MCP registry state.
   */
  publish(state: McpManagerState): void {
    if (this.initialized) {
      for (const server of state.servers) this.notifyTransition(server, this.previous.get(server.id))
    }
    this.previous = new Map(state.servers.map(server => [server.id, server.status]))
    this.initialized = true
    this.snapshot.set({ state, error: undefined, refreshing: false })
  }

  private notifyTransition(server: McpServerView, previous: McpServerView['status'] | undefined): void {
    const occurredAt = Date.now()
    if (server.status === 'error' && previous !== 'error') {
      this.notify({
        id: `mcp-connection-failed:${server.id}:${String(server.updatedAt)}`,
        occurredAt,
        kind: 'mcp-connection-failed',
        serverId: server.id,
        serverName: server.name,
      })
    } else if (server.status === 'connected' && previous === 'error') {
      this.notify({
        id: `mcp-connection-recovered:${server.id}:${String(server.updatedAt)}`,
        occurredAt,
        kind: 'mcp-connection-recovered',
        serverId: server.id,
        serverName: server.name,
      })
    }
  }
}
