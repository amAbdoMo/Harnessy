import { describe, expect, it } from 'vitest'
import SettingsController from '../src/index.ts'
import { activeUsageRefreshMs, resolveAccountUsagePolicy, usageRetryAfterMs } from '../src/usage-policy.ts'

describe('account quota refresh policy', () => {
  it('records the active-account cadence at each quota threshold', () => {
    const policy = resolveAccountUsagePolicy()
    expect([undefined, 0, 74.99, 75, 89.99, 90, 98.99, 99, 100].map(used => ({
      used: used ?? 'unknown', interval: activeUsageRefreshMs(policy, used, false),
    }))).toMatchInlineSnapshot(`
      [
        {
          "interval": 60000,
          "used": "unknown",
        },
        {
          "interval": 60000,
          "used": 0,
        },
        {
          "interval": 60000,
          "used": 74.99,
        },
        {
          "interval": 30000,
          "used": 75,
        },
        {
          "interval": 30000,
          "used": 89.99,
        },
        {
          "interval": 15000,
          "used": 90,
        },
        {
          "interval": 15000,
          "used": 98.99,
        },
        {
          "interval": 5000,
          "used": 99,
        },
        {
          "interval": 5000,
          "used": 100,
        },
      ]
    `)
  })

  it('preserves a shorter configured base, disabled caching, and custom thresholds', () => {
    expect(activeUsageRefreshMs(resolveAccountUsagePolicy({ activeRefreshMs: 1_000 }), 99, false)).toBe(1_000)
    expect(activeUsageRefreshMs(resolveAccountUsagePolicy({ activeRefreshMs: 0 }), 99, true)).toBe(0)
    const policy = resolveAccountUsagePolicy({ activeRefreshTiers: [{ usedPercent: 50, refreshMs: 12_000 }] })
    expect(activeUsageRefreshMs(policy, 49, false)).toBe(60_000)
    expect(activeUsageRefreshMs(policy, 50, false)).toBe(12_000)
    expect(activeUsageRefreshMs(policy, 50, true)).toBe(5_000)
    const fixed = resolveAccountUsagePolicy({ activeRefreshMs: 30_000, activeRefreshTiers: [], failureRefreshMs: 30_000 })
    expect(activeUsageRefreshMs(fixed, 99, false)).toBe(30_000)
    expect(activeUsageRefreshMs(fixed, 99, true)).toBe(30_000)
  })

  it.each([
    { accountUsageRefreshTiers: [{ usedPercent: -1, refreshMs: 5_000 }] },
    { accountUsageRefreshTiers: [{ usedPercent: 101, refreshMs: 5_000 }] },
    { accountUsageRefreshTiers: [{ usedPercent: 90, refreshMs: 0 }] },
    { failedAccountUsageRefreshMs: 0 },
    { accountUsageMaxRetryAfterMs: 0 },
  ])('rejects invalid deployment scheduling %j', (config) => {
    expect(() => SettingsController.Config(config)).toThrow()
  })

  it('bounds Retry-After seconds and dates and ignores invalid or unrelated headers', () => {
    const now = 1_800_000_000_000
    const response = (header: string, status = 429) => new Response('', { status, headers: { 'retry-after': header } })
    expect(usageRetryAfterMs(response('10'), now, 300_000)).toBe(10_000)
    expect(usageRetryAfterMs(response('900'), now, 300_000)).toBe(300_000)
    expect(usageRetryAfterMs(response(new Date(now + 60_000).toUTCString()), now, 300_000)).toBe(60_000)
    for (const header of ['invalid', '-1', new Date(now - 1_000).toUTCString()]) {
      expect(usageRetryAfterMs(response(header), now, 300_000)).toBeUndefined()
    }
    expect(usageRetryAfterMs(response('10', 503), now, 300_000)).toBeUndefined()
  })
})
