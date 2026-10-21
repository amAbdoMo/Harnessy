/** Mobile parser regression source; run only after parent integrates source paths. */
import { describe, expect, it } from 'vitest'
import {
  encodeApplicationRequest, encodeApplicationResult, MAX_MOBILE_JSON_BYTES,
  parseApplicationBudget, parseApplicationRequest, parseApplicationResult,
} from '../src/application.ts'

const budget = parseApplicationBudget({
  maxRequestBytes: 4096, maxResultBytes: 4096, maxTextBytes: 1024, maxTitleBytes: 128,
  maxRows: 2, maxSessions: 2, maxSubscriptionsPerGrant: 2, maxPendingSubmissionsPerGrant: 2,
  readTimeoutMs: 5000, subscriptionLifetimeMs: 60_000,
})
const id = Buffer.alloc(16, 1).toString('base64url')
const seq = (value: bigint): string => {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64BE(value)
  return bytes.toString('base64url')
}
const submit = { v: 1, type: 'submitText', requestId: id, sessionId: 'session-1', text: 'hello', submissionId: id }
const list = { v: 1, type: 'listSessions', requestId: id, limit: 2 }
const summary = { sessionId: 'session-1', title: '聊天 😀', status: 'closed' }
const workspace = { id: 'workspace-1', title: 'مشروع 项目 😀', order: 0 }
const navigation = { updatedAt: 1234, pinOrder: null, workspace }
const sessionsJson = (sessions: readonly object[]): string => JSON.stringify({ v: 1, requestId: id, type: 'sessions', sessions })
const operationId = Buffer.alloc(16, 2).toString('base64url')
const continuation = Buffer.alloc(32, 3).toString('base64url')
const managementIdentity = { v: 1, requestId: id, operationId, sessionId: 'session-1' }
const create = { ...managementIdentity, type: 'createSession', sessionId: `mobile-${operationId}`, workspaceId: workspace.id }
const rename = { ...managementIdentity, type: 'renameSession', title: '聊天 😀' }
const archive = { ...managementIdentity, type: 'archiveSession' }
const pin = { ...managementIdentity, type: 'setSessionPinned', pinned: true }
const managementList = { v: 1, type: 'listManagementWorkspaces', requestId: id, limit: 2 }
const managementRequests = [
  managementList, { ...managementList, limit: 1, cursor: continuation }, create, rename, archive, pin,
  { ...pin, pinned: false }, { ...rename, title: '' }, { ...rename, title: '😀'.repeat(32) },
  { ...rename, sessionId: 'a'.repeat(128) }, { ...create, workspaceId: 'a'.repeat(128) },
]
const managementWorkspaceResult = { v: 1, requestId: id, type: 'managementWorkspaces', enabled: true, workspaces: [workspace] }
const managedBase = { ...managementIdentity, type: 'managed', action: 'rename', outcome: 'applied' }
const applied = { ...managedBase, session: { ...summary, navigation } }
const managementActions = ['create', 'rename', 'archive', 'pin'] as const
const rejectionCodes = ['denied', 'expired', 'notFound', 'busy', 'conflict', 'limit', 'unavailable'] as const
const managementResults = [
  { ...managementWorkspaceResult, enabled: false, workspaces: [] },
  { ...managementWorkspaceResult, workspaces: [] },
  { ...managementWorkspaceResult, workspaces: [workspace, { ...workspace, id: 'workspace-2', order: Number.MAX_SAFE_INTEGER }], cursor: continuation },
  ...managementActions.flatMap((action) => {
    const common = { ...managedBase, action, sessionId: action === 'create' ? create.sessionId : summary.sessionId }
    return [
      { ...common, ...(action === 'archive' ? {} : { session: { ...summary, sessionId: common.sessionId, navigation } }) },
      { ...common, outcome: 'unknown' },
      ...rejectionCodes.map(code => ({ ...common, outcome: 'rejected', code })),
    ]
  }),
]
const invalidFixedIds = [
  '', 1, null, `${id}=`, `${id}+`, `${id}/`, id.slice(0, -1) + 'R',
  Buffer.alloc(15).toString('base64url'), Buffer.alloc(17).toString('base64url'),
]
const invalidTokens = ['', null, 1, '/private', 'bad id', '😀', 'a'.repeat(129)]

