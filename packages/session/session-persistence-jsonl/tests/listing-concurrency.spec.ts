/** Filesystem barriers pin shared listing bounds and traversal-ordered failures. */
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scheduler } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generationLogPath } from '../src/format.ts'
import { meta as sessionMeta } from '../../session-persistence/tests/contract.ts'

type ListingRead = 'directory' | 'header' | 'stat'
const probe = vi.hoisted(() => ({
  active: false,
  inFlight: 0,
  maxInFlight: 0,
  wholeFileReads: 0,
  kinds: new Set<ListingRead>(),
  failures: new Map<string, Error>(),
  beforeRead: undefined as ((kind: ListingRead, path: string) => Promise<void>) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  async function observe<T>(kind: ListingRead, path: string, read: () => Promise<T>): Promise<T> {
    if (!probe.active) return read()
    probe.inFlight += 1
    probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight)
    probe.kinds.add(kind)
    try {
      await probe.beforeRead?.(kind, path)
      const failure = probe.failures.get(`${kind}:${path}`)
      if (failure !== undefined) throw failure
      return await read()
    } finally {
      probe.inFlight -= 1
    }
  }
  return {
    ...actual,
    readdir: ((...args: Parameters<typeof actual.readdir>) =>
      observe('directory', String(args[0]), () => actual.readdir(...args))) as typeof actual.readdir,
    stat: ((...args: Parameters<typeof actual.stat>) =>
      observe('stat', String(args[0]), () => actual.stat(...args))) as typeof actual.stat,
    open: (...args: Parameters<typeof actual.open>) =>
      observe('header', String(args[0]), () => actual.open(...args)),
    readFile: ((...args: Parameters<typeof actual.readFile>) => {
      if (probe.active) probe.wholeFileReads += 1
      return actual.readFile(...args)
    }) as typeof actual.readFile,
  }
})

