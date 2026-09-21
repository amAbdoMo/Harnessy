/**
 * Package-local composition for the roster's tests: the real services the
 * plugin composes with, a scripted child backend that records every start
 * request, and the calling-agent stubs the authority checks read.
 *
 * This file is not a spec, so importing it never registers another file's
 * suites. Only the child backend stands in for a real one, because the roster's
 * contract with a backend is exactly the request it hands it.
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { createInboxStub, mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { defaultSubagentSettings } from '../src/defaults.ts'
import * as roster from '../src/index.ts'
import type { SubagentRosterController } from '../src/index.ts'
import { SubagentRunLimiter } from '../src/limiter.ts'
import {
  resolveSubagentConcurrencyLimit,
  SUBAGENT_ROSTER_NAMESPACE,
  subagentRosterView,
} from '../src/settings.ts'
import { DELEGATE_TOOL, installRosterTools, LIST_SUBAGENTS_TOOL } from '../src/tools.ts'
import type { SubagentDefinition, SubagentSettings } from '../src/types.ts'

/** Shared non-aborted tool signal for package-local integration tests. */
export const testToolSignal = new AbortController().signal

/**
 * The smallest real settings provider: one in-memory document, always
 * writable, so the plugin's settings registration is exercised end to end.
 */
export class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  /** Namespaces this provider persisted a user section for, in write order. */
  readonly writes: string[] = []

  constructor(ctx: Context, options: { readonly doc?: Record<string, unknown> } = {}) {
    super(ctx)
    this.doc = structuredClone(options.doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.writes.push(String(ns))
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

/** One registry-compatible live agent with a real Session the projections fold. */
export interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  readonly inbox: Inbox
  setStatus(status: AgentStatus): void
}

/** Build one registry-compatible live agent whose injections enter its test Inbox. */
export function stubAgent(ctx: Context, rawId: string): StubAgent {
  const session = ctx.sessions.create(SessionId(rawId))
  if (ctx.sessions.get(session.id) !== session) ctx.sessions.enter(session)
  const inbox = createInboxStub()
  let status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    get status() { return status },
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) {
      this.inbox.append('next-step', input)
    },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session, inbox, setStatus(value) { status = value } }
}

/** Open one message-triggered turn with its accepted model-visible input. */
export function openTurn(stub: StubAgent, source: MessageSource, text = 'prompt'): number {
  const turn = stub.session.snapshotEvents()
    .filter(event => event.type === 'turn/start')
    .reduce((max, event) => Math.max(max, event.data.turn), 0) + 1
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source,
  })
  stub.agent.inbox.append('next-turn', message)
  const claimed = stub.inbox.splice('next-turn', 0, 1, [])
  if (claimed.length === 0) throw new Error('expected queued turn input')
  stub.session.append('turn/start', { turn })
  for (const admitted of claimed) {
    stub.session.append('user/message', admitted, { surfaceOp: 'append' })
  }
  return turn
}

