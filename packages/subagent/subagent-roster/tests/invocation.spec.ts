/**
 * Who may start a role, and under what authority: the `automatic`, `ask-first`,
 * and `manual` invocation policies, each enforced at the router rather than
 * suggested to the model.
 */

import { describe, expect, it } from 'vitest'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { delegationAuthorityWindow } from '../src/authority.ts'
import {
  bootRoster,
  closeTurn,
  delegate,
  definition,
  documentOf,
  openTurn,
  stubAgent,
  text,
} from './harness.ts'

/** One definition per policy, all on the shipped backend. */
function policies() {
  return documentOf([
    definition({ id: 'auto', invocation: 'automatic' }),
    definition({ id: 'asked', invocation: 'ask-first' }),
    definition({ id: 'human', invocation: 'manual' }),
  ])
}

/** Answer every approval question with one fixed outcome. */
function answer(
  roster: Awaited<ReturnType<typeof bootRoster>>,
  outcome: ApprovalOutcome | (() => ApprovalOutcome),
): void {
  roster.ctx.on('approval/request', () =>
    Promise.resolve(typeof outcome === 'function' ? outcome() : outcome))
}

describe('automatic invocation', () => {
  it('starts directly, with no approval service and no human input', async () => {
    const roster = await bootRoster({ settings: policies() })
    const parent = stubAgent(roster.ctx, 'parent')
    roster.ctx.agents.register(parent.agent)
    const result = await delegate(roster, { subagent: 'auto', task: 'Work.' }, parent.agent)
    expect(result.isError).toBe(false)
    expect(roster.requests).toHaveLength(1)
    await roster.dispose()
  })
})

