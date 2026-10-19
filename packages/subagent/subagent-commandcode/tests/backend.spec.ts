/** The roster and backend run with production Agents and controlled CLI I/O. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import {
  canonicalWorkspaceKey,
  installRosterTools,
  resolveSubagentConcurrencyLimit,
  SubagentRunLimiter,
  subagentRosterView,
} from '@deepseek-ai/dsh-subagent-roster'
import type { SubagentDefinition, SubagentSettings } from '@deepseek-ai/dsh-subagent-roster'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { COMMAND_CODE_SUBAGENT_BACKEND, registerCommandCodeBackend } from '../src/backend.ts'
import type { CommandCodeDelegationApi } from '../src/tools.ts'
import type { CommandCodeDelegationSettings } from '../src/types.ts'
import { commandCodeDelegationView } from '../src/settings.ts'
import { startCommandCodeRun } from '../src/run.ts'
import { CommandCodeRunLimiter } from '../src/limiter.ts'
import { fakeChild } from './fake-child.ts'
import { agentHarness, barrier, directoryFixture } from './agent-harness.ts'

/** The delegating session's workspace; the standalone CLI stand-in answers regardless of it. */
const WORKSPACE = process.cwd()

/** The final answer the deterministic CLI reports for a run. */
const CLI_ANSWER = 'COMMANDCODE_DELEGATE_OK\n'

/** One process the plugin's machinery started, with what the run wrote into it. */
interface SpawnedProcess {
  readonly spec: SubprocessSpawnSpec
  readonly stdin: Buffer[]
}

/** One booted composition and the observations a test makes on it. */
interface Composition {
  readonly ctx: Context
  readonly agent: Agent
  /** Every process started by the backend's run machinery. */
  readonly spawned: SpawnedProcess[]
  /** Processes started for a delegation, which the run marks with `--output-format`. */
  runs(): SpawnedProcess[]
  delegate(args: Record<string, unknown>): Promise<ToolExecutionResult>
  /** Read the roster directory through its model-facing tool. */
  listSubagents(): Promise<ToolExecutionResult>
  dispose(): Promise<void>
}

/** One complete role naming the Command Code backend. */
function commandCodeRole(fields: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    id: 'code',
    name: 'Code',
    enabled: true,
    purpose: 'Implement a scoped change.',
    whenToUse: '',
    invocation: 'automatic',
    model: { mode: 'fixed' },
    access: 'inherit',
    instructions: '',
    execution: { backend: COMMAND_CODE_SUBAGENT_BACKEND, background: 'foreground' },
    ...fields,
  }
}

/** One complete roster document holding exactly this role. */
function documentOf(definition: SubagentDefinition): SubagentSettings {
  return {
    subagents: [definition],
    overrides: {},
    automaticRouting: { enabled: false, allowedModels: [] },
    limits: { maxConcurrentRuns: 2, defaultTimeoutMs: 3_600_000 },
  }
}

/**
 * Mount production Agent services, the backend, and roster tools with controlled CLI I/O.
 * @param definition - the role every delegation resolves.
 * @param instructionsPrefix - deployment policy for every delegated brief.
 * @param options - CLI admission and settings for the scenario.
 * @returns the booted composition and its observations.
 */