describe('JSONL shared listing concurrency', () => {
  let root: string
  let ctx: Context
  let unblock: (() => void) | undefined
  const pending: Promise<unknown>[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-listing-'))
    ctx = new Context()
    await ctx.plugin(JsonlPersistence, { root, compression: 'none', listConcurrency: 2 })
  })

  afterEach(async () => {
    unblock?.()
    unblock = undefined
    await Promise.allSettled(pending.splice(0))
    probe.active = false
    probe.beforeRead = undefined
    probe.failures.clear()
    probe.kinds.clear()
    probe.inFlight = 0
    probe.maxInFlight = 0
    probe.wholeFileReads = 0
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  async function seed(cwd: string, ids: readonly string[], version = SESSION_FORMAT_VERSION): Promise<string[]> {
    const paths: string[] = []
    for (const id of ids) {
      const header = { type: 'session', ...sessionMeta(id, cwd), version, delegationDepth: 0 }
      const path = generationLogPath(root, cwd, SessionId(id), version, 'none')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(header) + '\n')
      paths.push(path)
    }
    return paths
  }

  async function directoriesOf(path: string): Promise<string[]> {
    return (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => join(path, entry.name))
  }

  it('admits only positive integer listing limits and defaults to three', () => {
    expect(JsonlPersistence.Config({ root }).listConcurrency).toBe(3)
    expect(JsonlPersistence.Config({ root, listConcurrency: 1 }).listConcurrency).toBe(1)
    for (const listConcurrency of [0, -1, 1.5]) {
      expect(() => JsonlPersistence.Config({ root, listConcurrency })).toThrow()
    }
  })

  it.each(['directory', 'header', 'stat'] as const)('shares the bound across two overlapping lists during %s reads', async (kind) => {
    await seed('/work-a', ['bound-a1', 'bound-a2', 'bound-a3'], 3)
    await seed('/work-b', ['bound-b1', 'bound-b2', 'bound-b3'])
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    unblock = () => { release.resolve(undefined) }
    let paused = 0
    probe.beforeRead = async (readKind, path) => {
      // Root encoding discovery has one shared root read before it can fan out.
      if (readKind !== kind || path === root) return
      paused += 1
      if (paused === 2) entered.resolve(undefined)
      await release.promise
    }
    probe.active = true
    const completed = Promise.allSettled([ctx.sessionPersistence.list(), ctx.sessionPersistence.list()])
    pending.push(completed)
    try {
      await Promise.race([
        entered.promise,
        completed.then(() => { throw new Error('Listing completed without two overlapping reads') }),
      ])
      await scheduler.yield()
      expect(probe.inFlight).toBe(2)
      expect(probe.maxInFlight).toBe(2)
    } finally {
      release.resolve(undefined)
      await completed
    }
    const outcomes = await completed
    expect(probe.inFlight).toBe(0)
    expect(probe.maxInFlight).toBe(2)
    expect(probe.kinds).toEqual(new Set(['directory', 'header', 'stat']))
    expect(probe.wholeFileReads).toBe(0)
    const listings = outcomes.map((outcome) => {
      if (outcome.status === 'rejected') throw outcome.reason
      return outcome.value
    })
    expect(listings[1]).toEqual(listings[0])
    for (const listing of listings) {
      expect(listing.map(snapshot => snapshot.header.id).sort()).toEqual([
        'bound-a1', 'bound-a2', 'bound-a3', 'bound-b1', 'bound-b2', 'bound-b3',
      ])
      expect(listing.filter(snapshot => snapshot.formatStatus === 'migration-required')).toHaveLength(3)
    }
  })

  it('reports earlier Session directory failures before later project failures', async () => {
    await seed('/work-a', ['order-a1', 'order-a2'])
    await seed('/work-b', ['order-b1', 'order-b2'])
    await ctx.sessionPersistence.list()
    const [earlierProject, laterProject] = await directoriesOf(root)
    if (earlierProject === undefined || laterProject === undefined) throw new Error('Expected two projects')
    const [earlierSession, laterSession] = await directoriesOf(earlierProject)
    if (earlierSession === undefined || laterSession === undefined) throw new Error('Expected two Sessions')
    const projectFailure = Object.assign(new Error('later project denied'), { code: 'EACCES' })
    const laterSessionFailure = Object.assign(new Error('later Session denied'), { code: 'EACCES' })
    const earlierSessionFailure = Object.assign(new Error('earlier Session denied'), { code: 'EACCES' })
    probe.active = true
    probe.failures.set(`directory:${laterProject}`, projectFailure)
    await expect(ctx.sessionPersistence.list()).rejects.toBe(projectFailure)
    probe.failures.set(`directory:${laterSession}`, laterSessionFailure)
    await expect(ctx.sessionPersistence.list()).rejects.toBe(laterSessionFailure)
    probe.failures.set(`directory:${earlierSession}`, earlierSessionFailure)
    await expect(ctx.sessionPersistence.list()).rejects.toBe(earlierSessionFailure)
  })

  it.each(['header', 'stat'] as const)('reports the first traversal %s failure even when a later failure settles first', async (kind) => {
    await seed('/work', ['failure-a', 'failure-b'])
    const order = await ctx.sessionPersistence.list()
    const paths = order.map(snapshot => generationLogPath(root, snapshot.header.cwd, snapshot.header.id, SESSION_FORMAT_VERSION, 'none'))
    const [earlier, later] = paths
    if (earlier === undefined || later === undefined) throw new Error('Expected two stored Sessions')
    const laterEntered = Promise.withResolvers<undefined>()
    unblock = () => { laterEntered.resolve(undefined) }
    const firstFailure = Object.assign(new Error('earlier denied'), { code: 'EACCES' })
    const laterFailure = Object.assign(new Error('later denied'), { code: 'EACCES' })
    probe.failures.set(`${kind}:${earlier}`, firstFailure)
    probe.failures.set(`${kind}:${later}`, laterFailure)
    probe.beforeRead = async (readKind, path) => {
      if (readKind !== kind) return
      if (path === earlier) await laterEntered.promise
      if (path === later) laterEntered.resolve(undefined)
    }
    probe.active = true
    const listing = ctx.sessionPersistence.list()
    pending.push(listing)
    try {
      await expect(listing).rejects.toBe(firstFailure)
    } finally {
      laterEntered.resolve(undefined)
    }
    expect(probe.inFlight).toBe(0)
  })

  it('lists a historical fixture from its header without reading or migrating its body', async () => {
    const fixture = fileURLToPath(new URL('../../../../snapshots/session/fs-read/session.v3.jsonl', import.meta.url))
    const fixtureBytes = await readFile(fixture)
    // Instantiate the snapshot's directory token only in the private temporary corpus.
    const source = Buffer.from(fixtureBytes.toString('utf8').replaceAll('{{cwd}}', '/work'))
    const id = SessionId('{{session:1}}')
    const path = generationLogPath(root, '/work', id, 3, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, source)
    const beforeEntries = await readdir(dirname(path))
    probe.active = true
    const [first, second] = await Promise.all([ctx.sessionPersistence.list(), ctx.sessionPersistence.list()])
    expect(first).toEqual(second)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      header: { id, version: SESSION_FORMAT_VERSION, cwd: '/work' },
      formatStatus: 'migration-required', sizeBytes: source.length,
    })
    expect(first[0]?.revision).toBeDefined()
    expect(probe.wholeFileReads).toBe(0)
    expect(probe.maxInFlight).toBeLessThanOrEqual(2)
    probe.active = false
    expect(await readdir(dirname(path))).toEqual(beforeEntries)
    expect(await readFile(path)).toEqual(source)
    expect(await readFile(fixture)).toEqual(fixtureBytes)
  })
})
