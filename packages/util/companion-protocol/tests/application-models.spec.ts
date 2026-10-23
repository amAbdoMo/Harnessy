/** Mobile model-selector protocol regressions; shared source, no mocks, network, or device access. */
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
const requestId = Buffer.alloc(16, 1).toString('base64url')
const operationId = Buffer.alloc(16, 2).toString('base64url')
const choiceId = Buffer.alloc(16, 3).toString('base64url')
const otherChoiceId = Buffer.alloc(16, 4).toString('base64url')
const revision = Buffer.alloc(16, 5).toString('base64url')
const cursor = Buffer.alloc(32, 6).toString('base64url')
const sessionId = 'session-1'
const choice = { id: choiceId, title: 'DeepSeek V3', providerTitle: 'DeepSeek' }
const otherChoice = { id: otherChoiceId, title: 'GPT-5', providerTitle: 'OpenAI' }
const request = { v: 1, requestId }
const result = { v: 1, requestId }

const listRequest = { ...request, type: 'listSessionModels', sessionId, limit: 2 }
const pagedListRequest = { ...listRequest, cursor }
const selectRequest = { ...request, type: 'selectSessionModel', operationId, sessionId, revision, choiceId }
const readyResult = { ...result, type: 'sessionModels', sessionId, state: 'ready', models: [choice], current: choice, revision }
const pagedReadyResult = { ...readyResult, models: [otherChoice], current: choice, cursor }
const emptyReadyResult = { ...readyResult, models: [], current: null }
const busyResult = { ...result, type: 'sessionModels', sessionId, state: 'busy', models: [], current: choice }
const busyWithoutCurrent = { ...busyResult, current: null }
const deniedResult = { ...result, type: 'sessionModels', sessionId, state: 'denied', models: [], current: null }
const closedResult = { ...result, type: 'sessionModels', sessionId, state: 'closed', models: [], current: null }
const appliedResult = { ...result, type: 'modelSelected', operationId, sessionId, outcome: 'applied', selected: choice }
const rejectedCodes = ['denied', 'expired', 'notFound', 'busy', 'conflict', 'limit', 'unavailable'] as const
const rejectedResult = { ...result, type: 'modelSelected', operationId, sessionId, outcome: 'rejected', code: 'denied' }
const rejectedResults = rejectedCodes.map(code => ({ ...rejectedResult, code }))
const unknownResult = { ...result, type: 'modelSelected', operationId, sessionId, outcome: 'unknown' }

const invalidFixedIds = [
  '', 1, null, `${choiceId}=`, `${choiceId}+`, `${choiceId}/`, `${choiceId.slice(0, -1)}R`,
  Buffer.alloc(15).toString('base64url'), Buffer.alloc(17).toString('base64url'),
  'deepseek-chat', 'model-1',
]
const invalidTokens = ['', null, 1, '/private', 'bad id', '😀', 'a'.repeat(129)]
const invalidLimits = [0, -1, 0.5, 3, Number.MAX_SAFE_INTEGER + 1, '1', null, true]
const unapprovedFields = ['provider', 'model', 'endpoint', 'account', 'credential', 'config', 'rpcId', 'reasoning', 'globalDefault']

