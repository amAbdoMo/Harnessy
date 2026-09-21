/**
 * Harnessy's Command Code delegation: the live `commandcode-delegation`
 * settings section, the two model-facing tools, the concurrency gate, the
 * `commandcode` subagent backend, and the Remote surface the Delegation
 * Settings page reads.
 *
 * The plugin starts no Command Code process while loading. Installation,
 * authentication, and catalog facts are read when the Settings page asks for
 * them and again immediately before each delegated run.
 *
 * @module @deepseek-ai/dsh-subagent-commandcode
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { assertPositiveFinite } from '@deepseek-ai/dsh-subagent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import { registerCommandCodeBackend } from './backend.ts'
import {
  COMMAND_CODE_POSIX_COMMAND,
  COMMAND_CODE_PROBE_TIMEOUT_MS,
  COMMAND_CODE_SKIP_UPDATES_ENV,
  COMMAND_CODE_WINDOWS_COMMAND,
  defaultCommandCodeInvocation,
  probeCommandCode,
  readCommandCodeCatalog,
} from './cli.ts'
import type { CommandCodeInvocation, CommandCodeRunner } from './cli.ts'
import { CommandCodeRunLimiter } from './limiter.ts'
import { createCommandCodeCapabilitySource } from './models.ts'
import { DEFAULT_DISPOSE_GRACE_MS, startCommandCodeRun } from './run.ts'
import {
  COMMAND_CODE_DELEGATION_NAMESPACE,
  CommandCodeDelegationSchema,
  commandCodeDelegationView,
  validateCommandCodeDelegation,
} from './settings.ts'
import { installCommandCodeTools } from './tools.ts'
import type { CommandCodeDelegationApi } from './tools.ts'
import type {
  CommandCodeCatalog,
  CommandCodeDelegationSettings,
  CommandCodeDelegationView,
  CommandCodeHealth,
} from './types.ts'

export * from './types.ts'
export { COMMAND_CODE_DELEGATION_NAMESPACE, CommandCodeDelegationSchema } from './settings.ts'
export {
  COMMAND_CODE_DELEGATE_TOOL,
  COMMAND_CODE_LANES_TOOL,
  installCommandCodeTools,
} from './tools.ts'
export {
  COMMAND_CODE_SUBAGENT_BACKEND,
  commandCodeAccess,
  commandCodeEffort,
  registerCommandCodeBackend,
} from './backend.ts'

/** Deployment-owned process-release timing. */
export interface Config {
  /** Grace in milliseconds between managed-range termination tiers. */
  disposeGraceMs?: number
  /** Whether to register the pre-roster lane tools beside the backend. */
  toolsEnabled?: boolean
}

/** Plugin config schema. */
export const Config: z<Config> = z.object({
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  toolsEnabled: z.boolean().default(true),
})

/** Bytes collected from one installation, authentication, or catalog helper. */
const PROBE_OUTPUT_BYTES = 64 * 1024

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the Command Code delegation policy and its Remote namespace. */
    commandCodeController: CommandCodeController
  }
}

/**
 * This caller's cancellation reason, or undefined while it is still waiting.
 * @param signal - the caller's lifetime.
 * @returns the reason to reject with, or undefined.
 */
function callerCancellation(signal: AbortSignal): Error | undefined {
  if (!signal.aborted) return undefined
  return signal.reason instanceof Error ? signal.reason : new Error('probe cancelled')
}

/**
 * Await one shared operation, but stop waiting as soon as this caller cancels.
 *
 * Sharing a pending operation must not share cancellation authority: the
 * operation keeps running for whoever else is waiting, while the cancelling
 * caller stops waiting immediately.
 * @param pending - the shared operation.
 * @param signal - this caller's lifetime.
 * @returns the shared result, or a rejection once this caller cancels.
 */
