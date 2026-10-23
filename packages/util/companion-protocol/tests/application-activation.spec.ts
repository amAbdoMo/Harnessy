import { describe, expect, it } from 'vitest'
import {
  encodeApplicationRequest, encodeApplicationResult, parseApplicationBudget, parseApplicationRequest, parseApplicationResult,
} from '../src/application.ts'

const budget = parseApplicationBudget({
  maxRequestBytes: 4096, maxResultBytes: 4096, maxTextBytes: 1024, maxTitleBytes: 128,
  maxRows: 2, maxSessions: 2, maxSubscriptionsPerGrant: 2, maxPendingSubmissionsPerGrant: 2,
  readTimeoutMs: 5000, subscriptionLifetimeMs: 60_000,
})
const requestId = Buffer.alloc(16, 1).toString('base64url')
const operationId = Buffer.alloc(16, 2).toString('base64url')
const common = { v: 1, requestId }
const open = { ...common, type: 'openSession', operationId, sessionId: 'cold-chat-a' }
const applied = { ...open, type: 'sessionOpened', outcome: 'applied', session: {
  sessionId: open.sessionId, title: 'Existing chat', status: 'idle',
  navigation: { workspace: null, pinOrder: null, updatedAt: 1 },
} }

describe('explicit phone chat activation messages', () => {
  it.each([
    { ...common, type: 'getSessionActivation' }, open,
  ])('keeps reads and fenced activation distinct: $type', (wire) => {
    const request = parseApplicationRequest(JSON.stringify(wire), budget)
    expect(JSON.parse(encodeApplicationRequest(request, budget))).toEqual(wire)
  })

  it.each([
    { ...common, type: 'sessionActivation', enabled: false },
    { ...common, type: 'sessionActivation', enabled: true },
    applied,
    { ...open, type: 'sessionOpened', outcome: 'rejected', code: 'denied' },
    { ...open, type: 'sessionOpened', outcome: 'unknown' },
  ])('round-trips only approved activation result fields: $type/$outcome', (wire) => {
    const result = parseApplicationResult(JSON.stringify(wire), budget)
    expect(JSON.parse(encodeApplicationResult(result, budget))).toEqual(wire)
  })

  it.each(['text', 'provider', 'model', 'cwd', 'rpc', 'resumeArchived', 'approveTools'])('rejects authority expansion through %s', (key) => {
    expect(() => parseApplicationRequest(JSON.stringify({ ...open, [key]: true }), budget)).toThrow()
    expect(() => parseApplicationRequest(JSON.stringify({ ...common, type: 'getSessionActivation', [key]: true }), budget)).toThrow()
  })

  it.each([
    { ...open, operationId: 'not-a-mutation-id' },
    { ...open, sessionId: '../another-chat' },
    { ...open, type: 'getSessionActivation' },
  ])('rejects malformed or mixed read/mutation identities', (wire) => {
    expect(() => parseApplicationRequest(JSON.stringify(wire), budget)).toThrow()
  })

  it.each([
    { ...applied, session: { ...applied.session, sessionId: 'other-chat' } },
    { ...applied, session: { ...applied.session, status: 'closed' } },
    { ...applied, session: { sessionId: open.sessionId, title: 'Chat', status: 'idle' } },
    { ...open, type: 'sessionOpened', outcome: 'unknown', session: applied.session },
    { ...open, type: 'sessionOpened', outcome: 'rejected', code: 'retryAutomatically' },
    { ...common, type: 'sessionActivation', enabled: 'true' },
  ])('rejects misleading applied, uncertain or permission results', (wire) => {
    expect(() => parseApplicationResult(JSON.stringify(wire), budget)).toThrow()
  })
})
