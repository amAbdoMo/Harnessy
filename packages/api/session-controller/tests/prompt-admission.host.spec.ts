import { describe, expect, it } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import { promptAdmissionComposition } from './prompt-admission-composition.ts'

function checkCancellation(operation: AbortController): () => void {
  return () => {
    if (operation.signal.aborted) throw new RemoteError('gateway/cancelled', 'admission revoked', {})
  }
}

function request(
  fixture: Awaited<ReturnType<typeof promptAdmissionComposition>>,
  id: string,
  mode: SessionPromptRequest['mode'] = 'queue',
  image = false,
): SessionPromptRequest {
  return {
    sessionId: fixture.agent.id, requestId: brandString<SessionRequestId>(id), mode,
    content: image
      ? [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }]
      : [{ type: 'text', text: id }],
  }
}

async function expectNoAdmission(fixture: Awaited<ReturnType<typeof promptAdmissionComposition>>) {
  expect(fixture.agent.inbox.nextTurn).toEqual([])
  expect(fixture.agent.inbox.nextStep).toEqual([])
  expect(fixture.agent.session.snapshotEvents().filter(event =>
    event.type === 'agent/inbox/spliced' || event.type === 'user/message')).toEqual([])
  const abort = new AbortController()
  const iterator = fixture.control.control(abort.signal)[Symbol.asyncIterator]()
  try {
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'baseline', value: { projections: {
        [fixture.agent.id]: { values: { inbox: { 'next-turn': [], 'next-step': [] } } },
      } } },
    })
  } finally {
    abort.abort()
    await iterator.return?.()
  }
}