/** Close the currently open test turn. */
export function closeTurn(stub: StubAgent, turn: number): void {
  stub.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/**
 * A calling agent carrying nothing but the workspace header. Enough for every
 * path that does not read the agent registry or the session log.
 */
export function headerAgent(workspace?: string): Agent {
  return {
    session: {
      header: workspace === undefined ? {} : { cwd: workspace },
      requestHeader: () => undefined,
    },
  } as unknown as Agent
}

/** Every scripted-backend observation one harness collected. */
export interface ChildObservations {
  /** Start requests the roster handed the backend, in order. */
  readonly requests: SubagentStartRequest[]
  /** Starts refused because the caller had already cancelled. */
  readonly refused: SubagentStartRequest[]
  /** One settle hook per start currently held by a test. */
  readonly releases: Array<() => void>
}

/** One complete definition with the fields a test does not care about defaulted. */
export function definition(
  fields: Partial<SubagentDefinition> & { readonly id: string },
): SubagentDefinition {
  return {
    name: fields.id,
    enabled: true,
    purpose: `${fields.id} purpose`,
    whenToUse: '',
    invocation: 'automatic',
    model: { mode: 'fixed' },
    access: 'inherit',
    instructions: '',
    execution: { backend: 'spawn', background: 'foreground' },
    ...fields,
  }
}

/** One complete settings document holding exactly these definitions. */
export function documentOf(
  definitions: readonly SubagentDefinition[],
  rest: Partial<SubagentSettings> = {},
): SubagentSettings {
  return {
    subagents: [...definitions],
    overrides: {},
    automaticRouting: { enabled: false, allowedModels: [] },
    limits: { maxConcurrentRuns: 2, defaultTimeoutMs: 3_600_000 },
    ...rest,
  }
}

/** Options for one scripted child backend. */
export interface ScriptedChildOptions {
  /** Registry name the roster's definitions must name. */
  readonly name: string
  /** Final text the child reports. */
  readonly reply?: string
  /** Terminal reason of every child. */
  readonly stopReason?: SubagentStopReason
  /** Non-assistant detail for a non-completed child. */
  readonly diagnostic?: string
  /** Start-time features this backend advertises. */
  readonly capabilities?: Partial<SubagentCapabilities>
  /** Backend-owned route defaults applied under a tool's own selection. */
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  /** Hold every start until the test releases it, so concurrency stays observable. */
  readonly hold?: boolean
  /** Refuse every start with this failure, either at once or once the caller cancels. */
  readonly refuse?: { readonly failure: 'error' | 'aggregate'; readonly afterAbort?: boolean }
}

const DEFAULT_CHILD_CAPABILITIES: SubagentCapabilities = {
  agentOptions: true,
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
  accessPolicy: true,
  runtimeRoute: true,
}

/** Scripted backend: records the request, then settles as the test asks. */
class ScriptedChildProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities

  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly options: ScriptedChildOptions,
    private readonly seen: ChildObservations,
  ) {
    this.capabilities = { ...DEFAULT_CHILD_CAPABILITIES, ...options.capabilities }
  }

  start(request: SubagentStartRequest): Promise<SubagentRun> {
    if (request.signal.aborted && this.options.refuse === undefined) {
      this.seen.refused.push(request)
      return Promise.reject(new Error('scripted child start refused a cancelled caller'))
    }
    this.seen.requests.push(request)
    const refusal = this.options.refuse
    if (refusal !== undefined) {
      const failure = (): Error => refusal.failure === 'aggregate'
        ? new AggregateError([new Error('child startup failed')], 'the child failed to start')
        : new Error('the child failed to start')
      if (refusal.afterAbort !== true) return Promise.reject(failure())
      return new Promise<SubagentRun>((_resolve, reject) => {
        if (request.signal.aborted) {
          reject(failure())
          return
        }
        request.signal.addEventListener('abort', () => { reject(failure()) }, { once: true })
      })
    }
    const output: ContentBlock[] = [{ type: 'text', text: this.options.reply ?? 'scripted child reply' }]
    const state = { cancelled: false }
    const result = new Promise<SubagentResult>((resolve) => {
      const settle = (): void => {
        resolve({
          output,
          ...this.options.diagnostic === undefined || state.cancelled
            ? {}
            : { diagnostic: this.options.diagnostic },
          stopReason: state.cancelled ? 'aborted' : this.options.stopReason ?? 'completed',
        })
      }
      if (this.options.hold === true) {
        this.seen.releases.push(settle)
        request.signal.addEventListener('abort', () => {
          state.cancelled = true
          settle()
        }, { once: true })
        return
      }
      if (request.signal.aborted) state.cancelled = true
      else request.signal.addEventListener('abort', () => { state.cancelled = true }, { once: true })
      setTimeout(settle, 0)
    })
    return Promise.resolve({
      id: SessionId(`scripted-child:${this.name}:${request.parent.id}`),
      localAgent: undefined,
      result,
      dispose: () => {
        state.cancelled = true
        return Promise.resolve()
      },
    })
  }
}

