/** Agent activation, composition, and model-selection policy owned by API Session. */

import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type {
  Agent, AgentOptions, AgentSetup, ModelSelection as AgentModelSelection, ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type {} from '@deepseek-ai/dsh-workspace'
import { awaitActivationPreparation } from './activation.ts'
import type { ExistingAgentActivationOptions, ModelSelection } from './types.ts'

/** Cold Session identity absent from persistence. */
export class ApiSessionNotFound extends Error {}

/** Session identity whose lifecycle belongs to subagent routing. */
export class ApiSessionSubagentOwnership extends Error {
  /** @param sessionId - identity reserved to subagent routing. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is a subagent session; use subagent delivery`)
  }
}

/** Explicit-id creation attempted to adopt a Session under another cwd. */
export class ApiSessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      existingCwd === undefined
        ? `session "${sessionId}" records no cwd and cannot be adopted for "${requestedCwd}"`
        : `session "${sessionId}" belongs to "${existingCwd}", not "${requestedCwd}"`,
    )
  }
}

/** Explicit-id creation attempted to adopt a Session under another preset. */
export class ApiSessionPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
    readonly existingPreset: string | undefined,
  ) {
    super(
      existingPreset === undefined
        ? `session "${sessionId}" records no agent preset and cannot be adopted under "${requestedPreset}"`
        : `session "${sessionId}" runs agent preset "${existingPreset}", not "${requestedPreset}"`,
    )
  }
}

/** Failures produced while resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentError = RemoteError<'session/not-found' | 'session/agent-busy' | 'session/writer-held' | 'gateway/internal'>

/** Result of resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentResult =
  | { readonly agent: Agent }
  | { readonly error: ApiSessionAgentError }

type InstalledSelection = ModelSelectionRef & {
  current: AgentModelSelection
  consume(provider: string, model: string, reasoningEffort: string | undefined): boolean
}

/**
 * Test whether generic Session routing must leave an identity to subagent routing.
 * @param ctx - Host context carrying the Agent ownership registry.
 * @param session - attached or live Session whose ownership is tested.
 * @param agent - creation or resume result whose durable origin is checked when available.
 * @returns whether subagent routing owns the Session identity.
 */
export function hasApiSessionSubagentOwner(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent' || agent?.session.header.origin === 'subagent') return true
  const live = ctx.agents.get(session.header.id)
  return live !== undefined && (live.session.header.origin === 'subagent' || !ctx.agents.roots().includes(live))
}

/**
 * Build the stable caller-facing subagent ownership rejection.
 * @param sessionId - Session identity owned by subagent routing.
 * @returns a stable Session-domain failure.
 */
export function apiSessionSubagentOwnershipError(sessionId: SessionId): ApiSessionAgentError {
  return new RemoteError(
    'session/agent-busy',
    `session "${sessionId}" is owned by subagent routing`,
    { reason: 'use subagent delivery for this child session' },
  )
}

/**
 * Inspect one cold Session without repairing, resuming, or publishing it.
 * @param ctx - Host context carrying Session persistence.
 * @param sessionId - durable Session identity.
 * @param signal - optional cancellation for persistence reads.
 * @returns the persisted header and complete event prefix.
 */