function joinProbe(pending: Promise<CommandCodeHealth>, signal: AbortSignal): Promise<CommandCodeHealth> {
  const cancelled = callerCancellation(signal)
  if (cancelled !== undefined) return Promise.reject(cancelled)
  return new Promise<CommandCodeHealth>((resolve, reject) => {
    const onAbort = (): void => {
      reject(callerCancellation(signal) ?? new Error('probe cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * Host service backing the generated `ctx.remote.commandcode` namespace.
 *
 * It owns the settings registration, the model-facing tools, the shipped
 * concurrency gate, and the resolved CLI invocation. The tools resolve the
 * current workspace's lanes on every call, so a saved Settings change applies
 * to the next delegation from an existing Session.
 */
export class CommandCodeController extends TypertRemoteService {
  static inject = ['typert', 'settings', 'tools', 'subprocess']

  static Config: z<Config> = Config

  private readonly scope: SettingsScope<CommandCodeDelegationSettings>

  private readonly limiter: CommandCodeRunLimiter

  private readonly disposeGraceMs: number

  private invocation: CommandCodeInvocation | undefined

  /**
   * The one shared installation probe, owned by this plugin rather than by the
   * first caller that asked for it.
   */
  private probe: Promise<CommandCodeHealth> | undefined

  /** Cancellation owner for {@link probe}, so plugin disposal ends it. */
  private probeController: AbortController | undefined

  /**
   * @param ctx - Host context carrying settings, tools, and the process owner.
   * @param config - process-release timing.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'commandCodeController', { namespace: 'commandcode' })
    const graceMs = config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
    assertPositiveFinite('subagent-commandcode', 'disposeGraceMs', graceMs)
    if (graceMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`subagent-commandcode: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
    }
    this.disposeGraceMs = graceMs
    this.scope = ctx.settings.register(
      COMMAND_CODE_DELEGATION_NAMESPACE,
      CommandCodeDelegationSchema,
      { validate: validateCommandCodeDelegation },
    )
    this.limiter = new CommandCodeRunLimiter(() => this.scope.get().maxConcurrentRuns)
    ctx.effect(() => () => { this.abortProbe() }, 'commandcode delegation: probe lifetime')
    if (config.toolsEnabled ?? true) installCommandCodeTools(ctx, this.delegationApi())
    // Mounted through `inject` rather than this plugin's static list, so a
    // profile that composes the plugin without the subagent registry keeps the
    // two tools it already had.
    ctx.inject(['subagents'], (registryCtx) => {
      registryCtx.effect(
        () => registerCommandCodeBackend(registryCtx, this.delegationApi()),
        'commandcode delegation: subagent backend',
      )
    })
    // Command Code's `--list-models` listing and its `--effort` flag say nothing
    // about which level a given model takes, so the CLI's own shipped catalog is
    // the only per-model answer. Contributing it here lets any model-discovery
    // surface show a Command Code model's exact levels instead of asking the
    // user to restate them; the seam normalizes the answer and nothing is
    // claimed for a model the catalog does not describe.
    ctx.inject(['llm'], (scope) => {
      scope.effect(
        () => scope.llm.registerModelCapabilitySource('commandcode', createCommandCodeCapabilitySource()),
        'commandcode delegation: model capability source',
      )
    })
  }

  /**
   * Report the installed CLI's presence, version, and authentication state.
   * @param signal - caller lifetime.
   * @returns the bounded health facts the Subagents page shows.
   */
  @Remote
  async health(signal: AbortSignal): Promise<CommandCodeHealth> {
    return await this.preflight(signal)
  }

  /**
   * Read the local CLI's advisory model catalog.
   * @param signal - caller lifetime.
   * @returns catalog rows, empty with a bounded explanation when unreadable.
   */
  @Remote
  async catalog(signal: AbortSignal): Promise<CommandCodeCatalog> {
    let invocation: CommandCodeInvocation
    try {
      invocation = this.resolveInvocation()
    } catch {
      return { models: [], detail: 'Install Command Code, then reopen this page.' }
    }
    return await readCommandCodeCatalog(this.runner(invocation), this.probeSignal(signal))
  }

  /**
   * Resolve one workspace's lanes and bounds, with per-field override provenance.
   *
   * The read itself is synchronous — it resolves the live settings section —
   * so it carries the caller's signal only to refuse a read that was already
   * cancelled rather than to await anything.
   * @param workspace - the Session's workspace path, or null without one.
   * @param signal - caller lifetime; a superseded or unmounted reader cancels its own read.
   * @returns the resolved delegation view.
   * @throws when the caller's read was already cancelled.
   */
  @Remote
  delegation(workspace: string | null, signal: AbortSignal): CommandCodeDelegationView {
    signal.throwIfAborted()
    return commandCodeDelegationView(this.scope.get(), workspace)
  }

  /** The tools' view of this controller. */
  private delegationApi(): CommandCodeDelegationApi {
    return {
      viewFor: workspace => commandCodeDelegationView(this.scope.get(), workspace),
      preflight: signal => this.preflight(signal),
      acquire: signal => this.limiter.acquire(signal),
      start: (request, runSpec, onActivity) => startCommandCodeRun(request, runSpec, {
        spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
        invocation: this.resolveInvocation(),
        graceMs: this.disposeGraceMs,
        onError: (error, stopReason) => {
          this.ctx.logger.warn(`subagent-commandcode: run failed (${stopReason}): ${error.message}`)
        },
        onStderrTail: (tail) => {
          // Host-only diagnostic; Command Code's stderr never reaches the model.
          if (tail.length > 0) this.ctx.logger.debug(`subagent-commandcode: ${tail.trimEnd()}`)
        },
        onActivity,
      }),
      onStartError: (error) => {
        // The job reports a fixed product-owned detail; the host cause stays here.
        this.ctx.logger.warn(`subagent-commandcode: delegation did not start: ${error.message}`)
      },
    }
  }

  /**
   * Memoize the resolved executable. A PATH that cannot be resolved stays
   * unresolved, so a later attempt after the user installs the CLI succeeds.
   */
  private resolveInvocation(): CommandCodeInvocation {
    this.invocation ??= defaultCommandCodeInvocation()
    return this.invocation
  }

  /** Bound one probe by the lifetime that owns it and a fixed ceiling. */
  private probeSignal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(COMMAND_CODE_PROBE_TIMEOUT_MS)])
  }

  /**
   * Run installation and authentication checks, joining an already-running
   * probe instead of starting a second pair of helper processes.
   *
   * The shared probe runs under its own controller rather than any caller's
   * signal, so one reader cancelling cannot turn a healthy CLI into an
   * unavailable one for every other reader. Each caller still stops waiting the
   * moment it cancels, through {@link joinProbe}; the shared probe itself stays
   * bounded by its own deadline.
   * @param signal - this caller's lifetime.
   * @returns the joined probe result, or a rejection when this caller cancels.
   */
  private preflight(signal: AbortSignal): Promise<CommandCodeHealth> {
    const cancelled = callerCancellation(signal)
    // Never start a probe for a caller that has already gone: it would run for
    // nobody and keep helper processes alive past their only reason to exist.
    if (cancelled !== undefined) return Promise.reject(cancelled)
    return joinProbe(this.probe ?? this.startProbe(), signal)
  }

  /** Start the one shared probe and clear it when it settles. */
  private startProbe(): Promise<CommandCodeHealth> {
    const controller = new AbortController()
    const probe = this.runProbe(controller.signal)
    this.probe = probe
    this.probeController = controller
    const release = (): void => {
      if (this.probe === probe) {
        this.probe = undefined
        this.probeController = undefined
      }
    }
    void probe.then(release, release)
    return probe
  }

  /** Abort an in-flight shared probe with the plugin that owns it. */
  private abortProbe(): void {
    this.probeController?.abort(new Error('subagent-commandcode: probe cancelled with the plugin'))
  }

  private async runProbe(signal: AbortSignal): Promise<CommandCodeHealth> {
    const command = process.platform === 'win32' ? COMMAND_CODE_WINDOWS_COMMAND : COMMAND_CODE_POSIX_COMMAND
    let invocation: CommandCodeInvocation
    try {
      invocation = this.resolveInvocation()
    } catch (error: unknown) {
      return {
        command,
        installed: false,
        authenticated: false,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    return await probeCommandCode(this.runner(invocation), this.probeSignal(signal))
  }

  /** Run one short-lived helper through the shared process owner. */
  private runner(invocation: CommandCodeInvocation): CommandCodeRunner {
    return async (args, signal) => {
      const child = this.ctx.subprocess.spawn({
        argv: [invocation.program, ...invocation.prefix, ...args],
        cwd: process.cwd(),
        env: COMMAND_CODE_SKIP_UPDATES_ENV,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: PROBE_OUTPUT_BYTES },
          stderr: { maxBytes: PROBE_OUTPUT_BYTES },
        },
        graceMs: this.disposeGraceMs,
        signal,
      })
      const outcome = await child.done
      await child.waitForExit(AbortSignal.timeout(Math.ceil(this.disposeGraceMs))).catch(() => false)
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: child.collected.stdout?.readFrom(0).text ?? '',
        stderr: child.collected.stderr?.readFrom(0).text ?? '',
      }
    }
  }
}

export default CommandCodeController