describe('mobile model catalog requests', () => {
  it.each([listRequest, pagedListRequest, selectRequest])('round-trips the model request %j', (message) => {
    const parsed = parseApplicationRequest(JSON.stringify(message), budget)
    expect(parsed).toEqual(message)
    expect(JSON.parse(encodeApplicationRequest(parsed, budget))).toEqual(message)
  })

  it.each([listRequest, pagedListRequest, selectRequest].flatMap(message =>
    unapprovedFields.map(field => ({ ...message, [field]: 'unapproved' })),
  ))('rejects unapproved model request fields %j', (message) => {
    expect(() => parseApplicationRequest(JSON.stringify(message), budget)).toThrow()
  })

  it.each([
    ...['v', 'type', 'requestId', 'sessionId', 'limit'].map(field => ({ ...listRequest, [field]: undefined })),
    ...['v', 'type', 'requestId', 'operationId', 'sessionId', 'revision', 'choiceId']
      .map(field => ({ ...selectRequest, [field]: undefined })),
  ])('requires every declared model request field %j', (message) => {
    expect(() => parseApplicationRequest(JSON.stringify(message), budget)).toThrow()
  })

  it.each([
    ...invalidFixedIds.map(value => ({ ...selectRequest, choiceId: value })),
    ...invalidFixedIds.map(value => ({ ...selectRequest, revision: value })),
    ...invalidFixedIds.map(value => ({ ...listRequest, requestId: value })),
    ...invalidFixedIds.map(value => ({ ...selectRequest, operationId: value })),
    ...invalidTokens.map(value => ({ ...listRequest, sessionId: value })),
    ...invalidTokens.map(value => ({ ...selectRequest, sessionId: value })),
    ...invalidLimits.map(value => ({ ...listRequest, limit: value })),
    ...[null, '', `${cursor}=`, 'bad cursor', '😀'].map(value => ({ ...listRequest, cursor: value })),
    { ...listRequest, v: 2 },
    { ...selectRequest, v: 2 },
  ])('rejects malformed or unbound model requests %j', (message) => {
    expect(() => parseApplicationRequest(JSON.stringify(message), budget)).toThrow()
  })
})

describe('mobile model catalog results', () => {
  it.each([
    readyResult, pagedReadyResult, emptyReadyResult, busyResult, busyWithoutCurrent, deniedResult, closedResult,
  ])('round-trips the catalog page %j', (message) => {
    const parsed = parseApplicationResult(JSON.stringify(message), budget)
    expect(parsed).toEqual(message)
    expect(JSON.parse(encodeApplicationResult(parsed, budget))).toEqual(message)
  })

  it.each([
    { ...readyResult, state: 'unknown' },
    { ...readyResult, state: null },
    { ...readyResult, revision: undefined },
    { ...readyResult, revision: `${revision}=` },
    { ...readyResult, current: 'not-a-choice' },
    { ...readyResult, current: undefined },
    { ...readyResult, models: undefined },
    { ...readyResult, models: 'not-a-list' },
    { ...readyResult, models: [choice, choice] },
    { ...readyResult, models: [choice, otherChoice, { ...choice, id: Buffer.alloc(16, 7).toString('base64url') }] },
    { ...readyResult, models: [{ ...choice, id: undefined }] },
    { ...readyResult, models: [{ ...choice, title: undefined }] },
    { ...readyResult, models: [{ ...choice, providerTitle: undefined }] },
    { ...readyResult, models: [{ ...choice, title: '' }] },
    { ...readyResult, models: [{ ...choice, providerTitle: '' }] },
    { ...readyResult, models: [{ ...choice, title: 'a'.repeat(129) }] },
    { ...readyResult, models: [{ ...choice, providerTitle: 'a'.repeat(129) }] },
    { ...readyResult, models: [{ ...choice, title: '\ud800' }] },
    { ...readyResult, models: [{ ...choice, provider: 'deepseek' }] },
    { ...readyResult, models: [{ ...choice, endpoint: 'https://api.example' }] },
    { ...readyResult, models: [{ ...choice, account: 'ops@example' }] },
    { ...readyResult, models: [{ ...choice, credential: 'secret' }] },
    { ...readyResult, models: [{ ...choice, config: { reasoning: true } }] },
    { ...readyResult, models: [{ ...choice, model: 'deepseek-chat' }] },
    { ...readyResult, provider: 'deepseek' },
    { ...readyResult, globalDefault: 'deepseek-chat' },
    { ...readyResult, reasoning: 'high' },
    { ...busyResult, models: [choice] },
    { ...busyResult, models: 'not-a-list' },
    { ...busyResult, revision },
    { ...busyResult, cursor },
    { ...busyResult, current: undefined },
    { ...deniedResult, current: choice },
    { ...deniedResult, models: [choice] },
    { ...deniedResult, revision },
    { ...deniedResult, cursor },
    { ...closedResult, current: choice },
    { ...closedResult, models: [choice] },
    { ...closedResult, revision },
    { ...closedResult, cursor },
  ])('rejects invalid catalog pages %j', (message) => {
    expect(() => parseApplicationResult(JSON.stringify(message), budget)).toThrow()
  })

  it.each([
    ...invalidFixedIds.map(value => ({ ...readyResult, revision: value })),
    ...invalidFixedIds.map(value => ({ ...readyResult, models: [{ ...choice, id: value }] })),
    ...invalidFixedIds.map(value => ({ ...readyResult, current: { ...choice, id: value } })),
    ...invalidTokens.map(value => ({ ...readyResult, sessionId: value })),
  ])('rejects malformed catalog identities %j', (message) => {
    expect(() => parseApplicationResult(JSON.stringify(message), budget)).toThrow()
  })

  it('accepts the current choice outside the returned page and an empty advertised list', () => {
    const outside = { ...readyResult, models: [otherChoice], current: choice }
    expect(parseApplicationResult(JSON.stringify(outside), budget)).toEqual(outside)
    const empty = { ...readyResult, models: [], current: null }
    expect(parseApplicationResult(JSON.stringify(empty), budget)).toEqual(empty)
  })
})

