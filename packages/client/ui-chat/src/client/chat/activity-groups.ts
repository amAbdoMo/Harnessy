import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode, ChatNode } from '../contract/chat-nodes.ts'
import type { ChatNodeStore } from '../contract/snapshot.ts'

/** User-facing category for one compacted reasoning or tool activity. */
export type ActivityCategory =
  | 'think'
  | 'read'
  | 'search'
  | 'command'
  | 'edit'
  | 'mcp'
  | 'delegate'
  | 'tool'

/** One ordinary chat node or one consecutive activity group in display order. */
export type CompactFlowEntry =
  | { readonly kind: 'node'; readonly key: string }
  | {
    readonly kind: 'activity'
    readonly key: string
    readonly keys: readonly string[]
    readonly turn: number
    readonly categories: readonly ActivityCategory[]
    readonly anchors: readonly string[]
    readonly hasError: boolean
  }

function turnOf(node: ChatConversationViewNode): number | undefined {
  const location = node.location
  return location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : undefined
}

function toolName(block: ToolCallBlock): string {
  return 'kind' in block ? block.call?.name ?? block.callId : block.name
}

function toolCategory(name: string): ActivityCategory {
  const normalized = name.toLowerCase()
  if (normalized.startsWith('mcp_') || normalized.startsWith('mcp.')) return 'mcp'
  if (/subagent|delegate|spawn_agent/u.test(normalized)) return 'delegate'
  if (/apply_patch|edit|write|str_replace|create_file/u.test(normalized)) return 'edit'
  if (/web|search|find|grep|glob/u.test(normalized)) return 'search'
  if (/read|view_image|list_files/u.test(normalized)) return 'read'
  if (/bash|pwsh|powershell|terminal|exec|command/u.test(normalized)) return 'command'
  return 'tool'
}

function toolFailed(block: ToolCallBlock): boolean {
  if ('kind' in block && block.isError) return true
  return block.subCalls.some(toolFailed)
}

function toolAnchors(block: ToolCallBlock): readonly string[] {
  return [`call:${block.callId}`, ...block.subCalls.flatMap(toolAnchors)]
}

function activityCategory(node: ChatNode): ActivityCategory | undefined {
  if (node.kind === 'tool-call') return toolCategory(toolName(node.data.root))
  if (node.kind === 'assistant-step'
    && node.data.blocks.length > 0
    && node.data.blocks.every(block => block.kind === 'reasoning')) return 'think'
  return undefined
}

function appendActivity(
  entries: CompactFlowEntry[],
  node: ChatNode,
  category: ActivityCategory,
  turn: number,
  key: string,
): void {
  const previous = entries.at(-1)
  const failed = node.kind === 'tool-call' && toolFailed(node.data.root)
  if (previous?.kind !== 'activity' || previous.turn !== turn) {
    entries.push({
      kind: 'activity',
      key,
      keys: [node.key],
      turn,
      categories: [category],
      anchors: node.kind === 'tool-call' ? toolAnchors(node.data.root) : [],
      hasError: failed,
    })
    return
  }
  entries[entries.length - 1] = {
    ...previous,
    keys: [...previous.keys, node.key],
    categories: previous.categories.includes(category)
      ? previous.categories
      : [...previous.categories, category],
    anchors: node.kind === 'tool-call'
      ? [...previous.anchors, ...toolAnchors(node.data.root)]
      : previous.anchors,
    hasError: previous.hasError || failed,
  }
}

/**
 * Group consecutive reasoning and tool rows between user-facing progress messages.
 * @param order - Chat-node keys in display order.
 * @param nodes - Current chat-node store.
 * @param activeTurn - Turn whose low-level activity may be compacted.
 * @returns Ordered ordinary nodes and compact activity groups.
 */
export function compactFlow(
  order: readonly string[],
  nodes: ChatNodeStore,
  activeTurn: number,
): readonly CompactFlowEntry[] {
  const entries: CompactFlowEntry[] = []
  const groupsByTurn = new Map<number, number>()
  for (const key of order) {
    const node = nodes.get(key) as ChatNode | undefined
    if (node === undefined) continue
    const category = activityCategory(node)
    const turn = turnOf(node)
    if (category !== undefined && turn === activeTurn) {
      const previous = entries.at(-1)
      const ordinal = previous?.kind === 'activity' && previous.turn === turn
        ? groupsByTurn.get(turn) ?? 0
        : (groupsByTurn.get(turn) ?? 0) + 1
      groupsByTurn.set(turn, ordinal)
      appendActivity(entries, node, category, turn, `activity:${turn}:${ordinal}`)
    }
    else entries.push({ kind: 'node', key })
  }
  return entries
}