export async function inspectApiSession(
  ctx: Context,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<SessionInspection> {
  try {
    using observation = await ctx.sessionQuery.observeSession(sessionId, {
      ...(signal === undefined ? {} : { signal }),
      projectionMode: 'none',
    })
    if (observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    return {
      meta: observation.header,
      inheritedEventCount: observation.inheritedEventCount,
      events: [...observation.events],
    }
  } catch (error: unknown) {
    if (error instanceof SessionQueryError
      && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    throw error
  }
}

/** Owns every operation that may create, resume, or configure a Web Agent. */
export class ApiSessionAgentController {
  private readonly resumes = new Map<SessionId, Promise<Agent>>()
  private readonly creations = new Map<SessionId, Promise<Agent>>()
  private readonly selections = new WeakMap<Agent, InstalledSelection>()
  private readonly imageAdmissionChains = new WeakMap<Agent, Promise<void>>()
  private readonly activationOwner = new AbortController()
  private readonly activations = new Set<Promise<Agent>>()

  /**
   * @param ctx - Host context carrying Agent, model, persistence, and Typert services.
   * @param maxPendingActivations - Validated deployment capacity for retained existing-chat operations.
   */
  constructor(private readonly ctx: Context, private readonly maxPendingActivations: number) {
    ctx.effect(() => async () => {
      this.activationOwner.abort(new Error('api-session: activation owner disposed'))
      await Promise.allSettled([...this.activations])
    }, 'api-session.activations')
    ctx.typert.lookups.configure('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent
    })
    ctx.typert.lookups.configure('session', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.session
    })
    ctx.typert.contexts.configureHost('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.ctx
    })
  }

  /**
   * Resolve or resume one ordinary Session, deduplicating concurrent resumes.
   * @param sessionId - ordinary Session identity.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.resolve(sessionId)
  }

  /**
   * Resolve one ordinary Session from an already-retained exact observation.
   * @param observation - Host-owned observation whose preparation stays pinned through setup.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveObservedAgent(observation: SessionObservation): Promise<ApiSessionAgentResult> {
    return this.resolve(observation.header.id, observation)
  }

  /**
   * Open an existing ordinary Session for a trusted Host without submitting input.
   * The existing resume reservation owns preparation and completion even if the caller stops waiting.
   * @param sessionId - existing ordinary Session identity; never created on absence.
   * @param options - pre-admission caller lifetime and synchronous Host authorization callbacks.
   * @returns the current live root Agent, or the newly resumed root Agent after initialization.
   */
  async activateExistingAgent(sessionId: SessionId, options: ExistingAgentActivationOptions): Promise<Agent> {
    this.checkActivationAdmission(sessionId, options)
    if (this.resumes.has(sessionId) || this.creations.has(sessionId)) {
      throw this.activationBusy(sessionId, 'the Session is already being activated')
    }
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      this.assertActivationHeader(sessionId, live.session.header, live)
      this.assertLiveSelectionOwner(live)
      options.requireAdmission()
      return live
    }
    if (this.activations.size >= this.maxPendingActivations) {
      throw this.activationBusy(sessionId, 'the Host activation capacity is full')
    }
    const reply = Promise.withResolvers<Agent>()
    const withdraw = (): void => { reply.reject(options.signal?.reason) }
    const detach = (): void => { options.signal?.removeEventListener('abort', withdraw) }
    options.signal?.addEventListener('abort', withdraw, { once: true })
    const operation = Promise.resolve().then(() => this.activateCold(sessionId, options))
    this.resumes.set(sessionId, operation)
    this.activations.add(operation)
    const release = (): void => {
      detach()
      this.resumes.delete(sessionId)
      this.activations.delete(operation)
    }
    void operation.then((agent) => { release(); reply.resolve(agent) }, (error: unknown) => {
      release()
      reply.reject(error)
    })
    return reply.promise
  }

  private async activateCold(sessionId: SessionId, options: ExistingAgentActivationOptions): Promise<Agent> {
    this.checkActivationAdmission(sessionId, options)
    try {
      using observation = await awaitActivationPreparation(
        this.ctx.sessionQuery.observeSession(sessionId, {
          signal: AbortSignal.any([this.activationOwner.signal, ...options.signal === undefined ? [] : [options.signal]]),
        }),
        this.activationOwner.signal,
        abandoned => abandoned[Symbol.dispose](),
      )
      this.checkActivationAdmission(sessionId, options)
      this.assertActivationHeader(sessionId, observation.header, undefined)
      const cwd = observation.header.cwd
      const directory = await awaitActivationPreparation(stat(cwd), this.activationOwner.signal)
      this.checkActivationAdmission(sessionId, options)
      if (!directory.isDirectory()) throw new Error(`session "${sessionId}" cwd is not a directory`)
      const presetId = this.presetForObservation(observation)
      const composition = await awaitActivationPreparation(this.composeAgent(presetId), this.activationOwner.signal)
      this.checkActivationAdmission(sessionId, options)
      this.assertActivationHeader(sessionId, observation.header, undefined)
      if (this.ctx.agents.get(sessionId) !== undefined || this.ctx.sessions.get(sessionId) !== undefined) {
        throw this.activationBusy(sessionId, 'Session ownership changed during preparation')
      }
      const setup: AgentSetup = async (agentCtx, agent) => {
        this.assertActivationHeader(sessionId, agent.session.header, agent)
        this.assertActivationIdentity(agent, cwd, presetId)
        const commit = await composition.setup(agentCtx, agent)
        this.assertActivationHeader(sessionId, agent.session.header, agent)
        this.assertActivationIdentity(agent, cwd, presetId)
        return { commit: () => {
          this.assertActivationHeader(sessionId, agent.session.header, agent)
          this.assertActivationIdentity(agent, cwd, presetId)
          commit?.commit()
        } }
      }
      const agentOptions = this.agentOptions()
      options.signal?.throwIfAborted()
      options.requireAdmission()
      options.onAdmitted()
      const { agent } = await this.ctx.agents.resume({
        resumeSessionId: sessionId, agentOptions, setup, signal: this.activationOwner.signal,
      })
      await this.ctx.sessions.flush(agent.session)
      this.assertActivationHeader(sessionId, agent.session.header, agent)
      this.assertLiveSelectionOwner(agent)
      return agent
    } catch (error: unknown) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', error.message, { sessionId })
      }
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        throw new RemoteError('session/writer-held', error.message, { sessionId })
      }
      throw error
    }
  }

  private checkActivationAdmission(sessionId: SessionId, options: ExistingAgentActivationOptions): void {
    this.activationOwner.signal.throwIfAborted()
    this.ctx.fiber.assertActive()
    options.signal?.throwIfAborted()
    options.requireAdmission()
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
      throw this.activationBusy(sessionId, 'the Session is archived')
    }
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) this.assertActivationHeader(sessionId, attached.header, this.ctx.agents.get(sessionId))
  }

  private assertActivationHeader(
    sessionId: SessionId, header: SessionHeader, agent: Agent | undefined,
  ): asserts header is SessionHeader & { cwd: string } {
    if (header.id !== sessionId || header.cwd === undefined || !isAbsolute(header.cwd)) {
      throw new RemoteError('session/not-found', `session "${sessionId}" has no usable existing cwd`, { sessionId })
    }
    if (hasApiSessionSubagentOwner(this.ctx, { header }, agent)) throw apiSessionSubagentOwnershipError(sessionId)
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
      throw this.activationBusy(sessionId, 'the Session is archived')
    }
  }

  private assertActivationIdentity(agent: Agent, cwd: string, presetId: string | undefined): void {
    if (agent.session.header.cwd !== cwd || this.presetForSession(agent.session) !== presetId) {
      throw this.activationBusy(agent.id, 'the Session cwd or preset changed during activation')
    }
  }

  private activationBusy(sessionId: SessionId, reason: string): RemoteError<'session/agent-busy'> {
    return new RemoteError('session/agent-busy', `session "${sessionId}" cannot be activated: ${reason}`, { reason })
  }

  private async resolve(
    sessionId: SessionId,
    observation?: SessionObservation,
  ): Promise<ApiSessionAgentResult> {
    const live = this.liveAgent(sessionId)
    if (live !== undefined) return live
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
      return { error: apiSessionSubagentOwnershipError(sessionId) }
    }

    let resume = this.resumes.get(sessionId)
    if (resume === undefined) {
      resume = this.resume(sessionId, observation).finally(() => { this.resumes.delete(sessionId) })
      this.resumes.set(sessionId, resume)
    }
    try {
      const agent = await resume
      // A shared resume can publish an identity that subagent routing adopts
      // before every waiter observes it; apply the live ownership policy again.
      const published = this.liveAgent(sessionId)
      return published ?? { agent }
    } catch (error: unknown) {
      if (error instanceof ApiSessionNotFound) {
        return { error: new RemoteError('session/not-found', error.message, { sessionId }) }
      }
      if (error instanceof ApiSessionSubagentOwnership) {
        return { error: apiSessionSubagentOwnershipError(error.sessionId) }
      }
      const raced = this.liveAgent(sessionId)
      if (raced !== undefined) return raced
      const racedSession = this.ctx.sessions.get(sessionId)
      if (racedSession !== undefined && hasApiSessionSubagentOwner(this.ctx, racedSession, undefined)) {
        return { error: apiSessionSubagentOwnershipError(sessionId) }
      }
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        return { error: new RemoteError('session/writer-held', error.message, { sessionId }) }
      }
      return {
        error: new RemoteError(
          'gateway/internal',
          `resume failed for session "${sessionId}": ${String(error)}`,
          {},
        ),
      }
    }
  }

  /**
   * Resolve one requested identity, creating or resuming it once.
   * @param sessionId - requested Session identity.
   * @param cwd - directory the Session must own.
   * @param checkPersistedIdentity - whether to inspect a cold identity before creation.
   * @param presetId - optional Agent preset the Session must own.
   * @returns the matching live ordinary Agent.
   */
  async ensureSession(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    presetId?: string,
  ): Promise<Agent> {
    let creation = this.creations.get(sessionId) ?? this.resumes.get(sessionId)
    if (creation === undefined) {
      creation = this.createOrAdopt(sessionId, cwd, checkPersistedIdentity, presetId)
        .catch((error: unknown) => {
          const live = this.ctx.agents.get(sessionId)
          if (live !== undefined) {
            if (hasApiSessionSubagentOwner(this.ctx, live.session, live)) {
              throw new ApiSessionSubagentOwnership(sessionId)
            }
            return live
          }
          const attached = this.ctx.sessions.get(sessionId)
          if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
            throw new ApiSessionSubagentOwnership(sessionId)
          }
          throw error
        })
        .finally(() => { this.creations.delete(sessionId) })
      this.creations.set(sessionId, creation)
    }
    const agent = await creation
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (presetId !== undefined) {
      this.assertPresetUnchanged(sessionId, presetId, this.presetForSession(agent.session))
    }
    if (agent.session.header.cwd !== cwd) {
      throw new ApiSessionCwdConflict(sessionId, cwd, agent.session.header.cwd)
    }
    return agent
  }

  /**
   * Create a requested identity without adopting live, cold, or in-flight Sessions.
   * Persistence claims the durable identity exclusively; failures never resolve to a raced Agent.
   * @param sessionId - exclusive fresh Session identity.
   * @param cwd - directory for the new Session.
   * @param presetId - optional Agent preset for the new Session.
   * @returns the newly published Agent, or rejection if the identity is unavailable or creation fails.
   */
  async createFreshSession(sessionId: SessionId, cwd: string, presetId?: string): Promise<Agent> {
    if (this.creations.has(sessionId) || this.resumes.has(sessionId)
      || this.ctx.agents.get(sessionId) !== undefined || this.ctx.sessions.get(sessionId) !== undefined) {
      throw new Error(`session "${sessionId}" already exists or is being activated`)
    }
    const creation = this.createSession(sessionId, cwd, presetId)
      .finally(() => { this.creations.delete(sessionId) })
    this.creations.set(sessionId, creation)
    return creation
  }

  /**
   * Install or return the Session-local model selection used by prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @returns the installed mutable selection reference.
   */
  selectionFor(agent: Agent): InstalledSelection {
    const installed = this.selections.get(agent)
    if (installed !== undefined) return installed
    const projectionState = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
    if (projectionState === undefined) {
      throw new Error('api-session: required modelSelection projection is not registered')
    }
    let picked = projectionState.pending === null
      ? undefined
      : agentModelSelection(projectionState.pending)
    const defaultModel = this.ctx.agentDefaultModel
    const selection: InstalledSelection = {
      get current(): AgentModelSelection {
        if (picked !== undefined) return picked
        const loggedHeader = agent.session.requestHeader()
        if (loggedHeader === undefined) return defaultModel.currentSelection()
        const logged = loggedHeader.config
        return {
          provider: logged.provider,
          model: logged.model,
          // An effort the adapter defaulted is not a conversation choice: restoring
          // it as one would make an unchanged default read as a request change.
          ...(logged.reasoningEffort === undefined
            || loggedHeader.adapterDefaults?.reasoningEffort === true
            ? {}
            : { reasoningEffort: logged.reasoningEffort }),
        }
      },
      set current(next: AgentModelSelection) {
        picked = next
      },
      consume(provider: string, model: string, reasoningEffort: string | undefined): boolean {
        if (picked?.provider !== provider
          || picked.model !== model
          || picked.reasoningEffort !== reasoningEffort) return false
        picked = undefined
        return true
      },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, selection)
    this.selections.set(agent, selection)
    return selection
  }

  /**
   * Commit and cache one validated selection for the next prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @param selection - validated selection to record and apply.
   * @returns the durable event that recorded the selection.
   */
  selectForNextRequest(
    agent: Agent,
    selection: AgentModelSelection,
  ): SessionEvent<'model/selection'> {
    const event = agent.session.append('model/selection', selection)
    this.selectionFor(agent).current = selection
    return event
  }

  /**
   * Read the effective model selection of one live ordinary Agent.
   * @param agent - live ordinary Agent that owns the selection.
   * @returns a detached copy of the effective selection.
   * @throws RemoteError when the Agent is not a live ordinary Session owner.
   */
  currentSelection(agent: Agent): ModelSelection {
    this.assertLiveSelectionOwner(agent)
    const current = this.selectionFor(agent).current
    return {
      provider: current.provider,
      model: current.model,
      ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }),
    }
  }

  /**
   * Reject a supplied Agent that no longer owns a live ordinary Session.
   *
   * Both live registries must still identify this exact Agent and Session;
   * runtime-owned children belong to subagent routing rather than to ordinary selection.
   * @param agent - live Agent the caller supplied.
   * @returns the same Agent when it owns a live ordinary Session.
   * @throws RemoteError when the Agent is absent from the registry or owned by subagent routing.
   */
  assertLiveSelectionOwner(agent: Agent): Agent {
    if (this.ctx.agents.get(agent.id) !== agent || this.ctx.sessions.get(agent.id) !== agent.session) {
      throw new RemoteError(
        'session/not-found',
        `session "${agent.id}" is not the current live Session owner`,
        { sessionId: agent.id },
      )
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(agent.id)
    }
    return agent
  }

  /**
   * Reject a supplied Agent that is running or holds queued work.
   * @param agent - live ordinary Agent that owns the selection.
   * @returns the same Agent when it is idle with no queued work.
   * @throws RemoteError when the Agent is running or holds queued work.
   */
  assertIdleSelectionOwner(agent: Agent): Agent {
    this.assertLiveSelectionOwner(agent)
    if (agent.status !== 'idle'
      || agent.inbox.nextTurn.length > 0
      || agent.inbox.nextStep.length > 0) {
      throw new RemoteError(
        'session/agent-busy',
        `session "${agent.id}" is not idle`,
        { reason: 'the Agent is running or holds queued work' },
      )
    }
    return agent
  }

  /**
   * Let a matching durable request header retire the execution cache.
   * @param agent - live Agent whose request was recorded.
   * @param provider - provider route used by the request.
   * @param model - provider-owned model used by the request.
   * @param reasoningEffort - adapter-owned effort used by the request.
   * @returns whether the pending selection was consumed.
   */
  consumeSelection(
    agent: Agent,
    provider: string,
    model: string,
    reasoningEffort: string | undefined,
  ): boolean {
    return this.selections.get(agent)?.consume(provider, model, reasoningEffort) ?? false
  }

  /**
   * Read the current Agent preset from the Session projection.
   * @param session - live Session whose projection state is available.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForSession(session: Session): string | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'agentPreset') ?? undefined
  }

  /**
   * Serialize image admission and model selection for one Agent.
   * @param agent - live Agent that owns the serialization chain.
   * @param operation - asynchronous operation admitted after prior work settles.
   * @returns the operation result or rejection.
   */
  serializeImageAdmission<Value>(agent: Agent, operation: () => Promise<Value>): Promise<Value> {
    const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation)
    this.imageAdmissionChains.set(agent, result.then(() => undefined, () => undefined))
    return result
  }

  /**
   * Resolve the preset id and pre-publication Agent setup for a create or resume.
   * @param presetId - requested preset or the configured default when omitted.
   * @returns the resolved preset identity and Agent setup callback.
   */
  async composeAgent(presetId: string | undefined): Promise<{
    readonly agentPreset?: string
    readonly setup: AgentSetup
  }> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      return { setup: (_agentCtx, agent) => { this.installSelection(agent) } }
    }
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx, agent) => {
        this.installSelection(agent)
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }

  private liveAgent(sessionId: SessionId): ApiSessionAgentResult | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return undefined
    return hasApiSessionSubagentOwner(this.ctx, agent.session, agent)
      ? { error: apiSessionSubagentOwnershipError(sessionId) }
      : { agent }
  }

  private async resume(sessionId: SessionId, supplied?: SessionObservation): Promise<Agent> {
    if (supplied !== undefined) return this.resumeObserved(sessionId, supplied)
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      return await this.resumeObserved(sessionId, observation)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new ApiSessionNotFound(`session "${sessionId}" not found`)
      }
      throw error
    }
  }

  private async resumeObserved(
    sessionId: SessionId,
    observation: SessionObservation,
  ): Promise<Agent> {
    if (observation.header.id !== sessionId || observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    const composition = await this.composeAgent(this.presetForObservation(observation))
    const published = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (published !== undefined && hasApiSessionSubagentOwner(this.ctx, published, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    return (await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    })).agent
  }

  private async createOrAdopt(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    presetId: string | undefined,
  ): Promise<Agent> {
    const attached = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (live !== undefined) return live

    if (checkPersistedIdentity) {
      try {
        using observation = await this.ctx.sessionQuery.observeSession(sessionId)
        if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
          throw new ApiSessionSubagentOwnership(sessionId)
        }
        if (observation.header.cwd !== cwd) {
          throw new ApiSessionCwdConflict(sessionId, cwd, observation.header.cwd)
        }
        const storedPreset = this.presetForObservation(observation)
        this.assertPresetUnchanged(sessionId, presetId, storedPreset)
        const composition = await this.composeAgent(storedPreset)
        return (await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: this.agentOptions(),
          setup: composition.setup,
        })).agent
      } catch (error: unknown) {
        if (!(error instanceof SessionQueryError)
          || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      }
    }

    return this.createSession(sessionId, cwd, presetId)
  }

  private async createSession(sessionId: SessionId, cwd: string, presetId: string | undefined): Promise<Agent> {
    try {
      await mkdir(cwd, { recursive: true })
    } catch (error: unknown) {
      throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error })
    }
    const composition = await this.composeAgent(presetId)
    return (await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions(),
      meta: {
        cwd,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      setup: composition.setup,
    })).agent
  }

  private agentOptions(): AgentOptions {
    const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
    return { provider, model }
  }

  private installSelection(agent: Agent): void {
    this.selectionFor(agent)
  }

  /**
   * Read the current Agent preset from an all-projections observation.
   * @param observation - exact Session observation carrying its projection snapshot.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForObservation(observation: SessionObservation): string | undefined {
    if (observation.projections === undefined) {
      throw new Error('api-session: Agent activation requires a projected Session observation')
    }
    return observation.projections.values.agentPreset ?? undefined
  }

  private assertPresetUnchanged(
    sessionId: SessionId,
    requested: string | undefined,
    existing: string | undefined,
  ): void {
    if (requested === undefined || requested === existing) return
    throw new ApiSessionPresetConflict(sessionId, requested, existing)
  }
}

function agentModelSelection(selection: ModelSelection): AgentModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
  }
}
