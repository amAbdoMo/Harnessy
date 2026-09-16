/**
 * The background adaptation of one delegated run.
 *
 * The generic job registry registers a job synchronously and returns its id, so
 * the whole preflight → admission → spawn → teardown sequence runs inside the
 * job's `done` promise under one task-owned controller. A kill before the CLI
 * starts settles the job as killed and starts nothing; a kill after it starts
 * settles as killed once the process tree is gone. Every path returns the
 * concurrency permit it took.
 *
 * @module @deepseek-ai/dsh-subagent-commandcode/job
 */

import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { settleRun, type SubagentResult, type SubagentRun } from '@deepseek-ai/dsh-subagent'
import { MAX_COMMAND_CODE_OUTPUT_BYTES, boundCommandCodeText } from './bound.ts'
import { commandCodeFailureDiagnostic, commandCodeVisibleText } from './run.ts'
import type { CommandCodeRunRequest } from './run.ts'
import type {
  CommandCodeActivity,
  CommandCodeFailureCategory,
  CommandCodeHealth,
  CommandCodeRunSpec,
} from './types.ts'

/** The plugin surface one background job drives. */
export interface CommandCodeJobApi {
  /**
   * Confirm the installed CLI is present and signed in, immediately before a run.
   * @param signal - task cancellation.
   */
  preflight(signal: AbortSignal): Promise<CommandCodeHealth>
  /**
   * Take one concurrency slot.
   * @param signal - task cancellation while queued.
   */
  acquire(signal: AbortSignal): Promise<() => void>
  /**
   * Start one delegated run.
   * @param request - brief, workspace, and task cancellation.
   * @param spec - the lane's resolved execution parameters.
   * @param onActivity - receives each coarse activity change.
   */
  start(
    request: CommandCodeRunRequest,
    spec: CommandCodeRunSpec,
    onActivity: (activity: CommandCodeActivity) => void,
  ): SubagentRun
}

/** One background delegation's registration inputs, already resolved by the caller. */
export interface CommandCodeJobParts {
  /** The plugin surface the task drives. */
  readonly api: CommandCodeJobApi
  /** Complete brief written to the CLI's stdin. */
  readonly brief: string
  /** Delegating Session's workspace. */
  readonly workspace: string
  /** The lane's resolved execution parameters. */
  readonly spec: CommandCodeRunSpec
  /** One-line model-facing label. */
  readonly label: string
  /** Host diagnostic sink for a failure the task had to absorb. */
  readonly onError?: ((error: Error) => void) | undefined
}

/** The lifecycle surface the generic job runtime drives for one delegation. */
export type CommandCodeJob = JobHooks

/** Outcome of admitting one task to the concurrency gate. */
type PermitResult =
  | { readonly kind: 'permit'; readonly release: () => void }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'refused' }

/** One run's terminal outcome for a cancelled task. */
function killed(): JobOutcome {
  return { status: 'killed' }
}

/**
 * Report one delegation that never reached a run. The detail is the same
 * fixed-vocabulary diagnostic a failed run uses, so it carries no host path,
 * command, credential, or product transcript.
 * @param category - the fixed failure category.
 * @returns a failed outcome with bounded, product-owned detail.
 */
function startFailure(category: CommandCodeFailureCategory): JobOutcome {
  return {
    status: 'failed',
    detail: boundCommandCodeText(
      commandCodeFailureDiagnostic({ stage: 'start', category }),
      MAX_COMMAND_CODE_OUTPUT_BYTES,
    ),
  }
}

/**
 * Take one concurrency slot, tolerating cancellation while queued.
 * @param api - the plugin surface owning the gate.
 * @param signal - task cancellation.
 * @returns the permit, or why none was taken.
 */
async function takePermit(api: CommandCodeJobApi, signal: AbortSignal): Promise<PermitResult> {
  try {
    return { kind: 'permit', release: await api.acquire(signal) }
  } catch {
    // The gate only refuses a caller that was cancelled for it, in which case
    // no slot exists to return; anything else is reported as a start failure.
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'refused' }
  }
}

/**
 * Run the admitted task: probe the CLI, spawn it, and settle its run.
 *
 * The terminal result is awaited before disposal for the same reason the
 * foreground path does it, and it is what the job renders for a later read.
 * @param parts - the resolved registration inputs.
 * @param signal - task cancellation.
 * @param onActivity - receives each coarse activity change.
 * @param onTerminal - receives the parent-visible text of a settled run.
 * @returns the terminal outcome for this delegation.
 */
