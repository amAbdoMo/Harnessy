// @vitest-environment jsdom
/** Sidebar eligibility over immutable snapshots, including transient metadata gaps. */
import { expect, it, vi } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { subscribeNativeTaskbar } from '../src/client/native-taskbar.ts'

type SessionId = SessionListState['ids'][number]
const SESSION = 'eligibility-session' as SessionId
const summary: SessionSummary = {
  id: SESSION, displayTitle: SESSION, running: false, retainedBy: {}, blank: false, updatedAt: 1,
}
const unread: SessionStatusSnapshot = new Map([[SESSION, {
  running: false, pendingInteraction: undefined, completionUnread: true,
}]])

it.each([
  { scenario: 'missing metadata', ids: [SESSION], byId: {}, archived: [], expected: 0 },
  { scenario: 'unlisted metadata', ids: [], byId: { [SESSION]: summary }, archived: [], expected: 0 },
  { scenario: 'subagent origin', ids: [SESSION], byId: { [SESSION]: { ...summary, origin: 'subagent' } },
    archived: [], expected: 0 },
  { scenario: 'archived membership', ids: [SESSION], byId: { [SESSION]: summary }, archived: [SESSION], expected: 0 },
  { scenario: 'unselected blank', ids: [SESSION], byId: { [SESSION]: { ...summary, blank: true } },
    archived: [], expected: 0 },
  { scenario: 'current blank', ids: [SESSION], byId: { [SESSION]: { ...summary, blank: true, retainedBy: { mainView: 1 } } },
    archived: [], expected: 1 },
  { scenario: 'ordinary fork', ids: [SESSION], byId: { [SESSION]: { ...summary, parentId: 'source' as SessionId } },
    archived: [], expected: 1 },
] satisfies readonly {
  scenario: string
  ids: SessionId[]
  byId: SessionListState['byId']
  archived: SessionId[]
  expected: number
}[])('publishes $expected for unread with $scenario', ({ ids, byId, archived, expected }) => {
  const sessions = createSnapshotStore<SessionListState>({ ids, byId, phase: 'ready', projectionsBySession: {} })
  const workspaces = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: archived, pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  const statuses = createSnapshotStore(unread)
  const setUnreadCount = vi.fn(async (_count: number) => {})
  const dispose = subscribeNativeTaskbar({ setUnreadCount }, { sessions, workspaces, statuses }, window)
  try {
    expect(setUnreadCount.mock.calls).toEqual([[expected]])
    sessions.set({ ...sessions.getSnapshot(), ids: [] })
    expect(setUnreadCount).toHaveBeenLastCalledWith(0)
    sessions.set({ ids: [SESSION], byId: { [SESSION]: summary }, phase: 'ready', projectionsBySession: {} })
    workspaces.set({ ...workspaces.getSnapshot(), archivedSessionIds: [] })
    expect(setUnreadCount).toHaveBeenLastCalledWith(1)
    expect(statuses.getSnapshot()).toBe(unread)
  } finally { dispose() }
})