async function boot(definition: SubagentDefinition, instructionsPrefix = '', options: {
  api?: Partial<CommandCodeDelegationApi>
  roster?: SubagentSettings
  settings?: CommandCodeDelegationSettings
} = {}): Promise<Composition> {
  const { ctx, agents } = await agentHarness()
  await ctx.plugin(SubagentRuntime)
  const spawned: SpawnedProcess[] = []
  const cliSettings = options.settings ?? { maxConcurrentRuns: 2, timeoutMs: 3_600_000, maxTurns: 60, lanes: [], projects: {} }
  const cliLimiter = new CommandCodeRunLimiter(() => cliSettings.maxConcurrentRuns)
  const api: CommandCodeDelegationApi = {
    viewFor: workspace => commandCodeDelegationView(cliSettings, workspace),
    preflight: async () => ({ command: 'cmdc', installed: true, authenticated: true }),
    acquire: signal => cliLimiter.acquire(signal),
    start: (request, spec, onActivity) => startCommandCodeRun(request, spec, {
      invocation: { program: 'cmdc', prefix: [], source: 'path' },
      graceMs: 3_000,
      onActivity,
      spawn: (spawnSpec) => {
        const child = fakeChild(spawnSpec)
        spawned.push({ spec: spawnSpec, stdin: child.stdin })
        queueMicrotask(() => {
          child.stdout(`${JSON.stringify({ type: 'result', subtype: 'success', finalText: CLI_ANSWER })}\n`)
          child.exit()
        })
        return child.handle
      },
    }),
    onStartError: () => {},
    ...options.api,
  }
  ctx.effect(() => registerCommandCodeBackend(ctx, api, instructionsPrefix))

  const settings = options.roster ?? documentOf(definition)
  const limiter = new SubagentRunLimiter(
    () => resolveSubagentConcurrencyLimit(settings.limits.maxConcurrentRuns),
  )
  installRosterTools(ctx, {
    viewFor: workspace => subagentRosterView(settings, workspace),
    acquire: signal => limiter.acquire(signal),
  })

  const agent = await agents.create(SessionId('commandcode-parent'), {}, { cwd: WORKSPACE })
  let calls = 0
  const call = (name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`commandcode-backend-${++calls}`),
    name,
    arguments: args,
    agent,
  })
  return {
    ctx,
    agent,
    spawned,
    runs: () => spawned.filter(entry => entry.spec.argv.includes('--output-format')),
    delegate: args => call('delegate', args),
    listSubagents: () => call('list_subagents', {}),
    dispose: () => ctx.fiber.dispose(),
  }
}

