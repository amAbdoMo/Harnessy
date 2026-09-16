/**
 * One-shot Command Code lifecycle: spawn the user's CLI through the shared
 * subprocess owner in the delegating Session's workspace, read its NDJSON
 * stream, and settle only a genuine final answer as completed.
 *
 * @module @deepseek-ai/dsh-subagent-commandcode/run
 */

import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { assertProcessToken, commandCodeArgv } from './argv.ts'
import { MAX_COMMAND_CODE_OUTPUT_BYTES, boundCommandCodeText } from './bound.ts'
import type { CommandCodeInvocation } from './cli.ts'
import { CommandCodeFrameReader, classifyExitCode, resultFailure } from './protocol.ts'
import type { CommandCodeActivity, CommandCodeFailureCategory, CommandCodeRunSpec } from './types.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** UTF-8 bytes of stderr retained on the Host for diagnostics; never model-visible. */
const STDERR_TAIL_BYTES = 8_192

/** Where one delegation failed: before a run existed, during it, or while releasing it. */
export type CommandCodeFailureStage = 'start' | 'run' | 'teardown'

/** Fixed safe facts describing one failed run. */
export interface CommandCodeFailureFacts {
  readonly stage: CommandCodeFailureStage
  readonly category: CommandCodeFailureCategory
  readonly outcome?: SubprocessOutcome | undefined
}

const CATEGORY_REASONS: Readonly<Record<CommandCodeFailureCategory, string>> = {
  'not-installed': 'the Command Code CLI is not installed',
  'not-authenticated': 'the Command Code CLI is not signed in',
  'access-denied': 'Command Code denied the requested access',
  'rate-limited': 'Command Code rate limit reached',
  network: 'Command Code could not reach its service',
  service: 'Command Code reported a server error',
  credits: 'the Command Code account has insufficient credits',
  'max-turns': 'the run reached its turn limit before a final answer',
  'no-answer': 'the run ended without a final answer',
  timeout: 'the run exceeded its time limit',
  cancelled: 'the run was cancelled',
  protocol: 'the run ended before producing a final result',
  spawn: 'the Command Code process could not be started',
  teardown: 'the Command Code process could not be stopped cleanly',
  unknown: 'the delegation failed',
}

/**
 * Render fixed safe facts for one failed delegation. Only the stage, category,
 * and process exit facts are stated; raw stderr, Command Code's own error text,
 * commands, and file contents stay on the Host.
 * @param facts - the failure facts.
 * @returns model-visible diagnostic text.
 */
export function commandCodeFailureDiagnostic(facts: CommandCodeFailureFacts): string {
  const fields = [
    'product: Command Code',
    `stage: ${facts.stage}`,
    `cause: ${CATEGORY_REASONS[facts.category]}`,
  ]
  const exitCode = facts.outcome?.exitCode
  if (exitCode !== null && exitCode !== undefined) fields.push(`exit code: ${exitCode}`)
  const signal = facts.outcome?.signal
  if (signal !== null && signal !== undefined) fields.push(`signal: ${signal}`)
  return `Product delegation failure (${fields.join('; ')})`
}

/** Everything one run needs from its owning plugin. */
export interface CommandCodeRunDeps {
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Resolved executable and fixed launcher arguments. */
  readonly invocation: CommandCodeInvocation
  /** Subprocess termination grace passed to the shared managed-range owner. */
  readonly graceMs: number
  /** Host diagnostic sink; never reaches the parent Session. */
  readonly onError?: ((error: Error, stopReason: SubagentStopReason) => void) | undefined
  /** Receives the bounded stderr tail once, for Host logging only. */
  readonly onStderrTail?: ((tail: string) => void) | undefined
  /** Receives each coarse activity change while the run is in flight. */
  readonly onActivity?: ((activity: CommandCodeActivity) => void) | undefined
}

