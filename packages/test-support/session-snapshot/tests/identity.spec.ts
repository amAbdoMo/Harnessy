import { describe, expect, it } from 'vitest'
import { redactSessionSnapshotIds } from '../src/identity.ts'

const parentId = '11111111-1111-4111-8111-111111111111'
const childId = '22222222-2222-4222-8222-222222222222'
const messageId = '33333333-3333-4333-8333-333333333333'
const approvalId = '44444444-4444-4444-8444-444444444444'
const runId = '55555555-5555-4555-8555-555555555555'
const otherId = '66666666-6666-4666-8666-666666666666'
const proseUuid = '77777777-7777-4777-8777-777777777777'

function preparationReceipt(requestId: string): string {
  return `${JSON.stringify({ requestId, profileId: 'saved-account', mcpServerName: 'paired-mcp', status: 'pending' })}\nWaiting for the human to Resume this request. No page access is granted.`
}

function preparationRecords(text: string, name = 'website_prepare', isError = false): Record<string, unknown>[] {
  return [
    { type: 'tool/call', data: { name, callId: 'prepare-call', arguments: { profileId: 'saved-account' } } },
    { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId: 'prepare-call' },
      toolCallId: 'prepare-call', isError, content: [{ type: 'text', text }] } } },
  ]
}

function jsonl(records: Record<string, unknown>[]): string {
  return `${records.map(record => JSON.stringify(record)).join('\n')}\n`
}

