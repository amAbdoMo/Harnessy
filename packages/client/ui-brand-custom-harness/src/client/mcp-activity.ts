/** Secret-free MCP tool activity derived from one Session's durable Chat projection. */

import type { McpServerView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'

const ACTIVITY_LIMIT = 100

/** One MCP tool call safe to present in the Session header. */
export interface McpActivityRecord {
  readonly callId: string
  readonly serverId: string
  readonly toolName: string
  readonly technicalName: string
  readonly status: 'running' | 'success' | 'error'
  readonly startedAt: number
  readonly finishedAt?: number
}

/** Minimal Chat snapshot fields used by the activity projection. */
export interface McpActivityChatSnapshot {
  readonly legacy: {
    readonly nodes: readonly { readonly kind: string; readonly subCalls?: readonly ToolCallBlock[] }[]
    readonly runningCalls: readonly ToolCallBlock[]
  }
}

/**
 * Derive bounded MCP call history without copying tool arguments or results.
 * @param chat - current Session Chat snapshot.
 * @param servers - saved server names used to identify the tool namespace.
 * @returns newest-first activity records.
 */
export function mcpActivity(
  chat: McpActivityChatSnapshot | undefined,
  servers: readonly McpServerView[],
): readonly McpActivityRecord[] {
  if (chat === undefined) return []
  const calls: ToolCallBlock[] = []
  for (const node of chat.legacy.nodes) {
    if (node.kind === 'tool-result') calls.push(node as ToolCallBlock)
    else for (const call of node.subCalls ?? []) calls.push(call)
  }
  calls.push(...chat.legacy.runningCalls)
  const records = calls.flatMap(call => flattenCall(call, servers))
  return records
    .sort((left, right) => right.startedAt - left.startedAt)
    .filter((record, index, all) => all.findIndex(candidate => candidate.callId === record.callId) === index)
    .slice(0, ACTIVITY_LIMIT)
}

function flattenCall(call: ToolCallBlock, servers: readonly McpServerView[]): McpActivityRecord[] {
  const nested = call.subCalls.flatMap(child => flattenCall(child, servers))
  const settled = 'kind' in call
  const technicalName = settled ? call.call?.name : call.name
  if (technicalName === undefined) return nested
  const server = serverForTool(technicalName, servers)
  if (server === undefined) return nested
  const rawName = technicalName.slice(`mcp__${server.serverName}__`.length)
  const startedAt = settled ? call.callTime ?? call.time : call.time
  const record: McpActivityRecord = {
    callId: call.callId,
    serverId: server.id,
    toolName: friendlyToolName(rawName),
    technicalName,
    status: settled ? (call.isError ? 'error' : 'success') : 'running',
    startedAt,
    ...settled ? { finishedAt: call.time } : {},
  }
  return [record, ...nested]
}

function serverForTool(name: string, servers: readonly McpServerView[]): McpServerView | undefined {
  return [...servers]
    .sort((left, right) => right.serverName.length - left.serverName.length)
    .find(server => name.startsWith(`mcp__${server.serverName}__`))
}

function friendlyToolName(name: string): string {
  const words = name.replace(/[_-]+/gu, ' ').trim()
  return words === '' ? name : `${words[0]?.toLocaleUpperCase() ?? ''}${words.slice(1)}`
}
