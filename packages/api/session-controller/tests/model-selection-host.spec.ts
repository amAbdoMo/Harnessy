/**
 * Host-only Session-local model selection: the effective selection of one live
 * ordinary Agent, the model-only commit path with its final authorization
 * callback, the rejections for Agents that may not own a selection, and the
 * shared per-Agent admission queue.
 */

import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  BROKEN_MODEL,
  PLAIN_MODEL,
  REASONING_MODEL,
  modelSelectionComposition,
} from './model-selection-host-composition.ts'

describe('Host-only Session model selection', () => {
  it('reads the effective selection of a live ordinary Agent', async () => {
    const fixture = await modelSelectionComposition()
    expect(fixture.controller.currentModelSelection(fixture.agent))
      .toEqual({ provider: 'fixture', model: 'fixture-model' })

    await fixture.controller.selectModelForAgent(
      fixture.agent,
      { provider: 'fixture', model: REASONING_MODEL },
      () => {},
    )
    expect(fixture.controller.currentModelSelection(fixture.agent))
      .toEqual({ provider: 'fixture', model: REASONING_MODEL, reasoningEffort: 'high' })
  })

  it('commits a model-only choice without saving or changing the deployment default', async () => {
    const fixture = await modelSelectionComposition()
    const save = vi.spyOn(fixture.ctx.agentDefaultModel, 'saveSelection')

    const committed = await fixture.controller.selectModelForAgent(
      fixture.agent,
      { provider: 'fixture', model: REASONING_MODEL },
      () => {},
    )

    expect(committed.selected).toEqual({
      provider: 'fixture', model: REASONING_MODEL, reasoningEffort: 'high',
    })
    expect(committed.seq).toBe(0)
    expect(save).not.toHaveBeenCalled()
    expect(fixture.ctx.agentDefaultModel.currentSelection())
      .toEqual({ provider: 'fixture', model: 'fixture-model' })
    expect((await fixture.events()).filter(event => event.type === 'model/selection'))
      .toHaveLength(1)
  })

  it('uses the selected model and its default effort at the next real Agent request without changing PC defaults', async () => {
    const fixture = await modelSelectionComposition()
    await fixture.controller.selectModelForAgent(fixture.agent, { provider: 'fixture', model: REASONING_MODEL }, () => {})
    const stream = fixture.barrier()
    fixture.model.streamBarrier = stream
    fixture.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use the chosen model' }], source: { kind: 'user' } }))
    await stream.arrived
    expect(fixture.model.requests).toContainEqual({ provider: 'fixture', model: REASONING_MODEL, reasoningEffort: 'high' })
    expect(fixture.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'fixture', model: 'fixture-model' })
    stream.release()
    await fixture.agent.whenIdle()
  })

  it('normalizes the choice with the selected model effort and drops an effort that belonged to another model', async () => {
    const fixture = await modelSelectionComposition()

    const reasoning = await fixture.controller.selectModelForAgent(
      fixture.agent,
      { provider: 'fixture', model: REASONING_MODEL },
      () => {},
    )
    expect(reasoning.selected).toEqual({
      provider: 'fixture', model: REASONING_MODEL, reasoningEffort: 'high',
    })

    const plain = await fixture.controller.selectModelForAgent(
      fixture.agent,
      { provider: 'fixture', model: PLAIN_MODEL },
      () => {},
    )
    expect(plain.selected).toEqual({ provider: 'fixture', model: PLAIN_MODEL })
    expect(fixture.controller.currentModelSelection(fixture.agent))
      .toEqual({ provider: 'fixture', model: PLAIN_MODEL })
  })

  it('refuses a model the catalog does not advertise and a route that cannot be resolved', async () => {
    const fixture = await modelSelectionComposition()
    const before = (await fixture.events())

    await expect(fixture.controller.selectModelForAgent(
      fixture.agent,
      { provider: 'fixture', model: 'unlisted-model' },
      () => {},
    )).rejects.toMatchObject({ code: 'session/model-unavailable' })
    await expect(fixture.controller.selectModelForAgent(
      fixture.agent,
      { provider: 'fixture', model: BROKEN_MODEL },
      () => {},
    )).rejects.toMatchObject({
      code: 'session/model-unavailable',
      message: 'routing metadata offline',
    })
    expect((await fixture.events())).toEqual(before)
  })

  it('runs the final callback after the asynchronous waits and before the append', async () => {
    const fixture = await modelSelectionComposition()
    const barrier = fixture.barrier()
    fixture.model.resolveBarrier = barrier
    const observed: string[] = []

    const pending = fixture.controller.selectModelForAgent(
      fixture.agent,
      { provider: 'fixture', model: PLAIN_MODEL },
      () => {
        observed.push(fixture.agent.session.seq === 0 ? 'before-append' : 'after-append')
      },
    )
    await barrier.arrived
    expect(observed).toEqual([])

    barrier.release()
    await pending
    expect(observed).toEqual(['before-append'])
    expect((await fixture.events()).filter(event => event.type === 'model/selection'))
      .toHaveLength(1)
  })

  it('leaves no model event when the callback refuses the selection', async () => {
    const fixture = await modelSelectionComposition()
    const before = (await fixture.events())

    await expect(fixture.controller.selectModelForAgent(
      fixture.agent,
      { provider: 'fixture', model: PLAIN_MODEL },
      () => {
        throw new RemoteError('session/agent-busy', 'the Host refused the model grant', { reason: 'refused' })
      },
    )).rejects.toMatchObject({ code: 'session/agent-busy' })

    expect((await fixture.events())).toEqual(before)
    expect(fixture.controller.currentModelSelection(fixture.agent))
      .toEqual({ provider: 'fixture', model: 'fixture-model' })
  })

  it('refuses a running Agent', async () => {
    const fixture = await modelSelectionComposition()
    const barrier = fixture.barrier()
    fixture.model.streamBarrier = barrier
    fixture.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'work in progress' }],
      source: { kind: 'user' },
    }))
    await barrier.arrived
    expect(fixture.agent.status).toBe('running')

    await expect(fixture.controller.selectModelForAgent(
      fixture.agent,
      { provider: 'fixture', model: PLAIN_MODEL },
      () => {},
    )).rejects.toMatchObject({ code: 'session/agent-busy' })

    barrier.release()
    await fixture.agent.whenIdle()
  })

  it('refuses an idle Agent that holds queued work', async () => {
    const fixture = await modelSelectionComposition()
    fixture.agent.inject(createUserMessage({
      content: [{ type: 'text', text: 'queued context' }],
      source: { kind: 'user' },
    }))
    expect(fixture.agent.status).toBe('idle')
    expect(fixture.agent.inbox.nextStep).toHaveLength(1)

    await expect(fixture.controller.selectModelForAgent(
      fixture.agent,
      { provider: 'fixture', model: PLAIN_MODEL },
      () => {},
    )).rejects.toMatchObject({ code: 'session/agent-busy' })
  })

  it('refuses a runtime-owned child Agent', async () => {
    const fixture = await modelSelectionComposition()
    const { agent: child } = await fixture.ctx.agents.create({
      sessionId: SessionId('model-selection-child'),
      parentAgent: fixture.agent,
      meta: { cwd: fixture.cwd },
      agentOptions: { provider: 'fixture', model: 'fixture-model' },
    })

    await expect(fixture.controller.selectModelForAgent(
      child,
      { provider: 'fixture', model: PLAIN_MODEL },
      () => {},
    )).rejects.toMatchObject({ code: 'session/agent-busy' })
  })

  it('refuses an Agent whose Session was closed', async () => {
    const fixture = await modelSelectionComposition()
    await fixture.agentHandle.dispose()
    expect(fixture.ctx.agents.get(fixture.agent.id)).toBeUndefined()

    await expect(fixture.controller.selectModelForAgent(
      fixture.agent,
      { provider: 'fixture', model: PLAIN_MODEL },
      () => {},
    )).rejects.toMatchObject({ code: 'session/not-found' })
    expect(() => fixture.controller.currentModelSelection(fixture.agent))
      .toThrow(expect.objectContaining({ code: 'session/not-found' }))
  })

  it('refuses an Agent that a later Agent replaced', async () => {
    const fixture = await modelSelectionComposition()
    fixture.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'keep this conversation' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await fixture.ctx.sessions.flush(fixture.agent.session)
    await fixture.agentHandle.dispose()

    const { agent: replacement } = await fixture.ctx.agents.resume({
      resumeSessionId: fixture.agent.id,
      agentOptions: { provider: 'fixture', model: 'fixture-model' },
    })
    expect(fixture.ctx.agents.get(fixture.agent.id)).toBe(replacement)

    await expect(fixture.controller.selectModelForAgent(
      fixture.agent,
      { provider: 'fixture', model: PLAIN_MODEL },
      () => {},
    )).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('serializes a Host selection behind a Desktop selection on the same Agent queue', async () => {
    const fixture = await modelSelectionComposition()
    const save = vi.spyOn(fixture.ctx.agentDefaultModel, 'saveSelection')
    const barrier = fixture.barrier()
    fixture.model.resolveBarrier = barrier
    const observed: string[] = []

    const desktop = fixture.controller.selectModel({
      sessionId: fixture.agent.id,
      provider: 'fixture',
      model: REASONING_MODEL,
    })
    await barrier.arrived
    const host = fixture.controller.selectModelForAgent(
      fixture.agent,
      { provider: 'fixture', model: PLAIN_MODEL },
      () => {
        observed.push(fixture.controller.currentModelSelection(fixture.agent).model)
      },
    )
    barrier.release()
    await desktop
    await host

    expect(observed).toEqual([REASONING_MODEL])
    expect(save).toHaveBeenCalledExactlyOnceWith({
      provider: 'fixture', model: REASONING_MODEL, reasoningEffort: 'high',
    })
    const committed = (await fixture.events())
      .filter(event => event.type === 'model/selection')
      .map(event => event.data)
    expect(committed).toEqual([
      { provider: 'fixture', model: REASONING_MODEL, reasoningEffort: 'high' },
      { provider: 'fixture', model: PLAIN_MODEL },
    ])
  })
})