describe('legacy companion application compatibility', () => {
  const historyRows = [{ role: 'assistant', seq: seq(0n), id: 'message-1', text: 'answer' }]
  const common = { v: 1, requestId: id }
  const requests = [
    { ...common, type: 'listSessions', limit: 2 },
    { ...common, type: 'listSessions', limit: 2, cursor: continuation, view: 'navigation' },
    { ...common, type: 'readHistory', sessionId: summary.sessionId, limit: 2, cursor: continuation },
    { ...common, type: 'watchProgress', sessionId: summary.sessionId, cursor: continuation },
    { ...common, type: 'submitText', sessionId: summary.sessionId, text: 'hello', submissionId: id },
    { ...common, type: 'cancelRead', subscriptionId: id },
  ]
  const results = [
    { ...common, type: 'sessions', sessions: [summary] },
    { ...common, type: 'sessions', sessions: [{ ...summary, navigation }], cursor: continuation },
    { ...common, type: 'history', sessionId: summary.sessionId, rows: historyRows, cursor: continuation },
    { ...common, type: 'watching', sessionId: summary.sessionId, subscriptionId: id },
    { v: 1, type: 'progress', subscriptionId: id, sessionId: summary.sessionId, rows: historyRows, status: 'idle', cursor: continuation },
    { ...common, type: 'submitted', sessionId: summary.sessionId, submissionId: id, admission: 'inMemoryInbox' },
    { ...common, type: 'cancelled', subscriptionId: id },
    ...['denied', 'notFound', 'limit', 'expired', 'unavailable'].map(code => ({ ...common, type: 'error', code })),
  ]

  it.each(requests)('preserves legacy request bytes %j', (request) => {
    const json = JSON.stringify(request)
    expect(encodeApplicationRequest(parseApplicationRequest(json, budget), budget)).toBe(json)
  })

  it.each(results)('preserves legacy result bytes %j', (result) => {
    const json = JSON.stringify(result)
    expect(encodeApplicationResult(parseApplicationResult(json, budget), budget)).toBe(json)
  })

  it.each(['busy', 'conflict'])('does not add management-only rejection code %s to legacy errors', (code) => {
    expect(() => parseApplicationResult(JSON.stringify({ ...common, type: 'error', code }), budget)).toThrow()
  })

  it.each([
    [summary, summary],
    [summary, { ...summary, sessionId: 'session-2' }, { ...summary, sessionId: 'session-3' }],
  ].map(sessions => [sessions]))('retains duplicate and count limits for legacy Session arrays %j', (sessions) => {
    expect(() => parseApplicationResult(sessionsJson(sessions), budget)).toThrow()
  })
})

