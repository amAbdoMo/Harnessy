/** Supported management through real source Loader, Workspace, title, Agent, and JSONL owners. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  encodeApplicationResult, parseApplicationRequest, parseApplicationResult, parseId,
} from '@deepseek-ai/dsh-companion-protocol'
import type { ApplicationBudget, ApplicationResult, GrantId } from '@deepseek-ai/dsh-companion-protocol'
import { createApplicationDispatcher } from '../src/application-dispatch.ts'
import { composition, config } from './composition.ts'
import type { Composition } from './composition.ts'

const disk = vi.hoisted(() => ({
  stat: undefined as ((path: string) => Promise<void>) | undefined,
  rename: undefined as ((path: string) => Promise<void>) | undefined,
  open: undefined as ((path: string, flags: unknown) => Promise<void>) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (typeof args[0] === 'string') await disk.stat?.(args[0])
      return actual.stat(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (typeof args[1] === 'string') await disk.rename?.(args[1])
      return actual.rename(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (typeof args[0] === 'string') await disk.open?.(args[0], args[1])
      return actual.open(...args)
    },
  }
})

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  disk.stat = undefined
  disk.rename = undefined
  disk.open = undefined
  const failures: unknown[] = []
  try {
    for (const release of cleanup.splice(0).reverse()) {
      try { await release() } catch (error: unknown) { failures.push(error) }
    }
  } finally { vi.restoreAllMocks() }
  if (failures.length > 0) throw new AggregateError(failures, 'Management fixture teardown failed')
})

function intercept<K extends keyof typeof disk>(key: K, hook: (typeof disk)[K]) {
  const previous = disk[key]
  disk[key] = hook
  const restore = () => { disk[key] = previous }
  cleanup.push(restore)
  return restore
}

function ownPending<T>(pending: Promise<T>, barrier: Barrier): Promise<T> {
  cleanup.push(async () => { barrier.release(); await pending })
  return pending
}

class Barrier {
  private readonly arrival = Promise.withResolvers<undefined>()
  private readonly completion = Promise.withResolvers<undefined>()
  readonly arrived = this.arrival.promise
  constructor() { cleanup.push(() => { this.release() }) }
  async enter(): Promise<void> { this.arrival.resolve(undefined); await this.completion.promise }
  release(): void { this.completion.resolve(undefined) }
}

class Model extends LlmAdapter {
  calls = 0
  readonly barrier = new Barrier()
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    await this.barrier.enter()
    options.signal?.throwIfAborted()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const budget = config.budgets.application
let ordinal = 0
function identity() {
  const operationId = Buffer.alloc(16, ++ordinal).toString('base64url')
  return { v: 1, requestId: operationId, operationId, sessionId: `mobile-${operationId}` }
}
function request(value: object, limits: ApplicationBudget = budget) {
  return parseApplicationRequest(JSON.stringify(value), limits)
}
function decoded(result: ApplicationResult, limits: ApplicationBudget = budget): ApplicationResult {
  return parseApplicationResult(encodeApplicationResult(result, limits), limits)
}

async function boot() {
  const fixture = await composition({})
  cleanup.push(() => fixture.close())
  await mkdir(fixture.home, { recursive: true })
  const modules = { 'management-prompt': SystemPrompt, 'management-tools': Tools,
    'management-loop': AgentLoop, 'management-title': SessionTitle, 'management-cache': SessionProjectionCache }
  const configs: Record<string, object> = {
    'management-loop': { agents: [] },
    'management-title': { fallbackMaxWords: 10, fallbackMaxBytes: 256, maxTitleBytes: 1024 },
    'management-cache': { writeEveryEvents: 100, writeIntervalMs: 60_000 },
  }
  for (const [name, plugin] of Object.entries(modules)) {
    fixture.ctx.loader.builtins[name] = plugin
    await fixture.ctx.loader.create({ name: `cordis:${name}`, config: configs[name] ?? {} })
  }
  await fixture.ctx.loader.await()
  const model = new Model()
  fixture.ctx.effect(() => fixture.ctx.llm.registerAdapter(['fixture'], model))
  const workspace = await fixture.ctx.workspaceRegistry.create(fixture.home, 'Empty 工作区')
  expect(fixture.ctx.sessionTitle).toBeDefined()
  expect(fixture.ctx.sessionController).toBeDefined()
  return { ...fixture, model, workspace }
}

function dispatcher(fixture: Composition, settings: {
  enabled?: boolean
  budget?: ApplicationBudget
  maxPendingRequests?: number
} = {}) {
  const authority = { enabled: settings.enabled ?? false, current: true }
  const current = createApplicationDispatcher(fixture.ctx, {
    signal: fixture.owner.signal,
    requireCurrent: () => { if (!authority.current) throw new Error('private grant diagnostic') },
    managementAccess: () => authority.enabled, modelAccess: () => false, toolDetailsAccess: () => false, activationAccess: () => false,
    grantId: parseId<GrantId>('management-grant'), generation: 1,
    budget: settings.budget ?? budget, maxWatches: 1,
    maxPendingRequests: settings.maxPendingRequests ?? 4, maxProgressBuffer: 2,
    sendProgress: () => { throw new Error('Management must not publish progress') },
  })
  cleanup.push(() => current.close())
  return { ...current, authority }
}

async function create(fixture: Awaited<ReturnType<typeof boot>>, dispatch = dispatcher(fixture, { enabled: true })) {
  const id = identity()
  const result = decoded(await dispatch.dispatch(request({ ...id, type: 'createSession', workspaceId: fixture.workspace.id })))
  expect(result).toMatchObject({ type: 'managed', action: 'create', outcome: 'applied', sessionId: id.sessionId,
    session: { sessionId: id.sessionId, title: '', navigation: { workspace: { id: fixture.workspace.id } } } })
  return SessionId(id.sessionId)
}

function command(type: 'renameSession' | 'archiveSession' | 'setSessionPinned', sessionId: SessionId, extra: object = {}) {
  return request({ ...identity(), type, sessionId, ...extra })
}
function catalog(limit = 10, cursor?: string) {
  return request({ v: 1, type: 'listManagementWorkspaces', requestId: identity().requestId, limit,
    ...(cursor === undefined ? {} : { cursor }) })
}

async function persistedEvents(fixture: Composition, sessionId: SessionId) {
  await using handle = await fixture.ctx.sessionPersistence.open(sessionId, 'read')
  return (await handle.read()).events
}

function workspaceFile(fixture: Composition) {
  return join(dirname(fixture.home), 'storage', 'workspace.json')
}

async function physicalLog(fixture: Composition, sessionId: SessionId) {
  const root = join(dirname(fixture.home), 'sessions')
  const files = await readdir(root, { recursive: true })
  const physical = files.find(path => basename(dirname(path)) === sessionId && /session\.v\d+\.jsonl$/u.test(path))
  return physical === undefined ? undefined : join(root, physical)
}

async function durableLog(fixture: Composition, sessionId: SessionId) {
  const path = await physicalLog(fixture, sessionId)
  if (path === undefined) throw new Error(`Missing fixture Session log: ${sessionId}`)
  return { path, text: await readFile(path, 'utf8') }
}

describe('companion supported PC management', () => {
  it('denies by default without catalog disclosure or mutation service reads', async () => {
    const fixture = await boot()
    const dispatch = dispatcher(fixture)
    const list = vi.spyOn(fixture.ctx.workspaceRegistry, 'list')
    const stat = vi.spyOn(fixture.ctx.sessionPersistence, 'stat')
    const createCall = vi.spyOn(fixture.ctx.sessionController, 'create')
    expect(decoded(await dispatch.dispatch(catalog()))).toMatchObject({ type: 'managementWorkspaces', enabled: false, workspaces: [] })
    const id = identity()
    expect(decoded(await dispatch.dispatch(request({ ...id, type: 'createSession', workspaceId: fixture.workspace.id }))))
      .toMatchObject({ type: 'managed', outcome: 'rejected', code: 'denied' })
    expect(list).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
    expect(createCall).not.toHaveBeenCalled()
    expect(fixture.ctx.sessions.list()).toHaveLength(0)
  })

  it('lists empty registered Workspaces without paths and creates an empty default-PC chat with targeted flush', async () => {
    const fixture = await boot()
    const dispatch = dispatcher(fixture, { enabled: true })
    const result = decoded(await dispatch.dispatch(catalog()))
    expect(result).toMatchObject({ type: 'managementWorkspaces', enabled: true,
      workspaces: [{ id: fixture.workspace.id, title: 'Empty 工作区', order: 0 }] })
    expect(JSON.stringify(result)).not.toContain(fixture.home)
    // An unmaterialized independent writer would become physical under a global flush.
    const unrelated = fixture.ctx.sessions.prepare(SessionId('unrelated-unflushed'), { meta: { cwd: fixture.home } })
    await using unrelatedWriter = await fixture.ctx.sessionPersistence.create(unrelated.header)
    const id = await create(fixture, dispatch)
    const live = fixture.ctx.sessions.get(id)!
    expect(live.header).toMatchObject({ id, cwd: fixture.workspace.path })
    expect(fixture.ctx.sessionTitle.get(live)).toBeUndefined()
    expect(fixture.workspace.sessionIds).toEqual([id])
    expect(JSON.parse(await readFile(workspaceFile(fixture), 'utf8'))).toMatchObject({
      tables: { workspaces: { [fixture.workspace.id]: { sessionIds: [id] } } },
    })
    expect((await fixture.ctx.sessionPersistence.stat(id))?.header.id).toBe(id)
    const events = await persistedEvents(fixture, id)
    expect(events.some(event => ['user/message', 'request/header', 'tool/call', 'step/start', 'session/title'].includes(event.type))).toBe(false)
    expect(fixture.model.calls).toBe(0)
    const log = await durableLog(fixture, id)
    expect(JSON.parse(log.text.split('\n')[0]!)).toMatchObject({ type: 'session', id, cwd: fixture.workspace.path })
    expect(await physicalLog(fixture, unrelated.id)).toBeUndefined()
    await unrelatedWriter.flush()
    expect((await durableLog(fixture, unrelated.id)).text).toContain(unrelated.id)
  })

  it('keeps managed workspace ownership when a Session selects another registered execution directory', async () => {
    const fixture = await boot()
    const dispatch = dispatcher(fixture, { enabled: true })
    const otherPath = join(fixture.home, 'other-workspace')
    await mkdir(otherPath)
    const other = await fixture.ctx.workspaceRegistry.create(otherPath, 'Other workspace')
    const id = await create(fixture, dispatch)
    const session = fixture.ctx.sessions.get(id)!
    session.append('working-directory/change', { cwd: other.path })
    const renamed = decoded(await dispatch.dispatch(command('renameSession', id, { title: 'Directory retained' })))
    expect(renamed).toMatchObject({ outcome: 'applied', session: {
      sessionId: id, navigation: { workspace: { id: fixture.workspace.id } },
    } })
    expect(session.header.cwd).toBe(fixture.workspace.path)
    expect(fixture.workspace.sessionIds).toEqual([id])
    expect(other.sessionIds).toEqual([])
    const log = await durableLog(fixture, id)
    expect(JSON.parse(log.text.split('\n')[0]!)).toMatchObject({ cwd: fixture.workspace.path })
    expect((await persistedEvents(fixture, id)).filter(event => event.type === 'working-directory/change'))
      .toMatchObject([{ data: { cwd: other.path } }])
    expect(fixture.model.calls).toBe(0)
  })

  it('rejects pre-existing live and persisted create identities instead of adopting them', async () => {
    const fixture = await boot()
    const dispatch = dispatcher(fixture, { enabled: true })
    const id = identity()
    const value = request({ ...id, type: 'createSession', workspaceId: fixture.workspace.id })
    expect(await dispatch.dispatch(value)).toMatchObject({ outcome: 'applied' })
    const createCall = vi.spyOn(fixture.ctx.sessionController, 'create')
    expect(await dispatch.dispatch(value)).toMatchObject({ outcome: 'rejected', code: 'conflict' })
    const cold = identity()
    const session = fixture.ctx.sessions.prepare(SessionId(cold.sessionId), { meta: { cwd: fixture.home } })
    await using stored = await fixture.ctx.sessionPersistence.create(session.header)
    await stored.flush()
    expect(fixture.ctx.sessions.get(session.id)).toBeUndefined()
    expect(await dispatch.dispatch(request({ ...cold, type: 'createSession', workspaceId: fixture.workspace.id })))
      .toMatchObject({ outcome: 'rejected', code: 'conflict' })
    expect(createCall).not.toHaveBeenCalled()
  })

  it('does not activate a cold chat through management consent or live-only rename', async () => {
    const fixture = await boot()
    const dispatch = dispatcher(fixture, { enabled: true })
    const session = fixture.ctx.sessions.prepare(SessionId('cold-management-target'), { meta: { cwd: fixture.home } })
    await using writer = await fixture.ctx.sessionPersistence.create(session.header)
    await writer.flush()
    const before = (await durableLog(fixture, session.id)).text
    expect(await dispatch.dispatch(command('renameSession', session.id, { title: 'Must not initialize' })))
      .toMatchObject({ outcome: 'rejected', code: 'unavailable' })
    expect(() => fixture.ctx.sessionController.renameLiveSession({ sessionId: session.id, title: 'Still cold' })).toThrow()
    expect(fixture.ctx.agents.get(session.id)).toBeUndefined()
    expect(fixture.ctx.sessions.get(session.id)).toBeUndefined()
    expect((await durableLog(fixture, session.id)).text).toBe(before)
    expect(fixture.model.calls).toBe(0)
  })

  it('persists rename, preserves other pins, applies desired pin state, and archives without deleting the log', async () => {
    const fixture = await boot()
    const dispatch = dispatcher(fixture, { enabled: true })
    const first = await create(fixture, dispatch)
    const other = await create(fixture, dispatch)
    await fixture.ctx.workspaceRegistry.pinSession(other)
    expect(decoded(await dispatch.dispatch(command('renameSession', first, { title: 'Renamed 聊天' }))))
      .toMatchObject({ outcome: 'applied', action: 'rename', session: { title: 'Renamed 聊天', navigation: {} } })
    expect((await persistedEvents(fixture, first)).filter(event => event.type === 'session/title').at(-1))
      .toMatchObject({ data: { title: 'Renamed 聊天', source: { kind: 'user' } } })
    for (const pinned of [true, true, false, true]) {
      expect(decoded(await dispatch.dispatch(command('setSessionPinned', first, { pinned }))))
        .toMatchObject({ outcome: 'applied', action: 'pin', session: { navigation: { pinOrder: pinned ? 0 : null } } })
      expect(fixture.ctx.workspaceRegistry.pinnedSessionIds).toContain(other)
    }
    const before = await persistedEvents(fixture, first)
    const archived = decoded(await dispatch.dispatch(command('archiveSession', first)))
    expect(archived).toMatchObject({ outcome: 'applied', action: 'archive' })
    expect(archived).not.toHaveProperty('session')
    expect(fixture.ctx.workspaceRegistry.archivedSessionIds).toContain(first)
    expect(fixture.ctx.workspaceRegistry.pinnedSessionIds).toEqual([other])
    expect(await persistedEvents(fixture, first)).toEqual(before)
    expect(await dispatch.dispatch(command('setSessionPinned', first, { pinned: false })))
      .toMatchObject({ outcome: 'rejected', code: 'denied' })
  })

  it('refuses busy archive without stopping work while rename and pin use their PC owners', async () => {
    const fixture = await boot()
    const dispatch = dispatcher(fixture, { enabled: true })
    const id = await create(fixture, dispatch)
    const agent = fixture.ctx.agents.get(id)!
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'controlled external model wait' }] }))
    await fixture.model.barrier.arrived
    expect(agent.status).toBe('running')
    const stops = vi.fn()
    const stopListening = fixture.ctx.on('workspace/session-stop', stops)
    cleanup.push(() => { stopListening() })
    expect(decoded(await dispatch.dispatch(command('archiveSession', id))))
      .toMatchObject({ outcome: 'rejected', code: 'busy' })
    expect(fixture.ctx.workspaceRegistry.archivedSessionIds).not.toContain(id)
    expect(stops).not.toHaveBeenCalled()
    expect(agent.status).toBe('running')
    expect(await dispatch.dispatch(command('renameSession', id, { title: 'While busy' }))).toMatchObject({ outcome: 'applied' })
    expect(await dispatch.dispatch(command('setSessionPinned', id, { pinned: true }))).toMatchObject({ outcome: 'applied' })
    fixture.model.barrier.release()
    await agent.whenIdle()
    expect(await dispatch.dispatch(command('archiveSession', id))).toMatchObject({ outcome: 'applied' })
  })

  it('denies hidden, subagent, and nonexistent-directory targets even for unpin', async () => {
    const fixture = await boot()
    const dispatch = dispatcher(fixture, { enabled: true })
    const mutate = vi.spyOn(fixture.ctx.workspaceRegistry, 'unpinSession')
    for (const [name, meta] of [
      ['hidden', {}], ['child', { cwd: fixture.home, origin: 'subagent' as const }],
      ['missing-directory', { cwd: join(fixture.home, 'not-created') }],
    ] as const) {
      const session = fixture.ctx.sessions.prepare(SessionId(name), { meta })
      cleanup.push(fixture.ctx.sessions.enter(session))
      fixture.ctx.sessions.announce(session)
      expect(await dispatch.dispatch(command('setSessionPinned', session.id, { pinned: false })))
        .toMatchObject({ outcome: 'rejected', code: 'denied' })
    }
    expect(mutate).not.toHaveBeenCalled()
  })

  it('rechecks management grant after preflight and rejects without creating', async () => {
    const fixture = await boot()
    const dispatch = dispatcher(fixture, { enabled: true })
    const barrier = new Barrier()
    const restore = intercept('stat', async (path) => { if (path === fixture.workspace.path) await barrier.enter() })
    const createCall = vi.spyOn(fixture.ctx.sessionController, 'create')
    const id = identity()
    const value = request({ ...id, type: 'createSession', workspaceId: fixture.workspace.id })
    const pending = ownPending(dispatch.dispatch(value), barrier)
    try {
      await barrier.arrived
      expect(await dispatch.dispatch(value)).toMatchObject({ outcome: 'rejected', code: 'conflict' })
      dispatch.authority.enabled = false
      barrier.release()
      expect(await pending).toMatchObject({ outcome: 'rejected', code: 'denied' })
      expect(createCall).not.toHaveBeenCalled()
      expect(fixture.ctx.sessions.get(SessionId(id.sessionId))).toBeUndefined()
    } finally { barrier.release(); restore() }
  })

  it('finishes an admitted create and flush after revocation without claiming applied', async () => {
    const fixture = await boot()
    const dispatch = dispatcher(fixture, { enabled: true })
    const barrier = new Barrier()
    const file = workspaceFile(fixture)
    const before = await readFile(file, 'utf8')
    const restore = intercept('rename', async (path) => { if (path === file) await barrier.enter() })
    const id = identity()
    const sessionId = SessionId(id.sessionId)
    const pending = ownPending(dispatch.dispatch(request({ ...id, type: 'createSession', workspaceId: fixture.workspace.id })), barrier)
    try {
      await barrier.arrived
      const live = fixture.ctx.sessions.get(sessionId)!
      expect(live).toBeDefined()
      expect(fixture.workspace.sessionIds).not.toContain(sessionId)
      expect(await readFile(file, 'utf8')).toBe(before)
      dispatch.authority.current = false
      fixture.owner.abort()
      fixture.ctx.sessionTitle.rename(live, 'PC title during admitted create')
      barrier.release()
      expect(decoded(await pending)).toMatchObject({ type: 'managed', action: 'create', outcome: 'unknown' })
      expect(fixture.workspace.sessionIds).toContain(sessionId)
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
        tables: { workspaces: { [fixture.workspace.id]: { sessionIds: [sessionId] } } },
      })
      expect((await fixture.ctx.sessionPersistence.stat(sessionId))?.header.id).toBe(sessionId)
      expect((await persistedEvents(fixture, sessionId)).filter(event => event.type === 'session/title'))
        .toMatchObject([{ data: { title: 'PC title during admitted create', source: { kind: 'user' } } }])
      expect((await durableLog(fixture, sessionId)).text).toContain('PC title during admitted create')
      expect(fixture.model.calls).toBe(0)
    } finally { barrier.release(); restore() }
  })

  it('keeps creation uncertain when its post-attachment flush throws a recognized refusal error', async () => {
    const fixture = await boot()
    const dispatch = dispatcher(fixture, { enabled: true })
    const target = identity()
    const id = SessionId(target.sessionId)
    let faultReached = false
    const detach = fixture.ctx.on('session/flush', (session) => {
      if (session.id === id && fixture.workspace.sessionIds.includes(id)) {
        faultReached = true
        throw new RemoteError('workspace/not-found', 'private flush diagnostic', { workspaceId: fixture.workspace.id })
      }
    })
    cleanup.push(() => { detach() })
    const result = decoded(await dispatch.dispatch(request({ ...target, type: 'createSession', workspaceId: fixture.workspace.id })))
    expect(faultReached).toBe(true)
    expect(result).toMatchObject({ type: 'managed', outcome: 'unknown' })
    expect(fixture.workspace.sessionIds).toContain(id)
    expect((await fixture.ctx.sessionPersistence.stat(id))?.header.id).toBe(id)
    expect(JSON.stringify(result)).not.toContain('private')
    expect(fixture.model.calls).toBe(0)
  })

  it('does not adopt a nonempty cold identity inserted during directory preflight', async () => {
    const fixture = await boot()
    const dispatch = dispatcher(fixture, { enabled: true })
    const target = identity()
    const id = SessionId(target.sessionId)
    const barrier = new Barrier()
    const restore = intercept('stat', async (path) => { if (path === fixture.workspace.path) await barrier.enter() })
    const pending = ownPending(dispatch.dispatch(request({ ...target, type: 'createSession', workspaceId: fixture.workspace.id })), barrier)
    try {
      await barrier.arrived
      const cold = fixture.ctx.sessions.prepare(id, { meta: { cwd: fixture.workspace.path } })
      cold.append('user/message', createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text: 'Existing cold conversation must not be adopted' }] }), { surfaceOp: 'append' })
      {
        await using stored = await fixture.ctx.sessionPersistence.create(cold.header)
        await stored.append(cold.snapshotEvents())
        await stored.flush()
      }
      barrier.release()
      expect(decoded(await pending)).toMatchObject({ type: 'managed', action: 'create', outcome: 'unknown' })
      expect(fixture.ctx.agents.get(id)).toBeUndefined()
      expect(fixture.ctx.sessions.get(id)).toBeUndefined()
      expect(fixture.workspace.sessionIds).not.toContain(id)
      expect((await durableLog(fixture, id)).text).toContain('Existing cold conversation must not be adopted')
      expect(fixture.model.calls).toBe(0)
    } finally { barrier.release(); restore() }
  })

  it('reports a partial Workspace attachment as unknown and refuses to retry creation', async () => {
    const fixture = await boot()
    const dispatch = dispatcher(fixture, { enabled: true })
    const file = workspaceFile(fixture)
    const before = await readFile(file, 'utf8')
    const partial = identity()
    const sessionId = SessionId(partial.sessionId)
    let faults = 0
    const restore = intercept('rename', async (path) => {
      if (path !== file) return
      faults++
      fixture.ctx.sessionTitle.rename(fixture.ctx.sessions.get(sessionId)!, 'PC title before attach failure')
      throw new Error('private attach path diagnostic')
    })
    try {
      const partialRequest = request({ ...partial, type: 'createSession', workspaceId: fixture.workspace.id })
      const result = decoded(await dispatch.dispatch(partialRequest))
      expect(faults).toBe(1)
      expect(result).toMatchObject({ type: 'managed', action: 'create', outcome: 'unknown' })
      expect(JSON.stringify(result)).not.toContain('private')
      const live = fixture.ctx.sessions.get(sessionId)!
      expect(live.header).toMatchObject({ id: sessionId, cwd: fixture.workspace.path })
      expect(fixture.workspace.sessionIds).not.toContain(sessionId)
      expect(await readFile(file, 'utf8')).toBe(before)
      const log = await durableLog(fixture, sessionId)
      expect(JSON.parse(log.text.split('\n')[0]!)).toMatchObject({ type: 'session', id: sessionId })
      expect(log.text).toContain('PC title before attach failure')
      expect((await persistedEvents(fixture, sessionId)).filter(event => event.type === 'session/title'))
        .toMatchObject([{ data: { title: 'PC title before attach failure', source: { kind: 'user' } } }])
      expect(await dispatch.dispatch(partialRequest)).toMatchObject({ outcome: 'rejected', code: 'conflict' })
      expect(faults).toBe(1)
      expect(fixture.ctx.sessions.get(sessionId)).toBe(live)
      expect(fixture.ctx.sessions.list().map(session => session.id)).toEqual([sessionId])
      expect(fixture.workspace.sessionIds).not.toContain(sessionId)
      expect(await readFile(file, 'utf8')).toBe(before)
      expect(await readFile(log.path, 'utf8')).toBe(log.text)
      expect(fixture.model.calls).toBe(0)
    } finally { restore() }
  })

  it('reports a durable title flush failure as unknown without replaying the rename', async () => {
    const fixture = await boot()
    const dispatch = dispatcher(fixture, { enabled: true })
    const id = await create(fixture, dispatch)
    const log = await durableLog(fixture, id)
    let faults = 0
    const restore = intercept('open', async (path, flags) => {
      if (path !== log.path || flags !== 'a') return
      faults++
      throw new Error('private flush failure')
    })
    try {
      const result = decoded(await dispatch.dispatch(command('renameSession', id, { title: 'Flush uncertain' })))
      expect(faults).toBeGreaterThan(0)
      expect(result).toMatchObject({ type: 'managed', action: 'rename', outcome: 'unknown' })
      expect(JSON.stringify(result)).not.toContain('private')
      const live = fixture.ctx.sessions.get(id)!
      expect(fixture.ctx.sessionTitle.get(live)).toMatchObject({ title: 'Flush uncertain', source: { kind: 'user' } })
      expect(live.snapshotEvents().filter(event => event.type === 'session/title')).toHaveLength(1)
      expect(await readFile(log.path, 'utf8')).toBe(log.text)
      expect((await persistedEvents(fixture, id)).filter(event => event.type === 'session/title')).toHaveLength(0)
      expect(fixture.workspace.sessionIds).toEqual([id])
      expect(fixture.model.calls).toBe(0)
    } finally { restore() }
    const live = fixture.ctx.sessions.get(id)!
    expect(await fixture.ctx.sessions.flush(live)).toBe(true)
    expect((await persistedEvents(fixture, id)).filter(event => event.type === 'session/title'))
      .toMatchObject([{ data: { title: 'Flush uncertain' } }])
    expect((await durableLog(fixture, id)).text).toContain('Flush uncertain')
  })

  it('bounds complete catalog envelopes and rejects changed catalog continuations without activating Agents', async () => {
    const fixture = await boot()
    for (let i = 0; i < 7; i++) {
      const path = join(fixture.home, `empty-${i}`)
      await mkdir(path)
      await fixture.ctx.workspaceRegistry.create(path, `工作区 ${i} ${'x'.repeat(80)}`)
    }
    const limits = { ...budget, maxRequestBytes: 768, maxResultBytes: 768, maxTextBytes: 256 }
    const dispatch = dispatcher(fixture, { enabled: true, budget: limits })
    const resume = vi.spyOn(fixture.ctx.agents, 'resume')
    const createCall = vi.spyOn(fixture.ctx.agents, 'create')
    const resolve = vi.spyOn(fixture.ctx.sessionController, 'resolveAgent')
    const first = decoded(await dispatch.dispatch(catalog()), limits)
    expect(first.type).toBe('managementWorkspaces')
    if (first.type !== 'managementWorkspaces' || !first.enabled || first.cursor === undefined) throw new Error('Expected bounded continuation')
    expect(first.workspaces.length).toBeGreaterThan(0)
    expect(first.workspaces.length).toBeLessThan(8)
    expect(Buffer.byteLength(encodeApplicationResult(first, limits), 'utf8')).toBeLessThanOrEqual(limits.maxResultBytes)
    const next = decoded(await dispatch.dispatch(catalog(1, first.cursor)), limits)
    expect(next).toMatchObject({ workspaces: [{ order: first.workspaces.length }] })
    await fixture.workspace.setTitle('Catalog changed')
    expect(await dispatch.dispatch(catalog(1, first.cursor))).toMatchObject({ type: 'error', code: 'expired' })
    expect(resume).not.toHaveBeenCalled()
    expect(createCall).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('reads cold history without resuming the source Agent or granting management authority', async () => {
    const fixture = await boot()
    const session = fixture.ctx.sessions.prepare(SessionId('cold-source-agent'), { meta: { cwd: fixture.home } })
    session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Existing human text' }] }), { surfaceOp: 'append' })
    await using stored = await fixture.ctx.sessionPersistence.create(session.header)
    await stored.append(session.snapshotEvents())
    await stored.flush()
    const dispatch = dispatcher(fixture)
    const resume = vi.spyOn(fixture.ctx.agents, 'resume')
    const resolve = vi.spyOn(fixture.ctx.sessionController, 'resolveAgent')
    expect(decoded(await dispatch.dispatch(request({ v: 1, type: 'readHistory', requestId: identity().requestId,
      sessionId: session.id, limit: 10 })))).toMatchObject({ type: 'history', rows: [{ role: 'user', text: 'Existing human text' }] })
    expect(fixture.ctx.agents.get(session.id)).toBeUndefined()
    expect(resume).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(fixture.model.calls).toBe(0)
  })

  it('rejects over-budget requests and excess concurrent handlers before admitting PC services', async () => {
    const fixture = await boot()
    const limits = { ...budget, maxRequestBytes: 512, maxResultBytes: 512, maxTextBytes: 128 }
    const dispatch = dispatcher(fixture, { enabled: true, budget: limits, maxPendingRequests: 1 })
    const id = await create(fixture)
    const rename = vi.spyOn(fixture.ctx.sessionController, 'rename')
    const oversized = request({ ...identity(), type: 'renameSession', sessionId: id, title: '界'.repeat(200) },
      { ...budget, maxTitleBytes: 1024 })
    expect(await dispatch.dispatch(oversized)).toMatchObject({ outcome: 'rejected', code: 'limit' })
    expect(rename).not.toHaveBeenCalled()
    const barrier = new Barrier()
    const restore = intercept('stat', async (path) => { if (path === fixture.workspace.path) await barrier.enter() })
    const fresh = identity()
    const pending = ownPending(dispatch.dispatch(request({ ...fresh, type: 'createSession', workspaceId: fixture.workspace.id })), barrier)
    try {
      await barrier.arrived
      expect(await dispatch.dispatch(command('archiveSession', id))).toMatchObject({ outcome: 'rejected', code: 'limit' })
      barrier.release()
      await pending
    } finally { barrier.release(); restore() }
  })
})
