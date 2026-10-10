/** Host-lifetime ownership of explicitly approved, immutable project preview launchers. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  DevicePreviewProjectId, DevicePreviewRequestId, DevicePreviewResponse, DevicePreviewServerState,
} from '@deepseek-ai/dsh-client-ui-device-preview/types'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { JobOutcome, JobOutputSource, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { SandboxExecutionPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'

/** Detection never executes scripts; a plan requires an explicit script and a known or supplied URL. */
export interface DevicePreviewProjectResult {
  readonly project: string
  readonly choices: Array<{ script: string; command: string; knownUrl?: string }>
  readonly plan?: { projectId: DevicePreviewProjectId; cwd: string; command: string; url: string }
  readonly needsInput: boolean
}

/** Opening resolves launcher state only; the caller owns Main opening and separate observation approval. */
export interface DevicePreviewController {
  /** @param request - existing project, optional exact script and URL. @param execution - initiating tool invocation.
   * @returns detected choices and an optional immutable, app-run launch plan; never launches or installs. */
  project(request: { project: string; script?: string; url?: string }, execution: ToolExecution): Promise<DevicePreviewProjectResult>
  /** @param request - external URL or exact prepared plan. @param execution - current initiating invocation.
   * @returns external state or an approved owned launcher; running requires a complete startup line naming the exact URL,
   * never an HTTP probe.
   */
  open(request: { url: string; projectId?: string }, execution: ToolExecution): Promise<DevicePreviewServerState>
  /** @param projectId - recorded owned launch plan. @returns only after its provider-managed range is empty. */
  stop(projectId: string): Promise<{ kind: 'stopped'; projectId: DevicePreviewProjectId }>
  /** @param message - trusted Main IPC data. @returns whether the stop channel consumed it; replies settle asynchronously. */
  receive(message: unknown): boolean
  /** Fence admission, begin all owned stops and await admitted work plus managed-range quiescence; rejects incomplete cleanup. */
  dispose(): Promise<void>
  /** @returns injection readiness; await after configured providers load, not during boot setup. */
  await(): Promise<void>
}

// Fixed input/output security ceilings; no spill, network probes or unbounded startup transcript.
const MANIFEST_BYTES = 128 * 1024
const OUTPUT_BYTES = 32 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SCRIPT = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/
const WEB_NAME = /(?:^|[:._-])web(?:$|[:._-])/i
const WEB_COMMAND = /(?:^|\s)--web(?:\s|$)|\bexpo\s+(?:export:web|start\s+--web)\b/i
const MOBILE_COMMAND = /\b(?:metro|react-native|expo)\b/i

type Services = { fs: FileSystem; subprocess: SubprocessRuntime; policy: SandboxPolicyService; jobs: JobRegistry }
type Manifest = { cwd: string; path: string; hash: string; scripts: Record<string, string> }
type Permission = {
  agent: Agent
  approval: ApprovalService
  policy: SandboxExecutionPolicy
  services: Services
  sandbox: SandboxProvider | undefined
  key: string
}
type Grant = { agent: Agent; approval: ApprovalService; sandbox: SandboxProvider | undefined; key: string }
type Owned = { handle: SubprocessHandle; state: DevicePreviewServerState; done: Promise<JobOutcome>; stopping?: Promise<void> }
type Plan = {
  id: DevicePreviewProjectId
  manifest: Manifest
  script: string
  command: string
  url: string
  argv: readonly string[]
  services: Services
  grants: Grant[]
  owned?: Owned
  startup?: Promise<DevicePreviewServerState>
  startupCancellation?: AbortController
  stopping: boolean
  everOwned: boolean
}

function record(packet: unknown): packet is Record<string, unknown> {
  if (typeof packet !== 'object' || packet === null || Array.isArray(packet)) return false
  const prototype = Object.getPrototypeOf(packet)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(packet).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(packet, key)
    return typeof key === 'string' && descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
  })
}

function canonicalUrl(input: string): string {
  if (Buffer.byteLength(input) > 2048 || /[\u0000-\u0020]/.test(input)) throw new Error('Preview URL is invalid')
  const url = new URL(input)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Preview requires a credential-free HTTP(S) URL')
  if (Buffer.byteLength(url.href) > 2048) throw new Error('Canonical preview URL exceeds the limit')
  return url.href
}