/** Join the text blocks of one rendered tool result. */
function text(result: ToolExecutionResult): string {
  return result.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

const composition = boot

describe('the commandcode subagent backend', () => {
  it('is registered under the name a stored role names', async () => {
    const booted = await composition(commandCodeRole())
    expect(booted.ctx.subagents.list()).toEqual([COMMAND_CODE_SUBAGENT_BACKEND])
  })

  it('runs a role through delegate and the CLI protocol', async () => {
    const booted = await composition(commandCodeRole())
    const result = await booted.delegate({ subagent: 'code', task: 'Report the fixture contents.' })
    expect(result.isError).toBe(false)
    // The role's answer is the CLI's own final frame, not text the provider made up.
    expect(text(result)).toBe(CLI_ANSWER)

    const runs = booted.runs()
    expect(runs).toHaveLength(1)
    const argv = runs[0]?.spec.argv ?? []
    // The shipped headless flag set, with the brief on stdin rather than argv.
    expect(argv).toContain('-p')
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('json')
    expect(argv).toContain('--no-session')
    expect(argv).toContain('--skip-onboarding')
    expect(argv).toContain('--no-auto-update')
    expect(argv[argv.indexOf('--max-turns') + 1]).toBe('60')
    expect(argv).not.toContain('Report the fixture contents.')
  })

  it('starts no process while loading and none for a role that is only listed', async () => {
    const booted = await composition(commandCodeRole())
    expect(booted.spawned).toHaveLength(0)

    const listed = await booted.listSubagents()
    expect(text(listed)).toContain('code — Code')
    expect(booted.spawned).toHaveLength(0)
  })

  it('sends deployment policy before the role instructions and task', async () => {
    const booted = await composition(commandCodeRole({ instructions: 'Answer in one line.' }), 'Stop when access is blocked.')
    await booted.delegate({ subagent: 'code', task: 'Report the fixture contents.' })
    const written = Buffer.concat(booted.runs()[0]?.stdin ?? []).toString('utf8')
    expect(written).toBe('Stop when access is blocked.\n\nAnswer in one line.\n\nReport the fixture contents.')
  })
})

describe('directory capture before asynchronous admission', () => {
  it('retains the captured cwd through preflight and permit waits without changing header policy', async () => {
    const directories = await directoryFixture()
    const preflight = barrier()
    const permit = barrier()
    const definition = commandCodeRole({ access: 'danger-full-access' })
    const roster = documentOf(definition)
    roster.overrides[canonicalWorkspaceKey(WORKSPACE)] = {
      subagents: { code: { access: 'read-only', instructions: 'Original project policy.' } },
    }
    const settings = { maxConcurrentRuns: 2, timeoutMs: 90_000, maxTurns: 7, lanes: [], projects: {} }
    const workspaces: Array<string | null> = []
    const booted = await composition(definition, '', {
      roster,
      settings,
      api: {
        viewFor: (workspace) => {
          workspaces.push(workspace)
          return commandCodeDelegationView(settings, workspace)
        },
        preflight: async () => {
          await preflight.wait()
          return { command: 'cmdc', installed: true, authenticated: true }
        },
        acquire: async () => { await permit.wait(); return () => {} },
      },
    })
    const captured = await booted.ctx.workingDirectory.set(booted.agent, directories.captured)
    const pending = booted.delegate({ subagent: 'code', task: 'One.' })
    try {
      await preflight.entered
      expect(booted.runs()).toHaveLength(0)
      await booted.ctx.workingDirectory.set(booted.agent, directories.preflight)
      settings.maxTurns = 99
      preflight.release()
      await permit.entered
      expect(booted.runs()).toHaveLength(0)
      const current = await booted.ctx.workingDirectory.set(booted.agent, directories.permit)
      permit.release()
      expect((await pending).isError).toBe(false)
      const run = booted.runs()[0]!
      expect(run.spec.cwd).toBe(captured)
      expect(run.spec.argv).toContain('plan')
      expect(run.spec.argv).not.toContain('--yolo')
      expect(run.spec.argv[run.spec.argv.indexOf('--max-turns') + 1]).toBe('7')
      expect(Buffer.concat(run.stdin).toString('utf8')).toBe('Original project policy.\n\nOne.')
      expect(workspaces).toEqual([WORKSPACE])
      expect(booted.agent.session.header.cwd).toBe(WORKSPACE)
      expect(booted.ctx.workingDirectory.get(booted.agent.session)).toBe(current)
    } finally {
      preflight.release()
      permit.release()
      await pending
    }
  })
})

describe('the route a commandcode role owns', () => {
  it('reaches --model and --effort unchanged', async () => {
    const booted = await composition(commandCodeRole({
      model: {
        mode: 'fixed',
        route: { provider: 'vendor', model: 'vendor-product/model-x', reasoningEffort: 'high' },
      },
    }))
    const result = await booted.delegate({ subagent: 'code', task: 'One.' })
    expect(result.isError).toBe(false)
    const argv = booted.runs()[0]?.spec.argv ?? []
    expect(argv[argv.indexOf('--model') + 1]).toBe('vendor-product/model-x')
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high')
  })

  it('omits --model for a role that names no route, leaving the CLI its own default', async () => {
    const booted = await composition(commandCodeRole())
    await booted.delegate({ subagent: 'code', task: 'One.' })
    expect(booted.runs()[0]?.spec.argv).not.toContain('--model')
  })

  it('refuses an effort the CLI does not take before starting any process', async () => {
    const booted = await composition(commandCodeRole({
      model: { mode: 'fixed', route: { provider: 'vendor', model: 'vendor-product/model-x', reasoningEffort: 'max' } },
    }))
    const result = await booted.delegate({ subagent: 'code', task: 'One.' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the CLI accepts no reasoning effort "max"')
    expect(booted.spawned).toHaveLength(0)
  })
})

describe('the access a commandcode role requests', () => {
  it.each(['inherit', 'read-only'] as const)('runs %s in the CLI read-only permission mode', async (access) => {
    const booted = await composition(commandCodeRole({ access }))
    const result = await booted.delegate({ subagent: 'code', task: 'One.' })
    expect(result.isError).toBe(false)
    const argv = booted.runs()[0]?.spec.argv ?? []
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(argv).not.toContain('--yolo')
  })

  it('runs danger-full-access as the CLI unrestricted mode', async () => {
    const booted = await composition(commandCodeRole({ access: 'danger-full-access' }))
    await booted.delegate({ subagent: 'code', task: 'One.' })
    const argv = booted.runs()[0]?.spec.argv ?? []
    expect(argv).toContain('--yolo')
    expect(argv).not.toContain('--permission-mode')
  })

  it('refuses workspace-write loudly instead of rounding it to another level', async () => {
    const booted = await composition(commandCodeRole({ access: 'workspace-write' }))
    const result = await booted.delegate({ subagent: 'code', task: 'One.' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the CLI has no workspace-write permission mode')
    expect(booted.spawned).toHaveLength(0)
  })
})

describe('the capabilities this backend advertises', () => {
  it('refuses a tool scope it cannot honour', async () => {
    const booted = await composition(commandCodeRole({ tools: { deny: ['bash'] } }))
    const result = await booted.delegate({ subagent: 'code', task: 'One.' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not support the "toolFilter" capability')
    expect(booted.spawned).toHaveLength(0)
  })

  it('refuses a delegation-depth cap it does not manage', async () => {
    const booted = await composition(commandCodeRole({ maxDepth: 1 }))
    const result = await booted.delegate({ subagent: 'code', task: 'One.' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not support the "depthLimit" capability')
    expect(booted.spawned).toHaveLength(0)
  })
})
