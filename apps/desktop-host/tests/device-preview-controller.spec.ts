/** Preview permissions and managed-range lifetime, with real Context/approval/jobs and inert execution-world providers. */
import { Context } from '@deepseek-ai/cordis'
import { join, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditOutcome, FsInfo, FsPathInfo, FsTarget, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessSpawnSpec,
  SubprocessTerminalEnvironment, SubprocessTerminalHandle,
} from '@deepseek-ai/dsh-subprocess'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import UserApproval, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { installDevicePreviewController } from '../src/device-preview-controller.ts'

const ROOT = resolve('inert-device-preview-workspace')
const PROJECT = join(ROOT, 'app')
const URL = 'http://localhost:4179/'
const REQUEST_ID = '4bd58e9c-d546-4c16-bd21-b48160ed4d8c'

afterEach(() => vi.useRealTimers())

class PreviewFiles extends FileSystem {
  content = JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } })
  manifestPath = join(PROJECT, 'package.json')
  reads = vi.fn(async (_target: FsTarget, signal: AbortSignal | undefined, maxBytes: number) => {
    signal?.throwIfAborted()
    const bytes = Buffer.from(this.content)
    if (bytes.length > maxBytes) throw new FsError('Manifest exceeds bound', 'FS_TOO_LARGE')
    return bytes
  })
  override async resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    options?.signal?.throwIfAborted()
    const canonical = path === 'alias' ? PROJECT : path === 'package.json' ? this.manifestPath : resolve(options?.cwd ?? ROOT, path)
    return { displayPath: canonical, targetKey: FsTargetKey(canonical) }
  }
  override processPath(target: FsTarget): string { return target.displayPath }
  override fileUrl(target: FsTarget): string { return `file://${target.displayPath}` }
  override contains(parent: FsTarget, child: FsTarget): boolean { return child.displayPath.startsWith(parent.displayPath) }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    if (target.displayPath === PROJECT) return { type: 'directory', version: FsVersion('unchanged') }
    if (target.displayPath === this.manifestPath) return { type: 'file', version: FsVersion('unchanged'), size: this.content.length }
    return undefined
  }
  override async lstat(): Promise<FsPathInfo | undefined> { throw new Error('Detection must not inspect host paths') }
  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return this.reads(target, signal, maxBytes)
  }
  override async readText(): Promise<string> { throw new Error('Unbounded reads are forbidden') }
  override async streamText(): Promise<AsyncIterable<string>> { throw new Error('Unbounded reads are forbidden') }
  override async readByteRange(): Promise<Uint8Array> { throw new Error('Window reads do not bound the manifest') }
  override async listDir(): Promise<FsDirEntry[]> { throw new Error('Detection must not scan the project') }
  override async writeText(): Promise<FsWriteOutcome> { throw new Error('Project mutation is forbidden') }
  override async editText(): Promise<FsEditOutcome> { throw new Error('Project mutation is forbidden') }
}

function fakeRange() {
  const exit = Promise.withResolvers<SubprocessOutcome>()
  const empty = Promise.withResolvers<boolean>()
  const termination = Promise.withResolvers<undefined>()
  const output = { stdout: '', stderr: '' }
  let autoExit = true
  let terminated = false
  function read(channel: 'stdout' | 'stderr', from: number): SubprocessOutputRead {
    const bytes = Buffer.from(output[channel])
    return { text: bytes.subarray(from).toString('utf8'), nextOffset: bytes.length, lossy: false }
  }
  const handle: SubprocessHandle = {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: { stdout: { readFrom: from => read('stdout', from) }, stderr: { readFrom: from => read('stderr', from) } },
    done: exit.promise,
    terminate: vi.fn(() => {
      terminated = true
      termination.resolve(undefined)
      if (autoExit) { exit.resolve({ exitCode: 0, signal: null }); empty.resolve(true) }
    }),
    waitForExit: vi.fn(() => empty.promise),
  }
  return { handle, output, exit, empty, termination,
    holdExit: () => { autoExit = false },
    release: () => { exit.resolve({ exitCode: 0, signal: null }); empty.resolve(true) },
    get terminated() { return terminated } }
}

