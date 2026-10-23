/** Channel-local model offers and session-only commits; provider routing and credentials never cross the phone wire. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { buildModelCatalog } from '@deepseek-ai/dsh-api-session-controller'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller'
import type {
  ApplicationBudget, ApplicationRequest, MobileModelChoice, MobileModelChoiceId, MobileModelRevision,
  ModelSelectionResult, ReadCursor, SessionModelsResult,
} from '@deepseek-ai/dsh-companion-protocol'
import { encodeApplicationResult } from '@deepseek-ai/dsh-companion-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { MobileViewError, mobileSessionStatus, requireVisibleSession, sanitizedText } from './session-view.ts'

type CatalogRequest = Extract<ApplicationRequest, { type: 'listSessionModels' }>
type SelectionRequest = Extract<ApplicationRequest, { type: 'selectSessionModel' }>
type RejectionCode = Extract<ModelSelectionResult, { outcome: 'rejected' }>['code']

interface Offer {
  readonly revision: MobileModelRevision
  readonly agent: Agent
  readonly seq: number
  readonly selection: string
  readonly catalog: string
  readonly expiresAt: number
}
interface Route {
  readonly provider: string
  readonly model: string
  readonly title: string
  readonly providerTitle: string
  readonly defaultEffort: string | null
}

/** Fresh channel/permission authority; request-specific deadlines are additionally supplied at each operation. */
export interface SessionModelOptions {
  readonly budget: ApplicationBudget
  readonly requireCurrent: () => void
  readonly modelAccess: () => boolean
}

/** One bounded offer per channel; closing withdraws all cursors and choices before releasing the channel. */
export interface SessionModels {
  /**
   * @param request - Closed catalog/page request.
   * @param requireRead - Current request authority and deadline check.
   * @param signal - That request's cancellation signal, including its deadline.
   * @returns a bounded page or explicit unavailable state.
   */
  list(request: CatalogRequest, requireRead: () => void, signal: AbortSignal): Promise<SessionModelsResult>
  /**
   * @param request - Explicit fenced choice.
   * @param requireRead - Current request authority and deadline check.
   * @param signal - That request's cancellation signal; admitted persistence continues independently.
   * @returns applied only after targeted flush, or rejection/uncertainty.
   */
  select(request: SelectionRequest, requireRead: () => void, signal: AbortSignal): Promise<ModelSelectionResult>
  /** Withdraw the channel's single offer and erase its private signing key. */
  close(): void
}

class ModelRefusal extends Error {
  constructor(readonly code: RejectionCode) { super('Companion model selection refused') }
}

/**
 * Refuse a choice without claiming it reached the Session executor.
 * @param request - Original fenced target.
 * @param code - Fixed rejection code.
 * @returns a definite pre-admission refusal.
 */
export function rejectModelSelection(request: SelectionRequest, code: RejectionCode): ModelSelectionResult {
  return { v: 1, type: 'modelSelected', requestId: request.requestId, operationId: request.operationId,
    sessionId: request.sessionId, outcome: 'rejected', code }
}

