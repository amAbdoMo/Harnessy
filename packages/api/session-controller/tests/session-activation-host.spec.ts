import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { sessionActivationComposition } from './session-activation-host-fixture.ts'

const admitted = () => {}

describe('Host-owned activation of existing phone conversations', () => {
  it('opens two cold chats and changes only the chosen chat model without a Desktop follower or task', async () => {
    const f = await sessionActivationComposition()
    const a = await f.persist(SessionId('phone-cold-a'))
    const b = await f.persist(SessionId('phone-cold-b'))
    const originalA = await f.events(a)
    const originalB = await f.events(b)
    const defaults = f.ctx.agentDefaultModel.currentSelection()
    await f.controller.inspect(a)
    expect(f.ctx.agents.get(a)).toBeUndefined()
    const first = await f.controller.activateExistingAgent(a, { requireAdmission: admitted, onAdmitted: admitted })
    expect(f.ctx.agents.get(a)).toBe(first)
    expect(f.ctx.agents.get(b)).toBeUndefined()
    expect(first.inbox.nextStep).toHaveLength(0)
    expect(first.inbox.nextTurn).toHaveLength(0)
    expect((await f.events(a)).slice(0, originalA.length)).toEqual(originalA)
    expect(await f.events(b)).toEqual(originalB)
    await f.controller.selectModelForAgent(first, { provider: 'fixture', model: 'other-model' }, admitted)
    expect(f.controller.currentModelSelection(first)).toMatchObject({ provider: 'fixture', model: 'other-model' })
    const second = await f.controller.activateExistingAgent(b, { requireAdmission: admitted, onAdmitted: admitted })
    expect(f.ctx.agents.get(a)).toBe(first)
    expect(f.ctx.agents.get(b)).toBe(second)
    expect(f.controller.currentModelSelection(second)).toMatchObject({ provider: 'fixture', model: 'fixture-model' })
    expect(f.controller.currentModelSelection(first).model).toBe('other-model')
    expect(f.ctx.agentDefaultModel.currentSelection()).toEqual(defaults)
    expect(second.inbox.nextStep).toHaveLength(0)
    expect(second.inbox.nextTurn).toHaveLength(0)
  })

  it('returns an already-live chat without another admission or initialization', async () => {
    const f = await sessionActivationComposition()
    const id = await f.persist(SessionId('phone-live'))
    const first = await f.controller.activateExistingAgent(id, { requireAdmission: admitted, onAdmitted: admitted })
    const before = await f.events(id)
    const again = await f.controller.activateExistingAgent(id, { requireAdmission: admitted,
      onAdmitted: () => { throw new Error('an already-live chat must not be readmitted') } })
    expect(again).toBe(first)
    expect(await f.events(id)).toEqual(before)
  })

  it('refuses cancellation before admission and does not activate later', async () => {
    const f = await sessionActivationComposition()
    const id = await f.persist(SessionId('phone-cancelled'))
    const before = await f.events(id)
    const lifetime = new AbortController()
    const pending = f.controller.activateExistingAgent(id, { signal: lifetime.signal, requireAdmission: admitted,
      onAdmitted: () => { throw new Error('cancelled activation must not admit') } })
    lifetime.abort(new Error('phone left before admission'))
    await expect(pending).rejects.toThrow('phone left before admission')
    await f.disposeApi()
    expect(f.ctx.agents.get(id)).toBeUndefined()
    expect(await f.events(id)).toEqual(before)
  })

  it('refuses stale consent without obtaining writable ownership', async () => {
    const f = await sessionActivationComposition()
    const id = await f.persist(SessionId('phone-denied'))
    const before = await f.events(id)
    await expect(f.controller.activateExistingAgent(id, {
      requireAdmission: () => { throw new Error('activation consent withdrawn') }, onAdmitted: admitted,
    })).rejects.toThrow('activation consent withdrawn')
    expect(f.ctx.agents.get(id)).toBeUndefined()
    expect(await f.events(id)).toEqual(before)
  })

  it('rejects a simultaneous opening of the same identity while independent chats remain available', async () => {
    const f = await sessionActivationComposition()
    const a = await f.persist(SessionId('phone-race-a'))
    const b = await f.persist(SessionId('phone-race-b'))
    const first = f.controller.activateExistingAgent(a, { requireAdmission: admitted, onAdmitted: admitted })
    const duplicate = f.controller.activateExistingAgent(a, { requireAdmission: admitted, onAdmitted: admitted })
    await expect(duplicate).rejects.toMatchObject({ code: 'session/agent-busy' })
    const other = f.controller.activateExistingAgent(b, { requireAdmission: admitted, onAdmitted: admitted })
    const [agentA, agentB] = await Promise.all([first, other])
    expect(f.ctx.agents.get(a)).toBe(agentA)
    expect(f.ctx.agents.get(b)).toBe(agentB)
  })

  it('does not convert a missing identity into a new conversation', async () => {
    const f = await sessionActivationComposition()
    const id = SessionId('phone-does-not-exist')
    await expect(f.controller.activateExistingAgent(id, { requireAdmission: admitted, onAdmitted: admitted }))
      .rejects.toMatchObject({ code: 'session/not-found' })
    expect(f.ctx.agents.get(id)).toBeUndefined()
    await expect(f.controller.inspect(id)).rejects.toThrow()
  })

  it.each(['archived', 'subagent', 'without-cwd'] as const)('does not open an ineligible %s chat', async (kind) => {
    const f = await sessionActivationComposition()
    const id = SessionId(`phone-ineligible-${kind}`)
    await f.persist(id, kind === 'without-cwd' ? {} : kind === 'subagent'
      ? { cwd: f.root, origin: 'subagent', delegationDepth: 1 } : { cwd: f.root })
    if (kind === 'archived') await f.ctx.workspaceRegistry.archiveSession(id)
    const before = await f.events(id)
    await expect(f.controller.activateExistingAgent(id, { requireAdmission: admitted,
      onAdmitted: () => { throw new Error('an ineligible chat must not admit') } })).rejects.toThrow()
    expect(f.ctx.agents.get(id)).toBeUndefined()
    expect(await f.events(id)).toEqual(before)
  })

  it('retains admitted PC work when the phone loses its reply instead of reopening or disposing it', async () => {
    const f = await sessionActivationComposition()
    const id = await f.persist(SessionId('phone-reply-lost'))
    const lifetime = new AbortController()
    const opening = f.controller.activateExistingAgent(id, { signal: lifetime.signal, requireAdmission: admitted,
      onAdmitted: () => { lifetime.abort(new Error('reply lost after admission')) } })
    await expect(opening).rejects.toThrow('reply lost after admission')
    const settled = await f.controller.resolveAgent(id)
    if ('error' in settled) throw settled.error
    await f.ctx.sessions.flush(settled.agent.session)
    expect(f.ctx.agents.get(id)).toBe(settled.agent)
    expect(settled.agent.inbox.nextStep).toHaveLength(0)
    expect(settled.agent.inbox.nextTurn).toHaveLength(0)
  })
})
