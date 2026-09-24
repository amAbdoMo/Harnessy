/**
 * The Command Code headless wire: incremental NDJSON frame reading, coarse
 * activity classification, and the CLI's documented exit-code vocabulary.
 *
 * The reader keeps only what the product shows: the one terminal result frame
 * and a coarse activity category. Event frames are read for their type and
 * tool name alone, so no command text, file content, tool input, or reasoning
 * text can reach the parent Session through this module.
 *
 * @module @deepseek-ai/dsh-subagent-commandcode/protocol
 */

import type { CommandCodeActivity, CommandCodeFailureCategory } from './types.ts'

type JsonObject = Record<string, unknown>

/** One process exit code the CLI documents. */
const EXIT_SUCCESS = 0

/** Exit code to failure category, transcription of the CLI's documented codes. */
const EXIT_CODE_CATEGORIES: Readonly<Record<number, CommandCodeFailureCategory>> = {
  3: 'not-authenticated',
  4: 'access-denied',
  5: 'rate-limited',
  6: 'network',
  7: 'service',
  8: 'max-turns',
  9: 'no-answer',
  10: 'credits',
  130: 'cancelled',
}

/**
 * Classify one child exit code into the only vocabulary the parent is shown.
 * @param exitCode - the child's exit code, or null after a signal exit.
 * @returns the matching failure category, or `unknown`.
 */
export function classifyExitCode(exitCode: number | null): CommandCodeFailureCategory {
  if (exitCode === null) return 'unknown'
  if (exitCode === EXIT_SUCCESS) return 'unknown'
  return EXIT_CODE_CATEGORIES[exitCode] ?? 'unknown'
}

/** Tool-name fragments that report a mutating file operation. */
const EDITING_FRAGMENTS = ['write', 'edit', 'patch', 'apply', 'create', 'delete', 'remove', 'move', 'rename', 'mkdir']
/** Tool-name fragments that report running a command. */
const COMMAND_FRAGMENTS = ['bash', 'shell', 'command', 'exec', 'terminal', 'process', 'spawn']
/** Tool-name fragments that report reading or searching. */
const READING_FRAGMENTS = ['read', 'view', 'list', 'grep', 'glob', 'search', 'fetch', 'cat', 'head', 'tail', 'find', 'open', 'stat', 'tree']

function containsAny(value: string, fragments: readonly string[]): boolean {
  return fragments.some(fragment => value.includes(fragment))
}

/**
 * Classify one Command Code tool name into a coarse activity.
 * @param toolName - the wire tool name reported by an event frame.
 * @returns the activity to show, or undefined for an unrecognized tool.
 */
export function activityForTool(toolName: string): CommandCodeActivity | undefined {
  const name = toolName.toLowerCase()
  if (containsAny(name, EDITING_FRAGMENTS)) return 'editing'
  if (containsAny(name, COMMAND_FRAGMENTS)) return 'command'
  if (containsAny(name, READING_FRAGMENTS)) return 'reading'
  return undefined
}

function objectOf(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Classify one event frame's inner `AgentEvent`.
 * @param event - the frame's `event` object.
 * @returns the activity to show, or undefined for an event with no coarse meaning.
 */
function classifyEvent(event: JsonObject): CommandCodeActivity | undefined {
  const type = stringOf(event.type)?.toLowerCase() ?? ''
  if (type.includes('think') || type.includes('reason')) return 'thinking'
  if (type.includes('result') || type.includes('complete') || type.includes('final') || type.includes('done')) {
    return 'finalizing'
  }
  const toolName = stringOf(event.toolName)
  return toolName === undefined ? undefined : activityForTool(toolName)
}

/** The one terminal frame a successful or failed run always ends with. */
export interface CommandCodeResultFrame {
  /** `success`, `error`, or `max_turns`; other values stay forward-compatible. */
  readonly subtype: string
  /** The assistant's final answer; empty on an error result. */
  readonly finalText: string
  /** Why the loop ended, when the CLI reported it. */
  readonly stopReason?: string
  /** Product-owned error text, when the CLI reported one. */
  readonly error?: string
}

/**
 * Incremental line-delimited JSON reader for one Command Code run.
 *
 * Unreadable lines are counted rather than thrown: the CLI writes progress to
 * stderr, so a partially written or unknown line must not end a run that later
 * produces a valid result frame.
 */
export class CommandCodeFrameReader {
  private buffer = ''
  private terminal: CommandCodeResultFrame | undefined
  private latest: CommandCodeActivity | undefined
  private unreadable = 0

  /**
   * Feed one stdout chunk.
   * @param chunk - decoded text in stream order.
   */
  push(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.accept(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  /**
   * Read the trailing line a stream may end without a newline after, then
   * clear the buffer. A stream cut mid-frame simply fails to parse, and the
   * missing result frame is what reports the truncation.
   */
  flush(): void {
    const trailing = this.buffer
    this.buffer = ''
    if (trailing.trim().length > 0) this.accept(trailing)
  }

  /** The latest coarse activity, or undefined before the first readable frame. */
  get activity(): CommandCodeActivity | undefined {
    return this.terminal === undefined ? this.latest : 'finalizing'
  }

  /** The terminal result frame, or undefined when the stream produced none. */
  get result(): CommandCodeResultFrame | undefined {
    return this.terminal
  }

  /** Count of lines that were not readable JSON objects. */
  get unreadableFrames(): number {
    return this.unreadable
  }

  private accept(line: string): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      this.unreadable += 1
      return
    }
    const frame = objectOf(parsed)
    if (frame === undefined) {
      this.unreadable += 1
      return
    }
    const type = stringOf(frame.type)
    if (type === 'result') {
      this.terminal = this.readResult(frame)
      return
    }
    if (type !== 'event') return
    const event = objectOf(frame.event)
    if (event === undefined) {
      this.unreadable += 1
      return
    }
    const activity = classifyEvent(event)
    if (activity !== undefined) this.latest = activity
  }

  private readResult(frame: JsonObject): CommandCodeResultFrame {
    const stopReason = stringOf(frame.stopReason)
    const error = stringOf(frame.error)
    return {
      // An unrecognized subtype stays verbatim; dispatch treats it as a failure.
      subtype: stringOf(frame.subtype) ?? '',
      finalText: stringOf(frame.finalText) ?? '',
      ...stopReason === undefined ? {} : { stopReason },
      ...error === undefined ? {} : { error },
    }
  }
}

/**
 * Decide whether one terminal frame is a genuine completed answer.
 * @param frame - the run's terminal frame.
 * @returns the failure category, or undefined when the frame carries a real answer.
 */
export function resultFailure(frame: CommandCodeResultFrame): CommandCodeFailureCategory | undefined {
  if (frame.subtype === 'max_turns') return 'max-turns'
  if (frame.subtype !== 'success') return 'unknown'
  return frame.finalText.trim().length === 0 ? 'no-answer' : undefined
}
