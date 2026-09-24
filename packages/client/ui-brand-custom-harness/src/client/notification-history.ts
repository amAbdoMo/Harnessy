/** Persisted, browser-local history for user-relevant application activity. */

import type { AccountAutoSwitchEvent } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

// Keep the first release's key so existing account-switch history remains visible.
const STORAGE_KEY = 'harnessy.account-switch-notifications.v1'
const HISTORY_LIMIT = 50

/** Saved notification produced by a committed automatic Codex account switch. */
export interface AccountSwitchNotification extends AccountAutoSwitchEvent {
  readonly kind: 'account-switch'
}

/** Saved notification produced by a root Session's recorded terminal outcome. */
export interface SessionOutcomeNotification {
  readonly id: string
  readonly occurredAt: number
  readonly kind: 'task-completed' | 'task-stopped' | 'task-failed'
  readonly sessionId: string
  readonly sessionTitle: string
}

/** User action required by a Session. */
export interface SessionAttentionNotification {
  readonly id: string
  readonly occurredAt: number
  readonly kind: 'approval-required' | 'question-required' | 'plan-review-required'
  readonly sessionId: string
  readonly sessionTitle: string
}

/** Saved notification produced by a terminal MCP outage or later recovery. */
export interface McpConnectionNotification {
  readonly id: string
  readonly occurredAt: number
  readonly kind: 'mcp-connection-failed' | 'mcp-connection-recovered'
  readonly serverId: string
  readonly serverName: string
}

/** Every activity type retained by the Harnessy notification center. */
export type HarnessNotificationEvent =
  | AccountSwitchNotification
  | SessionOutcomeNotification
  | SessionAttentionNotification
  | McpConnectionNotification

/** One saved event plus its local read state. */
export type NotificationHistoryItem = HarnessNotificationEvent & { readonly read: boolean }

/** Notification-center state retained across app restarts. */
export interface NotificationHistoryState {
  readonly items: readonly NotificationHistoryItem[]
}

/**
 * Convert the Host account-switch event into the notification-center union.
 * @param event - Committed automatic account switch from the Host.
 * @returns Notification-center event with its discriminant attached.
 */
export function accountSwitchNotification(event: AccountAutoSwitchEvent): AccountSwitchNotification {
  return { ...event, kind: 'account-switch' }
}

/** Owns bounded notification history and the current transient toast. */
export class NotificationHistoryController {
  /** Saved notification rows. */
  readonly history: SnapshotStore<NotificationHistoryState>
  /** Most recently received activity shown briefly outside the panel. */
  readonly toast: SnapshotStore<HarnessNotificationEvent | undefined> =
    createSnapshotStore<HarnessNotificationEvent | undefined>(undefined)
  private toastTimer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    this.history = createSnapshotStore<NotificationHistoryState>({ items: [] }, {
      persist: { name: STORAGE_KEY },
    })
    this.history.set(decodeHistory(this.history.getSnapshot()))
  }

  /**
   * Save and announce one secret-free application event.
   * @param event - activity to retain and present.
   */
  add(event: HarnessNotificationEvent): void {
    const current = this.history.getSnapshot().items.filter(item => item.id !== event.id)
    this.history.set({ items: [{ ...event, read: false }, ...current].slice(0, HISTORY_LIMIT) })
    this.toast.set(event)
    if (this.toastTimer !== undefined) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => { this.dismissToast(event.id) }, 6_500)
  }

  /** Mark every currently saved notification as read. */
  markAllRead(): void {
    const current = this.history.getSnapshot()
    if (current.items.every(item => item.read)) return
    this.history.set({ items: current.items.map(item => ({ ...item, read: true })) })
  }

  /** Remove all locally retained notification rows. */
  clear(): void {
    this.history.set({ items: [] })
  }

  /**
   * Dismiss the toast only if it still represents the completed display.
   * @param id - event whose toast completed.
   */
  dismissToast(id: string): void {
    if (this.toast.getSnapshot()?.id !== id) return
    this.toast.set(undefined)
    if (this.toastTimer !== undefined) clearTimeout(this.toastTimer)
    this.toastTimer = undefined
  }

  /** Release the pending toast timeout with the Client plugin lifetime. */
  dispose(): void {
    if (this.toastTimer !== undefined) clearTimeout(this.toastTimer)
    this.toastTimer = undefined
    this.toast.set(undefined)
  }
}

function decodeHistory(persistedState: unknown): NotificationHistoryState {
  if (!isRecord(persistedState) || !Array.isArray(persistedState.items)) return { items: [] }
  return { items: persistedState.items.flatMap(decodeItem).slice(0, HISTORY_LIMIT) }
}

function decodeItem(candidate: unknown): NotificationHistoryItem[] {
  if (!isRecord(candidate)
    || typeof candidate.id !== 'string'
    || typeof candidate.occurredAt !== 'number'
    || !Number.isFinite(candidate.occurredAt)
    || typeof candidate.read !== 'boolean') return []
  const kind = candidate.kind
  if (kind === 'session-finished'
    || kind === 'task-completed'
    || kind === 'task-stopped'
    || kind === 'task-failed'
    || kind === 'approval-required'
    || kind === 'question-required'
    || kind === 'plan-review-required') {
    if (typeof candidate.sessionId !== 'string' || typeof candidate.sessionTitle !== 'string') return []
    return [{
      id: candidate.id,
      occurredAt: candidate.occurredAt,
      kind: kind === 'session-finished' ? 'task-completed' : kind,
      sessionId: candidate.sessionId,
      sessionTitle: candidate.sessionTitle,
      read: candidate.read,
    }]
  }
  if (kind === 'mcp-connection-failed' || kind === 'mcp-connection-recovered') {
    if (typeof candidate.serverId !== 'string' || typeof candidate.serverName !== 'string') return []
    return [{
      id: candidate.id,
      occurredAt: candidate.occurredAt,
      kind,
      serverId: candidate.serverId,
      serverName: candidate.serverName,
      read: candidate.read,
    }]
  }
  // Records written before the notification center supported Sessions have no kind.
  if (kind !== undefined && kind !== 'account-switch') return []
  if (candidate.provider !== 'openai-codex'
    || (candidate.limit !== '5h' && candidate.limit !== '7d')) return []
  const from = decodeParty(candidate.from)
  const to = decodeParty(candidate.to)
  if (from === undefined || to === undefined) return []
  return [{
    id: candidate.id,
    occurredAt: candidate.occurredAt,
    kind: 'account-switch',
    provider: candidate.provider,
    limit: candidate.limit,
    from,
    to,
    read: candidate.read,
  }]
}

function decodeParty(candidate: unknown): AccountAutoSwitchEvent['from'] | undefined {
  if (!isRecord(candidate) || typeof candidate.name !== 'string') return undefined
  const usageScope = candidate.usageScope
  if (usageScope !== undefined && usageScope !== 'personal' && usageScope !== 'workspace') return undefined
  return { name: candidate.name, ...usageScope === undefined ? {} : { usageScope } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
