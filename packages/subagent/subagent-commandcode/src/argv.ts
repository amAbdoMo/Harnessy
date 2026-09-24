/**
 * Command line construction for one delegated Command Code run.
 *
 * The brief travels on stdin: `-p` with no query argument is the CLI's
 * documented piped-input form, so task text never enters argv.
 *
 * @module @deepseek-ai/dsh-subagent-commandcode/argv
 */

import type { CommandCodeRunSpec } from './types.ts'

/**
 * Reject a value this build hands to the operating system as one argv token.
 * Empty or NUL-bearing values cannot be expressed as a token at all.
 * @param label - field name for the diagnostic.
 * @param value - the candidate token.
 * @returns the value, validated.
 */
export function assertProcessToken(label: string, value: string): string {
  if (value.length === 0) throw new TypeError(`commandcode: ${label} must not be empty`)
  if (value.includes('\0')) throw new TypeError(`commandcode: ${label} must not contain a NUL character`)
  if (value.includes('\n') || value.includes('\r')) {
    throw new TypeError(`commandcode: ${label} must not contain a line break`)
  }
  return value
}

/**
 * Build the flags for one headless run. The returned argv excludes the program
 * and any launcher prefix, and never carries the brief.
 * @param spec - the lane's resolved execution parameters.
 * @returns the CLI flags in a fixed order.
 */
export function commandCodeArgv(spec: CommandCodeRunSpec): string[] {
  // A run that names no model carries no `--model`, so the CLI answers with
  // its own configured default.
  const model = spec.model === undefined ? undefined : assertProcessToken('lane model', spec.model)
  const maxTurns = spec.maxTurns
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new TypeError(`commandcode: maxTurns must be a positive whole number, received ${String(maxTurns)}`)
  }
  return [
    // No query argument: the CLI reads the piped brief from stdin.
    '-p',
    // NDJSON event stream followed by one terminal result frame.
    '--output-format', 'json',
    // Harness keeps only the current-session job history, so the CLI must not
    // persist a transcript of its own.
    '--no-session',
    '--skip-onboarding',
    '--no-auto-update',
    '--max-turns', String(maxTurns),
    ...model === undefined ? [] : ['--model', model],
    ...spec.effort === 'default' ? [] : ['--effort', spec.effort],
    // Access is lane policy, never task text: full access bypasses the CLI's
    // permission prompts, read-only keeps its native plan mode.
    ...spec.access === 'full-access' ? ['--yolo'] : ['--permission-mode', 'plan'],
  ]
}
