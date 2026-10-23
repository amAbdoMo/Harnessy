/** Opaque phone model offers through real Loader, Agent, Session Controller and JSONL persistence. */
import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { createUserMessage, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { encodeApplicationResult, parseApplicationRequest, parseApplicationResult, parseId } from '@deepseek-ai/dsh-companion-protocol'
import type { ApplicationBudget, GrantId, SessionModelsResult } from '@deepseek-ai/dsh-companion-protocol'
import { createApplicationDispatcher } from '../src/application-dispatch.ts'
import { composition, config } from './composition.ts'

class Barrier {
  private readonly arrival = Promise.withResolvers<undefined>()
  private readonly completion = Promise.withResolvers<undefined>()
  readonly arrived = this.arrival.promise
  async enter(): Promise<void> { this.arrival.resolve(undefined); await this.completion.promise }
  release(): void { this.completion.resolve(undefined) }
}

/** The only model adapter is an external metadata/generation service, not a Session Controller substitute. */
class PhoneModels extends LlmAdapter {
  catalogWait: (() => Promise<void>) | undefined
  modelWait: ((model: string, count: number) => Promise<void>) | undefined
  defaultEffort = 'high'
  private readonly resolutions = new Map<string, number>()
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return (async () => {
      await this.catalogWait?.()
      return ['fixture', 'plain', 'reason'].map(id => ({ provider, id, name: `PC ${id}` }))
    })()
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const count = (this.resolutions.get(model) ?? 0) + 1
    this.resolutions.set(model, count)
    await this.modelWait?.(model, count)
    return { provider, id: model, name: `PC ${model}`, ...(model === 'reason' ? {
      reasoning: { efforts: ['low', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId(this.defaultEffort) },
    } : {}) }
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('Choosing a model must not invoke model generation')
  }
}

const budget = config.budgets.application
const token = () => randomBytes(16).toString('base64url')

async function boot(limits: ApplicationBudget = budget) {
  const fixture = await composition({})
  const dispatchers: ReturnType<typeof createApplicationDispatcher>[] = []
  const barriers: Barrier[] = []
  onTestFinished(async () => {
    fixture.owner.abort()
    for (const barrier of barriers) barrier.release()
    try { await Promise.all(dispatchers.map(dispatch => dispatch.close())) }
    finally { await fixture.close() }
  })
  await mkdir(fixture.home, { recursive: true })
  for (const [name, plugin] of Object.entries({ 'model-prompt': SystemPrompt, 'model-tools': Tools, 'model-loop': AgentLoop })) {
    fixture.ctx.loader.builtins[name] = plugin
    await fixture.ctx.loader.create({ name: `cordis:${name}`, config: name === 'model-loop' ? { agents: [] } : {} })
  }
  await fixture.ctx.loader.await()
  const model = new PhoneModels()
  const routing = fixture.ctx.llm.registerAdapter(['fixture'], model)
  const authority = { enabled: true, current: true }
  const makeDispatcher = () => {
    const dispatcher = createApplicationDispatcher(fixture.ctx, {
      signal: fixture.owner.signal, requireCurrent: () => { if (!authority.current) throw new Error('retired grant') },
      managementAccess: () => true, modelAccess: () => authority.enabled, toolDetailsAccess: () => false, activationAccess: () => false,
      grantId: parseId<GrantId>('phone-models'), generation: 1, budget: limits,
      maxWatches: 1, maxPendingRequests: 4, maxProgressBuffer: 2,
      sendProgress: () => { throw new Error('Model operations do not publish chat progress') },
    })
    dispatchers.push(dispatcher)
    const wire = async (message: object) => parseApplicationResult(encodeApplicationResult(
      await dispatcher.dispatch(parseApplicationRequest(JSON.stringify(message), limits)), limits), limits)
    return { ...dispatcher, wire }
  }
  const handle = await fixture.ctx.agents.create({ sessionId: SessionId('phone-model-target'),
    meta: { cwd: fixture.home }, agentOptions: { provider: 'fixture', model: 'fixture' } })
  const dispatcher = makeDispatcher()
  const list = async (cursor?: string, limit = 10, through = dispatcher): Promise<SessionModelsResult> => {
    const result = await through.wire({ v: 1, type: 'listSessionModels', requestId: token(),
      sessionId: handle.agent.id, limit, ...(cursor === undefined ? {} : { cursor }) })
    if (result.type !== 'sessionModels') throw new Error(`Expected model catalog, received ${result.type}`)
    return result
  }
  const ready = async () => {
    const offered = await list()
    if (offered.state !== 'ready') throw new Error(`Expected ready offer, received ${offered.state}`)
    return offered
  }
  const select = (offered: Extract<SessionModelsResult, { state: 'ready' }>, title: string, through = dispatcher) => {
    const choice = offered.models.find(row => row.title === title)
    if (choice === undefined) throw new Error(`Missing advertised choice ${title}`)
    return through.wire({ v: 1, type: 'selectSessionModel', requestId: token(), operationId: token(),
      sessionId: handle.agent.id, revision: offered.revision, choiceId: choice.id })
  }
  return { ...fixture, dispatcher, makeDispatcher, model, routing, authority, agent: handle.agent, handle, list, ready, select,
    barrier: () => { const barrier = new Barrier(); barriers.push(barrier); return barrier } }
}

describe('per-phone Session model offers', () => {
  it('does not derive model permission from chat-management consent', async () => {
    const fixture = await boot()
    fixture.authority.enabled = false
    expect(await fixture.list()).toMatchObject({ state: 'denied', models: [], current: null })
    expect(await fixture.dispatcher.wire({ v: 1, type: 'selectSessionModel', requestId: token(), operationId: token(),
      sessionId: fixture.agent.id, revision: token(), choiceId: token() })).toMatchObject({ outcome: 'rejected', code: 'denied' })
    expect(fixture.agent.session.seq).toBe(0)
  })

  it('pages opaque display-only choices and persists only the chosen live chat without changing global defaults', async () => {
    const fixture = await boot()
    const defaults = fixture.ctx.agentDefaultModel.currentSelection()
    const other = await fixture.ctx.agents.create({ sessionId: SessionId('other-model-chat'),
      meta: { cwd: fixture.home }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    const first = await fixture.list(undefined, 1)
    expect(first).toMatchObject({ state: 'ready', models: [{ title: 'PC fixture' }], current: { title: 'PC fixture' } })
    if (first.state !== 'ready' || first.cursor === undefined) throw new Error('Expected a paged model offer')
    const next = await fixture.list(first.cursor, 1)
    if (next.state !== 'ready') throw new Error('Expected ready continuation')
    expect(next.revision).toBe(first.revision)
    expect(next.current).toEqual(first.current)
    const choice = next.models[0]
    if (choice === undefined) throw new Error('Expected the next advertised model')
    expect(Object.keys(choice).sort()).toEqual(['id', 'providerTitle', 'title'])
    expect(choice.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(await fixture.select(next, 'PC plain')).toMatchObject({ type: 'modelSelected', outcome: 'applied', selected: { title: 'PC plain' } })
    expect(fixture.ctx.sessionController.currentModelSelection(fixture.agent)).toEqual({ provider: 'fixture', model: 'plain' })
    expect(fixture.ctx.agentDefaultModel.currentSelection()).toEqual(defaults)
    expect(fixture.ctx.sessionController.currentModelSelection(other.agent)).toEqual(defaults)
    using observed = await fixture.ctx.sessionQuery.observeSession(fixture.agent.id, { projectionMode: 'none' })
    expect([...observed.events].filter(event => event.type === 'model/selection').map(event => event.data))
      .toEqual([{ provider: 'fixture', model: 'plain' }])
  })

  it.each(['session-aba', 'other-channel', 'catalog-replacement'] as const)('refuses an offer after %s', async (change) => {
    const fixture = await boot()
    const offered = await fixture.ready()
    let through = fixture.dispatcher
    if (change === 'session-aba') {
      for (const model of ['plain', 'fixture']) await fixture.ctx.sessionController.selectModelForAgent(fixture.agent,
        { provider: 'fixture', model }, () => {})
    } else if (change === 'other-channel') through = fixture.makeDispatcher()
    else fixture.routing.replace(['fixture'])
    const before = fixture.agent.session.seq
    expect(await fixture.select(offered, 'PC plain', through)).toMatchObject({ outcome: 'rejected' })
    expect(fixture.agent.session.seq).toBe(before)
  })

  it('does not let an older initial metadata read overwrite a newer usable offer', async () => {
    const fixture = await boot()
    const barrier = fixture.barrier()
    let calls = 0
    fixture.model.catalogWait = () => ++calls === 1 ? barrier.enter() : Promise.resolve()
    const old = fixture.dispatcher.wire({ v: 1, type: 'listSessionModels', requestId: token(), sessionId: fixture.agent.id, limit: 10 })
    await barrier.arrived
    const newer = await fixture.ready()
    barrier.release()
    expect(await old).toMatchObject({ type: 'error', code: 'expired' })
    expect(await fixture.select(newer, 'PC plain')).toMatchObject({ outcome: 'applied' })
  })

  it('settles the request deadline while provider metadata is still pending and cannot later publish an offer', async () => {
    const fixture = await boot({ ...budget, readTimeoutMs: 100 })
    const barrier = fixture.barrier()
    fixture.model.catalogWait = () => barrier.enter()
    const pending = fixture.dispatcher.wire({ v: 1, type: 'listSessionModels', requestId: token(), sessionId: fixture.agent.id, limit: 10 })
    await barrier.arrived
    expect(await pending).toMatchObject({ type: 'error', code: 'expired' })
    await fixture.dispatcher.close()
    barrier.release()
    expect(fixture.agent.session.seq).toBe(0)
  })

  it.each(['revoke', 'provider-remove', 'effort-change', 'queued-work'] as const)(
    'rechecks %s after queued model normalization and before appending', async (change) => {
      const fixture = await boot()
      const offered = await fixture.ready()
      const barrier = fixture.barrier()
      fixture.model.modelWait = (model, count) => model === 'reason' && count === 3 ? barrier.enter() : Promise.resolve()
      const pending = fixture.select(offered, 'PC reason')
      await barrier.arrived
      if (change === 'revoke') fixture.authority.enabled = false
      else if (change === 'provider-remove') fixture.routing()
      else if (change === 'effort-change') fixture.model.defaultEffort = 'low'
      else fixture.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'queued work' }], source: { kind: 'user' } }))
      const before = fixture.agent.session.seq
      barrier.release()
      expect(await pending).toMatchObject({ outcome: 'rejected' })
      expect(fixture.agent.session.seq).toBe(before)
      expect(fixture.ctx.sessionController.currentModelSelection(fixture.agent)).toEqual({ provider: 'fixture', model: 'fixture' })
    })

  it('returns unknown after admission when persistence is pending, retains the event and never replays it', async () => {
    const fixture = await boot({ ...budget, readTimeoutMs: 100 })
    const offered = await fixture.ready()
    const barrier = fixture.barrier()
    // A second durability listener represents an independently owned external persistence sink.
    const release = fixture.ctx.on('session/flush', async (session) => { if (session === fixture.agent.session) await barrier.enter() })
    onTestFinished(() => { release() })
    const pending = fixture.select(offered, 'PC plain')
    await barrier.arrived
    expect(await pending).toMatchObject({ type: 'modelSelected', outcome: 'unknown' })
    await fixture.dispatcher.close()
    expect(fixture.ctx.sessionController.currentModelSelection(fixture.agent)).toEqual({ provider: 'fixture', model: 'plain' })
    barrier.release()
    expect(fixture.agent.session.seq).toBe(1)
  })
})
