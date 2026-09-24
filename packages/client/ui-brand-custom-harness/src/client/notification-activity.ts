/** Transition detector for Session lifecycle and pending user actions. */

import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HarnessNotificationEvent } from './notification-history.ts'

interface NotificationPendingInteraction {
  readonly key: string
  readonly kind: string
}

type SessionId = SessionListState['ids'][number]
type NotificationInteractionSnapshot = Iterable<readonly [SessionId, NotificationPendingInteraction]>
type SessionOutcomeKind = 'task-completed' | 'task-stopped' | 'task-failed'

/** Compares live Session state without replaying the initial snapshot. */
export class NotificationActivityObserver {
  private initialized = false
  private activeRootRuns = new Set<string>()
  private previousInteractions = new Map<string, string>()

  /**
   * Return only activity introduced since the previous observation.
   * @param sessions - current Session list and lifecycle summaries.
   * @param interactions - current effective user action by Session.
   * @param occurredAt - timestamp shared by activity found in this observation.
   * @returns newly detected notification events.
   */
  observe(
    sessions: SessionListState,
    interactions: NotificationInteractionSnapshot,
    occurredAt = Date.now(),
  ): readonly HarnessNotificationEvent[] {
    const nextInteractions = interactionState(interactions)
    const events = this.initialized
      ? [
        ...sessionTransitionEvents(sessions, interactions, this.activeRootRuns, occurredAt),
        ...interactionTransitionEvents(sessions, interactions, this.previousInteractions, occurredAt),
      ]
      : []
    if (!this.initialized) armRunningRootSessions(sessions, this.activeRootRuns)
    this.previousInteractions = nextInteractions
    this.initialized = true
    return events
  }
}

function interactionState(interactions: NotificationInteractionSnapshot): Map<string, string> {
  return new Map([...interactions].map(([sessionId, interaction]) => [sessionId, interaction.key]))
}

function sessionTransitionEvents(
  sessions: SessionListState,
  interactions: NotificationInteractionSnapshot,
  activeRootRuns: Set<string>,
  occurredAt: number,
): readonly HarnessNotificationEvent[] {
  const attentionSessions = new Set([...interactions].map(([sessionId]) => sessionId))
  return sessions.ids.flatMap((id) => {
    const session = sessions.byId[id]
    if (session === undefined || session.origin === 'subagent' || session.parentId !== undefined) return []
    if (session.running) {
      activeRootRuns.add(id)
      return []
    }
    if (!activeRootRuns.has(id)) return []
    if (attentionSessions.has(id)) {
      activeRootRuns.delete(id)
      return []
    }
    const outcome = latestOutcome(session.projectionValues)
    if (outcome === undefined) return []
    activeRootRuns.delete(id)
    return [{
      id: `${outcome.kind}:${id}:${outcome.turn}`,
      occurredAt,
      kind: outcome.kind,
      sessionId: id,
      sessionTitle: session.displayTitle,
    }]
  })
}

function armRunningRootSessions(sessions: SessionListState, activeRootRuns: Set<string>): void {
  for (const id of sessions.ids) {
    const session = sessions.byId[id]
    if (session?.running === true && session.origin !== 'subagent' && session.parentId === undefined) {
      activeRootRuns.add(id)
    }
  }
}

function latestOutcome(projections: unknown): { readonly kind: SessionOutcomeKind; readonly turn: number } | undefined {
  if (typeof projections !== 'object' || projections === null) return undefined
  const outline = (projections as { readonly turnOutline?: unknown }).turnOutline
  if (!Array.isArray(outline)) return undefined
  const latest = outline.at(-1) as { readonly turn?: unknown; readonly outcome?: unknown } | undefined
  if (latest === undefined || typeof latest.turn !== 'number') return undefined
  if (latest.outcome === 'completed') return { kind: 'task-completed', turn: latest.turn }
  if (latest.outcome === 'stopped') return { kind: 'task-stopped', turn: latest.turn }
  if (latest.outcome === 'failed') return { kind: 'task-failed', turn: latest.turn }
  return undefined
}

function interactionTransitionEvents(
  sessions: SessionListState,
  interactions: NotificationInteractionSnapshot,
  previousInteractions: ReadonlyMap<string, string>,
  occurredAt: number,
): readonly HarnessNotificationEvent[] {
  return [...interactions].flatMap(([sessionId, interaction]) => {
    if (previousInteractions.get(sessionId) === interaction.key) return []
    const kind = notificationKind(interaction.kind)
    if (kind === undefined) return []
    return [{
      id: `${kind}:${interaction.key}`,
      occurredAt,
      kind,
      sessionId,
      sessionTitle: sessions.byId[sessionId]?.displayTitle ?? sessionId,
    }]
  })
}

function notificationKind(
  kind: string,
): 'approval-required' | 'question-required' | 'plan-review-required' | undefined {
  if (kind === 'approval') return 'approval-required'
  if (kind === 'question') return 'question-required'
  if (kind === 'plan-review') return 'plan-review-required'
  return undefined
}
