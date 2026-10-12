/** Mobile parser regression source; run only after parent integrates source paths. */
import { describe, expect, it } from 'vitest'
import {
  encodeApplicationResult, parseApplicationBudget, parseApplicationRequest, parseApplicationResult,
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

describe('text-only companion application', () => {
  it.each([
    { ...submit, type: 'createSession' },
    { ...submit, mode: 'steer' },
    { ...submit, attachments: [] },
    { ...submit, rpcId: 'operator-command' },
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