class PreviewProcesses extends SubprocessRuntime {
  platform: SubprocessTerminalEnvironment['platform'] = 'posix'
  executable = '/execution/bin/bash'
  ranges: ReturnType<typeof fakeRange>[] = []
  specs: SubprocessSpawnSpec[] = []
  failure: Error | undefined
  override async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    signal?.throwIfAborted()
    return { platform: this.platform }
  }
  resolveShell = vi.fn(async (_command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    return this.executable
  })
  override resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return this.resolveShell(command, env, signal)
  }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.failure !== undefined) throw this.failure
    this.specs.push(spec)
    const range = fakeRange()
    this.ranges.push(range)
    return range.handle
  }
  override async spawnTerminal(): Promise<SubprocessTerminalHandle> { throw new Error('Preview must use managed subprocess ranges') }
}

class PreviewSandbox extends SandboxProvider {
  requests: Array<{ argv: readonly string[]; policy: SandboxPolicy }> = []
  beforeReturn: () => Promise<void> = async () => {}
  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    this.requests.push({ argv: [...argv], policy: { ...policy } })
    await this.beforeReturn()
    signal?.throwIfAborted()
    return { argv: ['/execution/sandbox', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

async function fixture(options: { approval?: boolean; sandbox?: boolean } = {}) {
  const ctx = new Context()
  const barriers: PromiseWithResolvers<undefined>[] = []
  const calls: Promise<unknown>[] = []
  let controllerInstalled = false
  onTestFinished(async () => {
    for (const barrier of barriers) barrier.resolve(undefined)
    const processes = ctx.get('subprocess') as PreviewProcesses | undefined
    for (const range of processes?.ranges ?? []) range.release()
    if (controllerInstalled) await controller.dispose()
    await Promise.allSettled(calls)
    await ctx.fiber.dispose()
  })
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: ROOT })
  await ctx.plugin(PreviewFiles)
  await ctx.plugin(PreviewProcesses)
  await ctx.plugin(LocalJobs)
  const sandboxFiber = options.sandbox === false ? undefined : await ctx.plugin(PreviewSandbox)
  const approvalFiber = options.approval === false ? undefined : await ctx.plugin(UserApproval)
  const id = SessionId('preview-initiator')
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: ROOT, isSeeded: false })
  session.append('turn/start', { turn: 1 })
  // The loop is external to this controller; the real Session records every approval question and decision.
  const agent = { id: session.id, session, ctx } as Agent
  let answer: (request: ApprovalRequest) => Promise<ApprovalOutcome> = async () => 'allowed-once'
  const approvals = vi.fn((request: ApprovalRequest) => answer(request))
  ctx.on('approval/request', approvals)
  const send = vi.fn(async (_message: object) => {})
  const controller = installDevicePreviewController(ctx, send)
  controllerInstalled = true
  await controller.await()
  const installed = controller
  function execution(owner: Agent | undefined = agent, signal = new AbortController().signal): ToolExecution {
    return { agent: owner, signal, name: 'device_preview_open', arguments: {},
      callId: ToolCallId('preview-call'), rootCallId: ToolCallId('preview-call'), token: Symbol('preview-test') as ToolExecution['token'] }
  }
  function track<T>(promise: Promise<T>): Promise<T> { calls.push(promise); return promise }
  function barrier() {
    const held = Promise.withResolvers<undefined>()
    barriers.push(held)
    return held
  }
  async function prepare(script = 'dev', url = URL) {
    const detected = await installed.project({ project: 'app', script, url }, execution())
    if (detected.plan === undefined) throw new Error('Fixture expected an exact plan')
    return detected.plan
  }
  return { ctx, agent, session, controller: installed, approvals, send, execution, prepare, track, barrier,
    files: ctx.fs as PreviewFiles, processes: ctx.subprocess as PreviewProcesses,
    sandbox: ctx.get('sandbox') as PreviewSandbox | undefined, sandboxFiber, approvalFiber,
    answerWith: (callback: typeof answer) => { answer = callback } }
}

