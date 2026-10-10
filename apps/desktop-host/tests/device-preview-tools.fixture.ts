/** Loader-backed preview tools with real Agents and inert filesystem, subprocess, confinement and private IPC providers. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditOutcome, FsInfo, FsPathInfo, FsTarget, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import { SandboxProvider, type ConfinedArgv, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec, SubprocessTerminalEnvironment,
  SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import type { DevicePreviewObservation, DevicePreviewOpenRequest, DevicePreviewObserveRequest } from '@deepseek-ai/dsh-client-ui-device-preview/types'
import { onTestFinished } from 'vitest'
import { executeToolCalls } from '../../../packages/core/agent-loop/src/tool-calls.ts'
import { installDevicePreviewController } from '../src/device-preview-controller.ts'
import { installDevicePreviewParentChannel } from '../src/device-preview-parent.ts'
import { installDevicePreviewTools } from '../src/device-preview-tools.ts'
import { TINY_PNG, WebsiteTestAttachments, WebsiteTestModels } from './website-browser.fixture.ts'

const ROOT = '/inert-device-preview'
const PROJECT = ROOT + '/app'

class PreviewToolFiles extends FileSystem {
  content = '{"scripts":{"dev":"vite","build":"vite build","start":"expo start"}}'
  readonly reads: Array<{ path: string; maxBytes: number }> = []
  override async resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    options?.signal?.throwIfAborted()
    const displayPath = posix.resolve(options?.cwd ?? ROOT, path)
    return { displayPath, targetKey: FsTargetKey(displayPath) }
  }
  override processPath(target: FsTarget): string { return target.displayPath }
  override fileUrl(target: FsTarget): string { return 'file://' + target.displayPath }
  override contains(parent: FsTarget, child: FsTarget): boolean {
    return child.displayPath === parent.displayPath || child.displayPath.startsWith(parent.displayPath + '/')
  }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    return target.displayPath === PROJECT ? { type: 'directory', version: FsVersion('unchanged') } : undefined
  }
  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    signal?.throwIfAborted()
    if (target.displayPath !== PROJECT + '/package.json') throw new Error('Unexpected inert file read')
    this.reads.push({ path: target.displayPath, maxBytes })
    const bytes = Buffer.from(this.content)
    if (bytes.length > maxBytes) throw new FsError('Inert manifest exceeds bound', 'FS_TOO_LARGE')
    return bytes
  }
  override async lstat(): Promise<FsPathInfo | undefined> { throw new Error('Host path inspection is forbidden') }
  override async readText(): Promise<string> { throw new Error('Unbounded read is forbidden') }
  override async streamText(): Promise<AsyncIterable<string>> { throw new Error('Unbounded read is forbidden') }
  override async readByteRange(): Promise<Uint8Array> { throw new Error('Unexpected range read') }
  override async listDir(): Promise<FsDirEntry[]> { throw new Error('Project scans are forbidden') }
  override async writeText(): Promise<FsWriteOutcome> { throw new Error('Project writes are forbidden') }
  override async editText(): Promise<FsEditOutcome> { throw new Error('Project edits are forbidden') }
}

class PreviewToolProcesses extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []
  readonly ranges: Array<{ terminated: boolean }> = []
  override async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    signal?.throwIfAborted()
    return { platform: 'posix' }
  }
  override async resolveExecutable(_command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    return '/inert/bin/bash'
  }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const range = { terminated: false }
    this.ranges.push(range)
    const done = Promise.withResolvers<SubprocessOutcome>()
    const empty = Promise.withResolvers<boolean>()
    const output = { readFrom: (from: number) => ({ text: '', nextOffset: from, lossy: false }) }
    return { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: { stdout: output, stderr: output }, done: done.promise,
      terminate() { range.terminated = true; done.resolve({ exitCode: 0, signal: null }); empty.resolve(true) },
      waitForExit: () => empty.promise }
  }
  override async spawnTerminal(): Promise<SubprocessTerminalHandle> { throw new Error('Actual terminal launch is forbidden') }
}

class PreviewToolSandbox extends SandboxProvider {
  override async confine(argv: readonly string[], _policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    return { argv: ['/inert/sandbox', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

/**
 * @param services - optional external binary storage and real approval service.
 * @returns real loaded tools, live Agents and an in-memory Main transport; no application or model is launched.
 */
