/**
 * The `commandcode` subagent backend, driven the way a roster role drives it:
 * `ctx.subagents` resolves the provider, the provider starts the real run
 * machinery, and the package's own deterministic CLI stand-in answers every
 * process that machinery spawns.
 *
 * The harness mounts the roster's `delegate` tool over one role, so these
 * assertions describe what a delegation reaches the CLI with rather than what
 * the provider was called with.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SettingsFileProvider from '@deepseek-ai/dsh-settings-file'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import {
  installRosterTools,
  resolveSubagentConcurrencyLimit,
  SubagentRunLimiter,
  subagentRosterView,
} from '@deepseek-ai/dsh-subagent-roster'
import type { SubagentDefinition, SubagentSettings } from '@deepseek-ai/dsh-subagent-roster'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import CommandCodeController, { COMMAND_CODE_SUBAGENT_BACKEND } from '../src/index.ts'
import * as FakeCli from './fixtures/loader/fake-cli.ts'

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
  /** Every process the composition started, probe and run alike. */
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

/** The delegating agent the roster reads its workspace from. */
function delegatingAgent(): Agent {
  return {
    options: {},
    session: { header: { cwd: WORKSPACE }, requestHeader: () => undefined },
  } as unknown as Agent
}

/**
 * Boot the real Host services, the subagent registry, the Command Code plugin,
 * and the roster's tools over one role.
 * @param definition - the role every delegation resolves.
 * @returns the booted composition and its observations.
 */
async function boot(definition: SubagentDefinition): Promise<Composition> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SettingsFileProvider, {
    path: join(mkdtempSync(join(tmpdir(), 'dsh-commandcode-backend-')), 'settings.yaml'),
  })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(FakeCli)

  const spawned: SpawnedProcess[] = []
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('the composition did not publish its process owner')
  const dispatch = subprocess.spawn.bind(subprocess)
  subprocess.spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    const handle = dispatch(spec)
    const stdin: Buffer[] = []
    // Observing the write, never taking it: the run still owns the stream.
    handle.stdin?.on('data', (chunk: Buffer) => { stdin.push(Buffer.from(chunk)) })
    spawned.push({ spec, stdin })
    return handle
  }

  await ctx.plugin(CommandCodeController)

  const settings = documentOf(definition)
  const limiter = new SubagentRunLimiter(
    () => resolveSubagentConcurrencyLimit(settings.limits.maxConcurrentRuns),
  )
  installRosterTools(ctx, {
    viewFor: () => subagentRosterView(settings, null),
    acquire: signal => limiter.acquire(signal),
  })

  const agent = delegatingAgent()
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

const BOOTED: Composition[] = []

afterEach(async () => {
  for (const booted of BOOTED.splice(0).reverse()) await booted.dispose()
})

/** Boot one composition and register it for teardown. */
async function composition(definition: SubagentDefinition): Promise<Composition> {
  const booted = await boot(definition)
  BOOTED.push(booted)
  return booted
}

describe('the commandcode subagent backend', () => {
  it('is registered under the name a stored role names', async () => {
    const booted = await composition(commandCodeRole())
    expect(booted.ctx.subagents.list()).toEqual([COMMAND_CODE_SUBAGENT_BACKEND])
  })

  it('runs a role through delegate and starts a real CLI process', async () => {
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

  it('sends the persona as the standing prefix of the brief', async () => {
    const booted = await composition(commandCodeRole({ instructions: 'Answer in one line.' }))
    await booted.delegate({ subagent: 'code', task: 'Report the fixture contents.' })
    const written = Buffer.concat(booted.runs()[0]?.stdin ?? []).toString('utf8')
    expect(written).toBe('Answer in one line.\n\nReport the fixture contents.')
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