it('detects only existing web launchers without execution, guessed URLs, installs or project writes', async () => {
  const f = await fixture()
  f.files.content = JSON.stringify({ scripts: { dev: 'vite', start: 'expo start', preview: 'vite preview',
    'start:web': 'expo start --web', 'native:dev': 'react-native start', metro: 'metro start', build: 'vite build' } })
  const detected = await f.controller.project({ project: 'app' }, f.execution())
  expect(detected).toEqual({ project: PROJECT, choices: [
    { script: 'dev', command: 'vite' }, { script: 'preview', command: 'vite preview' },
    { script: 'start:web', command: 'expo start --web' },
  ], needsInput: true })
  expect(await f.controller.project({ project: 'app', script: 'dev' }, f.execution())).toMatchObject({ needsInput: true })
  await expect(f.controller.project({ project: 'app', script: 'start', url: URL }, f.execution())).rejects.toThrow('existing web')
  expect(f.processes.specs).toEqual([])
  expect(f.processes.resolveShell).not.toHaveBeenCalled()
  expect(f.approvals).not.toHaveBeenCalled()
  expect(f.ctx.jobs.list()).toEqual([])
  expect(f.files.reads.mock.calls.every(([, , bound]) => bound === 128 * 1024)).toBe(true)
})

it.each([
  ['invalid JSON', '{', 'JSON'],
  ['no scripts', '{}', 'existing package.json scripts'],
  ['nonstring script', '{"scripts":{"dev":3}}', 'must be strings'],
  ['oversized manifest', ' '.repeat(128 * 1024 + 1), 'exceeds bound'],
])('refuses %s without executing detection', async (_scenario, content, message) => {
  const f = await fixture()
  f.files.content = content
  await expect(f.controller.project({ project: 'app' }, f.execution())).rejects.toThrow(message)
  expect(f.processes.specs).toHaveLength(0)
})

it('canonicalizes aliases and explicit URLs, hashes content rather than stat freshness and deduplicates unchanged plans', async () => {
  const f = await fixture()
  const first = await f.prepare()
  const alias = await f.controller.project({ project: 'alias', script: 'dev', url: URL }, f.execution())
  expect(alias.plan).toEqual(first)
  expect(first.projectId).toMatch(/^[0-9a-f-]{36}$/)
  f.files.content = JSON.stringify({ scripts: { dev: 'vite --host', build: 'vite build' } })
  const changed = await f.prepare()
  expect(changed.projectId).not.toBe(first.projectId)
  await expect(f.controller.open(first, f.execution())).rejects.toThrow('plan changed')
  const otherUrl = await f.prepare('dev', 'http://localhost:4180/')
  expect(otherUrl.projectId).not.toBe(changed.projectId)
  await expect(f.controller.open({ projectId: changed.projectId, url: URL + 'changed' }, f.execution())).rejects.toThrow('exact prepared')
  expect(f.processes.specs).toHaveLength(0)
})

it('uses a literal script URL but never infers an endpoint from a port flag', async () => {
  const f = await fixture()
  f.files.content = JSON.stringify({ scripts: { dev: 'server --url http://LOCALHOST:4179', preview: 'vite preview --port 4179' } })
  const detected = await f.controller.project({ project: 'app', script: 'dev' }, f.execution())
  expect(detected.choices[0]?.knownUrl).toBe(URL)
  expect(detected.plan?.url).toBe(URL)
  const unknown = await f.controller.project({ project: 'app', script: 'preview' }, f.execution())
  expect(unknown.plan).toBeUndefined()
  expect(unknown.needsInput).toBe(true)
})

