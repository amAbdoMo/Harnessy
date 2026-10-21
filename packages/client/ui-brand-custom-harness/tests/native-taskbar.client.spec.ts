// @vitest-environment jsdom
/** Native indicator output driven through the Loader, real Session Controller, and UiSession. */
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, vi, type Mock } from 'vitest'
import { z } from 'zod'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import {
  ClientRoster, createClientTest, type TestClient, webApp,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { loadPluginModules } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/modules.ts'
import { SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionFollowFrame, SessionListValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { subscribeNativeTaskbar } from '../src/client/native-taskbar.ts'

const manifest = z.object({
  name: z.string(),
  dsh: z.object({ client: z.object({ inject: z.array(z.string()) }) }),
}).parse(JSON.parse(readFileSync(new NodeURL('../package.json', import.meta.url), 'utf8')))
const BRAND = manifest.name
const roster = ClientRoster.of([...webApp.rows, {
  name: BRAND, inject: manifest.dsh.client.inject, immediately: false,
}]).closure([BRAND])
const it = createClientTest({ roster })
const SESSION = 'taskbar-session' as SessionId
const SECOND = 'taskbar-second' as SessionId
const CHILD = 'taskbar-child' as SessionId
const ORPHAN = 'taskbar-orphan' as SessionId

// Source-module arrival is suite setup; each scenario still owns a fresh Loader and client.
beforeAll(async () => {
  await loadPluginModules({ roster: roster.without(['@deepseek-ai/dsh-api-remotes']) })
})

beforeEach(() => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'custom-harness')
  vi.stubEnv('DSH_CLIENT_PRODUCT_NAME', 'Harnessy')
  vi.stubEnv('DSH_CLIENT_PRODUCT_URL', 'https://example.com/product')
  vi.stubEnv('DSH_CLIENT_SUPPORT_URL', 'https://example.com/support')
  vi.stubEnv('DSH_CLIENT_VERSION', 'test')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function row(sessionId: SessionId, overrides: Partial<SessionListValue['items'][number]> = {}): SessionListValue['items'][number] {
  return { sessionId, updatedAt: 1, running: false, blank: false, agentAvailable: true, ...overrides }
}

function configure(mock: RemoteMock, items: SessionListValue['items'] = [row(SESSION)]): void {
  mock.remote.session.list.mockResolvedValue(ok({ items }))
  mock.remote.accounts.describe.mockResolvedValue(ok({ writable: true, accounts: [], providers: [] }))
  mock.remote.accounts.refreshUsage.mockResolvedValue(ok({ writable: true, accounts: [], providers: [] }))
  mock.remote.mcpManager.describe.mockResolvedValue(ok({ available: true, writable: true, servers: [] }))
  mock.stream('session/follow', (_request, stream) => {
    stream.push({
      type: 'snapshot',
      header: { version: SESSION_FORMAT_VERSION, id: SESSION, createdAt: 1, isSeeded: false },
      cursor: -1, records: [], hasMore: false,
      projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 },
    } satisfies SessionFollowFrame)
  })
}

function native(request: (count: number) => Promise<void> = async () => {}): Mock<typeof request> {
  const setUnreadCount = vi.fn(request)
  vi.stubGlobal('dshDesktop', { taskbar: { setUnreadCount } })
  return setUnreadCount
}

async function emit(client: TestClient, event: string, args: readonly unknown[]): Promise<void> {
  client.mock.streams.push('$events', { type: 'emit', event, args })
  await client.mock.streams.drained('$events')
  await client.flush()
}

async function running(client: TestClient, sessionId: SessionId, state: boolean): Promise<void> {
  await emit(client, 'api-session/status', [sessionId, state])
}

async function baseline(client: TestClient): Promise<void> {
  await client.ctx.sessions.refresh()
  await client.flush()
}

const eligibilityCases: readonly {
  name: string
  overrides: Partial<SessionSummary>
  expected: number
  archived?: SessionId[]
  listed?: boolean
  metadata?: boolean
  unread?: boolean
  status?: boolean
}[] = [
  { name: 'ordinary listed Session', overrides: {}, expected: 2 },
  { name: 'listed subagent', overrides: { origin: 'subagent' }, expected: 1 },
  { name: 'archived Session', overrides: {}, archived: [SECOND], expected: 1 },
  { name: 'unlisted metadata', overrides: {}, listed: false, expected: 1 },
  { name: 'missing metadata', overrides: {}, metadata: false, expected: 1 },
  { name: 'unselected blank Session', overrides: { blank: true }, expected: 1 },
  { name: 'blank Session retained outside main view', overrides: { blank: true, retainedBy: { controllerOperation: 1 } }, expected: 1 },
  { name: 'selected blank Session', overrides: { blank: true, retainedBy: { mainView: 1 } }, expected: 2 },
  { name: 'read Session', overrides: {}, unread: false, expected: 1 },
  { name: 'missing status', overrides: {}, status: false, expected: 1 },
]

describe('native unread completion count', () => {
  it.each(eligibilityCases)('counts only eligible completions: $name', ({ overrides, expected, ...facts }) => {
    const summary = (id: SessionId): SessionSummary => ({
      id, displayTitle: id, running: false, retainedBy: {}, blank: false, updatedAt: 1,
    })
    const sessions = createSnapshotStore<SessionListState>({
      phase: 'ready', ids: facts.listed === false ? [SESSION] : [SESSION, SECOND],
      byId: { [SESSION]: summary(SESSION),
        ...(facts.metadata === false ? {} : { [SECOND]: { ...summary(SECOND), ...overrides } }) },
      projectionsBySession: {},
    })
    const statuses = createSnapshotStore<SessionStatusSnapshot>(new Map())
    const workspaces = createSnapshotStore<WorkspaceSnapshot>({
      items: [], archivedSessionIds: facts.archived ?? [], pinnedSessionIds: [],
      state: 'idle', phase: 'ready', error: null,
    })
    const setUnreadCount = vi.fn(async (_count: number) => {})
    const dispose = subscribeNativeTaskbar({ setUnreadCount }, { sessions, statuses, workspaces }, window)
    try {
      expect(setUnreadCount.mock.calls).toEqual([[0]])
      const unread = { running: false, pendingInteraction: undefined, completionUnread: true }
      const snapshot: SessionStatusSnapshot = new Map([
        [SESSION, unread],
        ...(facts.status === false ? [] : [[SECOND, { ...unread, completionUnread: facts.unread !== false }] as const]),
      ])
      statuses.set(snapshot)
      expect(setUnreadCount.mock.calls).toEqual([[0], [expected]])
      expect(statuses.getSnapshot()).toBe(snapshot)
      dispose()
      expect(setUnreadCount.mock.calls).toEqual([[0], [expected], [0]])
    } finally { dispose() }
  })

  for (const source of ['archives', 'metadata', 'membership', 'blank', 'running'] as const) {
    it(source === 'blank' ? 'retains engaged completions when a stale catalog labels them blank'
      : `publishes 0 -> 1 -> 2 -> 1 -> 0 through ${source} changes`, async ({ mock, start }) => {
      configure(mock, [row(SESSION), row(SECOND)])
      const setUnreadCount = native()
      const client = await start()
      await baseline(client)
      await running(client, SESSION, true)
      await running(client, SESSION, false)
      await running(client, SECOND, true)
      await running(client, SECOND, false)
      await running(client, SECOND, false)
      await emit(client, 'api-session/activity', [SECOND, 2])
      expect(setUnreadCount.mock.calls).toEqual([[0], [1], [2]])
      for (const excluded of [[SECOND], [SECOND, SESSION]]) {
        if (source === 'archives') {
          mock.streams.push('workspace/follow', { type: 'archived', archivedSessionIds: excluded })
          await mock.streams.drained('workspace/follow')
          await client.flush()
        } else if (source === 'running') {
          await running(client, excluded[excluded.length - 1]!, true)
        } else {
          const items = [SESSION, SECOND].filter(id => source !== 'membership' || !excluded.includes(id))
            .map(id => row(id, excluded.includes(id)
              ? source === 'blank' ? { blank: true } : { origin: 'subagent' } : {}))
          mock.remote.session.list.mockResolvedValue(ok({ items }))
          await baseline(client)
        }
        expect(setUnreadCount).toHaveBeenLastCalledWith(source === 'blank' ? 2 : 2 - excluded.length)
        if (source === 'archives' || source === 'metadata' || source === 'blank') {
          for (const id of excluded) expect(client.ctx.uiSession.sessionStatus.getSnapshot().get(id)?.completionUnread).toBe(true)
        }
      }
      expect(setUnreadCount.mock.calls).toEqual(source === 'blank' ? [[0], [1], [2]] : [[0], [1], [2], [1], [0]])
    })
  }

  for (const source of ['archives', 'membership'] as const) {
    it(`publishes an atomic 2 -> 0 through ${source}`, async ({ mock, start }) => {
      configure(mock, [row(SESSION), row(SECOND)])
      const setUnreadCount = native()
      const client = await start()
      await baseline(client)
      await running(client, SESSION, true)
      await running(client, SESSION, false)
      await running(client, SECOND, true)
      await running(client, SECOND, false)
      if (source === 'archives') {
        mock.streams.push('workspace/follow', { type: 'archived', archivedSessionIds: [SESSION, SECOND] })
        await mock.streams.drained('workspace/follow')
        await client.flush()
      } else {
        mock.remote.session.list.mockResolvedValue(ok({ items: [] }))
        await baseline(client)
      }
      expect(setUnreadCount.mock.calls).toEqual([[0], [1], [2], [0]])
    })
  }
  it('shows a regular completion once and clears on main-view reading, not on historical baseline', async ({ mock, start }) => {
    configure(mock)
    const setUnreadCount = native()
    const client = await start()
    await baseline(client)
    expect(client.ctx.uiSession.sessionStatus.getSnapshot().get(SESSION)?.completionUnread).toBe(false)
    await running(client, SESSION, false)
    expect(setUnreadCount.mock.calls).toEqual([[0]])
    await running(client, SESSION, true)
    await running(client, SESSION, false)
    await running(client, SESSION, false)
    await emit(client, 'api-session/activity', [SESSION, 2])
    expect(setUnreadCount.mock.calls).toEqual([[0], [1]])
    using reference = client.ctx.sessions.retain(SESSION, { source: 'mainView' })
    await reference.ready
    await client.flush()
    expect(setUnreadCount.mock.calls).toEqual([[0], [1], [0]])
    reference.release()
    await client.flush()
    expect(setUnreadCount.mock.calls).toEqual([[0], [1], [0]])
  })

  it('denies listed and catalog-only subagent completions and orphan status without metadata', async ({ mock, start }) => {
    configure(mock, [row(SESSION), row(CHILD, { origin: 'subagent', parentSessionId: SESSION })])
    mock.remote.session.projections.mockResolvedValue(ok({
      kind: 'sequenced' as const,
      asOfSeq: 0, values: { subagentCatalog: [{ id: ORPHAN, createdAt: 1, mode: 'continuable', label: 'Child' }] },
    }))
    const setUnreadCount = native()
    const client = await start()
    await baseline(client)
    await running(client, CHILD, true)
    await running(client, CHILD, false)
    await running(client, ORPHAN, true)
    await running(client, ORPHAN, false)
    expect(client.ctx.sessions.list.getSnapshot().byId[ORPHAN]).toBeUndefined()
    await client.ctx.sessions.refreshProjections(SESSION)
    await client.flush()
    expect(client.ctx.sessions.list.getSnapshot().byId[ORPHAN]?.origin).toBe('subagent')
    expect(client.ctx.sessions.list.getSnapshot().ids).not.toContain(ORPHAN)
    await running(client, ORPHAN, true)
    await running(client, ORPHAN, false)
    expect(client.ctx.uiSession.sessionStatus.getSnapshot().get(ORPHAN)?.completionUnread).toBe(true)
    expect(client.ctx.uiSession.sessionStatus.getSnapshot().get(CHILD)?.completionUnread).toBe(true)
    expect(setUnreadCount.mock.calls).toEqual([[0]])
  })

  it('recomputes on metadata, archives, and membership without another unread store', async ({ mock, start }) => {
    configure(mock)
    const setUnreadCount = native()
    const client = await start()
    await baseline(client)
    await running(client, SESSION, true)
    await running(client, SESSION, false)
    expect(setUnreadCount.mock.calls).toEqual([[0], [1]])

    mock.remote.session.list.mockResolvedValue(ok({ items: [row(SESSION, { origin: 'subagent' })] }))
    await baseline(client)
    expect(client.ctx.uiSession.sessionStatus.getSnapshot().get(SESSION)?.completionUnread).toBe(true)
    expect(setUnreadCount.mock.calls).toEqual([[0], [1], [0]])
    mock.remote.session.list.mockResolvedValue(ok({ items: [row(SESSION)] }))
    await baseline(client)
    expect(setUnreadCount.mock.calls).toEqual([[0], [1], [0], [1]])

    client.mock.streams.push('workspace/follow', { type: 'archived', archivedSessionIds: [SESSION] })
    await client.mock.streams.drained('workspace/follow')
    await client.flush()
    expect(setUnreadCount).toHaveBeenLastCalledWith(0)
    client.mock.streams.push('workspace/follow', { type: 'archived', archivedSessionIds: [] })
    await client.mock.streams.drained('workspace/follow')
    await client.flush()
    expect(setUnreadCount).toHaveBeenLastCalledWith(1)

    await emit(client, 'api-session/removed', [SESSION])
    expect(setUnreadCount.mock.calls).toEqual([[0], [1], [0], [1], [0], [1], [0]])
  })

  for (const mode of ['throw', 'reject'] as const) {
    it(`contains carrier ${mode} failures without changing Session unread state`, async ({ mock, start }) => {
      configure(mock)
      const failure = new Error('native context expired')
      const setUnreadCount = native(() => {
        if (mode === 'throw') throw failure
        return Promise.reject(failure)
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const client = await start()
      await baseline(client)
      await running(client, SESSION, true)
      await running(client, SESSION, false)
      expect(client.ctx.uiSession.sessionStatus.getSnapshot().get(SESSION)?.completionUnread).toBe(true)
      await client.unload(BRAND)
      await client.flush()
      expect(setUnreadCount.mock.calls).toEqual([[0], [1], [0]])
      expect(warn.mock.calls).toEqual([
        ['Harnessy taskbar unread update failed:', failure],
        ['Harnessy taskbar unread update failed:', failure],
        ['Harnessy taskbar unread update failed:', failure],
      ])
    })
  }

  it('keeps existing unread across HMR with one publisher and no late sends after rejected pending calls', async ({ mock, start }) => {
    configure(mock)
    const pending = Promise.withResolvers<undefined>()
    const setUnreadCount = native(() => pending.promise)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const client = await start()
      await baseline(client)
      await running(client, SESSION, true)
      await running(client, SESSION, false)
      await client.reload(BRAND)
      expect(setUnreadCount.mock.calls).toEqual([[0], [1], [0], [1]])
      await client.unload(BRAND)
      expect(setUnreadCount.mock.calls).toEqual([[0], [1], [0], [1], [0]])
      pending.reject(new Error('native carrier rejected'))
      await client.flush()
      expect(warn).toHaveBeenCalledTimes(5)
      await running(client, SESSION, true)
      await running(client, SESSION, false)
      window.dispatchEvent(new Event('pagehide'))
      expect(setUnreadCount.mock.calls).toEqual([[0], [1], [0], [1], [0]])
    } finally { pending.resolve(undefined) }
  })

  it('clears on pagehide and never publishes subsequent status, catalog, or archive changes', async ({ mock, start }) => {
    configure(mock)
    const setUnreadCount = native()
    const client = await start()
    await baseline(client)
    await running(client, SESSION, true)
    await running(client, SESSION, false)
    window.dispatchEvent(new Event('pagehide'))
    expect(setUnreadCount.mock.calls).toEqual([[0], [1], [0]])
    await running(client, SESSION, true)
    await running(client, SESSION, false)
    await emit(client, 'api-session/activity', [SESSION, 2])
    client.mock.streams.push('workspace/follow', { type: 'archived', archivedSessionIds: [SESSION] })
    await client.mock.streams.drained('workspace/follow')
    await client.unload(BRAND)
    expect(setUnreadCount.mock.calls).toEqual([[0], [1], [0]])
  })

  it('does not create native subscriptions in an ordinary Web page', async ({ mock, start }) => {
    configure(mock)
    vi.stubGlobal('dshDesktop', undefined)
    const client = await start()
    const subscriptions = vi.spyOn(client.ctx.uiSession.sessionStatus, 'subscribe')
    await client.reload(BRAND)
    expect(subscriptions).not.toHaveBeenCalled()
    await running(client, SESSION, true)
    await running(client, SESSION, false)
    window.dispatchEvent(new Event('pagehide'))
  })
})