describe('mobile model selection results', () => {
  it.each([appliedResult, ...rejectedResults, unknownResult])('round-trips the selection outcome %j', (message) => {
    const parsed = parseApplicationResult(JSON.stringify(message), budget)
    expect(parsed).toEqual(message)
    expect(JSON.parse(encodeApplicationResult(parsed, budget))).toEqual(message)
  })

  it.each([
    { ...appliedResult, code: 'denied' },
    { ...appliedResult, selected: undefined },
    { ...appliedResult, selected: { ...choice, provider: 'deepseek' } },
    { ...appliedResult, outcome: 'admitted' },
    { ...appliedResult, outcome: null },
    { ...appliedResult, outcome: undefined },
    { ...rejectedResult, selected: choice },
    { ...rejectedResult, code: 'unsupported' },
    { ...rejectedResult, code: null },
    { ...rejectedResult, code: undefined },
    { ...rejectedResult, outcome: 'unknown' },
    { ...unknownResult, selected: choice },
    { ...unknownResult, code: 'busy' },
    { ...unknownResult, action: 'rename' },
    { ...unknownResult, revision },
    { ...unknownResult, globalDefault: 'deepseek-chat' },
    { ...unknownResult, reasoning: 'high' },
    { ...unknownResult, credential: 'secret' },
  ])('rejects mixed or incomplete selection outcomes %j', (message) => {
    expect(() => parseApplicationResult(JSON.stringify(message), budget)).toThrow()
  })

  it.each([
    ...invalidFixedIds.map(value => ({ ...appliedResult, operationId: value })),
    ...invalidFixedIds.map(value => ({ ...appliedResult, requestId: value })),
    ...invalidTokens.map(value => ({ ...appliedResult, sessionId: value })),
  ])('rejects malformed selection identities %j', (message) => {
    expect(() => parseApplicationResult(JSON.stringify(message), budget)).toThrow()
  })

  it('keeps model selection out of the four chat management commands', () => {
    const managed = { ...result, type: 'managed', operationId, sessionId, action: 'selectModel', outcome: 'unknown' }
    expect(() => parseApplicationResult(JSON.stringify(managed), budget)).toThrow()
    expect(() => parseApplicationResult(JSON.stringify({ ...appliedResult, type: 'managed' }), budget)).toThrow()
  })
})