it.each(['posix', 'windows'] as const)('approves and confines the exact canonical %s shell argv and keeps the job Host-owned', async (platform) => {
  const f = await fixture()
  f.processes.platform = platform
  f.processes.executable = platform === 'windows' ? 'C:\\execution\\pwsh.exe' : '/execution/bin/bash'
  const plan = await f.prepare()
  const state = await f.controller.open(plan, f.execution())
  expect(state).toEqual({ ...plan, ownership: 'owned', status: 'starting', jobId: expect.any(String) })
  const argv = platform === 'windows'
    ? [f.processes.executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "npm.cmd run 'dev'; exit $LASTEXITCODE"]
    : [f.processes.executable, '--noprofile', '--norc', '-c', "npm run 'dev'"]
  expect(f.sandbox?.requests).toEqual([{ argv, policy: { mode: 'workspace-write', workspaceRoot: ROOT, sessionId: f.session.id } }])
  expect(f.processes.specs).toEqual([{ argv: ['/execution/sandbox', ...argv], cwd: PROJECT, graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 32 * 1024 }, stderr: { maxBytes: 32 * 1024 } },
    env: { BASH_ENV: undefined, ENV: undefined, NODE_OPTIONS: undefined } }])
  const approval = f.approvals.mock.calls[0]?.[0]
  expect(approval?.agent).toBe(f.agent)
  expect(approval?.callId).toBe(ToolCallId('preview-call'))
  expect(approval?.reason).toContain('enable this exact project preview launcher for this app run')
  expect(approval?.reason).toContain(JSON.stringify(argv))
  expect(approval?.reason).toContain('manifestHash')
  expect(approval?.reason).toContain('including explicit restarts after Stop')
  expect(f.ctx.jobs.list()).toEqual([expect.objectContaining({ id: state.jobId, status: 'running' })])
  expect(f.ctx.jobs.list()[0]?.owner).toBeUndefined()
  expect(f.session.seq).toBe(3)
})

it('opens external URLs without launch ownership, jobs or approval even when providers cannot authorize launches', async () => {
  const f = await fixture({ approval: false, sandbox: false })
  const state = await f.controller.open({ url: 'https://EXAMPLE.test/device' }, f.execution())
  expect(state).toEqual({ cwd: '', url: 'https://example.test/device', ownership: 'external', status: 'external' })
  expect(state).not.toHaveProperty('projectId')
  expect(state).not.toHaveProperty('jobId')
  expect(f.ctx.jobs.list()).toEqual([])
  expect(f.processes.specs).toEqual([])
  await expect(f.controller.stop('arbitrary-server')).rejects.toThrow('No owned')
})

it.each([
  ['file URL', 'file:///project/index.html'],
  ['script URL', 'javascript:alert(1)'],
  ['embedded credentials', 'http://user:password@localhost:4179'],
  ['URL whitespace', 'http://localhost:4179/ bad'],
  ['canonical URL exceeding the byte limit', `http://localhost/${'é'.repeat(700)}`],
])('rejects %s before launch', async (_scenario, url) => {
  const f = await fixture()
  await expect(f.controller.open({ url }, f.execution())).rejects.toThrow()
  expect(f.processes.specs).toHaveLength(0)
})

it.each(['rejected', 'cancelled', 'unavailable'] as const)('refuses %s approval and leaves no job or managed range', async (outcome) => {
  const f = await fixture()
  f.answerWith(async () => outcome)
  const plan = await f.prepare()
  await expect(f.controller.open(plan, f.execution())).rejects.toThrow('not approved')
  expect(f.processes.specs).toHaveLength(0)
  expect(f.ctx.jobs.list()).toEqual([])
})

it.each(['missing-approval', 'never', 'missing-sandbox'] as const)('fails closed for %s before spawning', async (unavailable) => {
  const f = await fixture({ approval: unavailable !== 'missing-approval', sandbox: unavailable !== 'missing-sandbox' })
  if (unavailable === 'never') setApprovalPolicy(f.session, 'never')
  const plan = await f.prepare()
  await expect(f.controller.open(plan, f.execution())).rejects.toThrow(unavailable === 'missing-sandbox' ? 'confinement' : 'approval')
  expect(f.processes.specs).toHaveLength(0)
  expect(f.approvals).not.toHaveBeenCalled()
})