/** Caller-owned inputs for one delegated run. */
export interface CommandCodeRunRequest {
  /** Complete brief written to the CLI's stdin. */
  readonly brief: string
  /** Delegating Session's workspace. */
  readonly cwd: string
  /** Parent cancellation. */
  readonly signal: AbortSignal
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed subprocess failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Start one Command Code run and publish its handle.
 *
 * The caller has already resolved the lane, so `spec` carries the only
 * authority this run has: a lane the user enabled, with the access that lane
 * chose. The brief travels on stdin, never in argv.
 * @param request - brief, workspace, and parent cancellation.
 * @param spec - the lane's resolved execution parameters.
 * @param deps - process owner, executable, grace, and diagnostic sinks.
 * @returns the published run; awaiting `result` never rejects.
 * @throws {Error} when the process could not be started at all, which publishes no run.
 */
export function startCommandCodeRun(
  request: CommandCodeRunRequest,
  spec: CommandCodeRunSpec,
  deps: CommandCodeRunDeps,
): SubagentRun {
  const argv = [
    assertProcessToken('executable', deps.invocation.program),
    ...deps.invocation.prefix.map(part => assertProcessToken('launcher argument', part)),
    ...commandCodeArgv(spec),
  ]

  const controller = new AbortController()
  const deadline = new AbortController()
  const onAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('commandcode: run cancelled locally'))
  }
  request.signal.addEventListener('abort', onAbort, { once: true })

  const reader = new CommandCodeFrameReader()
  const settled = Promise.withResolvers<SubagentResult>()
  let settledResult: SubagentResult | undefined
  let outcome: SubprocessOutcome | undefined
  let partialText = ''
  let diagnostic: string | undefined

  const finish = (result: SubagentResult): void => {
    if (settledResult !== undefined) return
    settledResult = result
    clearTimeout(timer)
    settled.resolve(result)
  }
  const fail = (facts: CommandCodeFailureFacts): void => {
    diagnostic = commandCodeFailureDiagnostic(facts)
    finish({
      output: partialText.length === 0 ? [] : [{ type: 'text', text: partialText }],
      diagnostic,
      stopReason: 'error',
    })
  }

  const timer = setTimeout(() => {
    // Terminate the managed range, then settle with the deadline as the cause —
    // the child's signal exit is a consequence, not the reason.
    deadline.abort(new Error('commandcode: run exceeded its time limit'))
    fail({ stage: 'run', category: 'timeout', outcome })
  }, spec.timeoutMs)

  const acceptFrame = (): void => {
    const frame = reader.result
    if (frame === undefined || settledResult !== undefined) return
    // The parent Session only ever sees text inside this one bound, so the
    // limiter runs here rather than at each consumer.
    const text = boundCommandCodeText(frame.finalText, MAX_COMMAND_CODE_OUTPUT_BYTES)
    partialText = text
    const failure = resultFailure(frame)
    if (failure === undefined) {
      finish({ output: [{ type: 'text', text }], stopReason: 'completed' })
      return
    }
    fail({ stage: 'run', category: failure, outcome })
  }

  let child: SubprocessHandle
  try {
    child = deps.spawn({
      argv,
      cwd: request.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: STDERR_TAIL_BYTES } },
      graceMs: deps.graceMs,
      signal: AbortSignal.any([controller.signal, deadline.signal]),
    })
  } catch (error: unknown) {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', onAbort)
    throw thrown(error)
  }

  const decoder = new TextDecoder()
  let reportedActivity: CommandCodeActivity | undefined
  const onStdoutData = (chunk: Buffer | string): void => {
    reader.push(decoder.decode(typeof chunk === 'string' ? Buffer.from(chunk) : chunk, { stream: true }))
    const activity = reader.activity
    if (activity !== undefined && activity !== reportedActivity) {
      reportedActivity = activity
      deps.onActivity?.(activity)
    }
    acceptFrame()
  }
  const onStreamError = (): void => {
    // Stream faults are classified from the process outcome below; the seam
    // owns terminal settlement for both streams.
  }
  child.stdout?.on('data', onStdoutData)
  child.stdout?.on('error', onStreamError)
  child.stderr?.on('error', onStreamError)
  const stdin = child.stdin
  if (stdin !== undefined) {
    stdin.on('error', onStreamError)
    stdin.end(Buffer.from(request.brief, 'utf8'))
  }

  void child.done.then(
    (value) => {
      outcome = value
      // A stream may end without a newline after its last frame.
      reader.flush()
      acceptFrame()
      if (settledResult === undefined) {
        const category = classifyExitCode(value.exitCode)
        fail({
          stage: 'run',
          category: category === 'unknown' ? 'protocol' : category,
          outcome: value,
        })
      }
      deps.onStderrTail?.(child.collected.stderr?.readFrom(0).text ?? '')
    },
    (error: unknown) => {
      deps.onError?.(thrown(error), 'error')
      fail({ stage: 'run', category: 'spawn', outcome })
    },
  )

  const result = settleRunResult({
    attempt: () => settled.promise,
    collectOutput: () => partialText.length === 0 ? [] : [{ type: 'text', text: partialText }],
    collectDiagnostic: () => diagnostic ?? 'Command Code delegation was cancelled',
    // Only caller and disposal cancellation settle as `aborted`; a deadline is
    // a failure the run already reported.
    cancelled: () => controller.signal.aborted,
    onError: deps.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel: onAbort,
    teardown: async () => {
      clearTimeout(timer)
      child.stdout?.off('data', onStdoutData)
      child.stdout?.off('error', onStreamError)
      child.stderr?.off('error', onStreamError)
      stdin?.off('error', onStreamError)
      try {
        stdin?.end()
      } catch (error: unknown) {
        // A stdin the child already closed is not a teardown failure.
        void error
      }
      child.terminate()
      try {
        await child.waitForExit()
      } catch (error: unknown) {
        const failure = thrown(error)
        deps.onError?.(failure, 'error')
        await child.done.catch(() => {})
        throw failure
      }
      await child.done.catch(() => {})
    },
  })
}

/**
 * Render the parent-visible text of one settled run.
 * @param result - the run's terminal result.
 * @returns the final answer, or the preserved partial answer when the run failed.
 */
export function commandCodeResultText(result: SubagentResult): string {
  return result.output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Render the one text a settled run shows its parent, bounded at the source.
 *
 * A completed run shows its final answer. Every other stop reason shows the
 * product-owned diagnostic plus whatever partial answer the CLI already
 * produced, because a failed run's partial text is the only evidence the parent
 * gets without the transcript. Foreground and background delegations both read
 * their parent-visible text here, so the two routes cannot drift.
 * @param result - the run's terminal result.
 * @returns the bounded text for the parent Session.
 */
export function commandCodeVisibleText(result: SubagentResult): string {
  const text = commandCodeResultText(result)
  if (result.stopReason === 'completed') {
    return boundCommandCodeText(text, MAX_COMMAND_CODE_OUTPUT_BYTES)
  }
  const headline = result.diagnostic ?? 'Command Code delegation did not complete'
  const visible = text.length === 0
    ? headline
    : `${headline}\nPartial output before the run ended:\n${text}`
  return boundCommandCodeText(visible, MAX_COMMAND_CODE_OUTPUT_BYTES)
}
