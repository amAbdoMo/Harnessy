/** Read-only navigation through the real source Loader, registries, cache, and JSON codec. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  encodeApplicationResult, parseApplicationRequest, parseApplicationResult, parseId,
} from '@deepseek-ai/dsh-companion-protocol'
import type { ApplicationBudget, ApplicationResult, GrantId } from '@deepseek-ai/dsh-companion-protocol'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import { createApplicationDispatcher } from '../src/application-dispatch.ts'
import { composition, config } from './composition.ts'
import type { Composition } from './composition.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  try { for (const release of cleanup.splice(0).reverse()) await release() }
  finally { vi.restoreAllMocks() }
})
const requestId = Buffer.alloc(16, 1).toString('base64url')
const budget = config.budgets.application

type SessionsResult = Extract<ApplicationResult, { type: 'sessions' }>

async function boot(): Promise<Composition> {
  const fixture = await composition({})
  cleanup.push(() => fixture.close())
  await mkdir(fixture.home, { recursive: true })
  for (const [name, plugin, options] of [
    ['navigation-title', SessionTitle, { fallbackMaxWords: 10, fallbackMaxBytes: 256, maxTitleBytes: 1024 }],
    ['navigation-cache', SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 }],
  ] as const) {
    fixture.ctx.loader.builtins[name] = plugin
    await fixture.ctx.loader.create({ name: `cordis:${name}`, config: options })
  }
  await fixture.ctx.loader.await()
  expect(fixture.ctx.get('sessionController')).toBeDefined()
  expect(fixture.ctx.get('sessionProjectionCache')).toBeDefined()
  expect(fixture.ctx.get('sessionTitle')).toBeDefined()
  return fixture
}

function dispatcher(fixture: Composition, options: {
  budget?: ApplicationBudget
  signal?: AbortSignal
  requireCurrent?: () => void
} = {}) {
  const current = createApplicationDispatcher(fixture.ctx, {
    signal: options.signal ?? fixture.owner.signal, requireCurrent: options.requireCurrent ?? (() => {}),
    managementAccess: () => false,
    grantId: parseId<GrantId>('navigation-grant'), generation: 1, budget: options.budget ?? budget,
    maxWatches: 1, maxPendingRequests: 2, maxProgressBuffer: 2,
    sendProgress: () => { throw new Error('Listing must not publish progress') },
  })
  cleanup.push(() => current.close())
  return current
}

function request(view?: 'navigation', limit = 10, cursor?: SessionsResult['cursor']) {
  return parseApplicationRequest(JSON.stringify({ v: 1, type: 'listSessions', requestId, limit,
    ...(view === undefined ? {} : { view }), ...(cursor === undefined ? {} : { cursor }) }), budget)
}

function sessions(result: ApplicationResult, limits: ApplicationBudget = budget): SessionsResult {
  const decoded = parseApplicationResult(encodeApplicationResult(result, limits), limits)
  if (decoded.type !== 'sessions') throw new Error(`Expected sessions, received ${decoded.type}`)
  return decoded
}

function live(fixture: Composition, name: string, cwd: string | undefined, createdAt: number,
  extra: { origin?: 'subagent'; delegationDepth?: number } = {}) {
  const session = fixture.ctx.sessions.prepare(SessionId(name), {
    meta: { createdAt, ...(cwd === undefined ? {} : { cwd }), ...extra },
  })
  const detach = fixture.ctx.sessions.enter(session)
  cleanup.push(detach)
  fixture.ctx.sessions.announce(session)
  session.append('session/title', { title: `聊天 ${name}`, messageSeqs: [], source: { kind: 'user' } })
  return { session, detach }
}

async function persist(fixture: Composition, session: Session): Promise<void> {
  await using stored = await fixture.ctx.sessionPersistence.create(session.header)
  await stored.append(session.snapshotEvents())
  await stored.flush()
  await fixture.ctx.sessionProjectionCache.write(session)
}

function noActivation(fixture: Composition) {
  const spies = [
    vi.spyOn(fixture.ctx.agents, 'create'), vi.spyOn(fixture.ctx.sessionController, 'resolveAgent'),
    vi.spyOn(fixture.ctx.sessionQuery, 'observeSession'), vi.spyOn(fixture.ctx.sessionQuery, 'listSessions'),
    vi.spyOn(fixture.ctx.sessionPersistence, 'open'),
  ]
  return () => { for (const spy of spies) expect(spy).not.toHaveBeenCalled() }
}

describe('companion navigation list', () => {
  it('keeps legacy JSON exact and projects only returned visible membership and registry pin positions', async () => {
    const fixture = await boot()
    const registry = fixture.ctx.workspaceRegistry
    const leftPath = join(fixture.home, 'left')
    const rightPath = join(fixture.home, 'right')
    const emptyPath = join(fixture.home, 'empty')
    await Promise.all([leftPath, rightPath, emptyPath].map(path => mkdir(path, { recursive: true })))
    const left = await registry.create(leftPath, 'مشروع 项目 😀')
    const right = await registry.create(rightPath, 'مشروع 项目 😀')
    const empty = await registry.create(emptyPath, 'Empty private inventory')
    await registry.insertBefore(left.id, right.id)
    const a = live(fixture, 'visible-a', leftPath, 600).session
    const b = live(fixture, 'visible-b', rightPath, 500).session
    const loose = live(fixture, 'same-cwd-unassigned', leftPath, 400).session
    const archived = live(fixture, 'archived', leftPath, 900).session
    const child = live(fixture, 'subagent', leftPath, 800, { origin: 'subagent' }).session
    live(fixture, 'delegated', leftPath, 700, { delegationDepth: 1 })
    live(fixture, 'no-cwd', undefined, 1000)
    const stale = live(fixture, 'stale-pin', leftPath, 1100)
    await left.attachSession(a.id)
    await right.attachSession(b.id)
    await left.attachSession(archived.id)
    await left.attachSession(child.id)
    await expect(right.attachSession(loose.id)).rejects.toThrow()
    await registry.archiveSession(archived.id)
    await registry.pinSession(b.id)
    await registry.pinSession(a.id)
    await registry.pinSession(child.id)
    await registry.pinSession(stale.session.id)
    stale.detach()
    expect(registry.list().map(item => item.id)).toEqual([empty.id, left.id, right.id])
    expect(registry.pinnedSessionIds).toEqual([stale.session.id, child.id, a.id, b.id])
    const unchanged = noActivation(fixture)
    const current = dispatcher(fixture)
    const legacyResult = await current.dispatch(request())
    const legacy = sessions(legacyResult)
    expect(encodeApplicationResult(legacyResult, budget)).toBe(JSON.stringify({
      v: 1, type: 'sessions', requestId,
      sessions: [a, b, loose].map(session => ({ sessionId: session.id, title: `聊天 ${session.id}`, status: 'closed' })),
    }))
    const nav = sessions(await current.dispatch(request('navigation')))
    expect(nav.sessions).toEqual([
      { ...legacy.sessions[0], navigation: { updatedAt: 600, pinOrder: 2,
        workspace: { id: left.id, title: left.title, order: 1 } } },
      { ...legacy.sessions[1], navigation: { updatedAt: 500, pinOrder: 3,
        workspace: { id: right.id, title: right.title, order: 2 } } },
      { ...legacy.sessions[2], navigation: { updatedAt: 400, pinOrder: null, workspace: null } },
    ])
    const json = encodeApplicationResult(nav, budget)
    for (const hidden of [fixture.home, empty.title, archived.id, child.id, stale.session.id]) {
      expect(json).not.toContain(JSON.stringify(hidden).slice(1, -1))
    }
    for (const key of ['sessionIds', 'cwd', 'path']) expect(json).not.toContain(`"${key}":`)
    await right.setTitle('😀'.repeat(33))
    await empty.setTitle('😀'.repeat(40))
    const cache = vi.spyOn(fixture.ctx.sessionProjections, 'cachedSnapshot')
    const page = sessions(await current.dispatch(request('navigation', 1)))
    expect(page.sessions.map(row => row.sessionId)).toEqual([a.id])
    expect(cache.mock.calls).toEqual([[a, ['title', 'sessionListMetadata']]])
    unchanged()
  })

  it('uses cached human prompt activity for both live and cold rows, not later assistant or injected events', async () => {
    const fixture = await boot()
    const current = dispatcher(fixture)
    const owned = live(fixture, 'activity', fixture.home, 1000)
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(2000)
      owned.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'human prompt' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      clock.mockReturnValue(3000)
      owned.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'background notice' }], source: { kind: 'watcher' },
      }), { surfaceOp: 'append' })
      clock.mockReturnValue(4000)
      owned.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({
        role: 'assistant', content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      }) }, { surfaceOp: 'append' })
      clock.mockReturnValue(5000)
      owned.session.append('session/title', { title: 'Renamed later', messageSeqs: [], source: { kind: 'user' } })
    } finally { clock.mockRestore() }
    await persist(fixture, owned.session)
    const unchanged = noActivation(fixture)
    const liveRow = sessions(await current.dispatch(request('navigation'))).sessions[0]
    expect(liveRow).toEqual({ sessionId: owned.session.id, title: 'Renamed later', status: 'closed',
      navigation: { updatedAt: 2000, pinOrder: null, workspace: null } })
    owned.detach()
    expect(fixture.ctx.sessions.get(owned.session.id)).toBeUndefined()
    expect(sessions(await current.dispatch(request('navigation'))).sessions).toEqual([liveRow])
    expect(fixture.ctx.sessions.get(owned.session.id)).toBeUndefined()
    unchanged()
  })

  it('uses creation on a cold cache miss and preserves createdAt plus hash cursor ordering across views', async () => {
    const fixture = await boot()
    const current = dispatcher(fixture)
    const newest = live(fixture, 'newest', fixture.home, 300).session
    const equal = ['equal-a', 'equal-b'].map(id => live(fixture, id, fixture.home, 200).session)
      .sort((a, b) => Buffer.compare(createHash('sha256').update(a.id).digest(), createHash('sha256').update(b.id).digest()))
    const uncached = fixture.ctx.sessions.prepare(SessionId('cold-cache-miss'), { meta: { cwd: fixture.home, createdAt: 100 } })
    await using stored = await fixture.ctx.sessionPersistence.create(uncached.header)
    await stored.flush()
    const unchanged = noActivation(fixture)
    const ordered = [newest.id, ...equal.map(session => session.id), uncached.id]
    const first = sessions(await current.dispatch(request('navigation', 1)))
    expect(first.sessions.map(row => row.sessionId)).toEqual(ordered.slice(0, 1))
    expect(first.cursor).toBeDefined()
    const second = sessions(await current.dispatch(request(undefined, 1, first.cursor)))
    expect(second.sessions.map(row => row.sessionId)).toEqual(ordered.slice(1, 2))
    expect(second.sessions[0]?.navigation).toBeUndefined()
    const third = sessions(await current.dispatch(request('navigation', 1, second.cursor)))
    expect(third.sessions.map(row => row.sessionId)).toEqual(ordered.slice(2, 3))
    const fourth = sessions(await current.dispatch(request('navigation', 1, third.cursor)))
    expect(fourth.sessions).toEqual([{ sessionId: uncached.id, title: '', status: 'closed',
      navigation: { updatedAt: 100, pinOrder: null, workspace: null } }])
    expect(fourth.cursor).toBeUndefined()
    unchanged()
  })

  it('enforces tiny and exact complete-result byte limits including navigation', async () => {
    const fixture = await boot()
    const workspace = await fixture.ctx.workspaceRegistry.create(fixture.home, '界'.repeat(60))
    const session = live(fixture, 'budget', fixture.home, 100).session
    session.append('session/title', { title: '文'.repeat(60), messageSeqs: [], source: { kind: 'user' } })
    await workspace.attachSession(session.id)
    const limits = { ...budget, maxTitleBytes: 256, maxTextBytes: 256 }
    const full = sessions(await dispatcher(fixture, { budget: limits }).dispatch(request('navigation')), limits)
    const bytes = Buffer.byteLength(encodeApplicationResult(full, limits))
    expect(bytes).toBeGreaterThan(512)
    const exact = { ...limits, maxResultBytes: bytes }
    expect(await dispatcher(fixture, { budget: exact }).dispatch(request('navigation'))).toEqual(full)
    for (const maxResultBytes of [512, bytes - 1]) {
      const bounded = dispatcher(fixture, { budget: { ...limits, maxResultBytes } })
      expect(await bounded.dispatch(request('navigation'))).toEqual({ v: 1, type: 'error', requestId, code: 'limit' })
      expect(sessions(await bounded.dispatch(request()), { ...limits, maxResultBytes }).sessions[0]?.navigation).toBeUndefined()
    }
  })

  it.each(['abort', 'grant', 'close'] as const)('withdraws a navigation read during header I/O on %s', async (reason) => {
    const fixture = await boot()
    live(fixture, 'withheld', fixture.home, 100)
    const owner = new AbortController()
    let authorized = true
    const current = dispatcher(fixture, { signal: owner.signal,
      requireCurrent: () => { if (!authorized) throw new Error('Grant generation retired') } })
    const arrived = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = fixture.ctx.sessionPersistence.list.bind(fixture.ctx.sessionPersistence)
    vi.spyOn(fixture.ctx.sessionPersistence, 'list').mockImplementationOnce(async (options) => {
      expect(options?.signal).toBeDefined()
      arrived.resolve(undefined)
      await release.promise
      return original(options)
    })
    const pending = current.dispatch(request('navigation'))
    cleanup.push(async () => { release.resolve(undefined); await pending })
    await arrived.promise
    let closed = false
    let closing: Promise<void> | undefined
    if (reason === 'abort') owner.abort()
    else if (reason === 'grant') authorized = false
    else closing = current.close().then(() => { closed = true })
    expect(closed).toBe(false)
    release.resolve(undefined)
    expect(await pending).toEqual({ v: 1, type: 'error', requestId, code: 'denied' })
    await closing
    if (reason === 'close') expect(closed).toBe(true)
    expect(await current.dispatch(request('navigation'))).toEqual({ v: 1, type: 'error', requestId, code: 'denied' })
  })
})