it('bypasses confinement only for explicit current danger-full-access and reapproves changed execution permissions', async () => {
  const f = await fixture()
  const plan = await f.prepare()
  await f.controller.open(plan, f.execution())
  await f.controller.stop(plan.projectId)
  setSandboxMode(f.session, 'read-only')
  await f.controller.open(plan, f.execution())
  await f.controller.stop(plan.projectId)
  expect(f.approvals).toHaveBeenCalledTimes(2)
  setSandboxMode(f.session, 'danger-full-access')
  await f.sandboxFiber?.dispose()
  await f.controller.open(plan, f.execution())
  expect(f.processes.specs[2]?.argv[0]).toBe(f.processes.executable)
  expect(f.approvals).toHaveBeenCalledTimes(3)
})

it('reuses owned work without relaunch and caches only exact unchanged app-run grants', async () => {
  const f = await fixture()
  const plan = await f.prepare()
  const state = await f.controller.open(plan, f.execution())
  setApprovalPolicy(f.session, 'never')
  expect(await f.controller.open(plan, f.execution())).toEqual(state)
  expect(f.processes.specs).toHaveLength(1)
  await f.controller.stop(plan.projectId)
  await expect(f.controller.open(plan, f.execution())).rejects.toThrow('approval')
  setApprovalPolicy(f.session, 'ask')
  await f.controller.open(plan, f.execution())
  expect(f.approvals).toHaveBeenCalledTimes(1)
  await f.controller.stop(plan.projectId)
  await f.approvalFiber?.dispose()
  await expect(f.controller.open(plan, f.execution())).rejects.toThrow('approval')
  expect(f.processes.specs).toHaveLength(2)
})

it('never shares approval between initiating Agents or different plans', async () => {
  const f = await fixture()
  const plan = await f.prepare()
  await f.controller.open(plan, f.execution())
  await f.controller.stop(plan.projectId)
  const id = SessionId('other-preview-initiator')
  const second = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: ROOT, isSeeded: false })
  second.append('turn/start', { turn: 1 })
  const other = { id: second.id, session: second, ctx: f.ctx } as Agent
  await f.controller.open(plan, f.execution(other))
  await f.controller.stop(plan.projectId)
  const otherPlan = await f.prepare('dev', 'http://localhost:4180/')
  await f.controller.open(otherPlan, f.execution())
  expect(f.approvals.mock.calls.map(([request]) => request.agent)).toEqual([f.agent, other, f.agent])
})

it('shares concurrent startup without duplicate approval or spawn', async () => {
  const f = await fixture()
  const entered = f.barrier()
  const release = f.barrier()
  f.answerWith(async () => { entered.resolve(undefined); await release.promise; return 'allowed-once' })
  const plan = await f.prepare()
  const first = f.track(f.controller.open(plan, f.execution()))
  await entered.promise
  const second = f.track(f.controller.open(plan, f.execution()))
  release.resolve(undefined)
  expect(await first).toEqual(await second)
  expect(f.approvals).toHaveBeenCalledOnce()
  expect(f.processes.specs).toHaveLength(1)
})

it.each(['manifest', 'shell', 'approval', 'sandbox-mode'] as const)('refuses a %s change while approval is pending', async (change) => {
  const f = await fixture()
  const entered = f.barrier()
  const release = f.barrier()
  f.answerWith(async () => { entered.resolve(undefined); await release.promise; return 'allowed-once' })
  const plan = await f.prepare()
  const opening = f.track(f.controller.open(plan, f.execution()))
  const rejected = expect(opening).rejects.toThrow()
  await entered.promise
  if (change === 'manifest') f.files.content = JSON.stringify({ scripts: { dev: 'vite --host' } })
  if (change === 'shell') f.processes.executable = '/execution/bin/replaced-bash'
  if (change === 'approval') setApprovalPolicy(f.session, 'never')
  if (change === 'sandbox-mode') setSandboxMode(f.session, 'danger-full-access')
  release.resolve(undefined)
  await rejected
  expect(f.processes.specs).toHaveLength(0)
})

