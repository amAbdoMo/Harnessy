/** Native notification copy and Session activation owned by the Harnessy plugin. */

import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

type NotificationSessionId = SessionListState['ids'][number]

/** Optional carrier capability; ordinary browser windows have no native notifications. */
export interface NativeNotifications {
  show(payload: { readonly title: string; readonly body: string; readonly sessionId?: NotificationSessionId }): Promise<boolean>
  subscribe?(listener: (sessionId: NotificationSessionId) => void): () => void
}

function shorten(copy: string, limit: number): string {
  return copy.length <= limit ? copy : `${copy.slice(0, limit - 1).trimEnd()}…`
}

/**
 * Send bounded display copy and a separate Session address to the native carrier.
 * @param notifications - carrier capability, absent in ordinary browsers.
 * @param presentation - localized secret-free display copy.
 * @param sessionId - existing catalog Session address, absent for application-wide activity.
 */
export function showNativeNotification(
  notifications: NativeNotifications | undefined,
  presentation: { readonly title: string; readonly message: string },
  sessionId?: NotificationSessionId,
): void {
  if (notifications === undefined) return
  void notifications.show({
    title: shorten(presentation.title, 120),
    body: shorten(presentation.message, 500),
    ...sessionId === undefined ? {} : { sessionId },
  }).catch((reason: unknown) => { console.warn('Harnessy native notification failed:', reason) })
}

/**
 * Select an existing Session after native activation, waiting for the initial catalog when necessary.
 * @param notifications - carrier capability, absent in ordinary browsers or older carriers.
 * @param sessions - authoritative Client Session catalog.
 * @param open - workspace-owned navigation command.
 * @returns removal of both subscriptions and any pending selection.
 */
export function subscribeNativeNotificationActivation(
  notifications: NativeNotifications | undefined,
  sessions: ObservableSnapshot<SessionListState>,
  open: (sessionId: SessionListState['ids'][number]) => void,
): () => void {
  if (notifications?.subscribe === undefined) return () => {}
  let active = true
  let pending: NotificationSessionId | undefined
  const select = (): void => {
    if (!active || pending === undefined) return
    const snapshot = sessions.getSnapshot()
    const id = snapshot.ids.find(candidate => candidate === pending)
    if (id !== undefined) { pending = undefined; open(id) }
    else if (snapshot.phase === 'ready') pending = undefined
  }
  const stopCatalog = sessions.subscribe(select)
  const stopNative = notifications.subscribe((sessionId) => { if (active) { pending = sessionId; select() } })
  return () => { active = false; pending = undefined; stopNative(); stopCatalog() }
}