export async function devicePreviewToolsFixture(services: { attachments?: boolean; approval?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-device-preview-tools-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-session-projection', SessionProjections],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-jobs-local', LocalJobs],
    ['preview-tool-files', PreviewToolFiles], ['preview-tool-processes', PreviewToolProcesses],
    ['preview-tool-sandbox', PreviewToolSandbox],
  ])
  if (services.approval !== false) modules.set('@deepseek-ai/dsh-user-approval', UserApproval)
  if (services.attachments) modules.set('website-test-attachments', WebsiteTestAttachments)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...modules.keys()].map(name => `- name: '${name}'`).join('\n') + '\n')
  let controller: ReturnType<typeof installDevicePreviewController> | undefined
  let parent: ReturnType<typeof installDevicePreviewParentChannel> | undefined
  let toolsFiber: ReturnType<typeof installDevicePreviewTools> | undefined
  const openings: DevicePreviewOpenRequest[] = []
  const observations: DevicePreviewObserveRequest[] = []
  const openingEntered = Promise.withResolvers<DevicePreviewOpenRequest>()
  let commit = true
  const observation: DevicePreviewObservation = { kind: 'layout', text: '{"viewport":{"width":390,"height":844},"document":{"width":390,"height":844},"horizontalOverflow":false,"truncated":false,"overflow":[]}', width: 390, height: 844 }
  const ctx = await boot('device-preview-tools-test', configPath, [], (owner) => {
    const send = async (message: object): Promise<void> => {
      if (!('type' in message)) throw new Error('Missing private packet type')
      if (message.type === 'device-preview-open') {
        const request = message as DevicePreviewOpenRequest
        openings.push(request)
        openingEntered.resolve(request)
        if (commit) parent?.receive({ type: 'device-preview-result', requestId: request.requestId,
          ok: true, result: { kind: 'opened', previewId: request.previewId } })
      } else if (message.type === 'device-preview-observe') {
        const request = message as DevicePreviewObserveRequest
        observations.push(request)
        parent?.receive({ type: 'device-preview-result', requestId: request.requestId, ok: true,
          result: request.operation === 'screenshot'
            ? { kind: 'screenshot', base64: TINY_PNG, mimeType: 'image/png', width: 1, height: 1 } : observation })
      } else if (message.type !== 'device-preview-cancel') throw new Error('Unexpected private packet')
    }
    controller = installDevicePreviewController(owner, send)
    parent = installDevicePreviewParentChannel(owner, send)
    toolsFiber = installDevicePreviewTools(owner, controller, parent)
    owner.loader.internal = {
      version: 'v2', loadCache: new Map(),
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error('Unexpected fixture module: ' + specifier)
        return modules.get(specifier)
      },
      register() { throw new Error('Unexpected fixture hook registration') },
      async getOrCreateModuleJob() { throw new Error('Unexpected fixture module job') },
      resolveSync() { throw new Error('Unexpected fixture module resolution') },
      async load() { throw new Error('Unexpected fixture module load') },
    }
  })
  onTestFinished(async () => {
    parent?.close()
    try { await controller?.dispose() }
    finally { await ctx.fiber.dispose() }
  })
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: ROOT })
  if (controller === undefined || parent === undefined || toolsFiber === undefined) throw new Error('Preview tools did not install')
  await ctx.loader.await()
  await controller.await()
  await toolsFiber.await()
  ctx.effect(() => ctx.llm.registerAdapter(['website-test', 'website-header'], new WebsiteTestModels()))
  async function createAgent(id: string): Promise<Agent> {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: ROOT },
      agentOptions: { provider: 'website-test', model: 'vision' } })
    handle.agent.session.append('turn/start', { turn: 1 })
    return handle.agent
  }
  const agent = await createAgent('device-preview-tools-owner')
  const signal = new AbortController().signal
  const invoke = (name: string, args: object, callId = name, owner: Agent = agent) =>
    ctx.tools.execute({ agent: owner, signal, name, arguments: args, callId: ToolCallId(callId) })
  async function logged(name: string, args: object, callId: string): Promise<ToolExecutionResult> {
    let result: ToolExecutionResult | undefined
    const detach = ctx.on('tools/result', (execution, value) => { if (execution.callId === callId) result = value })
    try {
      await ctx.agents.withInitiator(agent, () => executeToolCalls(agent.ctx, 1, 1,
        [{ type: 'tool-call', id: ToolCallId(callId), name, arguments: JSON.stringify(args) }], signal,
        () => { throw new Error('Unexpected deferred context') }))
    } finally { detach() }
    if (result === undefined) throw new Error('Missing logged tool result')
    return result
  }
  return { ctx, agent, controller, parent, toolsFiber, openings, observations, openingEntered, invoke, logged, createAgent,
    files: ctx.fs as PreviewToolFiles, processes: ctx.subprocess as PreviewToolProcesses,
    commitWith: (enabled: boolean) => { commit = enabled } }
}