it('revalidates the manifest after the final asynchronous shell lookup following confinement', async () => {
  const f = await fixture()
  const entered = f.barrier()
  const release = f.barrier()
  if (f.sandbox === undefined) throw new Error('Fixture sandbox is missing')
  f.sandbox.beforeReturn = async () => {
    f.processes.resolveShell.mockImplementationOnce(async (_command, _env, signal) => {
      entered.resolve(undefined)
      await release.promise
      signal?.throwIfAborted()
      return f.processes.executable
    })
  }
  const plan = await f.prepare()
  const opening = f.track(f.controller.open(plan, f.execution()))
  const rejected = expect(opening).rejects.toThrow('plan changed')
  await entered.promise
  f.files.content = JSON.stringify({ scripts: { dev: 'vite', predev: 'run-new-code' } })
  release.resolve(undefined)
  await rejected
  expect(f.processes.specs).toHaveLength(0)
})

it('Stop cancels pending approval and disposal drains admitted confinement before completing', async () => {
  const f = await fixture()
  const entered = f.barrier()
  const release = f.barrier()
  f.answerWith(async () => { entered.resolve(undefined); await release.promise; return 'allowed-once' })
  const plan = await f.prepare()
  const opening = f.track(f.controller.open(plan, f.execution()))
  const rejected = expect(opening).rejects.toThrow()
  await entered.promise
  await expect(f.controller.stop(plan.projectId)).resolves.toEqual({ kind: 'stopped', projectId: plan.projectId })
  await rejected
  expect(f.processes.specs).toHaveLength(0)
  release.resolve(undefined)
  f.answerWith(async () => 'allowed-once')
  const confining = f.barrier()
  const confined = f.barrier()
  if (f.sandbox === undefined) throw new Error('Fixture sandbox is missing')
  f.sandbox.beforeReturn = async () => { confining.resolve(undefined); await confined.promise }
  const next = f.track(f.controller.open(plan, f.execution()))
  const nextRejected = expect(next).rejects.toThrow()
  await confining.promise
  let disposed = false
  const disposal = f.track(f.controller.dispose().then(() => { disposed = true }))
  await Promise.resolve()
  expect(disposed).toBe(false)
  confined.resolve(undefined)
  await nextRejected
  await disposal
  expect(f.processes.specs).toHaveLength(0)
})

it('Stop awaits the recorded managed range, not top-level exit, and never touches another launcher', async () => {
  const f = await fixture()
  const first = await f.prepare()
  const other = await f.prepare('dev', 'http://localhost:4180/')
  await f.controller.open(first, f.execution())
  await f.controller.open(other, f.execution())
  const range = f.processes.ranges[0]!
  range.holdExit()
  let finished = false
  const stopping = f.track(f.controller.stop(first.projectId).then(() => { finished = true }))
  await range.termination.promise
  range.exit.resolve({ exitCode: 0, signal: null })
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(f.processes.ranges[1]?.terminated).toBe(false)
  range.empty.resolve(true)
  await stopping
  expect(range.handle.terminate).toHaveBeenCalledOnce()
  await expect(f.controller.stop(first.projectId)).resolves.toEqual({ kind: 'stopped', projectId: first.projectId })
  expect(range.handle.terminate).toHaveBeenCalledOnce()
})

