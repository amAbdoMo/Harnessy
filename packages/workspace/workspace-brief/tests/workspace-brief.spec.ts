import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, { CommandId, type CommandInvocation } from '@deepseek-ai/dsh-commands'
import { FsError } from '@deepseek-ai/dsh-fs'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as workspaceBrief from '../src/index.ts'

const CWD = 'C:\\workspace'
const encoder = new TextEncoder()

function shellResult(overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 5_000,
    stdout: {
      text: `${CWD}\n## main...origin/main\n M src/index.ts\n`,
      truncated: false,
    },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

function invocation(rawInput = '', signal = new AbortController().signal): CommandInvocation {
  return {
    commandId: CommandId('brief-test'),
    rawInput,
    signal,
    attachments: [],
    agent: {
      session: { header: { cwd: CWD } },
    } as unknown as Agent,
  }
}

function bench(options: {
  readonly entries?: readonly { name: string; type: 'file' | 'directory' | 'other' }[]
  readonly packageJson?: string
  readonly shell?: ShellRunResult | ((signal: AbortSignal) => Promise<ShellRunResult>)
  readonly workspaceStatus?: 'ok' | 'missing-dir'
  readonly resolveWorkspace?: 'present' | 'absent' | 'throw'
  readonly resolveWorkspaceWith?: () => Promise<unknown>
  readonly listError?: FsError
  readonly manifestError?: FsError
} = {}) {
  const entries = (options.entries ?? [
    { name: '.git', type: 'directory' as const },
    { name: 'package.json', type: 'file' as const },
    { name: 'src', type: 'directory' as const },
  ]).map(entry => ({
    ...entry,
    target: { targetKey: `target:${entry.name}`, displayPath: `${CWD}\\${entry.name}` },
  }))
  const calls = {
    reads: 0,
    shell: 0,
    shellRequest: undefined as Record<string, unknown> | undefined,
  }
  const workspace = {
    title: 'Example workspace',
    status: vi.fn(async () => options.workspaceStatus ?? 'ok'),
  }
  const fs = {
    resolve: vi.fn(async () => ({ targetKey: 'target:root', displayPath: CWD })),
    listDir: vi.fn(async () => {
      if (options.listError !== undefined) throw options.listError
      return entries
    }),
    lstat: vi.fn(async () => ({ type: 'file', version: 'v1' })),
    readBytes: vi.fn(async () => {
      calls.reads += 1
      if (options.manifestError !== undefined) throw options.manifestError
      return encoder.encode(options.packageJson ?? JSON.stringify({
        name: 'demo', version: '1.2.3', packageManager: 'pnpm@11', scripts: { test: 'vitest' },
      }))
    }),
    processPath: vi.fn(() => CWD),
  }
  const shell = {
    resolve: vi.fn((request: Record<string, unknown>) => {
      calls.shellRequest = request
      return request
    }),
    run: vi.fn(async (request: { signal?: AbortSignal }) => {
      calls.shell += 1
      if (typeof options.shell === 'function') return options.shell(request.signal ?? AbortSignal.abort())
      return options.shell ?? shellResult()
    }),
  }
  const workspaceRegistry = {
    resolveByPath: vi.fn(async () => {
      if (options.resolveWorkspaceWith !== undefined) return options.resolveWorkspaceWith()
      if (options.resolveWorkspace === 'throw') throw new Error('registry unavailable')
      return options.resolveWorkspace === 'absent' ? undefined : workspace
    }),
  }
  const sandboxPolicy = { resolve: vi.fn(() => ({ mode: 'read-only' })) }
  const ctx = { fs, shell, workspaceRegistry, sandboxPolicy } as unknown as Context
  return { ctx, runner: new workspaceBrief.WorkspaceBriefRunner(ctx), calls, fs, shell, workspaceRegistry }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WorkspaceBriefRunner', () => {
  it('creates a bounded read-only brief and omits status rows by default', async () => {
    const test = bench()
    const result = await test.runner.run(invocation())

    expect(result.kind).toBe('success')
    expect(result.text).toContain('# Workspace Brief')
    expect(result.text).toContain('- Workspace: `Example workspace`')
    expect(result.text).toContain('- Name: `demo`')
    expect(result.text).toContain('Not requested. Run `/workspace-brief --git`')
    expect(result.text).not.toContain('M src/index.ts')
    expect(test.calls.shellRequest).toMatchObject({
      workdir: CWD,
      timeoutMs: 5_000,
      stdoutMaxBytes: 32 * 1_024,
      sandboxPolicy: { mode: 'read-only' },
    })
    expect(String(test.calls.shellRequest?.command)).toContain('--untracked-files=no')
    expect(test.fs.readBytes).toHaveBeenCalledTimes(1)
    expect('writeText' in test.fs).toBe(false)
  })

  it('includes only bounded Git status for the exact --git option', async () => {
    const rows = Array.from({ length: 24 }, (_, index) => ` M file-${index}.ts`).join('\n')
    const test = bench({ shell: shellResult({
      stdout: { text: `${CWD}\n## feature/brief\n${rows}\n`, truncated: false },
    }) })

    const result = await test.runner.run(invocation(' --git '))
    expect(result.kind).toBe('success')
    expect(result.text).toContain(' M file-0.ts')
    expect(result.text).toContain(' M file-19.ts')
    expect(result.text).not.toContain(' M file-20.ts')
    expect(result.text).toContain('Partial: Git output was truncated')
    expect(String(test.calls.shellRequest?.command)).toContain('--untracked-files=normal')
  })

  it('rejects every unsupported suffix before touching the workspace', async () => {
    const test = bench()
    await expect(test.runner.run(invocation('--git .'))).resolves.toEqual({
      kind: 'error', text: 'Usage: /workspace-brief [--git]',
    })
    expect(test.workspaceRegistry.resolveByPath).not.toHaveBeenCalled()
    expect(test.shell.run).not.toHaveBeenCalled()
  })

  it('distinguishes no session workspace, unregistered workspace, and missing directory', async () => {
    const noCwd = bench()
    const noCwdInvocation = invocation()
    Object.defineProperty(noCwdInvocation.agent.session.header, 'cwd', { value: undefined })
    await expect(noCwd.runner.run(noCwdInvocation)).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('no selected workspace'),
    })

    await expect(bench({ resolveWorkspace: 'absent' }).runner.run(invocation())).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('not attached to a registered workspace'),
    })
    await expect(bench({ workspaceStatus: 'missing-dir' }).runner.run(invocation())).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('workspace directory is missing'),
    })
  })

  it('distinguishes a non-Git workspace without starting a process', async () => {
    const test = bench({ entries: [{ name: 'src', type: 'directory' }] })
    await expect(test.runner.run(invocation())).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('not a Git repository'),
    })
    expect(test.shell.run).not.toHaveBeenCalled()
  })

  it('labels unreadable or invalid package metadata as partial instead of hiding the brief', async () => {
    const denied = bench({ manifestError: new FsError('denied', 'FS_PERMISSION_DENIED') })
    const deniedResult = await denied.runner.run(invocation())
    expect(deniedResult).toMatchObject({ kind: 'success' })
    expect(deniedResult.text).toContain('Partial: package.json could not be read under the current permissions.')

    const invalid = bench({ packageJson: '{broken' })
    const invalidResult = await invalid.runner.run(invocation())
    expect(invalidResult).toMatchObject({ kind: 'success' })
    expect(invalidResult.text).toContain('Partial: package.json is invalid JSON')
  })

  it('reports filesystem and sandbox permission failures separately', async () => {
    const fsDenied = bench({ listError: new FsError('denied', 'FS_SANDBOX_DENIED') })
    await expect(fsDenied.runner.run(invocation())).resolves.toEqual({
      kind: 'error', text: 'Workspace brief permission denied while reading the selected workspace.',
    })

    const sandboxDenied = bench({ shell: shellResult({
      exitCode: 1,
      sandbox: { mode: 'read-only', denied: true },
    }) })
    await expect(sandboxDenied.runner.run(invocation())).resolves.toEqual({
      kind: 'error', text: 'Workspace brief permission denied by the current sandbox policy.',
    })
  })

  it('surfaces backend resolution failure and command timeout without partial success', async () => {
    await expect(bench({ resolveWorkspace: 'throw' }).runner.run(invocation())).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('cannot be resolved (registry unavailable)'),
    })

    vi.useFakeTimers()
    const timed = bench({
      shell: signal => new Promise(resolve => {
        signal.addEventListener('abort', () => resolve(shellResult({ aborted: true, exitCode: null })), { once: true })
      }),
    })
    const pending = timed.runner.run(invocation())
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toEqual({
      kind: 'error', text: 'Workspace brief timed out after 5000 ms.',
    })
  })

  it('settles the overall timeout while an unabortable registry lookup is stalled', async () => {
    vi.useFakeTimers()
    let finishLookup: (() => void) | undefined
    const test = bench({
      resolveWorkspaceWith: () => new Promise(resolve => {
        finishLookup = () => resolve({ title: 'late workspace', status: async () => 'ok' })
      }),
    })

    const pending = test.runner.run(invocation())
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toEqual({
      kind: 'error', text: 'Workspace brief timed out after 5000 ms.',
    })
    finishLookup?.()
    await vi.runAllTimersAsync()
    expect(test.fs.listDir).not.toHaveBeenCalled()
    expect(test.shell.run).not.toHaveBeenCalled()
  })

  it('propagates user cancellation and performs no observation when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))
    const test = bench()
    await expect(test.runner.run(invocation('', controller.signal))).rejects.toThrow('user cancelled')
    expect(test.workspaceRegistry.resolveByPath).not.toHaveBeenCalled()
  })

  it('is idempotent across explicit retries and never writes workspace state', async () => {
    const test = bench()
    const first = await test.runner.run(invocation('--git'))
    const second = await test.runner.run(invocation('--git'))
    expect(second).toEqual(first)
    expect(test.calls.reads).toBe(2)
    expect(test.calls.shell).toBe(2)
    expect('writeText' in test.fs).toBe(false)
  })
})

