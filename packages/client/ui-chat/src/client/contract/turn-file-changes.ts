import type { DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import { diffTotals } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatSnapshot } from './snapshot.ts'
import type { ChatNode } from './chat-nodes.ts'

/** Applied changes for one file during one turn. */
export interface TurnFileChange {
  readonly path: string
  readonly diffs: readonly DiffHunk[]
  readonly added: number
  readonly removed: number
}

/** Reliable tool-attributed file changes for one turn. */
export interface TurnFileChanges {
  readonly files: readonly TurnFileChange[]
  readonly added: number
  readonly removed: number
}

function diffsFromMeta(meta: unknown): readonly DiffHunk[] {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return []
  const candidate = (meta as { readonly diffs?: unknown }).diffs
  if (!Array.isArray(candidate)) return []
  const diffs: DiffHunk[] = []
  for (const hunk of candidate) {
    if (typeof hunk !== 'object' || hunk === null || Array.isArray(hunk)) return []
    const { path, oldText, newText } = hunk as Record<string, unknown>
    if (typeof path !== 'string' || (oldText !== null && typeof oldText !== 'string') || typeof newText !== 'string') {
      return []
    }
    diffs.push({ path, oldText, newText })
  }
  return diffs
}

function diffsFromToolBlock(block: ToolCallBlock): readonly DiffHunk[] {
  const own = 'kind' in block && !block.isError ? diffsFromMeta(block.meta) : []
  return [...own, ...block.subCalls.flatMap(diffsFromToolBlock)]
}

/**
 * Aggregate applied hunks by file without guessing command-side mutations.
 * @param diffs - Applied file hunks reported by tools.
 * @returns Per-file and total line counts, or `undefined` when no hunks exist.
 */
export function summarizeTurnDiffs(diffs: readonly DiffHunk[]): TurnFileChanges | undefined {
  if (diffs.length === 0) return undefined
  const byPath = new Map<string, DiffHunk[]>()
  for (const diff of diffs) byPath.set(diff.path, [...byPath.get(diff.path) ?? [], diff])
  const files = [...byPath].map(([path, fileDiffs]) => ({ path, diffs: fileDiffs, ...diffTotals(fileDiffs) }))
  const totals = diffTotals([...diffs])
  return { files, ...totals }
}

/**
 * Derive a settled turn summary from durable Session events.
 * @param events - Durable events belonging to the settled turn.
 * @returns Tool-attributed file changes, or `undefined` when none were recorded.
 */
export function turnChangesFromEvents(events: readonly SessionEvent[]): TurnFileChanges | undefined {
  return summarizeTurnDiffs(events.flatMap((event) => {
    if (event.type !== 'tool/result' || event.data.message.content[0].isError === true) return []
    return diffsFromMeta(event.data.meta)
  }))
}

/**
 * Derive the live summary for a loaded Chat turn.
 * @param snapshot - Loaded chat projection.
 * @param turn - Turn number to summarize.
 * @returns Tool-attributed file changes, or `undefined` when none are loaded.
 */
export function turnChangesFromChat(snapshot: ChatSnapshot, turn: number): TurnFileChanges | undefined {
  return summarizeTurnDiffs(snapshot.nodes.values().flatMap((node) => {
    const chatNode = node as ChatNode
    if (chatNode.kind !== 'tool-call') return []
    const location = chatNode.location
    const nodeTurn = location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : undefined
    if (nodeTurn !== turn) return []
    return diffsFromToolBlock(chatNode.data.root)
  }))
}