async function execute(
  parts: CommandCodeJobParts,
  signal: AbortSignal,
  onActivity: (activity: CommandCodeActivity) => void,
  onTerminal: (text: string) => void,
): Promise<JobOutcome> {
  const health = await parts.api.preflight(signal)
  // A cancelled task reports no verdict about the CLI.
  if (signal.aborted) return killed()
  if (!health.installed || !health.authenticated) {
    // No fallback to another product, model, or executable: the user's own
    // Command Code CLI is the only backend this job has.
    return startFailure(health.installed ? 'not-authenticated' : 'not-installed')
  }
  let run: SubagentRun
  try {
    run = parts.api.start(
      { brief: parts.brief, cwd: parts.workspace, signal },
      parts.spec,
      onActivity,
    )
  } catch (error: unknown) {
    parts.onError?.(error instanceof Error ? error : new Error(String(error)))
    return startFailure('spawn')
  }
  // The seam contract says `result` settles before disposal and does not reject
  // on a child-level failure; an infrastructure fault still must not stop the
  // shared settlement from producing the outcome below.
  const result = await run.result.then(
    (value): SubagentResult | undefined => value,
    (): undefined => undefined,
  )
  const outcome = await settleRun(run)
  // The parent reads this after settlement; a killed run has nothing to show.
  if (result !== undefined && outcome.status !== 'killed') {
    onTerminal(commandCodeVisibleText(result))
  }
  return outcome
}

/**
 * Begin one background delegation's task and return the hooks the registry drives.
 *
 * The caller invokes this from `JobStart.run`, so nothing exists until the job is
 * registered: before that call the task holds no concurrency permit and starts
 * no process. `done` never rejects; a start-time failure is a `failed` outcome
 * carrying product-owned detail, and a cancellation is `killed`.
 *
 * `readOutput` serves both halves of the generic job contract: while the task is
 * live it yields the coarse activity produced since the previous read, and after
 * settlement it yields the same bounded text a foreground delegation returns —
 * the final answer, or the product-owned diagnostic with any preserved partial
 * answer. Without that second half a stream job's terminal output would be
 * unreachable, because the registry returns a producer's `output` only for jobs
 * that expose no `readOutput`.
 * @param parts - resolved lane policy, brief, workspace, and the plugin surface.
 * @returns the hooks the generic job runtime drives.
 */
export function startCommandCodeJob(parts: CommandCodeJobParts): CommandCodeJob {
  const controller = new AbortController()
  let activity: CommandCodeActivity | undefined
  let reported: CommandCodeActivity | undefined
  let terminal: string | undefined

  const done = (async (): Promise<JobOutcome> => {
    // A settled read shows the same text the run produced, or — for a
    // delegation that never reached a run — the product-owned detail the
    // outcome already carries.
    const record = (outcome: JobOutcome): JobOutcome => {
      if (terminal === undefined && outcome.status === 'failed' && outcome.detail !== undefined) {
        terminal = boundCommandCodeText(outcome.detail, MAX_COMMAND_CODE_OUTPUT_BYTES)
      }
      return outcome
    }
    const permit = await takePermit(parts.api, controller.signal)
    if (permit.kind === 'cancelled') return killed()
    if (permit.kind === 'refused') return record(startFailure('unknown'))
    try {
      return record(await execute(
        parts,
        controller.signal,
        (next) => { activity = next },
        (text) => { terminal = text },
      ))
    } catch (error: unknown) {
      // `execute` reports its own terminal states; reaching here means an
      // unexpected host failure, which must not reject the job's `done`.
      parts.onError?.(error instanceof Error ? error : new Error(String(error)))
      return record(startFailure('unknown'))
    } finally {
      permit.release()
    }
  })()

  return {
    cancel: (reason?: string) => {
      if (controller.signal.aborted) return
      controller.abort(reason ?? 'background Command Code delegation killed')
    },
    done,
    readOutput: () => {
      // Settled: the terminal text is the whole answer, and a pending activity
      // delta is stale by definition.
      if (terminal !== undefined) return terminal
      // Live status only: a coarse category, never transcript detail.
      if (activity === undefined || activity === reported) return ''
      reported = activity
      return `${parts.label}: ${activity}\n`
    },
  }
}
