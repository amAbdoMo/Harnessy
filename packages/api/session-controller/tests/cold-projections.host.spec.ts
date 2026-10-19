/** Header-only migration deferral and live-preferred projection reads. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision, type SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSessionTestController } from './test-remote.ts'

const sessionId = SessionId('cold-projections')
const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false, cwd: '/project' }
const stored: SessionPersistenceSnapshot = {
  header, revision: SessionPersistenceRevision('cold-projections'), formatStatus: 'migration-required',
}

/** Controlled cache-read provider; the BFF, not cache checkpoint storage, is under test. */
class CachedHints extends SessionProjectionCache {
  static override inject: string[] = []
  protected override async [Service.init](): Promise<void> {}
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'cold-projection-jsonl-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }), cwd: '/project',
  })
  return { ctx, controller }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('cold Session projections', () => {
  it('serves an attached Session without persistence or query reads', async () => {
    const { ctx, controller } = await harness()
    const stat = vi.fn()
    vi.spyOn(ctx.sessionPersistence, 'stat').mockImplementation(stat)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    ctx.sessions.create(sessionId, { meta: { cwd: '/project' } })

    expect(await controller.projections({ sessionId }, signal())).toMatchObject({
      kind: 'sequenced', asOfSeq: -1, values: { sessionListMetadata: { blank: true, lastPromptAt: null } },
    })
    expect(stat).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
  })

  it.for(['hit', 'miss', 'unmounted'] as const)('defers migration with cache %s and no body read', async (cache) => {
    const { ctx, controller } = await harness()
    const stat = vi.fn(async () => stored)
    const open = vi.spyOn(ctx.sessionPersistence, 'open')
    vi.spyOn(ctx.sessionPersistence, 'stat').mockImplementation(stat)
    const cachedSnapshot = vi.fn<SessionProjectionCache['cachedSnapshot']>(() => cache === 'hit'
      ? { asOfSeq: SessionSeq(900), values: { title: 'cached hint' } }
      : undefined)
    if (cache !== 'unmounted') {
      await ctx.plugin(CachedHints, { writeEveryEvents: 1, writeIntervalMs: 1000 })
      vi.spyOn(ctx.sessionProjectionCache, 'cachedSnapshot').mockImplementation(cachedSnapshot)
    }
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    const requestSignal = signal()

    expect(await controller.projections({ sessionId }, requestSignal)).toEqual({
      kind: 'migration-required', values: cache === 'hit' ? { title: 'cached hint' } : {},
    })
    expect(stat).toHaveBeenCalledExactlyOnceWith(sessionId, { signal: requestSignal })
    if (cache !== 'unmounted') expect(cachedSnapshot).toHaveBeenCalledExactlyOnceWith(header)
    expect(open).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
  })

  it.for([stored, undefined])('prefers a Session attached while stat is pending: %s', async (snapshot) => {
    const { ctx, controller } = await harness()
    const pending = Promise.withResolvers<SessionPersistenceSnapshot | undefined>()
    vi.spyOn(ctx.sessionPersistence, 'stat').mockImplementation(() => pending.promise)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    const reading = controller.projections({ sessionId }, signal())
    ctx.sessions.create(sessionId, { meta: { cwd: '/project' } })
    pending.resolve(snapshot)

    expect(await reading).toMatchObject({ kind: 'sequenced', asOfSeq: -1 })
    expect(observe).not.toHaveBeenCalled()
  })

  it.for(['current', undefined] as const)('reads an exact cold baseline when status is %s', async (formatStatus) => {
    const { ctx, controller } = await harness()
    const handle = await ctx.sessionPersistence.create(header)
    try { await handle.flush() }
    finally { await handle.close() }
    const open = vi.spyOn(ctx.sessionPersistence, 'open')
    vi.spyOn(ctx.sessionPersistence, 'stat').mockResolvedValue({
      header, revision: stored.revision, ...(formatStatus === undefined ? {} : { formatStatus }),
    })

    expect(await controller.projections({ sessionId }, signal())).toMatchObject({
      kind: 'sequenced', asOfSeq: -1, values: { sessionListMetadata: { blank: true, lastPromptAt: null } },
    })
    expect(open).toHaveBeenCalledOnce()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('returns null for an absent header without observing a body', async () => {
    const { ctx, controller } = await harness()
    vi.spyOn(ctx.sessionPersistence, 'stat').mockResolvedValue(undefined)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    expect(await controller.projections({ sessionId }, signal())).toBeNull()
    expect(observe).not.toHaveBeenCalled()
  })

  it.for([false, true])('rechecks live state after a missing observation (attached: %s)', async (attached) => {
    const { ctx, controller } = await harness()
    vi.spyOn(ctx.sessionPersistence, 'stat').mockResolvedValue({ ...stored, formatStatus: 'current' })
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async () => {
      if (attached) ctx.sessions.create(sessionId, { meta: { cwd: '/project' } })
      throw new SessionQueryError('gone', 'SESSION_QUERY_SESSION_NOT_FOUND')
    })

    const result = await controller.projections({ sessionId }, signal())
    if (attached) expect(result).toMatchObject({ kind: 'sequenced', asOfSeq: -1 })
    else expect(result).toBeNull()
  })

  it('cancels before reading even an attached Session', async () => {
    const { ctx, controller } = await harness()
    ctx.sessions.create(sessionId, { meta: { cwd: '/project' } })
    const aborted = new AbortController()
    aborted.abort()
    await expect(controller.projections({ sessionId }, aborted.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
  })

  it('cancels a pending stat without returning cache hints or attached values', async () => {
    const { ctx, controller } = await harness()
    const pending = Promise.withResolvers<SessionPersistenceSnapshot>()
    vi.spyOn(ctx.sessionPersistence, 'stat').mockImplementation(() => pending.promise)
    const abort = new AbortController()
    const reading = controller.projections({ sessionId }, abort.signal)
    abort.abort()
    ctx.sessions.create(sessionId, { meta: { cwd: '/project' } })
    pending.resolve(stored)
    await expect(reading).rejects.toMatchObject({ code: 'gateway/cancelled' })
  })

  it('reports a failed stat instead of returning an empty baseline', async () => {
    const { ctx, controller } = await harness()
    vi.spyOn(ctx.sessionPersistence, 'stat').mockRejectedValue(new Error('disk failed'))
    await expect(controller.projections({ sessionId }, signal())).rejects.toMatchObject({ code: 'gateway/internal' })
  })
})