describe('workspace-brief command lifecycle', () => {
  it('registers, persists its result in command events, replays it, and unregisters cleanly', async () => {
    const test = bench()
    const ctx = new Context()
    await ctx.plugin(CommandRuntime).await()
    ctx.provide('fs', test.fs as never)
    ctx.provide('shell', test.shell as never)
    ctx.provide('workspaceRegistry', test.workspaceRegistry as never)
    ctx.provide('sandboxPolicy', { resolve: vi.fn(() => ({ mode: 'read-only' })) } as never)
    const fiber = ctx.plugin({ inject: [...workspaceBrief.inject], apply: workspaceBrief.apply })
    await fiber.await()

    const id = SessionId('workspace-brief-lifecycle')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1,
      cwd: CWD,
      isSeeded: false,
    }
    const session = Session.create(id, undefined, header)
    const agent = {
      session,
      status: 'idle',
      options: {},
      reserveTurnAdmission: () => () => undefined,
    } as unknown as Agent

    expect(ctx.commands.find(agent, 'workspace-brief')).toBeDefined()
    const execution = await ctx.commands.execute(agent, '/workspace-brief', [], new AbortController().signal)
    expect(execution?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('# Workspace Brief') })
    const lifecycle = session.snapshotEvents().filter(event => event.type.startsWith('command/'))
    expect(lifecycle.map(event => event.type)).toEqual(['command/run', 'command/done'])

    const replay = Session.create(id, session.snapshotEvents(), header)
    expect(replay.snapshotEvents().find(event => event.type === 'command/done')).toMatchObject({
      data: { kind: 'success', text: expect.stringContaining('# Workspace Brief') },
    })

    await fiber.dispose()
    expect(ctx.commands.find(agent, 'workspace-brief')).toBeUndefined()
    const reloaded = ctx.plugin({ inject: [...workspaceBrief.inject], apply: workspaceBrief.apply })
    await reloaded.await()
    expect(ctx.commands.list(agent).filter(command => command.name === 'workspace-brief')).toHaveLength(1)
  })
})
