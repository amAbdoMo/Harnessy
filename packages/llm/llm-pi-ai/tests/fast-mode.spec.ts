/** Keyless command, durable fold, admission, and lifecycle regressions. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Commands, { CommandId, type CommandInvocation, type CommandResult } from '@deepseek-ai/dsh-commands'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as LlmPiAi from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

async function harness(options: { providers?: LlmPiAi.Options['providers']; projection?: boolean } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Commands)
  if (options.projection !== false) await ctx.plugin(Projections)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Tools, {})
  await ctx.plugin(AgentRegistry)
  const loop = ctx.plugin(AgentLoop, { agents: [] })
  if (options.projection !== false) await loop
  const plugin = await ctx.plugin(LlmPiAi, { providers: options.providers ?? { 'openai-codex': {} } })
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session.id === 'fast-chat') events.push(event) })
  return { ctx, plugin, events }
}

async function createAgent(ctx: Context, id = 'fast-chat') {
  return ctx.agents.create({ sessionId: SessionId(id) })
}

async function run(ctx: Context, agent: Awaited<ReturnType<typeof createAgent>>['agent'], line: string) {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error('fast command is unavailable')
  return execution.result
}

function invocation(agent: Awaited<ReturnType<typeof createAgent>>['agent'], signal = new AbortController().signal): CommandInvocation {
  return { agent, signal, commandId: CommandId('direct-fast'), rawInput: ' on', attachments: [] }
}

function fastEvents(events: readonly SessionEvent[]) {
  return events.filter(event => event.type === 'llm-pi-ai/fast-mode')
}

describe('current-chat /fast', () => {
  it.each([
    ['/fast', true], ['/fast on', true], ['/fast\t on \n', true], ['/fast off', false],
  ])('applies %j as an ignorable log-only preference without changing history', async (line, enabled) => {
    const { ctx, events } = await harness()
    const { agent } = await createAgent(ctx)
    const before = agent.session.surface.contentGeneration
    const outcome = await run(ctx, agent, line)
    expect(outcome.kind).toBe('success')
    expect(outcome.text).toContain(enabled ? 'enabled' : 'disabled')
    expect(outcome.text).toContain('this chat only')
    expect(outcome.text).toContain('Codex')
    expect(outcome.text).toMatch(/usage/i)
    expect(ctx.sessionProjections.stateOf(agent.session, 'codexFastMode')).toBe(enabled)
    expect(fastEvents(events)).toEqual([expect.objectContaining({
      type: 'llm-pi-ai/fast-mode', data: { enabled }, ignorable: true,
    })])
    expect(fastEvents(events)[0]).not.toHaveProperty('surfaceOp')
    expect(agent.session.deriveMessages()).toEqual([])
    expect(agent.session.surface.contentGeneration).toBe(before)
    expect(ctx.sessionProjections.snapshot(agent.session).values).toHaveProperty('codexFastMode', enabled)
  })

  it.each([{}, { enabled: 'true' }, { enabled: 0 }, { enabled: null }, null])('rejects malformed durable fast-mode data %j', async (data) => {
    const { ctx } = await harness()
    const seed: SessionEvent[] = JSON.parse(JSON.stringify([
      { type: 'llm-pi-ai/fast-mode', data, seq: 0, time: 0, ignorable: true },
    ]))
    expect(() => ctx.sessionProjections.stateOf(Session.create(SessionId('malformed-mode'), seed), 'codexFastMode')).toThrow()
  })

  it('inherits the recorded choice in a fork without sharing subsequent changes', async () => {
    const { ctx } = await harness()
    const { agent } = await createAgent(ctx)
    await run(ctx, agent, '/fast on')
    const child = ctx.sessions.fork(agent.session, undefined, SessionId('forked-fast-chat'))
    expect(ctx.sessionProjections.stateOf(child, 'codexFastMode')).toBe(true)
    await run(ctx, agent, '/fast off')
    expect(ctx.sessionProjections.stateOf(agent.session, 'codexFastMode')).toBe(false)
    expect(ctx.sessionProjections.stateOf(child, 'codexFastMode')).toBe(true)
  })

  it('waits for the durability checkpoint before publishing command success', async () => {
    const { ctx, events } = await harness()
    const { agent } = await createAgent(ctx)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('session/flush', () => { entered.resolve(undefined); return release.promise })
    const pending = run(ctx, agent, '/fast on')
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => { throw new Error('command settled without entering the checkpoint') }),
      ])
      expect(events.filter(event => event.type === 'command/done')).toEqual([])
      expect(ctx.sessionProjections.stateOf(agent.session, 'codexFastMode')).toBe(true)
    } finally {
      release.resolve(undefined)
      await pending
    }
    expect(events.filter(event => event.type === 'command/done')).toMatchObject([{ data: { kind: 'success' } }])
  })

  it('reports persistence failure without undoing an already appended choice', async () => {
    const { ctx, events } = await harness()
    const { agent } = await createAgent(ctx)
    ctx.on('session/flush', () => { throw new Error('checkpoint rejected') })
    await expect(ctx.commands.find(agent, 'fast')!.handler(invocation(agent))).rejects.toThrow('checkpoint rejected')
    expect(fastEvents(events)).toMatchObject([{ data: { enabled: true }, ignorable: true }])
    expect(ctx.sessionProjections.stateOf(agent.session, 'codexFastMode')).toBe(true)
    expect(await run(ctx, agent, '/fast status')).toMatchObject({ kind: 'success' })
  })

  it('toggles each chat independently and reconstructs enabled and disabled preferences from JSON events', async () => {
    const { ctx, events } = await harness()
    const { agent } = await createAgent(ctx)
    const other = await createAgent(ctx, 'another-chat')
    expect(ctx.sessionProjections.stateOf(agent.session, 'codexFastMode')).toBe(false)
    expect(ctx.sessionProjections.stateOf(other.agent.session, 'codexFastMode')).toBe(false)
    await run(ctx, agent, '/fast')
    const enabledSeed: SessionEvent[] = JSON.parse(JSON.stringify(events))
    const reopened = Session.create(agent.id, enabledSeed, agent.session.header)
    expect(ctx.sessionProjections.stateOf(reopened, 'codexFastMode')).toBe(true)
    expect(ctx.sessionProjections.snapshot(reopened).values).toHaveProperty('codexFastMode', true)
    expect(ctx.sessionProjections.stateOf(other.agent.session, 'codexFastMode')).toBe(false)
    expect(ctx.sessionProjections.snapshot(other.agent.session).values).toHaveProperty('codexFastMode', false)
    await run(ctx, agent, '/fast')
    const disabledSeed: SessionEvent[] = JSON.parse(JSON.stringify(events))
    expect(ctx.sessionProjections.stateOf(Session.create(agent.id, disabledSeed, agent.session.header), 'codexFastMode')).toBe(false)
    expect(fastEvents(events).map(event => event.data.enabled)).toEqual([true, false])
    expect(ctx.sessionProjections.stateOf(reopened, 'codexFastMode')).toBe(true)
    expect(ctx.sessionProjections.stateOf(Session.create(SessionId('legacy-chat')), 'codexFastMode')).toBe(false)
  })

  it.each(['status', 'ON', 'on off', 'enabled', 'status extra'])('reads or refuses %j without a fast event', async (argument) => {
    const { ctx, events } = await harness()
    const { agent } = await createAgent(ctx)
    await run(ctx, agent, '/fast on')
    const count = fastEvents(events).length
    const outcome = await run(ctx, agent, `/fast ${argument}`)
    expect(outcome.kind).toBe(argument === 'status' ? 'success' : 'error')
    expect(fastEvents(events)).toHaveLength(count)
    expect(ctx.sessionProjections.stateOf(agent.session, 'codexFastMode')).toBe(true)
  })

  it.each([
    {},
    { deepseek: {} },
    { 'openai-codex': { api: 'openai-completions', models: [{ id: 'plain' }] } },
  ])('denies a direct handler with no serviceable Codex protocol: %j', async (providers) => {
    const { ctx, events } = await harness({ providers })
    const { agent } = await createAgent(ctx)
    const command = ctx.commands.find(agent, 'fast')!
    const outcome = await command.handler(invocation(agent))
    expect(outcome).toMatchObject({ kind: 'error', text: expect.stringContaining('no serviceable Codex protocol') })
    expect(fastEvents(events)).toEqual([])
    expect(ctx.sessionProjections.stateOf(agent.session, 'codexFastMode')).toBe(false)
  })

  it('keeps valid catalog models serviceable alongside an invalid stored model override', async () => {
    const { ctx } = await harness({ providers: { 'openai-codex': { models: [{ id: 'unserviceable-model' }] } } })
    const { agent } = await createAgent(ctx)
    expect(await run(ctx, agent, '/fast on')).toMatchObject({ kind: 'success' })
    expect(ctx.sessionProjections.stateOf(agent.session, 'codexFastMode')).toBe(true)
  })

  it('rechecks live protocols at operation time rather than relying on menu discovery', async () => {
    const { ctx, plugin, events } = await harness({ providers: {} })
    await plugin.dispose()
    const configured = await liveConfig(ctx, LlmPiAi, { providers: { 'openai-codex': {} } })
    const { agent } = await createAgent(ctx)
    expect(ctx.commands.find(agent, 'fast')).toBeDefined()
    await configured.replace({ providers: { 'openai-codex': { api: 'openai-completions', models: [{ id: 'plain' }] } } })
    expect(await run(ctx, agent, '/fast on')).toMatchObject({ kind: 'error' })
    expect(fastEvents(events)).toEqual([])
  })

  it('refuses cancellation during command admission and a bypassed cancelled handler', async () => {
    const { ctx, events } = await harness()
    const { agent } = await createAgent(ctx)
    const controller = new AbortController()
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'command/run') controller.abort(new Error('cancelled before mutation'))
    })
    await expect(ctx.commands.execute(agent, '/fast on', [], controller.signal)).rejects.toThrow('cancelled before mutation')
    const outcome = await ctx.commands.find(agent, 'fast')!.handler(invocation(agent, controller.signal))
    expect(outcome).toMatchObject({ kind: 'error', text: expect.stringContaining('cancelled') })
    expect(fastEvents(events)).toEqual([])
    expect(ctx.sessionProjections.stateOf(agent.session, 'codexFastMode')).toBe(false)
  })

  it('denies a detached receiving chat without changing its preference', async () => {
    const { ctx, events } = await harness()
    const handle = await createAgent(ctx)
    await handle.dispose()
    expect(await run(ctx, handle.agent, '/fast on')).toMatchObject({ kind: 'error', text: expect.stringContaining('not live') })
    expect(fastEvents(events)).toEqual([])
  })

  it('publishes no enabled echo when the authoritative append rejects', async () => {
    const { ctx, events } = await harness()
    const { agent } = await createAgent(ctx)
    const command = ctx.commands.find(agent, 'fast')!
    let mutation: Promise<CommandResult> | undefined
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'session/end-seed') mutation = Promise.resolve(command.handler(invocation(agent)))
    })
    agent.session.append('session/end-seed', {})
    if (mutation === undefined) throw new Error('the append observer did not invoke the command')
    await expect(mutation).rejects.toThrow('cannot reenter')
    expect(fastEvents(events)).toEqual([])
    expect(ctx.sessionProjections.stateOf(agent.session, 'codexFastMode')).toBe(false)
  })

  it('withdraws command and projection when their plugin unloads and refuses a stale handler', async () => {
    const { ctx, plugin, events } = await harness()
    const { agent } = await createAgent(ctx)
    const command = ctx.commands.find(agent, 'fast')!
    expect(command.definitionId).toBe('@deepseek-ai/dsh-llm-pi-ai/fast')
    expect(command.input).toEqual({ hint: '[on | off | status]' })
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'fast')).toBeUndefined()
    expect(ctx.sessionProjections.stateOf(agent.session, 'codexFastMode')).toBeUndefined()
    await expect(command.handler(invocation(agent))).rejects.toThrow()
    expect(fastEvents(events)).toEqual([])
  })

  it('offers no command until the optional projection service is live, then removes it with that service', async () => {
    const { ctx } = await harness({ projection: false })
    expect(ctx.get('sessionProjections')).toBeUndefined()
    const projection = await ctx.plugin(Projections)
    await ctx.fiber.await()
    const { agent } = await createAgent(ctx)
    expect(ctx.commands.find(agent, 'fast')).toBeDefined()
    await projection.dispose()
    expect(ctx.commands.find(agent, 'fast')).toBeUndefined()
  })
})
