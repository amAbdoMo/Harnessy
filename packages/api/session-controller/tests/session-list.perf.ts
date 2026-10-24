/** Manual warm Session-list serialization diagnostic over built Host services. */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'

const require = createRequire(resolve('packages/api/session-controller/package.json'))
const load = (name: string): Promise<object> => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis')
const { default: SessionStore, SessionId } = await load('@deepseek-ai/dsh-session') as typeof import('@deepseek-ai/dsh-session')
const { default: AgentRegistry } = await load('@deepseek-ai/dsh-agent') as typeof import('@deepseek-ai/dsh-agent')
const { default: ProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection') as typeof import('@deepseek-ai/dsh-session-projection')
const { default: QueryEngine } = await load('@deepseek-ai/dsh-session-query') as typeof import('@deepseek-ai/dsh-session-query')
const built = (path: string): Promise<object> => import(pathToFileURL(resolve(path)).href)
const outline = await built('packages/session/session-turn-outline/lib/index.js') as typeof import('@deepseek-ai/dsh-session-turn-outline')
const stats = await built('packages/session/session-stats/lib/index.js') as typeof import('@deepseek-ai/dsh-session-stats')
const { ApiSessionList } = await built('packages/api/session-controller/lib/types/list.js') as typeof import('../src/list.ts')

const count = Number(process.argv[2])
const turns = Number(process.argv[3])
if (!Number.isSafeInteger(count) || !Number.isSafeInteger(turns) || count < 1 || turns < 1) {
  throw new Error('Expected positive Session and turn counts')
}
const records: SessionRecord[] = []

/** Fixed metadata source isolates the list projection and serialization cost. */
class FixedCorpus extends QueryEngine {
  override listSessions(): Promise<SessionRecord[]> { return Promise.resolve(records) }
  override searchSessions(): Promise<never> { return Promise.reject(new Error('No search workload')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('No search workload')) }
}

const ctx = new Context()
try {
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ProjectionRegistry)
  await ctx.plugin(FixedCorpus)
  await ctx.plugin(outline)
  await ctx.plugin(stats)
  const list = new ApiSessionList(ctx, 16)
  for (let index = 0; index < count; index++) {
    const session = ctx.sessions.create(SessionId(`session-list-perf-${index}`), { meta: { cwd: '/synthetic-workspace' } })
    for (let turn = 1; turn <= turns; turn++) {
      session.append('turn/start', { turn })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    records.push({ header: session.header, formatStatus: 'current', live: true, persisted: false })
  }
  if (process.argv.includes('--full-projections')) {
    const first = records[0]
    const session = first === undefined ? undefined : ctx.sessions.get(first.header.id)
    if (session === undefined) throw new Error('Missing seeded Session')
    const allKeys = new Set(Object.keys(ctx.sessionProjections.snapshot(session).values))
    ctx.sessionProjections.summaryKeys = () => allKeys as ReturnType<typeof ctx.sessionProjections.summaryKeys>
  }
  for (let index = 0; index < 3; index++) JSON.stringify(await list.list())
  const samples: { ms: number; bytes: number }[] = []
  for (let index = 0; index < 7; index++) {
    global.gc?.()
    const start = performance.now()
    const rows = await list.list()
    const json = JSON.stringify(rows)
    const ms = performance.now() - start
    if (rows.length !== count || rows.some(row => row.blank)) throw new Error('Incorrect list output')
    samples.push({ ms, bytes: Buffer.byteLength(json) })
  }
  console.log(JSON.stringify({
    runtime: process.version, platform: process.platform, count, turns,
    endpoint: 'warm attached list plus JSON; excludes seed, corpus query, cold reads, browser and network',
    negativeControl: process.argv.includes('--full-projections'), samples,
    medianMs: samples.map(sample => sample.ms).sort((left, right) => left - right)[3],
  }, null, 2))
} finally {
  await ctx.fiber.dispose()
}