it('trusted Main Stop replies only after the recorded range settles and malformed packets grant nothing', async () => {
  const f = await fixture()
  const plan = await f.prepare()
  await f.controller.open(plan, f.execution())
  const range = f.processes.ranges[0]!
  range.holdExit()
  expect(f.controller.receive({ type: 'other' })).toBe(false)
  expect(f.controller.receive({ type: 'device-preview-stop', requestId: 'invalid', projectId: plan.projectId })).toBe(true)
  expect(f.controller.receive({ type: 'device-preview-stop', requestId: REQUEST_ID, projectId: plan.projectId, pid: 42 })).toBe(true)
  expect(range.terminated).toBe(false)
  const delivered = f.barrier()
  f.send.mockImplementation(async () => { delivered.resolve(undefined) })
  expect(f.controller.receive({ type: 'device-preview-stop', requestId: REQUEST_ID, projectId: plan.projectId })).toBe(true)
  await range.termination.promise
  expect(f.send).not.toHaveBeenCalled()
  range.release()
  await delivered.promise
  expect(f.send).toHaveBeenCalledWith({ type: 'device-preview-result', requestId: REQUEST_ID, ok: true,
    result: { kind: 'stopped', projectId: plan.projectId } })
})

it('reports unknown Main project ids without disclosing internal errors', async () => {
  const f = await fixture()
  const delivered = f.barrier()
  f.send.mockImplementation(async () => { delivered.resolve(undefined) })
  f.controller.receive({ type: 'device-preview-stop', requestId: REQUEST_ID, projectId: REQUEST_ID })
  await delivered.promise
  expect(f.send).toHaveBeenCalledWith({ type: 'device-preview-result', requestId: REQUEST_ID, ok: false,
    error: 'Owned preview launcher could not be stopped' })
  expect(f.processes.specs).toHaveLength(0)
})

it('keeps starting until bounded collected output supplies readiness evidence and never performs an HTTP request', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = await fixture()
  const plan = await f.prepare()
  await f.controller.open(plan, f.execution())
  const range = f.processes.ranges[0]!
  range.output.stdout = ['Starting preview process', 'ready', `Invocation URL: ${URL}`,
    `Local: ${URL}different`, `Not ready: ${URL}`, `Local: ${URL}`].join('\n')
  await vi.advanceTimersByTimeAsync(150)
  expect((await f.controller.open(plan, f.execution())).status).toBe('starting')
  range.output.stdout += 'different\n'
  await vi.advanceTimersByTimeAsync(150)
  expect((await f.controller.open(plan, f.execution())).status).toBe('starting')
  range.output.stdout += '\u001b[32mLocal:\u001b[0m http://LOCALHOST:4179/\n'
  await vi.advanceTimersByTimeAsync(150)
  expect((await f.controller.open(plan, f.execution())).status).toBe('running')
  range.output.stderr = 'é'.repeat(40 * 1024)
  await vi.advanceTimersByTimeAsync(150)
  const job = f.ctx.jobs.list()[0]!
  const retained = f.ctx.jobs.readAt(job.id, 0)
  expect(Buffer.byteLength(retained.chunks.filter(chunk => chunk.channel === 'stderr').map(chunk => chunk.text).join(''))).toBeLessThanOrEqual(32 * 1024)
  range.output.stderr += 'late unbounded output'
  await vi.advanceTimersByTimeAsync(150)
  expect(f.ctx.jobs.readAt(job.id, retained.next).chunks).toEqual([])
  await f.controller.dispose()
  await f.ctx.fiber.dispose()
  expect(vi.getTimerCount()).toBe(0)
})

it('disposal starts every owned termination while an admitted Stop is awaiting range exit', async () => {
  const f = await fixture()
  const first = await f.prepare()
  const second = await f.prepare('dev', 'http://localhost:4180/')
  await f.controller.open(first, f.execution())
  await f.controller.open(second, f.execution())
  for (const range of f.processes.ranges) range.holdExit()
  const stopping = f.track(f.controller.stop(first.projectId))
  await f.processes.ranges[0]!.termination.promise
  let disposed = false
  const disposal = f.track(f.controller.dispose().then(() => { disposed = true }))
  await f.processes.ranges[1]!.termination.promise
  expect(disposed).toBe(false)
  expect(f.processes.ranges.every(range => range.terminated)).toBe(true)
  for (const range of f.processes.ranges) range.release()
  await stopping
  await disposal
  expect(disposed).toBe(true)
})

