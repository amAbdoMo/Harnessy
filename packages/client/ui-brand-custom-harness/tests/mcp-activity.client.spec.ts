import { describe, expect, it } from 'vitest'
import type { McpServerView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { mcpActivity, type McpActivityChatSnapshot } from '../src/client/mcp-activity.ts'

function server(id: string, serverName: string): McpServerView {
  return {
    id,
    name: id,
    serverName,
    transport: 'stdio',
    enabled: true,
    endpoint: 'npx',
    args: [],
    status: 'connected',
    tools: [],
    authenticationConfigured: false,
    environmentKeys: [],
    updatedAt: 1,
  }
}

function chat(nodes: readonly ToolCallBlock[], runningCalls: readonly ToolCallBlock[] = []): McpActivityChatSnapshot {
  return { legacy: { nodes: nodes as McpActivityChatSnapshot['legacy']['nodes'], runningCalls } }
}

describe('MCP Session activity', () => {
  it('keeps only MCP metadata and gives tools readable names', () => {
    const result = {
      kind: 'tool-result',
      seq: 2,
      time: 200,
      callId: 'call-1',
      call: { name: 'mcp__wordpress__get_posts', argsRaw: '{"password":"secret"}' },
      callTime: 100,
      content: [{ type: 'text', text: 'secret result' }],
      isError: false,
      subCalls: [],
    } as ToolCallBlock
    expect(mcpActivity(chat([result]), [server('wp', 'wordpress')])).toEqual([{
      callId: 'call-1',
      serverId: 'wp',
      toolName: 'Get posts',
      technicalName: 'mcp__wordpress__get_posts',
      status: 'success',
      startedAt: 100,
      finishedAt: 200,
    }])
  })

  it('reports running and failed calls newest first and ignores other tools', () => {
    const running = {
      callId: 'call-running', name: 'mcp__travel__search_flights', argsRaw: '{}',
      turn: 2, step: 1, time: 300, subCalls: [],
    } as ToolCallBlock
    const failed = {
      kind: 'tool-result', seq: 2, time: 250, callId: 'call-failed',
      call: { name: 'mcp__travel__book-flight', argsRaw: '{}' }, callTime: 200,
      content: [], isError: true, subCalls: [],
    } as ToolCallBlock
    const ordinary = {
      callId: 'call-local', name: 'read_file', argsRaw: '{}', turn: 1, step: 1, time: 400, subCalls: [],
    } as ToolCallBlock
    expect(mcpActivity(chat([failed], [ordinary, running]), [server('travel', 'travel')]).map(record => ({
      callId: record.callId,
      status: record.status,
    }))).toEqual([
      { callId: 'call-running', status: 'running' },
      { callId: 'call-failed', status: 'error' },
    ])
  })
})