function knownUrl(command: string): string | undefined {
  const urls = command.match(/https?:\/\/[^\s'"`]+/g)
  const url = urls?.length === 1 ? urls[0] : undefined
  if (url === undefined || /[$<>\\]/.test(url)) return undefined
  try { return canonicalUrl(url) }
  catch (_error) { return undefined /* An invalid script literal is not a known endpoint. */ }
}

function startupReady(evidence: string, url: string): boolean {
  const lines = evidence.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).slice(0, -1)
  return lines.some(line => /\b(?:ready|listening|local)\b/i.test(line)
    && !/\b(?:not|never)\s+(?:ready|listening)\b/i.test(line)
    && (line.match(/https?:\/\/[^\s'"`]+/g) ?? []).some((endpoint) => {
      try { return canonicalUrl(endpoint) === url }
      catch (_error) { return false /* Invalid output cannot establish readiness. */ }
    }))
}

function webScript(script: string, command: string): boolean {
  const explicitWeb = WEB_NAME.test(script) || WEB_COMMAND.test(command)
  return SCRIPT.test(script) && (['start', 'dev', 'preview'].includes(script) || explicitWeb)
    && (!MOBILE_COMMAND.test(command) || explicitWeb)
}

async function manifest(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<Manifest> {
  const directory = await fs.resolve(cwd, { signal })
  const canonicalCwd = fs.processPath(directory)
  if ((await fs.stat(directory, signal))?.type !== 'directory') throw new Error('Preview project must be an existing directory')
  const target = await fs.resolve('package.json', { cwd: canonicalCwd, signal })
  const bytes = await fs.readBytes(target, signal, MANIFEST_BYTES)
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!record(parsed) || !record(parsed.scripts)) throw new Error('Preview project requires existing package.json scripts')
  const scripts: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [script, command] of Object.entries(parsed.scripts)) {
    if (typeof command !== 'string') throw new Error('Project script commands must be strings')
    if (command.trim() && webScript(script, command)) scripts[script] = command
  }
  return { cwd: canonicalCwd, path: fs.processPath(target), hash: createHash('sha256').update(bytes).digest('hex'), scripts }
}

async function launcher(subprocess: SubprocessRuntime, script: string, signal: AbortSignal) {
  const environment = await subprocess.terminalEnvironment(signal)
  const shell = await subprocess.resolveExecutable(environment.platform === 'windows' ? 'pwsh' : 'bash', undefined, signal)
  const command = environment.platform === 'windows' ? `npm.cmd run '${script}'` : `npm run '${script}'`
  const argv = environment.platform === 'windows'
    ? [shell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${command}; exit $LASTEXITCODE`]
    : [shell, '--noprofile', '--norc', '-c', command]
  return { command, argv }
}

function permissionKey(policy: SandboxExecutionPolicy): string {
  return JSON.stringify([policy.mode, policy.workspaceRoot, policy.sessionId])
}

function providerIdentity(provider: object | undefined): unknown {
  // Cordis creates a new caller-bound proxy on each service lookup.
  return provider === undefined ? undefined : Reflect.get(provider, symbols.original) ?? provider
}

function samePermission(left: Permission, right: Permission): boolean {
  return left.agent === right.agent && providerIdentity(left.approval) === providerIdentity(right.approval)
    && providerIdentity(left.sandbox) === providerIdentity(right.sandbox) && left.key === right.key
    && left.services === right.services
}

/**
 * @param ctx - unscoped Desktop Host lifetime; resources are not owned by the initiating Session.
 * @param send - private Main response sender; no preview opening or observation is performed here.
 * @returns a readiness-aware controller; every new spawn requires exact-plan approval and current confinement.
 */
export function installDevicePreviewController(ctx: Context, send: (message: object) => Promise<void>): DevicePreviewController {
  const plans = new Map<DevicePreviewProjectId, Plan>()
  const planKeys = new Map<string, Plan>()
  ctx.on('agent/disposed', ({ agent }) => {
    for (const plan of plans.values()) plan.grants = plan.grants.filter(grant => grant.agent !== agent)
  })
  const pending = new Set<Promise<unknown>>()
  const lifetime = new AbortController()
  let stopped = false
  let disposal: Promise<void> | undefined
  let services: Services | undefined
  const injection = ctx.inject(['fs', 'subprocess', 'sandboxPolicy', 'jobs'], (scope) => {
    services = { fs: scope.fs, subprocess: scope.subprocess, policy: scope.sandboxPolicy, jobs: scope.jobs }
    const detach = scope.jobs.attachController('desktop-device-preview')
    return async () => { try { await dispose() } finally { detach() } }
  })

  function track<T>(operation: () => Promise<T>): Promise<T> {
    const promise = operation()
    pending.add(promise)
    void promise.then(() => pending.delete(promise), () => pending.delete(promise))
    return promise
  }

  function check(execution: ToolExecution): Agent {
    if (stopped) throw new Error('Device preview Host is stopping')
    execution.signal.throwIfAborted()
    if (execution.agent === undefined) throw new Error('Device preview requires an initiating Agent Session')
    return execution.agent
  }

  async function ready(execution: ToolExecution): Promise<Services> {
    check(execution)
    await injection.await()
    check(execution)
    if (services === undefined) throw new Error('Device preview providers are unavailable')
    return services
  }

  function permission(execution: ToolExecution, mounted: Services): Permission {
    const agent = check(execution)
    const approval = agent.ctx.get('approval')
    if (approval === undefined || (approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask') === 'never') {
      throw new Error('New preview launches require available human approval')
    }
    if (services !== mounted) throw new Error('Preview providers changed; prepare a new plan')
    const policy = mounted.policy.resolve({ session: agent.session })
    const sandbox = ctx.get('sandbox')
    if (policy.mode !== 'danger-full-access' && sandbox === undefined) throw new Error('Preview confinement is unavailable')
    return { agent, approval, policy, services: mounted, sandbox, key: permissionKey(policy) }
  }

  async function validate(plan: Plan, signal: AbortSignal): Promise<void> {
    const shell = await launcher(plan.services.subprocess, plan.script, signal)
    const current = await manifest(plan.services.fs, plan.manifest.cwd, signal)
    if (current.cwd !== plan.manifest.cwd || current.path !== plan.manifest.path || current.hash !== plan.manifest.hash
      || current.scripts[plan.script] === undefined || shell.command !== plan.command
      || JSON.stringify(shell.argv) !== JSON.stringify(plan.argv)) {
      plan.grants.length = 0
      throw new Error('Preview launch plan changed; prepare the project again')
    }
  }

  async function authorize(plan: Plan, execution: ToolExecution, captured: Permission, signal: AbortSignal): Promise<void> {
    const granted = plan.grants.some(grant => grant.agent === captured.agent
      && providerIdentity(grant.approval) === providerIdentity(captured.approval)
      && providerIdentity(grant.sandbox) === providerIdentity(captured.sandbox) && grant.key === captured.key)
    if (granted) return
    const reason = 'enable this exact project preview launcher for this app run: '
      + JSON.stringify({ projectId: plan.id, cwd: plan.manifest.cwd, manifest: plan.manifest.path,
        manifestHash: plan.manifest.hash, script: plan.script, scriptCommand: plan.manifest.scripts[plan.script],
        command: plan.command, argv: plan.argv, url: plan.url, permissions: captured.policy })
      + '. Allowed-once enables only this unchanged plan under these same execution permissions until this Host exits, including explicit restarts after Stop; it grants no page observation.'
    const outcome = await captured.approval.request({ agent: captured.agent, toolName: execution.name,
      callId: execution.callId, signal, reason, detailMode: 'summary-only' })
    if (outcome !== 'allowed-once') throw new Error('Preview launcher was not approved')
    signal.throwIfAborted()
    if (!samePermission(captured, permission(execution, plan.services))) throw new Error('Preview launch permissions changed')
    plan.grants.push({ agent: captured.agent, approval: captured.approval, sandbox: captured.sandbox, key: captured.key })
  }

  async function settled(handle: SubprocessHandle, plan: Plan): Promise<JobOutcome> {
    let outcome: JobOutcome
    try {
      const exit = await handle.done
      outcome = { status: plan.stopping ? 'killed' : exit.exitCode === 0 ? 'completed' : 'failed' }
    } catch (_error) { outcome = { status: 'failed', detail: 'Preview launcher failed' } }
    try {
      if (!await handle.waitForExit()) throw new Error('Preview process range did not settle')
    } catch (error) {
      const owned = plan.owned
      if (owned !== undefined && owned.handle === handle) owned.state = { ...owned.state, status: 'failed' }
      throw error
    }
    const owned = plan.owned
    if (owned !== undefined && owned.handle === handle) {
      owned.state = { ...owned.state, status: outcome.status === 'failed' ? 'failed' : 'stopped' }
    }
    return outcome
  }

  function output(getOwned: () => Owned | undefined, channel: 'stdout' | 'stderr', url: string): JobOutputSource {
    let remaining = OUTPUT_BYTES
    let evidence = ''
    return { channel, read(fromByte) {
      const owned = getOwned()
      const reader = owned?.handle.collected[channel]
      if (reader === undefined || remaining === 0) return { text: '', nextOffset: fromByte, lossy: false }
      const chunk = reader.readFrom(fromByte)
      const bytes = Buffer.from(chunk.text)
      const text = new TextDecoder().decode(bytes.subarray(0, remaining), { stream: true })
      remaining -= Math.min(remaining, bytes.length)
      evidence = `${chunk.lossy ? '' : evidence}${text}`.slice(-4096)
      if (owned !== undefined && !stopped && owned.stopping === undefined && owned.state.status === 'starting'
        && startupReady(evidence, url)) {
        owned.state = { ...owned.state, status: 'running' }
      }
      return { text, nextOffset: chunk.nextOffset, lossy: chunk.lossy || bytes.length > Buffer.byteLength(text) }
    } }
  }

  function spawn(plan: Plan, argv: readonly string[]): DevicePreviewServerState {
    let owned: Owned | undefined
    const jobId = plan.services.jobs.start({ kind: 'bash', label: plan.command,
      output: [output(() => owned, 'stdout', plan.url), output(() => owned, 'stderr', plan.url)], run() {
        const handle = plan.services.subprocess.spawn({ argv, cwd: plan.manifest.cwd, graceMs: 1000,
          stdio: { stdin: 'ignore', stdout: { maxBytes: OUTPUT_BYTES }, stderr: { maxBytes: OUTPUT_BYTES } },
          // Providers scrub ambient credentials; these tombstones also suppress ambient code injection.
          env: { BASH_ENV: undefined, ENV: undefined, NODE_OPTIONS: undefined } })
        owned = { handle, state: { projectId: plan.id, cwd: plan.manifest.cwd, command: plan.command,
          url: plan.url, ownership: 'owned', status: 'starting' }, done: settled(handle, plan) }
        plan.owned = owned
        plan.everOwned = true
        const resource = owned
        return { cancel: () => { void stopRange(plan, resource).catch(error => ctx.logger.error(error)) },
          done: resource.done.catch((_error: unknown): JobOutcome => ({ status: 'failed', detail: 'Preview process range could not be observed' })) }
      } })
    if (owned === undefined) throw new Error('Preview job did not start its launcher')
    owned.state = { ...owned.state, jobId }
    return { ...owned.state }
  }

  async function launch(plan: Plan, execution: ToolExecution, cancellation: AbortController): Promise<DevicePreviewServerState> {
    const signal = AbortSignal.any([execution.signal, lifetime.signal, cancellation.signal])
    const captured = permission(execution, plan.services)
    await validate(plan, signal)
    await authorize(plan, execution, captured, signal)
    const policy = captured.policy
    let argv: readonly string[]
    if (policy.mode === 'danger-full-access') argv = plan.argv
    else {
      const sandbox = captured.sandbox
      if (sandbox === undefined) throw new Error('Preview confinement is unavailable')
      argv = (await sandbox.confine(plan.argv, { ...policy, mode: policy.mode }, signal)).argv
    }
    // Both asynchronous approval and confinement can outlive a manifest edit or permission change.
    await validate(plan, signal)
    signal.throwIfAborted()
    if (plan.stopping || !samePermission(captured, permission(execution, plan.services))) throw new Error('Preview launch was withdrawn')
    return spawn(plan, argv)
  }

  async function project(
    request: { project: string; script?: string; url?: string }, execution: ToolExecution,
  ): Promise<DevicePreviewProjectResult> {
    const mounted = await ready(execution)
    const agent = check(execution)
    const signal = AbortSignal.any([execution.signal, lifetime.signal])
    const cwd = agent.session.header.cwd
    const directory = await mounted.fs.resolve(request.project, { ...cwd === undefined ? {} : { cwd }, signal })
    const detected = await manifest(mounted.fs, mounted.fs.processPath(directory), signal)
    const choices = Object.entries(detected.scripts).map(([script, command]) => {
      const url = knownUrl(command)
      return { script, command, ...url === undefined ? {} : { knownUrl: url } }
    })
    if (request.script === undefined) return { project: detected.cwd, choices, needsInput: true }
    const command = detected.scripts[request.script]
    if (command === undefined || !Object.hasOwn(detected.scripts, request.script)) throw new Error('Choose an existing web preview script')
    const url = request.url === undefined ? knownUrl(command) : canonicalUrl(request.url)
    if (url === undefined) return { project: detected.cwd, choices, needsInput: true }
    const shell = await launcher(mounted.subprocess, request.script, signal)
    check(execution)
    const key = JSON.stringify([detected.cwd, detected.path, detected.hash, request.script, shell.argv, url])
    let plan = planKeys.get(key)
    if (plan === undefined || plan.services !== mounted) {
      plan = { id: randomUUID() as DevicePreviewProjectId, manifest: detected, script: request.script,
        command: shell.command, argv: shell.argv, url, services: mounted, grants: [], stopping: false, everOwned: false }
      plans.set(plan.id, plan)
      planKeys.set(key, plan)
    }
    return { project: detected.cwd, choices, needsInput: false,
      plan: { projectId: plan.id, cwd: detected.cwd, command: plan.command, url } }
  }

  async function open(request: { url: string; projectId?: string }, execution: ToolExecution): Promise<DevicePreviewServerState> {
    check(execution)
    const url = canonicalUrl(request.url)
    if (request.projectId === undefined) return { cwd: '', url, ownership: 'external', status: 'external' }
    await ready(execution)
    const plan = plans.get(request.projectId as DevicePreviewProjectId)
    if (plan === undefined || plan.url !== url) throw new Error('Use the exact prepared preview plan and URL')
    if (plan.stopping) throw new Error('Preview launcher is stopping')
    if (plan.owned !== undefined) return { ...plan.owned.state }
    permission(execution, plan.services)
    if (plan.startup === undefined) {
      const cancellation = new AbortController()
      plan.startupCancellation = cancellation
      const startup = launch(plan, execution, cancellation)
      plan.startup = startup
      const finish = () => { delete plan.startup; delete plan.startupCancellation }
      void startup.then(finish, finish)
    }
    const state = await plan.startup
    check(execution)
    return { ...state }
  }

  function stopRange(plan: Plan, owned: Owned): Promise<void> {
    if (owned.stopping !== undefined) return owned.stopping
    if (plan.owned === owned) plan.stopping = true
    owned.handle.terminate()
    const stopping = (async () => {
      if (!await owned.handle.waitForExit()) throw new Error('Preview process range did not stop')
      // This Stop has confirmed quiescence even if an earlier observation failed.
      await Promise.allSettled([owned.done])
      if (plan.owned === owned) { delete plan.owned; plan.stopping = false }
    })()
    owned.stopping = stopping
    void stopping.then(undefined, () => {
      if (owned.stopping === stopping) delete owned.stopping
    })
    return stopping
  }

  async function stopOwned(plan: Plan): Promise<void> {
    plan.stopping = true
    plan.startupCancellation?.abort()
    if (plan.startup !== undefined) await Promise.allSettled([plan.startup])
    const owned = plan.owned
    if (owned === undefined) { plan.stopping = false; return }
    await stopRange(plan, owned)
  }

  async function stop(projectId: string): Promise<{ kind: 'stopped'; projectId: DevicePreviewProjectId }> {
    if (stopped) throw new Error('Device preview Host is stopping')
    const plan = plans.get(projectId as DevicePreviewProjectId)
    if (plan === undefined || (!plan.everOwned && plan.startup === undefined)) throw new Error('No owned preview launcher is recorded')
    await stopOwned(plan)
    return { kind: 'stopped', projectId: plan.id }
  }

  async function reply(requestId: DevicePreviewRequestId, projectId: string): Promise<void> {
    let response: DevicePreviewResponse
    try { response = { type: 'device-preview-result', requestId, ok: true, result: await stop(projectId) } }
    catch (_error) { response = { type: 'device-preview-result', requestId, ok: false, error: 'Owned preview launcher could not be stopped' } }
    if (!stopped) await send(response)
  }

  async function drain(): Promise<void> {
    const stopping = Promise.allSettled([...plans.values()].map(stopOwned))
    await Promise.allSettled([...pending])
    const outcomes = await stopping
    const errors = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Device preview cleanup did not reach quiescence')
  }

  function dispose(): Promise<void> {
    if (disposal !== undefined) return disposal
    stopped = true
    lifetime.abort()
    disposal = drain()
    return disposal
  }
  ctx.effect(() => dispose)

  return {
    project: (request, execution) => track(() => project(request, execution)),
    open: (request, execution) => track(() => open(request, execution)),
    stop: projectId => track(() => stop(projectId)),
    receive(message) {
      if (!record(message) || message.type !== 'device-preview-stop') return false
      if (stopped || Object.keys(message).length !== 3 || typeof message.requestId !== 'string' || !UUID.test(message.requestId)
        || typeof message.projectId !== 'string' || !UUID.test(message.projectId)) return true
      void track(() => reply(message.requestId as DevicePreviewRequestId, message.projectId as string))
        .catch(error => ctx.logger.error(error))
      return true
    },
    dispose,
    async await() {
      await injection.await()
      if (stopped) throw new Error('Device preview Host is stopping')
      if (services === undefined) throw new Error('Device preview providers are unavailable')
    },
  }
}