/** Mount one scripted backend through an effect-scoped local plugin. */
async function mountChild(
  ctx: Context,
  options: ScriptedChildOptions,
  seen: ChildObservations,
): Promise<void> {
  await ctx.plugin({
    name: `roster-test-child:${options.name}`,
    inject: ['subagents'],
    apply(pluginCtx: Context): void {
      const provider = new ScriptedChildProvider(options.name, options, seen)
      pluginCtx.subagents.registerProvider(options.agentRouteDefaults === undefined
        ? provider
        : Object.assign(provider, { agentRouteDefaults: options.agentRouteDefaults }))
    },
  })
}

/** Options for one roster harness. */
export interface RosterOptions {
  /** Complete settings the api reads through; the shipped document by default. */
  readonly settings?: SubagentSettings
  /** Workspace the delegating session reports, unless the agent names its own. */
  readonly workspace?: string
  /** Scripted backends to register, in order; the shipped `spawn` backend alone by default. */
  readonly children?: readonly ScriptedChildOptions[]
  /** Mount the process-local job registry, so background delegation can register. */
  readonly jobs?: boolean
  /** Mount the approval service, so `ask-first` has a channel to ask on. */
  readonly approval?: boolean
  /** Hold every run-gate admission until the test releases it. */
  readonly holdPermit?: boolean
  /**
   * Compose without the LLM runtime, as a deployment that resolves no child
   * route does. Every other service the tools read is still mounted.
   */
  readonly withoutLlm?: boolean
}

/** One booted roster and everything its tests observe. */
export interface Roster {
  readonly ctx: Context
  /** Start requests the child backend received, in order. */
  readonly requests: SubagentStartRequest[]
  /** Starts refused because the caller had already cancelled. */
  readonly refused: SubagentStartRequest[]
  /** Delegations currently holding a run-gate permit. */
  inFlight(): number
  /** Replace the settings document the api reads through. */
  configure(settings: SubagentSettings): void
  /** Settle the oldest held child start. */
  release(): void
  /** Admit the oldest queued run-gate request. */
  releasePermit(): void
  /** Runs that reached the run gate, admitted or queued. */
  acquireCalls(): number
  dispose(): Promise<void>
}

/** Mount the roster's tools over the real services they compose with. */
export async function bootRoster(options: RosterOptions = {}): Promise<Roster> {
  const ctx = new Context()
  if (options.withoutLlm === true) {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
  } else {
    await mountAgentLoopTestDependencies(ctx)
  }
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(SubagentRuntime)
  if (options.jobs === true) {
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('roster-test')
  }
  if (options.approval === true) await ctx.plugin(ApprovalService)

  const seen: ChildObservations = { requests: [], refused: [], releases: [] }
  for (const child of options.children ?? [{ name: 'spawn' }]) await mountChild(ctx, child, seen)

  let settings = options.settings ?? defaultSubagentSettings()
  let permits = 0
  let acquireCalls = 0
  const admit: Array<() => void> = []
  const limiter = new SubagentRunLimiter(
    () => resolveSubagentConcurrencyLimit(settings.limits.maxConcurrentRuns),
  )
  installRosterTools(ctx, {
    viewFor: workspace => subagentRosterView(settings, workspace ?? options.workspace ?? null),
    acquire: async (signal) => {
      acquireCalls += 1
      if (options.holdPermit === true) {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled while queued'))
          }, { once: true })
          admit.push(resolve)
        })
        signal.throwIfAborted()
      }
      const release = await limiter.acquire(signal)
      permits += 1
      return () => {
        permits -= 1
        release()
      }
    },
  })
  return {
    ctx,
    requests: seen.requests,
    refused: seen.refused,
    inFlight: () => permits,
    configure: (next) => { settings = next },
    release: () => { seen.releases.shift()?.() },
    releasePermit: () => { admit.shift()?.() },
    acquireCalls: () => acquireCalls,
    dispose: () => ctx.fiber.dispose(),
  }
}

