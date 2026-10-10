/** Publishes local Session completion reminders to the optional native taskbar carrier. */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'

/** Optional desktop capability; Windows owns the indicator's accent color. */
export interface NativeTaskbar {
  /**
   * Replace the window's unread indicator in invocation order.
   * @param unread - whether a listed ordinary Session has an unread completion.
   * @returns acknowledgement of the native update; carrier failures reject.
   */
  setUnread(unread: boolean): Promise<void>
}

interface TaskbarSources {
  readonly sessions: ObservableSnapshot<SessionListState>
  readonly statuses: ObservableSnapshot<SessionStatusSnapshot>
  readonly workspaces: ObservableSnapshot<WorkspaceSnapshot>
}

function completionUnread(sources: TaskbarSources): boolean {
  const list = sources.sessions.getSnapshot()
  const statuses = sources.statuses.getSnapshot()
  const archived = new Set(sources.workspaces.getSnapshot().archivedSessionIds)
  const current = Object.values(list.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
  return list.ids.some((id) => {
    const summary = list.byId[id]
    return summary !== undefined && summary.origin !== 'subagent' && !archived.has(id)
      && (!summary.blank || id === current) && statuses.get(id)?.completionUnread === true
  })
}

function reportTaskbarFailure(reason: unknown): void {
  console.warn('Harnessy taskbar unread update failed:', reason)
}

function sendUnread(taskbar: NativeTaskbar, unread: boolean): void {
  try {
    void taskbar.setUnread(unread).catch(reportTaskbarFailure)
  } catch (reason) {
    reportTaskbarFailure(reason)
  }
}

/**
 * Send the current aggregate and live changes without owning a second unread state.
 * Calls reach the carrier immediately in order, including teardown's final clear;
 * promise settlement never publishes another update. Failures are diagnostic only.
 * @param taskbar - native window capability, resolved only in the apply world.
 * @param sources - authoritative Session status, catalog membership, and archive membership.
 * @param page - page lifecycle whose departure ends this subscription.
 * @returns idempotent subscription disposal and native clear for the owning effect.
 */
export function subscribeNativeTaskbar(taskbar: NativeTaskbar, sources: TaskbarSources, page: Window): () => void {
  let active = true
  let lastPublished: boolean | undefined
  const publish = (unread: boolean): void => {
    if (unread === lastPublished) return
    lastPublished = unread
    sendUnread(taskbar, unread)
  }
  const sync = (): void => { if (active) publish(completionUnread(sources)) }
  const stopStatus = sources.statuses.subscribe(sync)
  const stopSessions = sources.sessions.subscribe(sync)
  const stopWorkspaces = sources.workspaces.subscribe(sync)
  const dispose = (): void => {
    if (!active) return
    active = false
    stopStatus()
    stopSessions()
    stopWorkspaces()
    page.removeEventListener('pagehide', dispose)
    sendUnread(taskbar, false)
  }
  page.addEventListener('pagehide', dispose)
  sync()
  return dispose
}
