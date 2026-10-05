/** Host-local exact-Agent website authority and cancellation, independent of native guest validation. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Session } from '@deepseek-ai/dsh-session'
import type { DesktopWebsiteHostProfile, DesktopWebsiteProfileId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { McpToolCallEvent } from '@deepseek-ai/dsh-mcp-client'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { WebsiteMcpBinding } from './website-mcp.ts'
import { WebsiteOperationUnknownOutcomeError } from './website-parent.ts'
import { websiteBrowserConsentReason, type WebsiteBrowserConsent } from './website-consent.ts'

/** Domain identity of one request; unrelated to IPC correlation IDs. */
export type WebsiteRequestId = Branded<'DesktopWebsiteRequestId'>

/** Trusted saved association supplied by the Main-process integration. */
export interface WebsiteRequestProfile extends DesktopWebsiteHostProfile {
  readonly mcpBinding: WebsiteMcpBinding
}

/** Read-only receipt; Agent and Session objects remain private to this Host. */
export interface WebsiteRequestSnapshot {
  readonly requestId: WebsiteRequestId
  readonly profileId: DesktopWebsiteProfileId
  readonly serverName: string
  readonly sessionId: Session['id']
  readonly epoch: number
  readonly status: 'pending' | 'granted' | 'revoked'
  readonly signal: AbortSignal
  /** Original owner/execution ended; this request cannot be renewed. */
  readonly terminal?: true
}