let callCounter = 0

/** Anything that owns a context with the roster's tools registered on it. */
export interface ToolHost {
  readonly ctx: Context
}

/** Execute one registered roster tool through the real ToolRuntime pipeline. */
export function call(
  host: ToolHost,
  name: string,
  args: Record<string, unknown>,
  agent?: Agent,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  return host.ctx.tools.execute({
    signal: signal ?? testToolSignal,
    callId: ToolCallId(`roster-${++callCounter}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

/** Delegate through the roster's model-facing tool. */
export function delegate(
  host: ToolHost,
  args: Record<string, unknown>,
  agent?: Agent,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  return call(host, DELEGATE_TOOL, args, agent, signal)
}

/** Read the roster's directory through its model-facing tool. */
export function listSubagents(host: ToolHost, agent?: Agent): Promise<ToolExecutionResult> {
  return call(host, LIST_SUBAGENTS_TOOL, {}, agent)
}

/** Join the text blocks of one rendered tool result. */
export function text(result: ToolExecutionResult): string {
  return result.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** The JSON-Schema object one registered tool declares for its parameters. */
export function parametersOf(ctx: Context, name: string, agent?: Agent): Record<string, unknown> {
  const schema = ctx.tools.schemas(agent).find(entry => entry.name === name)
  if (schema === undefined) throw new Error(`tool ${name} is not registered`)
  return (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
}

/** Wait until a condition holds, without racing the event loop. */
export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
  throw new Error('the awaited condition never held')
}

/** One booted shipped-plugin composition over a real settings provider. */
export interface PluginRoster {
  readonly ctx: Context
  /** The provider's own context, which owns the settings write path. */
  readonly settingsCtx: Context
  /** The Host Remote controller the generated Client namespace addresses. */
  readonly controller: SubagentRosterController
  /** Detach the settings provider, as a storage backend going away does. */
  detachSettings(): Promise<void>
  /** Dispose only the plugin's own contributions. */
  dispose(): Promise<void>
}

/**
 * Mount the shipped plugin itself over a real settings provider, so its
 * settings registration, read-through, and Remote surface are exercised as a
 * session and the Settings page see them.
 * @param settings - the stored roster document, or none for the shipped entry.
 * @param provider - whether the provider mounts before the plugin, attaches
 *   after the section is installed, or is absent altogether.
 * @returns the booted composition.
 */
export async function bootPlugin(
  settings?: SubagentSettings,
  provider: 'before' | 'after' | 'none' = 'before',
): Promise<PluginRoster> {
  const ctx = new Context()
  const doc = settings === undefined ? {} : { [SUBAGENT_ROSTER_NAMESPACE]: settings }
  await mountAgentLoopTestDependencies(ctx)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(TypertRegistry)
  await mountChild(ctx, { name: 'spawn' }, { requests: [], refused: [], releases: [] })
  const rosterFiber = provider === 'after' ? await ctx.plugin(roster) : undefined
  const settingsFiber = provider === 'none' ? undefined : ctx.plugin(MemorySettings, { doc })
  await settingsFiber?.await()
  const fiber = rosterFiber ?? await ctx.plugin(roster)
  // The controller mounts as this plugin's child fiber, so it is the child's
  // registration that publishes the service the generated client calls.
  await waitFor(() => ctx.get('subagentRosterController') !== undefined)
  return {
    ctx,
    settingsCtx: settingsFiber?.ctx ?? ctx,
    controller: ctx.get('subagentRosterController') as SubagentRosterController,
    detachSettings: () => settingsFiber?.dispose() ?? Promise.resolve(),
    dispose: () => fiber.dispose(),
  }
}
