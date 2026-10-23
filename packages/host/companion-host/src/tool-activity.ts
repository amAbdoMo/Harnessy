/** Opt-in literal tool summaries from trusted PC tool metadata, never raw arguments or result content. */
import { posix, win32 } from 'node:path'
import type { ApplicationBudget } from '@deepseek-ai/dsh-companion-protocol'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Compact identity retained by one watch; no argument or result payload is copied. */
export interface MobileToolCall {
  readonly seq: SessionSeq
  readonly callId: ToolCallId
  readonly turn: number
  readonly step: number
  readonly name: string
}

/** The caller owns the immutable cut or bounded live correlation cache and fresh permission checks. */
export interface MobileToolActivityContext {
  readonly callAt: (sequence: SessionSeq) => MobileToolCall | undefined
  readonly cwd: string
  readonly budget: ApplicationBudget
}

/**
 * Extract only call identity for a bounded watch cache.
 * @param event - Already accepted PC Session event.
 * @returns compact identity for a top-level tool call; other events carry none.
 */
export function mobileToolCall(event: SessionEvent): MobileToolCall | undefined {
  if (event.type !== 'tool/call') return undefined
  return { seq: event.seq, callId: event.data.callId, turn: event.data.turn, step: event.data.step, name: event.data.name }
}

/**
 * Resolve a call inside a caller-owned ordered observation, including before the current page.
 * @param events - Complete immutable Session observation in sequence order.
 * @param sequence - Exact event sequence cited by a result.
 * @returns compact call identity only when the cited event is a tool call.
 */
export function observedToolCall(events: readonly SessionEvent[], sequence: SessionSeq): MobileToolCall | undefined {
  let low = 0
  let high = events.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const event = events[middle]
    if (event === undefined) return undefined
    if (event.seq === sequence) return mobileToolCall(event)
    if (event.seq < sequence) low = middle + 1
    else high = middle - 1
  }
  return undefined
}

function record(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}
function count(value: JsonValue | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function safeLabel(value: string): boolean {
  return value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
}
function relativeTarget(cwd: string, value: JsonValue | undefined): string | undefined {
  if (typeof value !== 'string' || !safeLabel(value) || !safeLabel(cwd)
    || /^[\\/]{2}/u.test(value) || /^[\\/]{2}/u.test(cwd)) return undefined
  const windows = /^[A-Za-z]:[\\/]/u.test(cwd)
  const paths = windows ? win32 : posix
  if (!paths.isAbsolute(cwd) || (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) && !/^[A-Za-z]:[\\/]/u.test(value))
    || (!windows && /^[A-Za-z]:/u.test(value))) return undefined
  const target = paths.relative(cwd, paths.resolve(cwd, value))
  if (target === '' || target === '..' || target.startsWith(`..${paths.sep}`) || paths.isAbsolute(target)) return undefined
  return windows ? target.replaceAll('\\', '/') : target
}
function readSummary(meta: { [key: string]: JsonValue }): string | undefined {
  const offset = meta.offset
  const total = meta.totalLines
  const lines = meta.lines
  if (!count(offset) || offset < 1 || !count(total) || !Array.isArray(lines)) return undefined
  const returned = lines.length
  const last = offset + returned - 1
  if (!Number.isSafeInteger(last) || last > total || offset - 1 > total
    || !lines.every((line, index) => record(line)?.number === offset + index)) return undefined
  return `Returned ${returned} lines from ${offset}; total ${total}`
}
function details(name: string, metadata: JsonValue | undefined, cwd: string): string | undefined {
  const meta = record(metadata)
  if (meta === undefined) return undefined
  switch (name) {
    case 'read': {
      const target = relativeTarget(cwd, meta.path)
      const summary = readSummary(meta)
      return target === undefined || summary === undefined ? undefined : `${target}\n${summary}`
    }
    case 'write': {
      const target = relativeTarget(cwd, meta.path)
      return target === undefined || (meta.operation !== 'create' && meta.operation !== 'update')
        ? undefined : `${target}\n${meta.operation === 'create' ? 'Created' : 'Updated'}`
    }
    case 'edit': return relativeTarget(cwd, meta.path)
    case 'grep':
    case 'glob':
      if (meta.shape !== (name === 'grep' ? 'matches' : 'paths') || !count(meta.total) || typeof meta.truncated !== 'boolean') return undefined
      return `${name === 'grep' ? 'Matched lines' : 'Discovered paths'}: ${meta.total}${meta.truncated ? '\nPartial results' : ''}`
    default: return undefined
  }
}

/**
 * Build an allowlisted literal summary only for an exactly correlated result.
 * Tool names/metadata are trusted-composition observations, not authenticated producer identities;
 * scoped tools may shadow names. Filenames may be sensitive despite omission of contents and commands.
 * @param event - Accepted event; nested PTC events are deliberately excluded.
 * @param context - Current PC working directory, explicit byte budgets and call resolver.
 * @returns bounded text, or no summary when correlation or the fixed status cannot be represented.
 */
export function mobileToolResultText(event: SessionEvent, context: MobileToolActivityContext): string | undefined {
  if (event.type !== 'tool/result' || event.sourceEventSeqs?.length !== 1) return undefined
  const sequence = event.sourceEventSeqs[0]
  if (sequence === undefined || sequence >= event.seq) return undefined
  const call = context.callAt(sequence)
  const result = event.data
  if (call === undefined || call.seq !== sequence || call.callId !== result.message.toolCallId
    || call.callId !== result.message.source.callId || call.turn !== result.turn || call.step !== result.step) return undefined
  const name = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/u.test(call.name)
    && Buffer.byteLength(call.name, 'utf8') <= context.budget.maxTitleBytes ? call.name : 'tool'
  const base = `${name} — ${result.message.isError ? 'failed' : 'completed'}`
  if (Buffer.byteLength(base, 'utf8') > context.budget.maxTextBytes) return undefined
  if (result.message.isError) return base
  const summary = details(name, result.meta, context.cwd)
  if (summary === undefined) return base
  const text = `${base}\n${summary}`
  return Buffer.byteLength(text, 'utf8') <= context.budget.maxTextBytes ? text : base
}
