/** Optional approval detail from the exact correlated Chat Tool node. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'

/** Apply-owned identity lookup; components do not encode Conversation keys. */
export interface ApprovalCommandInjected {
  readonly nodeKey: (callId: PropsRuntime<'conversation.approval.detail'>['callId']) => string
}

/**
 * Extract command text from tool JSON when the arguments contain a command.
 * @param argsRaw - Correlated tool arguments.
 * @returns command text, or absence for malformed or unrelated arguments.
 */
export function commandOf(argsRaw: string): string | undefined {
  try {
    const args: unknown = JSON.parse(argsRaw)
    return typeof args === 'object' && args !== null && 'command' in args && typeof args.command === 'string'
      ? args.command : undefined
  } catch (_error) {
    // Incomplete streamed Tool JSON has no command preview.
    return undefined
  }
}

/**
 * Render a running root command without scanning the Chat node collection.
 * @param props - Correlated call, framework Chat hook, and injected identity lookup.
 * @returns command text, or no detail outside a running root call.
 */
export function ApprovalCommand({ callId, useChat, nodeKey }: PropsRuntime<'conversation.approval.detail'> & ApprovalCommandInjected) {
  const key = nodeKey(callId)
  const command = useChat((snapshot) => {
    const node = snapshot.nodes.get(key)
    const root = node?.kind === 'tool-call' ? (node as ChatNode<'tool-call'>).data.root : undefined
    return root !== undefined && !('kind' in root) && root.phase === 'start' ? commandOf(root.argsRaw) : undefined
  })
  return command ?? null
}
