import { describe, expect, it } from 'vitest'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import type { ChatNodeStore, ChatSnapshot } from '../src/client/contract/snapshot.ts'
import { compactFlow } from '../src/client/chat/activity-groups.ts'
import { summarizeTurnDiffs, turnChangesFromChat } from '../src/client/contract/turn-file-changes.ts'

function node(key: string, kind: ChatNode['kind'], data: unknown, turn = 1): ChatNode {
  return {
    key,
    kind,
    target: 'chat',
    anchorSeq: 1,
    visibility: 'visible',
    location: { kind: 'turn', turn: { turn } },
    data,
  } as unknown as ChatNode
}

function store(nodes: readonly ChatNode[]): ChatNodeStore {
  const byKey = new Map(nodes.map(candidate => [candidate.key, candidate]))
  return {
    get: key => byKey.get(key),
    values: () => nodes,
    source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
    processSource: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
  }
}

function tool(key: string, name: string, error = false): ChatNode {
  return node(key, 'tool-call', {
    root: error
      ? {
        kind: 'tool-result', callId: key, call: { name, argsRaw: '{}' }, callTime: 0,
        seq: 2, time: 2, content: [], isError: true, subCalls: [],
      }
      : { callId: key, name, argsRaw: '{}', turn: 1, step: 1, time: 1, subCalls: [] },
  })
}

describe('compact live turn presentation', () => {
  it('groups consecutive tool activity between normal progress messages and opens failed groups', () => {
    const nodes = [
      node('think', 'assistant-step', { blocks: [{ kind: 'reasoning', text: 'Inspecting.' }] }),
      tool('read', 'read_file'),
      tool('edit', 'apply_patch'),
      node('progress', 'assistant-step', { blocks: [{ kind: 'text', text: 'Implemented the first part.' }] }),
      tool('mcp', 'mcp_wordpress_update', true),
    ]
    expect(compactFlow(nodes.map(candidate => candidate.key), store(nodes), 1)).toEqual([
      expect.objectContaining({
        kind: 'activity', keys: ['think', 'read', 'edit'], categories: ['think', 'read', 'edit'], hasError: false,
      }),
      { kind: 'node', key: 'progress' },
      expect.objectContaining({ kind: 'activity', keys: ['mcp'], categories: ['mcp'], hasError: true }),
    ])
  })
})

describe('turn file changes', () => {
  it('aggregates successful attributed hunks by file and excludes failed tools', () => {
    const successful = node('write', 'tool-call', {
      root: {
        kind: 'tool-result', callId: 'write', call: { name: 'write', argsRaw: '{}' }, callTime: 0,
        seq: 2, time: 2, content: [], isError: false,
        meta: { diffs: [
          { path: 'src/a.ts', oldText: 'old\n', newText: 'new\nnext\n' },
          { path: 'src/a.ts', oldText: null, newText: 'tail\n' },
        ] },
        subCalls: [{
          kind: 'tool-result', callId: 'nested', call: { name: 'edit', argsRaw: '{}' }, callTime: 0,
          seq: 4, time: 4, content: [], isError: false, subCalls: [],
          meta: { diffs: [{ path: 'src/b.ts', oldText: 'before\n', newText: 'after\n' }] },
        }],
      },
    })
    const failed = node('failed', 'tool-call', {
      root: {
        kind: 'tool-result', callId: 'failed', call: { name: 'edit', argsRaw: '{}' }, callTime: 0,
        seq: 3, time: 3, content: [], isError: true, subCalls: [],
        meta: { diffs: [{ path: 'ignored.ts', oldText: null, newText: 'no' }] },
      },
    })
    const nodes = store([successful, failed])
    const snapshot = { nodes } as unknown as ChatSnapshot
    expect(turnChangesFromChat(snapshot, 1)).toEqual({
      files: [
        {
          path: 'src/a.ts',
          diffs: [
            { path: 'src/a.ts', oldText: 'old\n', newText: 'new\nnext\n' },
            { path: 'src/a.ts', oldText: null, newText: 'tail\n' },
          ],
          added: 3,
          removed: 1,
        },
        {
          path: 'src/b.ts',
          diffs: [{ path: 'src/b.ts', oldText: 'before\n', newText: 'after\n' }],
          added: 1,
          removed: 1,
        },
      ],
      added: 4,
      removed: 2,
    })
    expect(summarizeTurnDiffs([])).toBeUndefined()
  })
})
