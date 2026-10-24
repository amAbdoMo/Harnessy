/** Host-wide removal of every ended task shares per-row deletion's durability rules. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAfterScheduleRecord, ScheduleId } from '../src/domain.ts'
import { scheduleDomain, type ScheduleTask } from '../src/storage.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { gatedScheduleBackend, harness } from './harness.ts'

const tests: Awaited<ReturnType<typeof harness>>[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-16T00:00:00Z'))
})
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.useRealTimers()
})

/**
 * Build one ended task carrying one saved delivery.
 * @param sessionId - Session the task was created in.
 * @param id - stored task identity.
 * @param title - stored task name.
 * @returns the row a delivered one-shot leaves behind.
 */
function endedRow(sessionId: SessionId, id: string, title: string): ScheduleTask {
  const receipt = {
    scheduledAt: '2026-09-15T23:59:00.000Z',
    deliveredAt: '2026-09-15T23:59:01.000Z',
    messageId: MessageId(`${id}-delivery`),
  }
  return {
    sessionId,
    record: createAfterScheduleRecord(ScheduleId(id), title, 60, Date.now(), title),
    status: 'inactive',
    lastDelivery: receipt,
    deliveryHistory: { records: [receipt], earlierRecordsUnavailable: false },
  }
}

/**
 * Boot a service whose store already holds the given rows.
 * @param rows - task rows present before activation.
 * @returns the started harness with its storage pool.
 */
async function seeded(rows: readonly ScheduleTask[]) {
  const test = await harness({ beforeService: async (_ctx, facility) => {
    const domain = await facility.open(scheduleDomain)
    for (const row of rows) await domain.table('tasks').put(row.record.id, row)
    await domain.close()
  } })
  tests.push(test)
  return test
}

it('removes ended tasks across Sessions with their saved deliveries and keeps active ones', async () => {
  const firstSession = SessionId('ended-first')
  const secondSession = SessionId('ended-second')
  const armedSession = SessionId('still-armed')
  const endedFirst = endedRow(firstSession, 'ended-a', 'Ended first')
  const endedSecond = endedRow(secondSession, 'ended-b', 'Ended second')
  const armed = createAfterScheduleRecord(ScheduleId('armed'), 'Still armed', 3_600, Date.now(), 'Still armed')
  const test = await seeded([endedFirst, endedSecond, {
    sessionId: armedSession, record: armed, status: 'active',
  }])
  const { ctx, service, resolve } = test
  const changed = vi.fn()
  ctx.on('schedule/changed', changed)

  expect(await service.deleteInactive()).toEqual({ deleted: 2 })

  expect((await service.catalog()).map(entry => entry.title)).toEqual(['Still armed'])
  expect(await service.list({ sessionId: firstSession })).toEqual([])
  // The saved delivery records went with their rows, so history no longer resolves them.
  expect(await service.history({ sessionId: firstSession, id: endedFirst.record.id, limit: 20 }))
    .toEqual({ id: endedFirst.record.id, code: 'schedule_not_found' })
  expect(await service.history({ sessionId: secondSession, id: endedSecond.record.id, limit: 20 }))
    .toEqual({ id: endedSecond.record.id, code: 'schedule_not_found' })
  expect(changed).toHaveBeenCalledTimes(1)
  expect(resolve).not.toHaveBeenCalled()
  expect(ctx.agents.roots()).toEqual([])
})

it('reports zero and announces nothing when the Host holds no ended task', async () => {
  const sessionId = SessionId('only-active')
  const test = await seeded([{
    sessionId,
    record: createAfterScheduleRecord(ScheduleId('armed'), 'Still armed', 3_600, Date.now(), 'Still armed'),
    status: 'active',
  }])
  const { ctx, service } = test
  const changed = vi.fn()
  ctx.on('schedule/changed', changed)

  expect(await service.deleteInactive()).toEqual({ deleted: 0 })
  expect(changed).not.toHaveBeenCalled()
  expect(await service.catalog()).toHaveLength(1)
})

it('keeps the removals that landed, announces them, and reports the failure', async () => {
  const pool = new MemoryMediaPool()
  let deletes = 0
  // The first ended row lands durably; the second row's physical delete rejects.
  const backend = gatedScheduleBackend(pool, {
    deleteRecord: async (table) => {
      if (table !== 'tasks') return
      deletes += 1
      if (deletes === 2) throw new Error('injected delete failure')
    },
  })
  const test = await harness({
    pool,
    backend,
    beforeService: async (_ctx, facility) => {
      const domain = await facility.open(scheduleDomain)
      await domain.table('tasks').put(ScheduleId('ended-a'), endedRow(SessionId('partial-a'), 'ended-a', 'Partial first'))
      await domain.table('tasks').put(ScheduleId('ended-b'), endedRow(SessionId('partial-b'), 'ended-b', 'Partial second'))
      await domain.close()
    },
  })
  tests.push(test)
  const { ctx, service } = test
  const changed = vi.fn()
  ctx.on('schedule/changed', changed)

  const failure = await service.deleteInactive().then(() => undefined, (error: unknown) => error)

  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).toContain('injected delete failure')
  // The row removed before the failure is a durable change observers must hear.
  expect(changed).toHaveBeenCalledTimes(1)
  expect((await service.catalog()).map(entry => entry.title)).toEqual(['Partial second'])
})

it('attempts every row and reports a rejection reason that carries no Error', async () => {
  const pool = new MemoryMediaPool()
  let deletes = 0
  const backend = gatedScheduleBackend(pool, {
    deleteRecord: async (table) => {
      if (table !== 'tasks') return
      deletes += 1
      throw undefined
    },
  })
  const test = await harness({
    pool,
    backend,
    beforeService: async (_ctx, facility) => {
      const domain = await facility.open(scheduleDomain)
      await domain.table('tasks').put(ScheduleId('ended-a'), endedRow(SessionId('unreportable-a'), 'ended-a', 'Unreportable first'))
      await domain.table('tasks').put(ScheduleId('ended-b'), endedRow(SessionId('unreportable-b'), 'ended-b', 'Unreportable second'))
      await domain.close()
    },
  })
  tests.push(test)
  const { ctx, service } = test
  const changed = vi.fn()
  ctx.on('schedule/changed', changed)

  const failure = await service.deleteInactive().then(() => undefined, (error: unknown) => error)

  // A reason that carries no Error must not read as a successful removal.
  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).toContain('schedule ended-task removal failed')
  expect(deletes).toBe(2)
  expect(changed).not.toHaveBeenCalled()
  expect((await service.catalog()).map(entry => entry.title).sort())
    .toEqual(['Unreportable first', 'Unreportable second'])
})
