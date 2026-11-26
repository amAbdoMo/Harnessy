/** Native browser-share request/result wire regressions; no Desktop or transport mocks. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrowserShareId, MobileRequestId } from '../src/application-types.ts'
import {
  encodeApplicationRequest, encodeApplicationResult, MAX_BROWSER_SHARE_JPEG_BYTES,
  MAX_BROWSER_SHARE_JPEG_CHARS, parseApplicationBudget, parseApplicationRequest, parseApplicationResult,
} from '../src/application.ts'

const budget = parseApplicationBudget({
  maxRequestBytes: 32_768, maxResultBytes: 32_768, maxTextBytes: 8_192, maxTitleBytes: 256,
  maxRows: 64, maxSessions: 256, maxSubscriptionsPerGrant: 8, maxPendingSubmissionsPerGrant: 4,
  readTimeoutMs: 10_000, subscriptionLifetimeMs: 120_000,
})
const requestId = brandString<MobileRequestId>(Buffer.alloc(16, 1).toString('base64url'))
const shareId = brandString<BrowserShareId>('e7ceaa5b-761d-4e48-9abc-9fa732df8617')

describe('native browser-share application messages', () => {
  it.each([
    { v: 1, type: 'watchBrowserShare', requestId },
    { v: 1, type: 'watchBrowserShare', requestId, shareId },
    { v: 1, type: 'subscribeBrowserShare', requestId },
    { v: 1, type: 'unsubscribeBrowserShare', requestId, watchId: requestId },
    { v: 1, type: 'stopBrowserShare', requestId, shareId },
  ])('round-trips additive request %j', (request) => {
    const json = JSON.stringify(request)
    expect(JSON.parse(encodeApplicationRequest(parseApplicationRequest(json, budget), budget))).toEqual(request)
  })

  it.each([
    { v: 1, type: 'browserShare', requestId, status: 'idle' },
    { v: 1, type: 'browserShare', requestId, status: 'busy' },
    { v: 1, type: 'browserShare', requestId, status: 'ended' },
    { v: 1, type: 'browserShare', requestId, status: 'frame', shareId, jpeg: 'anBlZw==' },
  ])('round-trips bounded result %j', (result) => {
    const json = JSON.stringify(result)
    expect(encodeApplicationResult(parseApplicationResult(json, budget), budget)).toBe(json)
  })

  it.each([
    { v: 1, type: 'watchBrowserShare', requestId, shareId: shareId.toUpperCase() },
    { v: 1, type: 'watchBrowserShare', requestId, shareId: 'e7ceaa5b-761d-5e48-9abc-9fa732df8617' },
    { v: 1, type: 'stopBrowserShare', requestId },
    { v: 1, type: 'stopBrowserShare', requestId, shareId: `${shareId}x` },
    { v: 1, type: 'subscribeBrowserShare', requestId, shareId },
    { v: 1, type: 'unsubscribeBrowserShare', requestId, watchId: 'unvalidated' },
  ])('rejects incomplete or noncanonical request %j', (request) => {
    expect(() => parseApplicationRequest(JSON.stringify(request), budget)).toThrow()
  })

  it.each([
    { v: 1, type: 'browserShare', requestId, status: 'frame', shareId, jpeg: '' },
    { v: 1, type: 'browserShare', requestId, status: 'frame', shareId, jpeg: 'anBlZw' },
    { v: 1, type: 'browserShare', requestId, status: 'frame', shareId, jpeg: 'anBl?g==' },
    { v: 1, type: 'browserShare', requestId, status: 'frame', shareId, jpeg: 'anBlZw==', extra: true },
    { v: 1, type: 'browserShare', requestId, status: 'frame', shareId: 'e7ceaa5b-761d-5e48-9abc-9fa732df8618', jpeg: 'anBlZw==' },
  ])('rejects malformed frame result %j', (result) => {
    expect(() => parseApplicationResult(JSON.stringify(result), budget)).toThrow()
  })

  it('enforces the exact decoded JPEG and base64 character limits', () => {
    const bytes = Buffer.alloc(MAX_BROWSER_SHARE_JPEG_BYTES, 7).toString('base64')
    expect(bytes.length).toBe(MAX_BROWSER_SHARE_JPEG_CHARS)
    const result = { v: 1, type: 'browserShare', requestId, status: 'frame', shareId, jpeg: bytes } as const
    expect(parseApplicationResult(JSON.stringify(result), budget)).toEqual(result)
    const tooLarge = Buffer.alloc(MAX_BROWSER_SHARE_JPEG_BYTES + 1, 7).toString('base64')
    expect(tooLarge.length).toBeGreaterThan(MAX_BROWSER_SHARE_JPEG_CHARS)
    expect(() => parseApplicationResult(JSON.stringify({ ...result, jpeg: tooLarge }), budget)).toThrow()
    expect(() => parseApplicationResult(JSON.stringify({ ...result, jpeg: `${bytes}A` }), budget)).toThrow()
  })

  it('charges the complete frame envelope to the application result budget', () => {
    const result = { v: 1, type: 'browserShare', requestId, status: 'frame', shareId, jpeg: 'anBlZw==' } as const
    const json = encodeApplicationResult(result, budget)
    const exact = { ...budget, maxResultBytes: Buffer.byteLength(json, 'utf8') }
    expect(encodeApplicationResult(result, exact)).toBe(json)
    expect(() => encodeApplicationResult(result, { ...exact, maxResultBytes: exact.maxResultBytes - 1 })).toThrow()
  })
})
