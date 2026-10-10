// @vitest-environment jsdom
/** Native indicator output driven through the Loader, real Session Controller, and UiSession. */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, vi, type Mock } from 'vitest'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import {
  ClientRoster, createClientTest, type TestClient, webApp,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionFollowFrame, SessionListValue } from '@deepseek-ai/dsh-api-session-controller/types'

const manifest: { readonly name: string; readonly dsh: { readonly client: { readonly inject: readonly string[] } } } =
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const BRAND = manifest.name
const roster = ClientRoster.of([...webApp.rows, {
  name: BRAND, inject: manifest.dsh.client.inject, immediately: false,
}]).closure([BRAND])
const it = createClientTest({ roster })
const SESSION = 'taskbar-session' as SessionId
const CHILD = 'taskbar-child' as SessionId
const ORPHAN = 'taskbar-orphan' as SessionId

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

function native(request: (unread: boolean) => Promise<void> = async () => {}): Mock<typeof request> {
  const setUnread = vi.fn(request)
  vi.stubGlobal('dshDesktop', { taskbar: { setUnread } })
  return setUnread
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

describe('Harnessy Windows taskbar completion unread', () => {
  it('shows a regular completion once and clears on main-view reading, not on historical baseline', async ({ mock, start }) => {
    configure(mock)
    const setUnread = native()
    const client = await start()
    await baseline(client)
    expect(client.ctx.uiSession.sessionStatus.getSnapshot().get(SESSION)?.completionUnread).toBe(false)
    await running(client, SESSION, false)
    expect(setUnread.mock.calls).toEqual([[false]])
    await running(client, SESSION, true)
    await running(client, SESSION, false)
    await running(client, SESSION, false)
    await emit(client, 'api-session/activity', [SESSION, 2])
    expect(setUnread.mock.calls).toEqual([[false], [true]])
    using reference = client.ctx.sessions.retain(SESSION, { source: 'mainView' })
    await reference.ready
    await client.flush()
    expect(setUnread.mock.calls).toEqual([[false], [true], [false]])
    reference.release()
    await client.flush()
    expect(setUnread.mock.calls).toEqual([[false], [true], [false]])
  })

  it('denies listed and catalog-only subagent completions and orphan status without metadata', async ({ mock, start }) => {
    configure(mock, [row(SESSION), row(CHILD, { origin: 'subagent', parentSessionId: SESSION })])
    mock.remote.session.projections.mockResolvedValue(ok({
      asOfSeq: 0, values: { subagentCatalog: [{ id: ORPHAN, createdAt: 1, mode: 'continuable', label: 'Child' }] },
    }))
    const setUnread = native()
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
    expect(setUnread.mock.calls).toEqual([[false]])
  })

  it('recomputes on metadata, archives, and membership without another unread store', async ({ mock, start }) => {
    configure(mock)
    const setUnread = native()
    const client = await start()
    await baseline(client)
    await running(client, SESSION, true)
    await running(client, SESSION, false)
    expect(setUnread.mock.calls).toEqual([[false], [true]])

    mock.remote.session.list.mockResolvedValue(ok({ items: [row(SESSION, { origin: 'subagent' })] }))
    await baseline(client)
    expect(client.ctx.uiSession.sessionStatus.getSnapshot().get(SESSION)?.completionUnread).toBe(true)
    expect(setUnread.mock.calls).toEqual([[false], [true], [false]])
    mock.remote.session.list.mockResolvedValue(ok({ items: [row(SESSION)] }))
    await baseline(client)
    expect(setUnread.mock.calls).toEqual([[false], [true], [false], [true]])

    client.mock.streams.push('workspace/follow', { type: 'archived', archivedSessionIds: [SESSION] })
    await client.mock.streams.drained('workspace/follow')
    await client.flush()
    expect(setUnread).toHaveBeenLastCalledWith(false)
    client.mock.streams.push('workspace/follow', { type: 'archived', archivedSessionIds: [] })
    await client.mock.streams.drained('workspace/follow')
    await client.flush()
    expect(setUnread).toHaveBeenLastCalledWith(true)

    await emit(client, 'api-session/removed', [SESSION])
    expect(setUnread.mock.calls).toEqual([[false], [true], [false], [true], [false], [true], [false]])
  })

  it('contains synchronous native carrier failures without changing Session unread state', async ({ mock, start }) => {
    configure(mock)
    const failure = new Error('native context expired')
    const setUnread = native(() => { throw failure })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = await start()
    await baseline(client)
    await running(client, SESSION, true)
    await running(client, SESSION, false)
    expect(client.ctx.uiSession.sessionStatus.getSnapshot().get(SESSION)?.completionUnread).toBe(true)
    await client.unload(BRAND)
    expect(setUnread.mock.calls).toEqual([[false], [true], [false]])
    expect(warn.mock.calls).toEqual([
      ['Harnessy taskbar unread update failed:', failure],
      ['Harnessy taskbar unread update failed:', failure],
      ['Harnessy taskbar unread update failed:', failure],
    ])
  })

  it('keeps existing unread across HMR with one publisher and no late sends after rejected pending calls', async ({ mock, start }) => {
    configure(mock)
    const pending = Promise.withResolvers<undefined>()
    const setUnread = native(() => pending.promise)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const client = await start()
      await baseline(client)
      await running(client, SESSION, true)
      await running(client, SESSION, false)
      await client.reload(BRAND)
      expect(setUnread.mock.calls).toEqual([[false], [true], [false], [true]])
      await client.unload(BRAND)
      expect(setUnread.mock.calls).toEqual([[false], [true], [false], [true], [false]])
      pending.reject(new Error('native carrier rejected'))
      await client.flush()
      expect(warn).toHaveBeenCalledTimes(5)
      await running(client, SESSION, true)
      await running(client, SESSION, false)
      window.dispatchEvent(new Event('pagehide'))
      expect(setUnread.mock.calls).toEqual([[false], [true], [false], [true], [false]])
    } finally { pending.resolve(undefined) }
  })

  it('clears on pagehide and never publishes subsequent status, catalog, or archive changes', async ({ mock, start }) => {
    configure(mock)
    const setUnread = native()
    const client = await start()
    await baseline(client)
    await running(client, SESSION, true)
    await running(client, SESSION, false)
    window.dispatchEvent(new Event('pagehide'))
    expect(setUnread.mock.calls).toEqual([[false], [true], [false]])
    await running(client, SESSION, true)
    await running(client, SESSION, false)
    await emit(client, 'api-session/activity', [SESSION, 2])
    client.mock.streams.push('workspace/follow', { type: 'archived', archivedSessionIds: [SESSION] })
    await client.mock.streams.drained('workspace/follow')
    await client.unload(BRAND)
    expect(setUnread.mock.calls).toEqual([[false], [true], [false]])
  })

  it('reports synchronous native failures without interrupting completion tracking', async ({ mock, start }) => {
    configure(mock)
    const failure = new Error('native carrier unavailable')
    const setUnread = native(() => { throw failure })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = await start()
    await baseline(client)
    await running(client, SESSION, true)
    await running(client, SESSION, false)
    expect(client.ctx.uiSession.sessionStatus.getSnapshot().get(SESSION)?.completionUnread).toBe(true)
    await client.unload(BRAND)
    expect(setUnread.mock.calls).toEqual([[false], [true], [false]])
    expect(warn.mock.calls.map(([, reason]) => reason)).toEqual([failure, failure, failure])
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