describe('manual invocation', () => {
  it('refuses a call made outside an open turn', async () => {
    const roster = await bootRoster({ settings: policies() })
    const parent = stubAgent(roster.ctx, 'parent')
    roster.ctx.agents.register(parent.agent)
    const result = await delegate(roster, { subagent: 'human', task: 'Work.' }, parent.agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('delegate requires an open model turn')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })

  it('refuses a turn a plugin opened rather than a human', async () => {
    const roster = await bootRoster({ settings: policies() })
    const parent = stubAgent(roster.ctx, 'parent')
    roster.ctx.agents.register(parent.agent)
    openTurn(parent, { kind: 'plugin', plugin: 'test' }, 'scheduled work')
    const result = await delegate(roster, { subagent: 'human', task: 'Work.' }, parent.agent)
    expect(result.isError).toBe(true)
    expect(text(result))
      .toContain('this subagent may only be started from a direct human turn on a top-level agent')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })

  it('accepts a turn the human opened on the root agent', async () => {
    const roster = await bootRoster({ settings: policies() })
    const parent = stubAgent(roster.ctx, 'parent')
    roster.ctx.agents.register(parent.agent)
    const turn = openTurn(parent, { kind: 'user' }, 'please delegate this')
    const accepted = await delegate(roster, { subagent: 'human', task: 'Work.' }, parent.agent)
    expect(accepted.isError).toBe(false)
    expect(roster.requests).toHaveLength(1)

    // The authority is the OPEN turn: once it ends, the same agent is refused.
    closeTurn(parent, turn)
    const after = await delegate(roster, { subagent: 'human', task: 'More.' }, parent.agent)
    expect(after.isError).toBe(true)
    expect(roster.requests).toHaveLength(1)
    await roster.dispose()
  })

  it('refuses a child agent even when its own turn came from the human', async () => {
    const roster = await bootRoster({ settings: policies() })
    const root = stubAgent(roster.ctx, 'root')
    roster.ctx.agents.register(root.agent)
    const child = stubAgent(roster.ctx, 'child')
    roster.ctx.agents.enter(child.agent, root.agent)
    roster.ctx.agents.announce(child.agent)
    openTurn(child, { kind: 'user' }, 'delegated prompt')
    const result = await delegate(roster, { subagent: 'human', task: 'Work.' }, child.agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('direct human turn on a top-level agent')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })
})

describe('ask-first invocation', () => {
  it('starts only after a one-shot grant', async () => {
    const roster = await bootRoster({ settings: policies(), approval: true })
    answer(roster, 'allowed-once')
    const parent = stubAgent(roster.ctx, 'parent')
    roster.ctx.agents.register(parent.agent)
    openTurn(parent, { kind: 'user' })
    const result = await delegate(roster, { subagent: 'asked', task: 'Work.' }, parent.agent)
    expect(result.isError).toBe(false)
    expect(roster.requests).toHaveLength(1)
    await roster.dispose()
  })

  it.each<ApprovalOutcome>(['rejected', 'unavailable', 'cancelled'])(
    'refuses the start when the outcome is %s',
    async (outcome) => {
      const roster = await bootRoster({ settings: policies(), approval: true })
      answer(roster, outcome)
      const parent = stubAgent(roster.ctx, 'parent')
      roster.ctx.agents.register(parent.agent)
      openTurn(parent, { kind: 'user' })
      const result = await delegate(roster, { subagent: 'asked', task: 'Work.' }, parent.agent)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain(`starting subagent "asked" was not approved (${outcome})`)
      expect(roster.requests).toHaveLength(0)
      await roster.dispose()
    },
  )

  it('fails closed when the answerer throws instead of answering', async () => {
    const roster = await bootRoster({ settings: policies(), approval: true })
    roster.ctx.on('approval/request', () => { throw new Error('the answerer crashed') })
    const parent = stubAgent(roster.ctx, 'parent')
    roster.ctx.agents.register(parent.agent)
    openTurn(parent, { kind: 'user' })
    const result = await delegate(roster, { subagent: 'asked', task: 'Work.' }, parent.agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('was not approved (unavailable)')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })

  it('asks for nothing when the request already outside an open turn', async () => {
    const roster = await bootRoster({ settings: policies(), approval: true })
    answer(roster, 'allowed-once')
    const parent = stubAgent(roster.ctx, 'parent')
    roster.ctx.agents.register(parent.agent)
    const result = await delegate(roster, { subagent: 'asked', task: 'Work.' }, parent.agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('outside an open turn')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })

  it('refuses to start without an approval channel rather than starting unasked', async () => {
    const roster = await bootRoster({ settings: policies() })
    const parent = stubAgent(roster.ctx, 'parent')
    roster.ctx.agents.register(parent.agent)
    openTurn(parent, { kind: 'user' })
    const result = await delegate(roster, { subagent: 'asked', task: 'Work.' }, parent.agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no approval service is composed')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })

  it('audits the question and the decision on the parent log', async () => {
    const roster = await bootRoster({ settings: policies(), approval: true })
    answer(roster, 'allowed-once')
    const parent = stubAgent(roster.ctx, 'parent')
    roster.ctx.agents.register(parent.agent)
    openTurn(parent, { kind: 'user' })
    await delegate(roster, { subagent: 'asked', task: 'Work.' }, parent.agent)
    const asked = parent.session.snapshotEvents().filter(event => event.type === 'approval/asked')
    const decided = parent.session.snapshotEvents().filter(event => event.type === 'approval/decided')
    expect(asked).toHaveLength(1)
    expect(decided).toHaveLength(1)
    await roster.dispose()
  })
})

describe('the calling-agent authority window', () => {
  it('refuses a call that reached it without a calling agent', async () => {
    const roster = await bootRoster({ settings: policies() })
    // The tool refuses an agentless call before it resolves a window, so this
    // guard is reachable through the exported helper alone.
    expect(() => delegationAuthorityWindow(roster.ctx, {} as never))
      .toThrow('delegate requires a calling agent (exec.agent was undefined)')
    await roster.dispose()
  })
})

describe('invocation ordering', () => {
  it('refuses an unknown role before asking anything of the approval channel', async () => {
    const roster = await bootRoster({ settings: policies(), approval: true })
    let consulted = false
    roster.ctx.on('approval/request', () => {
      consulted = true
      return Promise.resolve('allowed-once' as const)
    })
    const parent = stubAgent(roster.ctx, 'parent')
    roster.ctx.agents.register(parent.agent)
    openTurn(parent, { kind: 'user' })
    const result = await delegate(roster, { subagent: 'ghost', task: 'Work.' }, parent.agent)
    expect(result.isError).toBe(true)
    expect(consulted).toBe(false)
    await roster.dispose()
  })

  it('refuses a definition naming a backend nobody registered', async () => {
    const roster = await bootRoster({
      settings: documentOf([definition({ id: 'code', execution: { backend: 'missing', background: 'foreground' } })]),
    })
    const result = await delegate(roster, { subagent: 'code', task: 'Work.' }, parent(roster))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no subagent provider registered for "missing"')
    await roster.dispose()
  })

  it('refuses an invocation policy outside the closed vocabulary', async () => {
    // The closed union ends in `assertNever`, so a document that bypassed the
    // schema fails loud here instead of silently starting the child.
    const outOfVocabulary = definition({ id: 'code', invocation: 'always' as 'automatic' })
    const roster = await bootRoster({ settings: documentOf([outOfVocabulary]) })
    const result = await delegate(roster, { subagent: 'code', task: 'Work.' }, parent(roster))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('SubagentInvocationPolicy')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })
})

/** A registered root stub agent, for tests that need one inline. */
function parent(roster: Awaited<ReturnType<typeof bootRoster>>): Agent {
  const stub = stubAgent(roster.ctx, 'parent-inline')
  roster.ctx.agents.register(stub.agent)
  return stub.agent
}