function routes(catalog: ModelCatalog, budget: ApplicationBudget): Route[] {
  return catalog.groups.flatMap(group => group.models.map(model => ({
    provider: group.id, model: model.id,
    title: sanitizedText(model.name, budget.maxTitleBytes),
    providerTitle: sanitizedText(group.name, budget.maxTitleBytes),
    defaultEffort: model.reasoning?.defaultEffort ?? null,
  })))
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function refusalCode(error: unknown): RejectionCode {
  if (error instanceof ModelRefusal || error instanceof MobileViewError) return error.code
  if (error instanceof RemoteError) {
    if (error.code === 'gateway/cancelled') return 'denied'
    if (error.code === 'session/agent-busy') return 'busy'
    if (error.code === 'session/not-found') return 'notFound'
  }
  return 'unavailable'
}

/**
 * Create isolated phone model offers without activating a cold Session or changing deployment defaults.
 * Rebuilt catalogs must match the offer; final grant, Agent and Session revision checks run inside the PC selection queue.
 * @param ctx - Existing Session/Agent/model owners.
 * @param options - Explicit message budgets and current channel/independent-model permission.
 * @returns one disposable offer owner; no provider routes or catalog bodies are retained between requests.
 */
export function createSessionModels(ctx: Context, options: SessionModelOptions): SessionModels {
  const key = randomBytes(32)
  const lifetime = new AbortController()
  let offer: Offer | undefined
  let closed = false
  let catalogGeneration = 0
  let initialReadGeneration = 0
  const withdrawCatalog = ctx.on('llm/adapters-updated', () => {
    catalogGeneration++
    initialReadGeneration++
    offer = undefined
  })

  function requireAuthority(requireRead: () => void): void {
    if (closed) throw new ModelRefusal('denied')
    options.requireCurrent()
    requireRead()
    if (!options.modelAccess()) throw new ModelRefusal('denied')
  }
  function currentSelection(agent: Agent): string {
    return JSON.stringify(ctx.sessionController.currentModelSelection(agent))
  }
  function requireOffer(current: Offer, requireRead: () => void): void {
    requireAuthority(requireRead)
    if (offer !== current || Date.now() >= current.expiresAt) throw new ModelRefusal('expired')
    if (ctx.agents.get(current.agent.session.id) !== current.agent
      || ctx.sessions.get(current.agent.session.id) !== current.agent.session) throw new ModelRefusal('conflict')
    requireVisibleSession(ctx, current.agent.session.header)
    if (mobileSessionStatus(ctx, current.agent.session.id) !== 'idle') throw new ModelRefusal('busy')
    if (current.agent.session.seq !== current.seq || currentSelection(current.agent) !== current.selection) {
      throw new ModelRefusal('conflict')
    }
  }
  function choice(current: Offer, route: Route): MobileModelChoice {
    const id = createHmac('sha256', key).update(JSON.stringify([current.revision, route.provider, route.model]))
      .digest().subarray(0, 16).toString('base64url')
    return { id: brandString<MobileModelChoiceId>(id), title: route.title, providerTitle: route.providerTitle }
  }
  function cursor(current: Offer, offset: number): ReadCursor {
    const payload = Buffer.alloc(20)
    Buffer.from(current.revision, 'base64url').copy(payload)
    payload.writeUInt32BE(offset, 16)
    return brandString<ReadCursor>(Buffer.concat([payload, createHmac('sha256', key).update(payload).digest()]).toString('base64url'))
  }
  function offset(value: ReadCursor, current: Offer): number {
    const data = Buffer.from(value, 'base64url')
    if (data.length !== 52) throw new ModelRefusal('expired')
    const payload = data.subarray(0, 20)
    if (payload.subarray(0, 16).toString('base64url') !== current.revision
      || !timingSafeEqual(data.subarray(20), createHmac('sha256', key).update(payload).digest())) throw new ModelRefusal('expired')
    return payload.readUInt32BE(16)
  }
  function checked<T extends SessionModelsResult | ModelSelectionResult>(result: T): T {
    encodeApplicationResult(result, options.budget)
    return result
  }
  function noChoices(request: CatalogRequest, state: 'denied' | 'busy' | 'closed'): SessionModelsResult {
    offer = undefined
    return checked({ v: 1, type: 'sessionModels', requestId: request.requestId, sessionId: request.sessionId,
      state, models: [], current: null })
  }

  async function list(request: CatalogRequest, requireRead: () => void, callerSignal: AbortSignal): Promise<SessionModelsResult> {
    const signal = AbortSignal.any([callerSignal, lifetime.signal])
    options.requireCurrent()
    requireRead()
    signal.throwIfAborted()
    const readGeneration = request.cursor === undefined ? ++initialReadGeneration : initialReadGeneration
    const generation = catalogGeneration
    if (request.cursor === undefined) offer = undefined
    if (closed || !options.modelAccess()) return noChoices(request, 'denied')
    const agent = ctx.agents.get(request.sessionId)
    if (agent === undefined || ctx.sessions.get(request.sessionId) !== agent.session) return noChoices(request, 'closed')
    requireVisibleSession(ctx, agent.session.header)
    if (mobileSessionStatus(ctx, request.sessionId) !== 'idle') return noChoices(request, 'busy')
    const seq = agent.session.seq
    const selection = currentSelection(agent)
    const available = routes(await buildModelCatalog(ctx, ctx.sessionController.currentModelSelection(agent), signal), options.budget)
    requireAuthority(requireRead)
    if (readGeneration !== initialReadGeneration || generation !== catalogGeneration) throw new ModelRefusal('expired')
    if (ctx.agents.get(request.sessionId) !== agent || ctx.sessions.get(request.sessionId) !== agent.session
      || seq !== agent.session.seq || selection !== currentSelection(agent)) throw new ModelRefusal('conflict')
    requireVisibleSession(ctx, agent.session.header)
    if (mobileSessionStatus(ctx, request.sessionId) !== 'idle') return noChoices(request, 'busy')
    const catalog = digest(available)
    let current: Offer
    let start = 0
    if (request.cursor === undefined) {
      current = { revision: brandString<MobileModelRevision>(randomBytes(16).toString('base64url')),
        agent, seq, selection, catalog, expiresAt: Date.now() + options.budget.subscriptionLifetimeMs }
      offer = current
    } else {
      if (offer === undefined || offer.agent !== agent || offer.catalog !== catalog) throw new ModelRefusal('expired')
      current = offer
      requireOffer(current, requireRead)
      start = offset(request.cursor, current)
      if (start < 1 || start >= available.length) throw new ModelRefusal('expired')
    }
    const selected = ctx.sessionController.currentModelSelection(agent)
    const selectedRoute = available.find(route => route.provider === selected.provider && route.model === selected.model)
    const base = { v: 1 as const, type: 'sessionModels' as const, requestId: request.requestId, sessionId: request.sessionId,
      state: 'ready' as const, current: selectedRoute === undefined ? null : choice(current, selectedRoute), revision: current.revision }
    const models: MobileModelChoice[] = []
    let result: SessionModelsResult = checked({ ...base, models: [] })
    for (let index = start; index < available.length && models.length < request.limit; index++) {
      requireOffer(current, requireRead)
      const route = available[index]
      if (route === undefined) throw new ModelRefusal('expired')
      const item = choice(current, route)
      const candidate = { ...base, models: [...models, item],
        ...(index + 1 < available.length ? { cursor: cursor(current, index + 1) } : {}) }
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > options.budget.maxResultBytes) {
        if (models.length === 0) throw new MobileViewError('limit')
        break
      }
      result = checked(candidate)
      models.push(item)
    }
    requireOffer(current, requireRead)
    return result
  }

  async function select(request: SelectionRequest, requireRead: () => void, callerSignal: AbortSignal): Promise<ModelSelectionResult> {
    const signal = AbortSignal.any([callerSignal, lifetime.signal])
    const common = { v: 1 as const, type: 'modelSelected' as const, requestId: request.requestId,
      operationId: request.operationId, sessionId: request.sessionId }
    const transaction = { admitted: false }
    try {
      requireAuthority(requireRead)
      const current = offer
      if (current === undefined || current.revision !== request.revision || current.agent.session.id !== request.sessionId) {
        return rejectModelSelection(request, 'expired')
      }
      requireOffer(current, requireRead)
      const available = routes(await buildModelCatalog(ctx,
        ctx.sessionController.currentModelSelection(current.agent), signal), options.budget)
      requireOffer(current, requireRead)
      if (digest(available) !== current.catalog) return rejectModelSelection(request, 'conflict')
      const route = available.find(item => choice(current, item).id === request.choiceId)
      if (route === undefined) return rejectModelSelection(request, 'denied')
      const selected = checked({ ...common, outcome: 'applied' as const, selected: choice(current, route) })
      await ctx.sessionController.selectModelForAgent(current.agent, { provider: route.provider, model: route.model }, (normalized) => {
        requireOffer(current, requireRead)
        if (normalized.provider !== route.provider || normalized.model !== route.model
          || (normalized.reasoningEffort ?? null) !== route.defaultEffort) throw new ModelRefusal('conflict')
        offer = undefined
        transaction.admitted = true
      }, signal)
      requireAuthority(requireRead)
      return selected
    } catch (error: unknown) {
      return transaction.admitted ? { ...common, outcome: 'unknown' } : rejectModelSelection(request, refusalCode(error))
    }
  }

  return {
    list: (request, requireRead, signal) => list(request, requireRead, signal).catch((error: unknown) => {
      if (error instanceof ModelRefusal) {
        const code = error.code === 'busy' || error.code === 'conflict' ? 'expired' : error.code
        throw new MobileViewError(code, { cause: error })
      }
      throw error
    }),
    select,
    close() {
      if (closed) return
      closed = true
      lifetime.abort(new MobileViewError('denied'))
      offer = undefined
      initialReadGeneration++
      withdrawCatalog()
      key.fill(0)
    },
  }
}