/** Request operations called only by trusted Host/Main integration, never by model arguments. */
export interface WebsiteRequestsController {
  /**
   * Replace the complete saved inventory; enrolled namespaces remain guarded for this Host lifetime even after removal.
   * @param profiles - saved pairings.
   */
  syncProfiles(profiles: readonly WebsiteRequestProfile[]): void
  /** @returns enrolled non-secret pairings; unavailable before initialization or after shutdown. */
  profiles(): readonly WebsiteRequestProfile[]
  /**
   * Capture one request per registered preparation execution; grants nothing.
   * @param execution - exact observed invocation; wrapper cancellation or a failed final result terminates preparation, and original
   * caller cancellation remains terminal after success.
   * @param profile - saved pairing.
   * @returns pending receipt, unvalidatable until the preparation tool settles.
   */
  create(execution: ToolExecution, profile: WebsiteRequestProfile): WebsiteRequestSnapshot
  /**
   * Join private Main capture to pending preparation drainage; grants nothing.
   * @param request - current pending receipt.
   * @param capture - cancellable native handoff.
   * @returns after a still-current handoff; failure propagates to the preparation's final result and drainage joins its settlement.
   */
  handoff(request: WebsiteRequestSnapshot, capture: (signal: AbortSignal) => Promise<void>): Promise<void>
  /**
   * Check the exact owner and current MCP binding; grants nothing. A successfully drained revocation may start a new pending epoch.
   * @param requestId - domain request.
   * @param epoch - current generation.
   * @returns validated receipt.
   */
  validate(requestId: WebsiteRequestId, epoch: number): Promise<WebsiteRequestSnapshot>
  /**
   * Consume validation once, recheck the current MCP binding, and commit after Main's guest validation.
   * @param requestId - domain request.
   * @param epoch - validated generation.
   * @returns granted receipt.
   */
  commit(requestId: WebsiteRequestId, epoch: number): Promise<WebsiteRequestSnapshot>
  /** Recheck a retained response immediately before private IPC publication. @param snapshot - exact controller-owned result. */
  assertCurrent(snapshot: WebsiteRequestSnapshot): void
  /** Refuse stale drainage acknowledgement after renewal. @param requestId - revoked, successfully drained request. */
  assertDrained(requestId: WebsiteRequestId): void
  /**
   * Abort immediately and synchronously enqueue notification. Notification errors propagate and block drainage/removal.
   * @param requestId - domain request.
   * @returns revoked receipt.
   */
  revoke(requestId: WebsiteRequestId): WebsiteRequestSnapshot
  /**
   * Await physical settlement, including failed/cancelled operations; never mistake cancellation for settlement.
   * @param requestId - revoked request.
   * @returns after successful drainage, or rejects while retaining authority locks.
   */
  drain(requestId: WebsiteRequestId): Promise<void>
  /** Remove only after successful drainage. @param requestId - drained, revoked request. @returns after detaching its owner effect. */
  remove(requestId: WebsiteRequestId): Promise<void>
  /**
   * Run browser work for the exact initiating Agent and Session during an observed, unsettled tool invocation.
   * Request, current caller, and dispatch cancellation are additive; work remains tracked until physical settlement.
   * @param execution - current registry-provided invocation, not a copy or settled preparation.
   * @param requestId - granted request.
   * @param epoch - admitted generation.
   * @param operation - work receiving all cancellation sources; its promise settles only after physical work stops.
   * @returns only a result authorized for the still-current invocation and request.
   */
  run<T>(execution: ToolExecution, requestId: WebsiteRequestId, epoch: number,
    operation: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/** Captured grant-time capability; scoped descriptors cannot select another request or owner. */
export interface WebsiteRequestToolScope {
  readonly agent: Agent
  readonly session: Session
  readonly request: WebsiteRequestSnapshot
  readonly profile: WebsiteRequestProfile
  /** @param execution - live registry invocation. @param operation - physically settling work.
   * @param consent - fixed warning and explicit MCP fallback reason for this operation. @returns current authorized output.
   */
  run<T>(execution: ToolExecution, operation: (signal: AbortSignal) => Promise<T>, consent: WebsiteBrowserConsent): Promise<T>
}

interface Request {
  readonly id: WebsiteRequestId
  readonly agent: Agent
  readonly session: Session
  readonly callerSignal: AbortSignal
  readonly profile: WebsiteRequestProfile
  readonly operations: Set<Promise<void>>
  readonly failures: unknown[]
  epoch: number
  status: WebsiteRequestSnapshot['status']
  terminal: boolean
  preparing: boolean
  cancellation: AbortController
  validatedEpoch: number | undefined
  drained: boolean
  drainage: Promise<void> | undefined
  detachOwner: (() => void | Promise<void>) | undefined
  detachCaller: () => void
  detachPreparation: () => void
  detachTool: (() => void) | undefined
}

const STALE = 'Website request is not authorized for this owner and generation'

/**
 * Install one global MCP guard with an effect-owned, quiescent teardown.
 * @param ctx - unscoped Host plugin context with the live Agent registry.
 * @param inspectBinding - inspector preserving current MCP registry/configuration identity.
 * @param notifyRevocation - synchronously enqueue Main's revocation and join delivery; failure retains account locks.
 * @param validateNative - check the current request-specific native grant before dispatch and result publication.
 * @param installTool - register one exact-Agent observation descriptor at commit; revocation removes it synchronously.
 * @returns exact-owner request controller; no grants survive disposal or a Host restart.
 */
export function installWebsiteRequests(
  ctx: Context,
  inspectBinding: (serverName: string) => Promise<WebsiteMcpBinding>,
  notifyRevocation: (request: WebsiteRequestSnapshot) => void | Promise<void>,
  validateNative: (request: WebsiteRequestSnapshot, signal: AbortSignal) => Promise<void>,
  installTool?: (scope: WebsiteRequestToolScope) => () => void,
): WebsiteRequestsController {
  if (scopeOf(ctx) !== undefined) throw new Error('Website requests require an unscoped Host context')
  const requests = new Map<WebsiteRequestId, Request>()
  const callerSignals = new WeakMap<ToolExecution, AbortSignal>()
  const preparations = new WeakMap<ToolExecution, Request>()
  let profiles = new Map<DesktopWebsiteProfileId, WebsiteRequestProfile>()
  const protectedNamespaces = new Set<string>()
  let stopped = false
  let initialized = false

  function snapshot(request: Request): WebsiteRequestSnapshot {
    return Object.freeze({ requestId: request.id, profileId: request.profile.id,
      serverName: request.profile.serverName, sessionId: request.session.id,
      epoch: request.epoch, status: request.status, signal: request.cancellation.signal,
      ...(request.terminal ? { terminal: true } : {}) })
  }

  function requireRequest(id: WebsiteRequestId): Request {
    const request = requests.get(id)
    if (request === undefined) throw new Error(STALE)
    return request
  }

  function sameProfile(left: WebsiteRequestProfile, right: WebsiteRequestProfile): boolean {
    return left.name === right.name && left.accountLabel === right.accountLabel && left.url === right.url
      && left.serverName === right.serverName && left.mcpBinding.identity === right.mcpBinding.identity
      && left.mcpBinding.endpoint === right.mcpBinding.endpoint
  }

  function detachTool(request: Request): void {
    const detach = request.detachTool
    request.detachTool = undefined
    try { detach?.() }
    catch (error) { request.failures.push(error) }
  }

  function revoke(request: Request): void {
    if (request.status === 'revoked') return
    request.status = 'revoked'
    request.epoch++
    request.validatedEpoch = undefined
    detachTool(request)
    // Drainage is published before abort/notification callbacks can reenter.
    void drain(request).catch((_error: unknown) => { /* Failed settlement retains the account reservation. */ })
    request.cancellation.abort(new Error(STALE))
    notify(request)
  }

  function notify(request: Request): void {
    try {
      const notification = Promise.resolve(notifyRevocation(snapshot(request)))
        .then(() => {}, (error: unknown) => { request.failures.push(error) })
      request.operations.add(notification)
      void notification.then(() => request.operations.delete(notification))
    }
    catch (error) {
      request.failures.push(error)
      throw error
    }
  }

  function terminate(request: Request): void {
    if (request.terminal) return
    request.terminal = true
    if (request.status !== 'revoked') { revoke(request); return }
    request.epoch++
    if (request.drained) {
      request.drained = false
      request.drainage = undefined
    }
    void drain(request).catch((_error: unknown) => { /* Failed terminal settlement retains the account reservation. */ })
    notify(request)
  }

  function assertOwner(request: Request): void {
    const saved = profiles.get(request.profile.id)
    if (stopped || request.terminal || requests.get(request.id) !== request || ctx.agents.get(request.agent.id) !== request.agent
      || request.agent.session !== request.session || request.callerSignal.aborted
      || saved === undefined || !sameProfile(saved, request.profile)) {
      revoke(request)
      throw new Error(STALE)
    }
  }

  function assertGeneration(request: Request, epoch: number, granted: boolean): void {
    assertOwner(request)
    if (request.epoch !== epoch || request.status === 'revoked' || request.cancellation.signal.aborted
      || (granted && request.status !== 'granted')) throw new Error(STALE)
  }

  function tracked<T>(request: Request, operation: () => Promise<T>): Promise<T> {
    // Publish the settlement before invoking user code, including synchronous reentrant revocation.
    const result = Promise.resolve().then(operation)
    const settled = result.then(() => {}, () => {})
    request.operations.add(settled)
    void settled.then(() => request.operations.delete(settled))
    return result
  }

  async function checkBinding(request: Request, epoch: number, granted: boolean): Promise<void> {
    assertGeneration(request, epoch, granted)
    let binding: WebsiteMcpBinding
    try { binding = await inspectBinding(request.profile.serverName) }
    catch (error) {
      revoke(request)
      throw error
    }
    assertGeneration(request, epoch, granted)
    if (binding.identity !== request.profile.mcpBinding.identity || binding.endpoint !== request.profile.mcpBinding.endpoint) {
      revoke(request)
      throw new Error('Website MCP pairing changed')
    }
  }

  async function checkNative(request: Request, epoch: number, signal: AbortSignal): Promise<void> {
    assertGeneration(request, epoch, true)
    try { await validateNative(snapshot(request), signal) }
    catch (error) { revoke(request); throw error }
    assertGeneration(request, epoch, true)
    signal.throwIfAborted()
  }

  function drain(request: Request): Promise<void> {
    if (request.status !== 'revoked') return Promise.reject(new Error('Revoke the website request before draining it'))
    return request.drainage ??= Promise.resolve().then(async () => {
      while (request.operations.size > 0) await Promise.all([...request.operations])
      if (request.failures.length > 0) throw new AggregateError(request.failures, 'Website request drainage failed')
      request.drained = true
    })
  }

  async function disposeRequest(request: Request): Promise<void> {
    // Join settlement even when notification failed; drain reports the retained failure afterward.
    try { terminate(request) }
    catch (_error) { /* The request retains notification failure for drain(). */ }
    await drain(request)
  }

  function paired(serverName: string): boolean {
    return protectedNamespaces.has(serverName)
  }

  async function runAuthorized<T>(request: Request, execution: ToolExecution, epoch: number,
    getAdditionalSignal: () => AbortSignal, operation: (signal: AbortSignal) => Promise<T>, consent: WebsiteBrowserConsent | 'mcp'): Promise<T> {
    const callerSignal = callerSignals.get(execution)
    const agent = execution.agent
    if (agent === undefined || callerSignal === undefined || agent !== request.agent
      || agent.session !== request.session) throw new Error(STALE)
    const capturedSignal = AbortSignal.any([callerSignal, execution.signal, request.cancellation.signal])
    const currentSignal = () => AbortSignal.any([capturedSignal, getAdditionalSignal()])
    const assertInvocation = (): undefined => {
      if (callerSignals.get(execution) !== callerSignal) throw new Error(STALE)
      assertGeneration(request, epoch, true)
      currentSignal().throwIfAborted()
      return undefined
    }
    assertInvocation()
    ctx.tools.guardResult(execution, assertInvocation)
    const result = await tracked(request, async () => {
      assertInvocation()
      const approval = agent.ctx.get('approval')
      if (approval === undefined) throw new Error('Website operations require available human approval')
      const reason = consent === 'mcp'
        ? `Run paired website MCP tool ${JSON.stringify(execution.name)} for ${JSON.stringify(request.profile.name)} / ${JSON.stringify(request.profile.accountLabel)}. This may read sensitive website data or change the site. Tool arguments are hidden; approve only if you intend this operation. Permission applies only to this call.`
        : websiteBrowserConsentReason(consent)
      const outcome = await approval.request({ agent, toolName: execution.name, callId: execution.callId,
        signal: currentSignal(), reason, detailMode: 'summary-only' })
      assertInvocation()
      if (outcome !== 'allowed-once') throw new Error('Website operation was not approved')
      await checkBinding(request, epoch, true)
      assertInvocation()
      await checkNative(request, epoch, currentSignal())
      assertInvocation()
      const result = await operation(currentSignal())
      assertInvocation()
      await checkBinding(request, epoch, true)
      assertInvocation()
      await checkNative(request, epoch, currentSignal())
      assertInvocation()
      return result
    })
    assertInvocation()
    return result
  }

  async function guard(payload: McpToolCallEvent, next: () => Promise<unknown>): Promise<unknown> {
    if (stopped || !initialized) throw new Error(STALE)
    if (!paired(payload.serverName)) return next()
    const request = [...requests.values()].find(candidate => candidate.status === 'granted'
      && candidate.agent === payload.execution.agent && candidate.profile.serverName === payload.serverName)
    if (request === undefined) throw new Error(STALE)
    return runAuthorized(request, payload.execution, request.epoch, () => payload.signal, async (signal) => {
      payload.addCancellation(signal)
      try { return await next() }
      finally {
        // Rejected dispatches include uncancelled timeouts; neither establishes server-side settlement.
        if (payload.dispatchStatus === 'dispatched') {
          request.failures.push(new Error('MCP request has an unknown server outcome'))
          revoke(request)
        }
      }
    }, 'mcp')
  }

  const controller: WebsiteRequestsController = {
    syncProfiles(inventory) {
      if (stopped) throw new Error(STALE)
      profiles = new Map(inventory.map(profile => [profile.id, { ...profile, mcpBinding: { ...profile.mcpBinding } }]))
      for (const profile of inventory) protectedNamespaces.add(profile.serverName)
      initialized = true
      const failures: unknown[] = []
      for (const request of requests.values()) {
        const saved = profiles.get(request.profile.id)
        if (saved !== undefined && sameProfile(saved, request.profile)) continue
        try { revoke(request) }
        catch (error) { failures.push(error) }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Website inventory revocation failed')
    },
    profiles() {
      if (stopped || !initialized) throw new Error('Website pairing inventory is unavailable')
      return [...profiles.values()].map(profile => ({ ...profile, mcpBinding: { ...profile.mcpBinding } }))
    },
    create(execution, profile) {
      const callerSignal = callerSignals.get(execution)
      if (stopped || execution.agent === undefined || callerSignal === undefined || preparations.has(execution)
        || callerSignal.aborted || execution.signal.aborted) throw new Error(STALE)
      const agent = execution.agent
      const session = agent.session
      if (ctx.agents.get(agent.id) !== agent) throw new Error(STALE)
      const saved = profiles.get(profile.id)
      if (saved === undefined || !sameProfile(saved, profile)) throw new Error('Website pairing is not enrolled')
      if (requests.size >= 64) throw new Error('Website pending request limit reached')
      const request: Request = {
        id: randomUUID() as WebsiteRequestId, agent, session, callerSignal,
        profile: { ...profile, mcpBinding: { ...profile.mcpBinding } }, operations: new Set(), failures: [],
        epoch: 1, status: 'pending', terminal: false, preparing: true, cancellation: new AbortController(), validatedEpoch: undefined,
        drained: false, drainage: undefined, detachOwner: undefined,
        detachCaller: () => {}, detachPreparation: () => {}, detachTool: undefined,
      }
      requests.set(request.id, request)
      try {
        request.detachOwner = agent.ctx.effect(() => () => disposeRequest(request), 'website request owner')
        const onAbort = () => {
          try { terminate(request) }
          catch (error) { ctx.logger.error(error) }
        }
        callerSignal.addEventListener('abort', onAbort, { once: true })
        request.detachCaller = () => { callerSignal.removeEventListener('abort', onAbort) }
        const preparationSignal = execution.signal
        if (preparationSignal !== callerSignal) {
          preparationSignal.addEventListener('abort', onAbort, { once: true })
          request.detachPreparation = () => { preparationSignal.removeEventListener('abort', onAbort) }
        }
        preparations.set(execution, request)
        assertOwner(request)
        return snapshot(request)
      } catch (error) {
        requests.delete(request.id)
        request.detachCaller()
        request.detachPreparation()
        preparations.delete(execution)
        throw error
      }
    },
    async handoff(receipt, capture) {
      const request = requireRequest(receipt.requestId)
      controller.assertCurrent(receipt)
      if (!request.preparing || request.status !== 'pending') throw new Error('Website request is not awaiting capture')
      await tracked(request, async () => {
        await checkBinding(request, receipt.epoch, false)
        await capture(request.cancellation.signal)
        await checkBinding(request, receipt.epoch, false)
      })
      controller.assertCurrent(receipt)
    },
    validate(id, epoch) {
      const request = requireRequest(id)
      assertOwner(request)
      if (request.preparing) throw new Error('Website preparation has not settled')
      if (request.epoch !== epoch) return Promise.reject(new Error(STALE))
      if (request.status === 'granted') return Promise.reject(new Error('Website request is already granted'))
      if (request.status === 'revoked') {
        if (!request.drained) return Promise.reject(new Error('Website request drainage is incomplete'))
        request.status = 'pending'
        request.cancellation = new AbortController()
        request.drained = false
        request.drainage = undefined
      }
      return tracked(request, async () => {
        await checkBinding(request, epoch, false)
        assertGeneration(request, epoch, false)
        request.validatedEpoch = epoch
        return snapshot(request)
      })
    },
    commit(id, epoch) {
      const request = requireRequest(id)
      assertGeneration(request, epoch, false)
      if (request.validatedEpoch !== epoch) throw new Error('Validate the website request before committing it')
      request.validatedEpoch = undefined
      return tracked(request, async () => {
        await checkBinding(request, epoch, false)
        assertGeneration(request, epoch, false)
        for (const other of requests.values()) {
          if (other === request
            || (other.profile.id !== request.profile.id && other.profile.serverName !== request.profile.serverName)) continue
          if (other.status === 'granted' || (other.status === 'revoked' && !other.drained)) {
            throw new Error('Website account is still held by another request')
          }
        }
        request.status = 'granted'
        try {
          request.detachTool = installTool?.({ agent: request.agent, session: request.session,
            request: snapshot(request), profile: request.profile,
            run: (execution, operation, consent) => runAuthorized(request, execution, epoch, () => execution.signal, async (signal) => {
              try { return await operation(signal) }
              catch (error) {
                if (error instanceof WebsiteOperationUnknownOutcomeError) {
                  request.failures.push(error)
                  revoke(request)
                }
                throw error
              }
            }, consent),
          })
          assertGeneration(request, epoch, true)
          return snapshot(request)
        } catch (error) {
          // An installer may revoke synchronously before returning its disposer.
          detachTool(request)
          revoke(request)
          throw error
        }
      })
    },
    assertDrained(id) {
      const request = requireRequest(id)
      if (request.status !== 'revoked' || !request.drained) throw new Error('Website drainage acknowledgement is stale')
    },
    assertCurrent(saved) {
      const request = requireRequest(saved.requestId)
      if (saved.status !== 'revoked') assertOwner(request)
      if (request.epoch !== saved.epoch || request.status !== saved.status
        || request.cancellation.signal !== saved.signal || request.terminal !== (saved.terminal === true)
        || (request.status !== 'revoked' && saved.signal.aborted)) throw new Error(STALE)
    },
    revoke(id) {
      const request = requireRequest(id)
      revoke(request)
      return snapshot(request)
    },
    drain(id) { return drain(requireRequest(id)) },
    async remove(id) {
      const request = requireRequest(id)
      if (request.status !== 'revoked' || !request.drained) throw new Error('Drain the website request before removing it')
      await request.detachOwner?.()
      await drain(request)
      request.detachCaller()
      request.detachPreparation()
      requests.delete(id)
    },
    async run(execution, id, epoch, operation) {
      return runAuthorized(requireRequest(id), execution, epoch, () => execution.signal, operation, { operation: 'page-info' })
    },
  }

  ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', (execution, next) => {
      // Dispatch wrappers replace the body signal and discard its relays after settlement.
      callerSignals.set(execution, execution.signal)
      return next()
    })
    yield ctx.on('tools/result', (execution, result) => {
      callerSignals.delete(execution)
      const request = preparations.get(execution)
      preparations.delete(execution)
      if (request !== undefined) {
        request.preparing = false
        request.detachPreparation()
        if (result.isError && requests.get(request.id) === request) terminate(request)
      }
      return undefined
    })
    yield ctx.on('mcp/tool-call', guard)
    yield async () => {
      stopped = true
      const outcomes = await Promise.allSettled([...requests.values()].map(disposeRequest))
      const detachments = await Promise.allSettled([...requests.values()].map(async (request) => { await request.detachOwner?.() }))
      for (const request of requests.values()) {
        request.detachCaller()
        request.detachPreparation()
      }
      const failures = [...outcomes, ...detachments].filter(outcome => outcome.status === 'rejected')
        .map((outcome): unknown => outcome.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Website requests teardown failed')
      requests.clear()
    }
  }, 'website requests')
  return controller
}
