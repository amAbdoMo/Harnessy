/**
 * Named one-shot subagent providers backed by OAR's default runtime registry.
 * OAR owns native processes; installation checks occur on delegation.
 *
 * @module @deepseek-ai/dsh-experimental-subagent-oar
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import { defaultRuntimes } from '@botiverse/oar'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  validateConfiguredCwd,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { startOarRun, type OarRunSpec } from './run.ts'

/** Cordis plugin identity. */
export const name = 'experimental-subagent-oar'
/** Provider registry and per-Session directory services. */
export const inject = ['subagents', 'workingDirectory']

const DEFAULT_PROVIDER_NAME = 'oar'

/** Native runtime selection and deployment settings for one provider instance. */
export interface Config {
  /** OAR default-runtime id; unknown ids fail during plugin activation. */
  runtime: string
  /** Name registered on ctx.subagents (default oar). */
  providerName?: string
  /** Child directory override; omission inherits the calling Session's current directory. */
  cwd?: string
  /** Native model id; omission preserves the runtime's model selection. */
  model?: string
  /** Native reasoning effort; unsupported choices fail during startup. */
  effort?: string
  /** Explicit entries applied after ambient credential scrubbing; null removes a value. */
  env?: Record<string, string | null>
  /** Native arguments; empty Claude arguments use dontAsk without prompts, while other runtimes preserve their defaults. */
  launchArgs?: string[]
  /** Optional turn deadline in milliseconds after startup; omission uses parent cancellation only. */
  timeoutMs?: number
}

/** Validated provider deployment settings. */
export const Config: z<Config> = z.object({
  runtime: z.string().min(1).required(),
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  cwd: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1),
  env: z.dict(z.union([z.string(), z.const(null)])).default({}),
  launchArgs: z.array(z.string()),
  timeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
})

/**
 * Register one provider using a runtime in OAR's default registry.
 * @param ctx - context carrying the shared subagent service.
 * @param config - runtime, registry name, native settings, and turn deadline.
 */
export function apply(ctx: Context, config: Config): void {
  const runtime = defaultRuntimes.require(config.runtime)
  const timeoutMs = config.timeoutMs
  const providerName = config.providerName ?? DEFAULT_PROVIDER_NAME
  const cwd = validateConfiguredCwd('subagent-oar', config.cwd)
  const configuredArgs = config.launchArgs ?? []
  const launchArgs = config.runtime === 'claude' && configuredArgs.length === 0
    ? ['--permission-mode', 'dontAsk', '--permission-prompts', 'none'] : configuredArgs
  if (config.runtime === 'claude' && !launchArgs.some(arg => arg === '--permission-mode' || arg.startsWith('--permission-mode='))) {
    throw new Error('subagent-oar: Claude launchArgs must explicitly select --permission-mode')
  }
  if (timeoutMs !== undefined) {
    assertPositiveFinite('subagent-oar', 'timeoutMs', timeoutMs)
    if (timeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`subagent-oar: timeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
    }
  }
  const spec: Omit<OarRunSpec, 'cwd'> = {
    runtime,
    ...config.model === undefined ? {} : { model: config.model },
    ...config.effort === undefined ? {} : { effort: config.effort },
    env: config.env ?? {},
    launchArgs,
    ...timeoutMs === undefined ? {} : { timeoutMs },
    onError: (error) => {
      ctx.logger.warn('subagent-oar "%s": %s', providerName, error.message)
    },
  }
  const provider: SubagentProvider = {
    name: providerName,
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,
    start: request => startOarRun(request, {
      ...spec,
      cwd: resolveChildCwd('subagent-oar', request.cwdExplicit ? undefined : cwd, request.cwd),
    }),
  }
  ctx.subagents.registerProvider(provider)
}