describe('session snapshot identity redaction', () => {
  it('links preparation JSON text to request-scoped tool names and approvals across logs', () => {
    const nextRequestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const pageTool = `website_page_info_${otherId}`
    const parent = jsonl([
      { type: 'session', id: parentId },
      ...preparationRecords(preparationReceipt(otherId)),
      { type: 'request/header', data: { header: { tools: [{ name: pageTool, parameters: {} }] } } },
      { type: 'assistant/message', data: { message: { role: 'assistant', content: [
        { type: 'tool-call', id: 'page-call', name: pageTool, arguments: {} },
        { type: 'text', text: `Unrelated UUID ${proseUuid}` },
      ], source: {}, id: messageId } } },
      { type: 'tool/call', data: { callId: 'page-call', name: pageTool, arguments: {} } },
      { type: 'approval/asked', data: { id: approvalId, description: pageTool } },
      { type: 'approval/decided', data: { id: approvalId, decision: 'allow' } },
      ...preparationRecords(preparationReceipt(nextRequestId)),
    ])
    const child = jsonl([{ type: 'session', id: childId },
      { type: 'example', data: { requestId: otherId, tool: pageTool } }])
    const redacted = redactSessionSnapshotIds([parent, child])
    expect(redacted[0]).toContain(preparationReceipt('{{id:1}}').split('\n')[0]!.replaceAll('"', '\\"'))
    expect(redacted[0]?.match(/website_page_info_\{\{id:1\}\}/g)).toHaveLength(4)
    expect(redacted[0]).toContain('{{id:2}}')
    expect(redacted[0]).toContain(proseUuid)
    expect(redacted[1]).toContain('"requestId":"{{id:1}}"')
    expect(redacted[1]).toContain('website_page_info_{{id:1}}')
    expect(redacted.join('\n')).not.toContain(otherId)
    expect(redactSessionSnapshotIds(redacted)).toEqual(redacted)
  })

  it.each<[string, Record<string, unknown>[]]>([
    ['unrelated tool', preparationRecords(preparationReceipt(proseUuid), 'another_tool')],
    ['failed preparation', preparationRecords(preparationReceipt(proseUuid), 'website_prepare', true)],
    ['uncorrelated result', preparationRecords(preparationReceipt(proseUuid)).slice(1)],
    ['malformed JSON', preparationRecords(`{\"requestId\":\"${proseUuid}\"\nWaiting for the human to Resume this request. No page access is granted.`)],
    ['missing receipt fields', preparationRecords(`{\"requestId\":\"${proseUuid}\"}\nWaiting for the human to Resume this request. No page access is granted.`)],
    ['UUID prose', preparationRecords(`Request ${proseUuid}`)],
    ['JSON without checkpoint text', preparationRecords(JSON.stringify({ requestId: proseUuid, profileId: 'saved-account', mcpServerName: 'paired-mcp', status: 'pending' }))],
    ['wrong pending status', preparationRecords(preparationReceipt(proseUuid).replace('pending', 'granted'))],
  ])('leaves %s identifiers unclaimed', (_scenario, records) => {
    const source = jsonl(records)
    expect(redactSessionSnapshotIds([source])).toEqual([source])
  })

  it('preserves feedback versions and target relationships without redacting unrelated prose', () => {
    const source = [
      { type: 'session', id: parentId },
      { type: 'assistant/message', data: { message: { id: messageId, role: 'assistant', content: [], source: {} } } },
      { type: 'feedback/message-put', data: { sessionId: parentId, item: { messageId, version: approvalId, note: proseUuid } } },
      { type: 'feedback/message-put', data: { sessionId: parentId, item: { messageId, version: runId } } },
      { type: 'feedback/message-delete', data: { sessionId: parentId, messageId } },
      { type: 'example', data: { version: proseUuid } },
    ].map(record => JSON.stringify(record)).join('\n')
    const [output] = redactSessionSnapshotIds([source])
    expect(output).toContain('"version":"{{id:1}}"')
    expect(output).toContain('"version":"{{id:2}}"')
    expect(output?.match(/"messageId":"{{message:1}}"/g)).toHaveLength(3)
    expect(output).toContain(proseUuid)
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('preserves typed relationships across parent and child logs', () => {
    const parent = [
      JSON.stringify({ type: 'session', id: parentId, createdAt: 1, cwd: '/tmp/work' }),
      JSON.stringify({
        type: 'agent/inbox/spliced',
        data: {
          inserted: [{
            role: 'user',
            content: [{ type: 'text', text: `keep unrelated ${proseUuid}; session ${childId}` }],
            source: { kind: 'user' },
            id: messageId,
          }],
        },
      }),
      JSON.stringify({ type: 'approval/asked', data: { id: approvalId } }),
      JSON.stringify({ type: 'tool-workflow/run-start', data: { runId } }),
      JSON.stringify({ type: 'example', data: { requestId: otherId, echoed: otherId } }),
      '',
    ].join('\n')
    const child = [
      JSON.stringify({ type: 'session', id: childId, parentSession: parentId, createdAt: 2, cwd: '/tmp/work' }),
      JSON.stringify({
        type: 'user/message',
        data: {
          role: 'user', content: [], source: { kind: 'user' }, id: messageId,
        },
      }),
      '',
    ].join('\n')

    const redacted = redactSessionSnapshotIds([parent, child])
    expect(redacted[0]).toContain('"id":"{{session:1}}"')
    expect(redacted[1]).toContain('"id":"{{session:2}}"')
    expect(redacted[1]).toContain('"parentSession":"{{session:1}}"')
    expect(redacted.join('\n').match(/\{\{message:1\}\}/g)).toHaveLength(2)
    expect(redacted[0]).toContain('"id":"{{approval:1}}"')
    expect(redacted[0]).toContain('"runId":"{{workflow:1}}"')
    expect(redacted[0]).toContain('"requestId":"{{id:1}}"')
    expect(redacted[0]).toContain('"echoed":"{{id:1}}"')
    expect(redacted[0]).toContain(proseUuid)
    expect(redacted[0]).toContain('session {{session:2}}')
    expect(redactSessionSnapshotIds(redacted)).toEqual(redacted)
  })

  it('classifies semantic text plus command, RPC, and retry identity fields', () => {
    const semanticMessage = '88888888-8888-4888-8888-888888888888'
    const anonymousUser = '99999999-9999-4999-8999-999999999999'
    const retryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const source = [
      JSON.stringify({ type: 'not-a-session', data: { value: 'plain' } }),
      JSON.stringify({
        type: 'example',
        data: {
          commandId: 'command-7',
          rpcId: 'rpc-9',
          retryId,
          requestId: 'stable-readable-id',
          text: `Retain this as message ${semanticMessage}. Anonymous user: ${anonymousUser}`,
        },
      }),
    ].join('\n')

    const [redacted] = redactSessionSnapshotIds([source])
    expect(redacted).toContain('"commandId":"{{command:1}}"')
    expect(redacted).toContain('"rpcId":"{{rpc:1}}"')
    expect(redacted).toContain('"retryId":"{{retry:1}}"')
    expect(redacted).toContain('as message {{message:1}}')
    expect(redacted).toContain('Anonymous user: {{id:1}}')
    expect(redacted).toContain('"requestId":"stable-readable-id"')
    expect(redacted?.endsWith('\n')).toBe(false)
  })

  it('keeps a canonical token first seen through a generic id key', () => {
    const canonical = '{{message:7}}'
    const nextMessage = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const source = [
      JSON.stringify({ type: 'example', data: { requestId: canonical } }),
      JSON.stringify({
        type: 'user/message',
        data: { role: 'user', content: [], source: { kind: 'user' }, id: canonical },
      }),
      JSON.stringify({
        type: 'user/message',
        data: { role: 'user', content: [], source: { kind: 'user' }, id: nextMessage },
      }),
      '',
    ].join('\n')

    const [redacted] = redactSessionSnapshotIds([source])
    expect(redacted?.match(/\{\{message:7\}\}/g)).toHaveLength(2)
    expect(redacted).toContain('"id":"{{message:8}}"')
    expect(redacted).not.toContain('{{id:')
  })
})