describe('text-only companion application', () => {
  it('preserves exact legacy request and three-field summary JSON without navigation', () => {
    const request = JSON.stringify({ v: 1, requestId: id, type: 'listSessions', limit: 2 })
    expect(encodeApplicationRequest(parseApplicationRequest(request, budget), budget)).toBe(request)
    const json = sessionsJson([summary])
    const parsed = parseApplicationResult(json, budget)
    expect(encodeApplicationResult(parsed, budget)).toBe(json)
    if (parsed.type !== 'sessions') throw new Error('Expected sessions')
    expect(Object.keys(parsed.sessions[0]!)).toEqual(['sessionId', 'title', 'status'])
    const optIn = { ...list, view: 'navigation' }
    expect(parseApplicationRequest(JSON.stringify(optIn), budget)).toEqual(optIn)
  })

  it.each(['legacy', '', 'Navigation', null, 0, false, {}, []].map(view => [view]))('rejects unsupported list view %j', (view) => {
    expect(() => parseApplicationRequest(JSON.stringify({ ...list, view }), budget)).toThrow()
  })

  it('round-trips atomic Unicode navigation with duplicate Workspace titles and distinct IDs', () => {
    const sessions = [
      { ...summary, navigation: { ...navigation, updatedAt: 0, pinOrder: 0 } },
      { ...summary, sessionId: 'session-2', navigation: {
        updatedAt: Number.MAX_SAFE_INTEGER, pinOrder: Number.MAX_SAFE_INTEGER,
        workspace: { ...workspace, id: 'workspace-2', order: Number.MAX_SAFE_INTEGER },
      } },
    ]
    const json = sessionsJson(sessions)
    expect(encodeApplicationResult(parseApplicationResult(json, budget), budget)).toBe(json)
    const unassigned = sessionsJson([{ ...summary, navigation: { updatedAt: 0, pinOrder: null, workspace: null } }])
    expect(encodeApplicationResult(parseApplicationResult(unassigned, budget), budget)).toBe(unassigned)
    const titleLimit = sessionsJson([{ ...summary, navigation: {
      ...navigation, workspace: { ...workspace, title: '😀'.repeat(32) },
    } }])
    expect(encodeApplicationResult(parseApplicationResult(titleLimit, budget), budget)).toBe(titleLimit)
  })

  it.each([
    null, {}, { updatedAt: 1 }, { updatedAt: 1, pinOrder: null },
    { pinOrder: null, workspace: null }, { updatedAt: 1, workspace: null },
    { ...navigation, updatedAt: null }, { ...navigation, updatedAt: -1 },
    { ...navigation, updatedAt: 0.5 }, { ...navigation, updatedAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...navigation, pinOrder: -1 }, { ...navigation, pinOrder: 0.5 },
    { ...navigation, pinOrder: Number.MAX_SAFE_INTEGER + 1 }, { ...navigation, pinOrder: '0' },
    { ...navigation, cwd: '/private' }, { ...navigation, workspace: {} },
    { ...navigation, workspace: { id: 'workspace-1', title: 'title' } },
    { ...navigation, workspace: { title: 'title', order: 0 } },
    { ...navigation, workspace: { id: 'workspace-1', order: 0 } },
    { ...navigation, workspace: { ...workspace, path: '/private' } },
    ...['', '/private', 'bad id', '😀', 'a'.repeat(129)].map(id => ({ ...navigation, workspace: { ...workspace, id } })),
    ...[null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0'].map(order => ({ ...navigation, workspace: { ...workspace, order } })),
    { ...navigation, workspace: { ...workspace, title: null } },
    { ...navigation, workspace: { ...workspace, title: '\ud800' } },
    { ...navigation, workspace: { ...workspace, title: '😀'.repeat(33) } },
  ])('rejects partial or unapproved navigation fields %j', (value) => {
    expect(() => parseApplicationResult(sessionsJson([{ ...summary, navigation: value }]), budget)).toThrow()
  })

  it('charges navigation, Unicode Workspace titles, and cursors to the exact whole JSON budget', () => {
    const json = JSON.stringify({ v: 1, requestId: id, type: 'sessions',
      sessions: [{ ...summary, navigation }], cursor: Buffer.alloc(32).toString('base64url') })
    const result = parseApplicationResult(json, budget)
    const exact = { ...budget, maxResultBytes: Buffer.byteLength(json, 'utf8') }
    expect(encodeApplicationResult(result, exact)).toBe(json)
    expect(() => encodeApplicationResult(result, { ...exact, maxResultBytes: exact.maxResultBytes - 1 })).toThrow()
    expect(() => parseApplicationResult(json, { ...exact, maxResultBytes: 1 })).toThrow()
    const legacy = sessionsJson([summary])
    expect(parseApplicationResult(legacy, { ...budget, maxResultBytes: Buffer.byteLength(legacy) }).type).toBe('sessions')
    expect(() => parseApplicationResult(sessionsJson([{ ...summary, navigation }]),
      { ...budget, maxResultBytes: Buffer.byteLength(legacy) })).toThrow()
  })

  it('enforces the fixed 49,152-byte ceiling on complete navigation lists', () => {
    const largest = parseApplicationBudget({ ...budget, maxResultBytes: MAX_MOBILE_JSON_BYTES,
      maxTitleBytes: 1024, maxSessions: 256 })
    const sessions = Array.from({ length: 55 }, (_, index) => ({
      ...summary, sessionId: `session-${index}`, navigation: {
        ...navigation, workspace: { ...workspace, title: '界'.repeat(300) },
      },
    }))
    const json = sessionsJson(sessions)
    expect(Buffer.byteLength(json)).toBeGreaterThan(MAX_MOBILE_JSON_BYTES)
    expect(() => parseApplicationResult(json, largest)).toThrow()
  })

  it.each([
    { ...submit, type: 'createSession' },
    { ...submit, mode: 'steer' },
    { ...submit, attachments: [] },
    { ...submit, rpcId: 'operator-command' },
    { ...submit, view: 'navigation' },
    { ...submit, text: '\ud800' },
    { ...submit, submissionId: `${id}=` },
    { ...submit, v: 2 },
  ])('rejects unsupported mutation fields and noncanonical inputs %j', (value) => {
    expect(() => parseApplicationRequest(JSON.stringify(value), budget)).toThrow()
  })

  it('counts multibyte text and complete result wrappers before encoding', () => {
    const valid = parseApplicationRequest(JSON.stringify({ ...submit, text: '😀'.repeat(256) }), budget)
    expect(valid.type).toBe('submitText')
    expect(() => parseApplicationRequest(JSON.stringify({ ...submit, text: '😀'.repeat(257) }), budget)).toThrow()
    const json = JSON.stringify({ v: 1, type: 'history', requestId: id, sessionId: 'session-1', rows: [
      { role: 'assistant', seq: seq(0n), id: 'message-1', text: 'answer' },
    ] })
    const parsed = parseApplicationResult(json, budget)
    const encoded = encodeApplicationResult(parsed, { ...budget, maxResultBytes: Buffer.byteLength(json) })
    expect(JSON.parse(encoded)).toEqual(JSON.parse(json))
    expect(Buffer.byteLength(encoded)).toBe(Buffer.byteLength(json))
    expect(() => encodeApplicationResult(parsed, { ...budget, maxResultBytes: Buffer.byteLength(json) - 1 })).toThrow()
  })

  it.each([
    [{ role: 'assistant', seq: seq(0n), id: 'a', text: 'ok', url: 'https://example.invalid' }],
    [{ role: 'system', seq: seq(0n), id: 'a', text: 'secret' }],
    [{ role: 'notice', seq: seq(2n), id: 'a', text: 'ok' }, { role: 'notice', seq: seq(1n), id: 'b', text: 'ok' }],
    [{ role: 'notice', seq: seq(1n), id: 'a', text: 'ok' }, { role: 'notice', seq: seq(2n), id: 'a', text: 'ok' }],
    [0, 1, 2].map(n => ({ role: 'notice', seq: seq(BigInt(n)), id: `m-${n}`, text: 'ok' })),
  ].map(rows => [rows]))('rejects unapproved or unordered history projection %j', (rows) => {
    expect(() => parseApplicationResult(JSON.stringify({ v: 1, type: 'history', requestId: id, sessionId: 'session-1', rows }), budget)).toThrow()
  })

  it('reports only volatile inbox admission and omits an authoritative receipt endpoint', () => {
    const acknowledged = parseApplicationResult(JSON.stringify({
      v: 1, type: 'submitted', requestId: id, sessionId: 'session-1', submissionId: id, admission: 'inMemoryInbox',
    }), budget)
    expect(acknowledged.type).toBe('submitted')
    expect(() => parseApplicationRequest(JSON.stringify({ v: 1, type: 'readSubmissionReceipt', requestId: id, submissionId: id }), budget)).toThrow()
    expect(() => parseApplicationResult(JSON.stringify({
      v: 1, type: 'submitted', requestId: id, sessionId: 'session-1', submissionId: id, admission: 'durableCompletion',
    }), budget)).toThrow()
  })
})

describe('closed chat management requests', () => {
  it.each(managementRequests)('round-trips supported management requests %j', (request) => {
    const parsed = parseApplicationRequest(JSON.stringify(request), budget)
    expect(parsed).toEqual(request)
    expect(JSON.parse(encodeApplicationRequest(parsed, budget))).toEqual(request)
  })

  it.each([create, rename, archive, pin, managementList].flatMap(request =>
    ['provider', 'cwd', 'model', 'rpcId', 'view', 'delete'].map(field => ({ ...request, [field]: 'unapproved' })),
  ))('rejects unapproved management request fields %j', (request) => {
    expect(() => parseApplicationRequest(JSON.stringify(request), budget)).toThrow()
  })

  it.each([create, rename, archive, pin, managementList].flatMap(request =>
    Object.keys(request).map(field => ({ ...request, [field]: undefined })),
  ))('requires every management request field %j', (request) => {
    expect(() => parseApplicationRequest(JSON.stringify(request), budget)).toThrow()
  })

  it.each([
    ...[create, rename, archive, pin].flatMap(request => [
      ...invalidFixedIds.map(requestId => ({ ...request, requestId })),
      ...invalidFixedIds.map(operationId => ({ ...request, operationId })),
      ...invalidTokens.map(sessionId => ({ ...request, sessionId })),
      { ...request, v: 2 },
    ]),
    ...invalidTokens.map(workspaceId => ({ ...create, workspaceId })),
    { ...create, sessionId: summary.sessionId },
    { ...create, operationId: id },
    { ...create, text: 'not empty' },
    { ...create, title: 'not supported' },
    ...[null, 0, false, {}, [], '\ud800', '😀'.repeat(33)].map(title => ({ ...rename, title })),
    ...[null, 0, 1, 'true', {}, []].map(pinned => ({ ...pin, pinned })),
    { ...pin, toggle: true },
    { ...archive, title: 'extra' },
    { ...archive, type: 'deleteSession' },
    { ...archive, type: 'Delete' },
    ...[0, -1, 0.5, 3, Number.MAX_SAFE_INTEGER + 1, '1', null].map(limit => ({ ...managementList, limit })),
    ...[null, '', `${continuation}=`, 'bad cursor'].map(cursor => ({ ...managementList, cursor })),
  ])('rejects malformed or unbound management requests %j', (request) => {
    expect(() => parseApplicationRequest(JSON.stringify(request), budget)).toThrow()
  })

  it.each([
    { request: create, patch: { sessionId: summary.sessionId } },
    { request: create, patch: { operationId: `${operationId}=` } },
    { request: create, patch: { workspaceId: '/private' } },
    { request: rename, patch: { requestId: `${id}=` } },
    { request: rename, patch: { title: '\ud800' } },
    { request: rename, patch: { title: '😀'.repeat(33) } },
    { request: rename, patch: { title: null } },
    { request: pin, patch: { pinned: 'true' } },
    { request: archive, patch: { title: 'extra' } },
    { request: archive, patch: { type: 'deleteSession' } },
    { request: managementList, patch: { limit: 3 } },
  ])('rejects invalid management values before request encryption %j', ({ request, patch }) => {
    const parsed = parseApplicationRequest(JSON.stringify(request), budget)
    const untrustedFields: Record<string, unknown> = patch
    expect(() => encodeApplicationRequest({ ...parsed, ...untrustedFields }, budget)).toThrow()
  })

  it.each(managementRequests)('charges the complete management request UTF-8 envelope %j', (request) => {
    const parsed = parseApplicationRequest(JSON.stringify(request), budget)
    const json = encodeApplicationRequest(parsed, budget)
    const exact = { ...budget, maxRequestBytes: Buffer.byteLength(json, 'utf8') }
    expect(parseApplicationRequest(json, exact)).toEqual(parsed)
    expect(encodeApplicationRequest(parsed, exact)).toBe(json)
    const short = { ...exact, maxRequestBytes: exact.maxRequestBytes - 1 }
    expect(() => parseApplicationRequest(json, short)).toThrow()
    expect(() => encodeApplicationRequest(parsed, short)).toThrow()
    const extra = { provider: 'unapproved' }
    expect(() => encodeApplicationRequest({ ...parsed, ...extra }, budget)).toThrow()
  })
})

describe('management Workspace projection', () => {
  it.each([
    { ...managementWorkspaceResult, workspaces: [{ ...workspace, title: '' }] },
    { ...managementWorkspaceResult, workspaces: [{ ...workspace, title: '😀'.repeat(32), id: 'a'.repeat(128) }] },
  ])('accepts bounded Workspace title and token limits %j', (result) => {
    const parsed = parseApplicationResult(JSON.stringify(result), budget)
    expect(JSON.parse(encodeApplicationResult(parsed, budget))).toEqual(result)
  })

  it.each([
    ...[null, 0, 'true', [], {}].map(enabled => ({ ...managementWorkspaceResult, enabled })),
    { ...managementWorkspaceResult, enabled: undefined },
    { ...managementWorkspaceResult, workspaces: undefined },
    ...[null, {}, 'rows'].map(workspaces => ({ ...managementWorkspaceResult, workspaces })),
    { ...managementWorkspaceResult, enabled: false },
    { ...managementWorkspaceResult, enabled: false, workspaces: [], cursor: continuation },
    { ...managementWorkspaceResult, enabled: false, workspaces: [], cursor: null },
    { ...managementWorkspaceResult, workspaces: [workspace, workspace] },
    { ...managementWorkspaceResult, workspaces: [workspace, { ...workspace, id: 'w-2' }, { ...workspace, id: 'w-3' }] },
    { ...managementWorkspaceResult, cwd: '/private' },
    ...[null, '', `${continuation}=`, 'bad cursor'].map(cursor => ({ ...managementWorkspaceResult, cursor })),
  ])('rejects disabled leaks and invalid Workspace envelopes %j', (result) => {
    expect(() => parseApplicationResult(JSON.stringify(result), budget)).toThrow()
  })

  it.each([
    null, [], 1, {},
    ...Object.keys(workspace).map(field => ({ ...workspace, [field]: undefined })),
    ...invalidTokens.map(id => ({ ...workspace, id })),
    ...[null, 0, false, {}, [], '\ud800', '😀'.repeat(33)].map(title => ({ ...workspace, title })),
    ...[null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0'].map(order => ({ ...workspace, order })),
    { ...workspace, path: '/private' },
  ].map(row => [row]))('rejects invalid Workspace rows %j', (row) => {
    expect(() => parseApplicationResult(JSON.stringify({ ...managementWorkspaceResult, workspaces: [row] }), budget)).toThrow()
  })
})

describe('settled management results', () => {
  it.each(managementResults)('round-trips every supported action and outcome %j', (result) => {
    const parsed = parseApplicationResult(JSON.stringify(result), budget)
    expect(parsed).toEqual(result)
    expect(JSON.parse(encodeApplicationResult(parsed, budget))).toEqual(result)
  })

  it.each([
    ...Object.keys(managedBase).map(field => ({ ...applied, [field]: undefined })),
    ...invalidFixedIds.map(requestId => ({ ...applied, requestId })),
    ...invalidFixedIds.map(operationId => ({ ...applied, operationId })),
    ...invalidTokens.map(sessionId => ({ ...applied, sessionId })),
    ...[null, 1, '', 'delete', 'setSessionPinned'].map(action => ({ ...applied, action })),
    ...[null, 1, '', 'admitted', 'durableCompletion'].map(outcome => ({ ...applied, outcome })),
    { ...applied, v: 2 },
    { ...applied, provider: 'unapproved' },
    { ...applied, code: 'denied' },
    { ...managedBase, action: 'archive', session: summary },
    { ...managedBase, sessionId: create.sessionId, action: 'create', session: { ...summary, navigation, sessionId: create.sessionId }, operationId: id },
    ...['create', 'rename', 'pin'].map(action => ({ ...managedBase, action, sessionId: action === 'create' ? create.sessionId : summary.sessionId })),
    ...[null, {}, summary, { ...summary, navigation: null }, { ...summary, navigation: {} },
      { ...summary, navigation, sessionId: 'session-2' }, { ...summary, navigation, status: 'deleted' },
      { ...summary, navigation, title: '\ud800' }, { ...summary, navigation, title: '😀'.repeat(33) },
      { ...summary, navigation, cwd: '/private' }, { ...summary, navigation: { ...navigation, model: 'unapproved' } },
    ].map(session => ({ ...managedBase, session })),
    { ...managedBase, outcome: 'rejected' },
    ...[null, 1, '', 'deleted', 'inMemoryInbox'].map(code => ({ ...managedBase, outcome: 'rejected', code })),
    { ...applied, outcome: 'rejected', code: 'denied' },
    { ...managedBase, outcome: 'unknown', code: 'busy' },
    { ...applied, outcome: 'unknown' },
    { ...managedBase, outcome: 'rejected', code: 'busy', revision: 1 },
    { ...managedBase, outcome: 'unknown', receipt: 'durable' },
  ])('rejects invalid settlement fields, identities, and applied rows %j', (result) => {
    expect(() => parseApplicationResult(JSON.stringify(result), budget)).toThrow()
  })

  it.each([
    { result: managementWorkspaceResult, patch: { enabled: false } },
    { result: managementWorkspaceResult, patch: { enabled: 'true' } },
    { result: managementWorkspaceResult, patch: { workspaces: [workspace, workspace] } },
    { result: managementWorkspaceResult, patch: { workspaces: [{ ...workspace, order: 0.5 }] } },
    { result: managementWorkspaceResult, patch: { workspaces: [{ ...workspace, title: '😀'.repeat(33) }] } },
    { result: applied, patch: { operationId: `${operationId}=` } },
    { result: applied, patch: { action: 'delete' } },
    { result: applied, patch: { session: { ...summary, navigation, sessionId: 'session-2' } } },
    { result: applied, patch: { session: summary } },
    { result: applied, patch: { session: { ...summary, navigation, title: '\ud800' } } },
    { result: applied, patch: { action: 'archive' } },
    { result: applied, patch: { outcome: 'unknown' } },
    { result: { ...managedBase, outcome: 'unknown' }, patch: { outcome: 'rejected' } },
    { result: { ...managedBase, outcome: 'rejected', code: 'busy' }, patch: { code: 'unsupported' } },
  ])('rejects invalid management values before result encryption %j', ({ result, patch }) => {
    const parsed = parseApplicationResult(JSON.stringify(result), budget)
    const untrustedFields: Record<string, unknown> = patch
    expect(() => encodeApplicationResult({ ...parsed, ...untrustedFields }, budget)).toThrow()
  })

  it.each(managementResults)('charges the complete management result UTF-8 envelope %j', (result) => {
    const parsed = parseApplicationResult(JSON.stringify(result), budget)
    const json = encodeApplicationResult(parsed, budget)
    const exact = { ...budget, maxResultBytes: Buffer.byteLength(json, 'utf8') }
    expect(parseApplicationResult(json, exact)).toEqual(parsed)
    expect(encodeApplicationResult(parsed, exact)).toBe(json)
    const short = { ...exact, maxResultBytes: exact.maxResultBytes - 1 }
    expect(() => parseApplicationResult(json, short)).toThrow()
    expect(() => encodeApplicationResult(parsed, short)).toThrow()
    const extra = { model: 'unapproved' }
    expect(() => encodeApplicationResult({ ...parsed, ...extra }, budget)).toThrow()
  })

  it('bounds aggregate Workspace results by the fixed plaintext ceiling', () => {
    const largest = parseApplicationBudget({ ...budget, maxResultBytes: MAX_MOBILE_JSON_BYTES, maxTitleBytes: 1024, maxSessions: 256 })
    const workspaces = Array.from({ length: 55 }, (_, index) => ({ ...workspace, id: `workspace-${index}`, title: '界'.repeat(300) }))
    const json = JSON.stringify({ ...managementWorkspaceResult, workspaces })
    expect(Buffer.byteLength(json, 'utf8')).toBeGreaterThan(MAX_MOBILE_JSON_BYTES)
    expect(() => parseApplicationResult(json, largest)).toThrow()
    const relaxed = { ...largest, maxResultBytes: MAX_MOBILE_JSON_BYTES * 2 }
    expect(() => parseApplicationResult(json, relaxed)).toThrow()
    const small = JSON.stringify({ ...managementWorkspaceResult, workspaces: workspaces.map(row => ({ ...row, title: '' })) })
    const parsed = parseApplicationResult(small, largest)
    if (parsed.type !== 'managementWorkspaces' || !parsed.enabled) throw new Error('Expected enabled Workspaces')
    const oversized = { ...parsed, workspaces: parsed.workspaces.map(row => ({ ...row, title: '界'.repeat(300) })) }
    expect(() => encodeApplicationResult(oversized, largest)).toThrow()
    expect(() => encodeApplicationResult(oversized, relaxed)).toThrow()
  })

  it.each([
    { kind: 'request', message: create, parse: parseApplicationRequest },
    { kind: 'result', message: managementWorkspaceResult, parse: parseApplicationResult },
  ])('enforces the fixed $kind ceiling independently of deployment limits', ({ message, parse }) => {
    const json = JSON.stringify(message)
    const exact = json + ' '.repeat(MAX_MOBILE_JSON_BYTES - Buffer.byteLength(json, 'utf8'))
    const relaxed = { ...budget, maxRequestBytes: MAX_MOBILE_JSON_BYTES + 1, maxResultBytes: MAX_MOBILE_JSON_BYTES + 1 }
    expect(parse(exact, relaxed)).toEqual(message)
    expect(() => parse(exact + ' ', relaxed)).toThrow()
  })
})