describe('prompt admission through source Loader composition', () => {
  it('denies cancellation while the live Agent resolver is still awaited', async () => {
    const fixture = await promptAdmissionComposition()
    const operation = new AbortController()
    const pending = fixture.prompt(request(fixture, 'cancel-resolve'), checkCancellation(operation))
    const denied = expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' })
    operation.abort()
    await denied
    await expectNoAdmission(fixture)
  })

  it.each(['model', 'storage'] as const)('denies revocation during %s admission without publishing inbox state', async (stage) => {
    const fixture = await promptAdmissionComposition()
    const barrier = fixture.barrier()
    if (stage === 'model') fixture.model.modelBarrier = barrier
    else fixture.storage.saveBarrier = barrier
    const operation = new AbortController()
    let authorized = true
    const check = checkCancellation(operation)
    const pending = fixture.prompt(request(fixture, `cancel-${stage}`, 'queue', true), () => {
      check()
      if (!authorized) throw new RemoteError('gateway/cancelled', 'authorization revoked', {})
    })
    const denied = expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' })
    await barrier.arrived
    if (stage === 'model') authorized = false
    else operation.abort()
    barrier.release()
    await denied
    expect(fixture.storage.saved).toBe(stage === 'storage')
    await expectNoAdmission(fixture)
  })

  it('denies a revoked request waiting behind another image admission', async () => {
    const fixture = await promptAdmissionComposition()
    const barrier = fixture.barrier()
    fixture.model.modelBarrier = barrier
    const first = new AbortController()
    const firstPending = fixture.prompt(request(fixture, 'first-image', 'queue', true), checkCancellation(first))
    const firstDenied = expect(firstPending).rejects.toMatchObject({ code: 'gateway/cancelled' })
    await barrier.arrived
    const second = new AbortController()
    const resolved = Promise.withResolvers<undefined>()
    let entered = false
    const secondCheck = checkCancellation(second)
    const secondPending = fixture.prompt(request(fixture, 'second-image', 'queue', true), () => {
      secondCheck()
      if (entered) resolved.resolve(undefined)
      entered = true
    })
    const secondDenied = expect(secondPending).rejects.toMatchObject({ code: 'gateway/cancelled' })
    // The post-resolver authorization returns synchronously into the occupied image lane.
    await resolved.promise
    second.abort()
    first.abort()
    barrier.release()
    await Promise.all([firstDenied, secondDenied])
    expect(fixture.storage.saved).toBe(false)
    await expectNoAdmission(fixture)
  })

  it.each(['queue', 'steer'] as const)('rechecks authorization immediately before %s and rolls back receipt binding', async (mode) => {
    const fixture = await promptAdmissionComposition()
    const receipt = await fixture.ctx.fileUploads.upload(
      fixture.agent, { data: 'AAAA', name: 'retained.txt' }, new AbortController().signal,
    )
    const operation = new AbortController()
    const check = checkCancellation(operation)
    const checkAdmission = () => {
      check()
      // Withdrawal immediately after the first post-storage authorization succeeds.
      if (fixture.storage.saved) operation.abort()
    }
    const prompt = {
      ...request(fixture, `final-${mode}`, mode, true),
      content: [
        { type: 'file' as const, receiptId: receipt.receiptId },
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA' },
      ],
    }
    await expect(fixture.prompt(prompt, checkAdmission)).rejects.toMatchObject({ code: 'gateway/cancelled' })
    await expectNoAdmission(fixture)
    fixture.ctx.fileUploads.retirePrompt(fixture.agent, prompt.requestId)
    expect(fixture.ctx.fileUploads.resolve(fixture.agent, receipt.receiptId)).toEqual({ type: 'file', attachment: receipt.file })
  })

  it.each(['entry', 'resolve'] as const)('denies a duplicate canceled at %s while retaining the admitted task', async (cancellationPoint) => {
    const fixture = await promptAdmissionComposition()
    const stream = fixture.barrier()
    fixture.model.streamBarrier = stream
    const accepted = request(fixture, 'accepted-once')
    await expect(fixture.prompt(accepted, checkCancellation(new AbortController())))
      .resolves.toEqual({ accepted: true })
    await stream.arrived
    const before = fixture.agent.session.snapshotEvents()
    const retry = new AbortController()
    if (cancellationPoint === 'entry') retry.abort()
    const pending = fixture.prompt(accepted, checkCancellation(retry))
    const denied = expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' })
    if (cancellationPoint === 'resolve') retry.abort()
    await denied
    expect(fixture.agent.session.snapshotEvents()).toEqual(before)
    stream.release()
    await fixture.agent.whenIdle()
    const messages = fixture.agent.session.deriveMessages()
    expect(messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(messages.at(-1)?.content).toEqual([{ type: 'text', text: 'completed' }])
  })

  it('keeps an admitted task running and persists its completed turn after the caller cancels', async () => {
    const fixture = await promptAdmissionComposition()
    const stream = fixture.barrier()
    fixture.model.streamBarrier = stream
    await fixture.prompt(request(fixture, 'active-task'), checkCancellation(new AbortController()))
    await stream.arrived
    const operation = new AbortController()
    const accepted = request(fixture, 'continue-after-admission')
    await expect(fixture.prompt(accepted, checkCancellation(operation))).resolves.toEqual({ accepted: true })
    const queued = fixture.agent.inbox.nextTurn
    expect(queued).toMatchObject([{ source: { kind: 'user', rpcId: accepted.requestId } }])
    operation.abort()
    expect(fixture.agent.inbox.nextTurn).toEqual(queued)
    stream.release()
    await fixture.agent.whenIdle()
    await fixture.ctx.sessions.flush(fixture.agent.session)
    await using stored = await fixture.ctx.sessionPersistence.open(fixture.agent.id, 'read')
    const { events } = await stored.read()
    expect(events.filter(event => event.type === 'user/message')).toMatchObject([
      { data: { source: { kind: 'user', rpcId: 'active-task' } } },
      { data: { source: { kind: 'user', rpcId: accepted.requestId } } },
    ])
    expect(events.filter(event => event.type === 'assistant/message')).toMatchObject([
      { data: { message: { content: [{ type: 'text', text: 'completed' }] } } },
      { data: { message: { content: [{ type: 'text', text: 'completed' }] } } },
    ])
    expect(events.at(-1)).toMatchObject({ type: 'turn/end' })
  })
})
