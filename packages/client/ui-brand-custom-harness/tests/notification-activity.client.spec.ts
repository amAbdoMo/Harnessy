import { describe, expect, it } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TurnOutlineEntry } from '@deepseek-ai/dsh-session-turn-outline/types'
import { NotificationActivityObserver } from '../src/client/notification-activity.ts'

type SessionId = SessionListState['ids'][number]
const SESSION_ID = 'session-1' as SessionId
const SESSION_SEQ = 0 as TurnOutlineEntry['seq']

function sessions(running: boolean, updatedAt: number, outcome?: 'completed' | 'stopped' | 'failed'): SessionListState {
  return {
    ids: [SESSION_ID],
    byId: {
      [SESSION_ID]: {
        id: SESSION_ID,
        displayTitle: 'Fix checkout',
        running,
        blank: false,
        updatedAt,
        projectionValues: {
          turnOutline: [{ turn: 1, seq: SESSION_SEQ, prompt: 'Fix checkout', response: '', ...outcome === undefined ? {} : { outcome } }],
        },
      },
    },
    current: SESSION_ID,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function childSessions(running: boolean, updatedAt: number): SessionListState {
  return {
    ...sessions(running, updatedAt),
    byId: {
      [SESSION_ID]: {
        ...sessions(running, updatedAt).byId[SESSION_ID]!,
        origin: 'subagent',
        parentId: 'parent-session' as SessionId,
      },
    },
  }
}

function pending(key: string, kind: string) {
  return new Map([[SESSION_ID, { key, kind }]])
}

describe('Harnessy notification activity observer', () => {
  it('uses the first snapshot as a silent baseline', () => {
    const observer = new NotificationActivityObserver()
    expect(observer.observe(sessions(true, 1), pending('approval:existing', 'approval'), 10)).toEqual([])
  })

  it('reports each recorded root outcome once', () => {
    const observer = new NotificationActivityObserver()
    observer.observe(sessions(true, 1), new Map(), 10)

    expect(observer.observe(sessions(false, 2, 'completed'), new Map(), 20)).toEqual([
      expect.objectContaining({ kind: 'task-completed', sessionTitle: 'Fix checkout', occurredAt: 20 }),
    ])
    expect(observer.observe(sessions(false, 2, 'completed'), new Map(), 30)).toEqual([])
  })

  it('prioritizes action-needed activity over an idle transition', () => {
    const observer = new NotificationActivityObserver()
    observer.observe(sessions(true, 1), new Map(), 10)
    expect(observer.observe(sessions(false, 2, 'completed'), pending('approval:1', 'approval'), 20)).toEqual([
      expect.objectContaining({ kind: 'approval-required', sessionTitle: 'Fix checkout', occurredAt: 20 }),
    ])
    expect(observer.observe(sessions(false, 2, 'completed'), pending('approval:1', 'approval'), 30)).toEqual([])
    expect(observer.observe(sessions(false, 2), pending('question:1', 'question'), 40)).toEqual([
      expect.objectContaining({ kind: 'question-required', occurredAt: 40 }),
    ])
    expect(observer.observe(sessions(false, 2), pending('plan:1', 'plan-review'), 50)).toEqual([
      expect.objectContaining({ kind: 'plan-review-required', occurredAt: 50 }),
    ])
  })

  it.each([
    ['stopped', 'task-stopped'],
    ['failed', 'task-failed'],
  ] as const)('maps %s turn outcomes to %s', (outcome, kind) => {
    const observer = new NotificationActivityObserver()
    observer.observe(sessions(true, 1), new Map(), 10)
    expect(observer.observe(sessions(false, 2, outcome), new Map(), 20)).toEqual([
      expect.objectContaining({ kind }),
    ])
  })

  it('ignores pending interaction kinds the notification center does not own', () => {
    const observer = new NotificationActivityObserver()
    observer.observe(sessions(true, 1), new Map(), 10)
    expect(observer.observe(sessions(true, 1), pending('other:1', 'other'), 20)).toEqual([])
  })

  it('does not notify when a delegated child finishes', () => {
    const observer = new NotificationActivityObserver()
    observer.observe(childSessions(true, 1), new Map(), 10)
    expect(observer.observe(childSessions(false, 2), new Map(), 20)).toEqual([])
  })

  it('does not guess an outcome when the projection has not settled', () => {
    const observer = new NotificationActivityObserver()
    observer.observe(sessions(true, 1), new Map(), 10)
    expect(observer.observe(sessions(false, 2), new Map(), 20)).toEqual([])
    expect(observer.observe(sessions(false, 3, 'completed'), new Map(), 30)).toEqual([
      expect.objectContaining({ kind: 'task-completed' }),
    ])
  })
})
