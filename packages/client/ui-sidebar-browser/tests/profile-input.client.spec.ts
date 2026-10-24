/** Human-entered profile addresses use Browser parsing while preserving pairing restrictions. */
import { describe, expect, it } from 'vitest'
import { resolveWebsiteProfileInput } from '../src/client/browser/profile-input.ts'
import { websiteProfileFailureReason } from '../src/client/browser/profile-failure.ts'

const input = { name: 'Work', accountLabel: '', url: 'abdom.me', mcpServerName: 'website' }

describe('saved profile input', () => {
  it.each([
    ['abdom.me', 'https://abdom.me/'],
    ['localhost:3000/admin', 'https://localhost:3000/admin'],
    ['http://router.local/', 'http://router.local/'],
  ])('normalizes %s before Main validates the pairing', (url, expected) => {
    expect(resolveWebsiteProfileInput({ ...input, url })).toMatchObject({ ok: true, value: { url: expected } })
  })

  it.each([
    [{ url: 'javascript:alert(1)' }, 'url', 'invalid-url'],
    [{ url: 'https://user:password@example.test/' }, 'url', 'unsafe-url'],
    [{ url: 'https://example.test/?token=private' }, 'url', 'unsafe-url'],
    [{ url: 'https://example.test/#private' }, 'url', 'unsafe-url'],
    [{ name: 'x'.repeat(121) }, 'name', 'invalid-name'],
    [{ name: '\nWork' }, 'name', 'invalid-name'],
    [{ accountLabel: 'x'.repeat(121) }, 'accountLabel', 'invalid-account-label'],
    [{ mcpServerName: 'invalid name' }, 'mcpServerName', 'invalid-mcp-name'],
  ] as const)('returns a safe correction for %j', (fields, field, reason) => {
    expect(resolveWebsiteProfileInput({ ...input, ...fields })).toEqual({ ok: false, issue: { field, reason } })
  })

  it.each([new Error('private account token'), new Error('[website-profile/private-account-token] private'), 'private', null])(
    'does not turn unrecognized diagnostics into public failure details', (error) => {
      expect(websiteProfileFailureReason(error)).toBe('unknown')
    },
  )
})