it('Host effect disposal fences launches, terminates all recorded ranges and awaits their physical exit', async () => {
  const f = await fixture()
  const first = await f.prepare()
  const second = await f.prepare('dev', 'http://localhost:4180/')
  await f.controller.open(first, f.execution())
  await f.controller.open(second, f.execution())
  for (const range of f.processes.ranges) range.holdExit()
  let disposed = false
  const disposal = f.track(Promise.resolve(f.ctx.fiber.dispose()).then(() => { disposed = true }))
  await Promise.all(f.processes.ranges.map(range => range.termination.promise))
  expect(disposed).toBe(false)
  await expect(f.controller.open({ url: URL }, f.execution())).rejects.toThrow('stopping')
  await expect(f.controller.stop(first.projectId)).rejects.toThrow('stopping')
  expect(f.controller.receive({ type: 'device-preview-stop', requestId: REQUEST_ID, projectId: first.projectId })).toBe(true)
  for (const range of f.processes.ranges) range.release()
  await disposal
  expect(disposed).toBe(true)
  expect(f.processes.ranges.every(range => range.terminated)).toBe(true)
  expect(f.send).not.toHaveBeenCalled()
})

it('reports failed range observation and permits Stop after a fresh confirmed empty range', async () => {
  const f = await fixture()
  const plan = await f.prepare()
  await f.controller.open(plan, f.execution())
  const range = f.processes.ranges[0]!
  vi.mocked(range.handle.waitForExit).mockRejectedValueOnce(new Error('Inert range observation failed'))
  range.release()
  const job = f.ctx.jobs.list()[0]!
  expect((await f.ctx.jobs.wait(job.id, 5000)).status).toBe('failed')
  expect((await f.controller.open(plan, f.execution())).status).toBe('failed')
  await expect(f.controller.stop(plan.projectId)).resolves.toEqual({ kind: 'stopped', projectId: plan.projectId })
})

it('retries a failed Stop observation while keeping the launcher fenced until confirmed empty', async () => {
  const f = await fixture()
  const plan = await f.prepare()
  await f.controller.open(plan, f.execution())
  const range = f.processes.ranges[0]!
  range.holdExit()
  vi.mocked(range.handle.waitForExit).mockRejectedValueOnce(new Error('Inert Stop observation failed'))
  await expect(f.controller.stop(plan.projectId)).rejects.toThrow('Inert Stop observation failed')
  await expect(f.controller.open(plan, f.execution())).rejects.toThrow('stopping')
  const retry = f.track(f.controller.stop(plan.projectId))
  expect(range.handle.terminate).toHaveBeenCalledTimes(2)
  range.release()
  await expect(retry).resolves.toEqual({ kind: 'stopped', projectId: plan.projectId })
  expect(f.processes.ranges).toHaveLength(1)
})

it('contains spawn failure without recording ownership or a successful job', async () => {
  const f = await fixture()
  const plan = await f.prepare()
  f.processes.failure = new Error('Inert provider spawn failed')
  await expect(f.controller.open(plan, f.execution())).rejects.toThrow('spawn failed')
  expect(f.ctx.jobs.list()).toEqual([])
  await expect(f.controller.stop(plan.projectId)).rejects.toThrow('No owned')
})

it('does not authorize a pre-aborted or Agent-less invocation', async () => {
  const f = await fixture()
  const plan = await f.prepare()
  const cancellation = new AbortController()
  cancellation.abort()
  await expect(f.controller.open(plan, f.execution(f.agent, cancellation.signal))).rejects.toThrow()
  const { agent: _agent, ...execution } = f.execution()
  await expect(f.controller.open(plan, execution)).rejects.toThrow('initiating Agent')
  expect(f.approvals).not.toHaveBeenCalled()
  expect(f.processes.specs).toHaveLength(0)
})