describe('legacy companion message compatibility', () => {
  it('keeps legacy requests and results unchanged beside the model messages', () => {
    const legacyRequest = { ...request, type: 'listSessions', limit: 2 }
    expect(parseApplicationRequest(JSON.stringify(legacyRequest), budget)).toEqual(legacyRequest)
    const legacyResult = { ...result, type: 'sessions', sessions: [{ sessionId, title: '聊天 😀', status: 'closed' }] }
    expect(parseApplicationResult(JSON.stringify(legacyResult), budget)).toEqual(legacyResult)
  })

  it.each([
    { ...request, type: 'listSessions', limit: 2, revision },
    { ...request, type: 'listSessions', limit: 2, models: [] },
  ])('rejects model fields on legacy requests %j', (message) => {
    expect(() => parseApplicationRequest(JSON.stringify(message), budget)).toThrow()
  })

  it.each([
    { ...result, type: 'sessions', sessions: [], revision },
    { ...result, type: 'sessions', sessions: [], current: null },
    { ...result, type: 'error', code: 'denied', selected: choice },
  ])('rejects model fields on legacy results %j', (message) => {
    expect(() => parseApplicationResult(JSON.stringify(message), budget)).toThrow()
  })
})

describe('complete model message byte limits', () => {
  it('charges complete multibyte labels, wrappers, and cursors to the encoded result budget', () => {
    const json = JSON.stringify({
      ...readyResult, models: [{ ...choice, title: '😀'.repeat(20), providerTitle: '界'.repeat(20) }], current: null,
    })
    const parsed = parseApplicationResult(json, budget)
    const exact = { ...budget, maxResultBytes: Buffer.byteLength(json, 'utf8') }
    const encoded = encodeApplicationResult(parsed, exact)
    expect(parseApplicationResult(encoded, exact)).toEqual(parsed)
    expect(Buffer.byteLength(encoded, 'utf8')).toBe(exact.maxResultBytes)
    expect(() => parseApplicationResult(json, { ...exact, maxResultBytes: exact.maxResultBytes - 1 })).toThrow()
    expect(() => encodeApplicationResult(parsed, { ...exact, maxResultBytes: exact.maxResultBytes - 1 })).toThrow()
  })

  it('bounds each label by the deployment title budget in UTF-8 bytes', () => {
    const atLimit = { ...readyResult, models: [{ ...choice, title: 'a'.repeat(128), providerTitle: '😀'.repeat(32) }] }
    expect(parseApplicationResult(JSON.stringify(atLimit), budget)).toEqual(atLimit)
    const overLimit = { ...readyResult, models: [{ ...choice, title: '😀'.repeat(33) }] }
    expect(() => parseApplicationResult(JSON.stringify(overLimit), budget)).toThrow()
  })

  it('charges the complete model request envelope', () => {
    const json = JSON.stringify(pagedListRequest)
    const parsed = parseApplicationRequest(json, budget)
    const exact = { ...budget, maxRequestBytes: Buffer.byteLength(json, 'utf8') }
    expect(parseApplicationRequest(json, exact)).toEqual(parsed)
    const encoded = encodeApplicationRequest(parsed, exact)
    expect(parseApplicationRequest(encoded, exact)).toEqual(parsed)
    expect(Buffer.byteLength(encoded, 'utf8')).toBe(exact.maxRequestBytes)
    expect(() => parseApplicationRequest(json, { ...exact, maxRequestBytes: exact.maxRequestBytes - 1 })).toThrow()
    expect(() => encodeApplicationRequest(parsed, { ...exact, maxRequestBytes: exact.maxRequestBytes - 1 })).toThrow()
  })

  it.each([
    { kind: 'request', message: listRequest, parse: parseApplicationRequest },
    { kind: 'result', message: readyResult, parse: parseApplicationResult },
  ])('enforces the fixed ceiling on complete $kind messages', ({ message, parse }) => {
    const json = JSON.stringify(message)
    const exact = json + ' '.repeat(MAX_MOBILE_JSON_BYTES - Buffer.byteLength(json, 'utf8'))
    const relaxed = { ...budget, maxRequestBytes: MAX_MOBILE_JSON_BYTES + 1, maxResultBytes: MAX_MOBILE_JSON_BYTES + 1 }
    expect(parse(exact, relaxed)).toEqual(message)
    expect(() => parse(exact + ' ', relaxed)).toThrow()
  })
})
