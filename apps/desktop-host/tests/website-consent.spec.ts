/** Every browser fallback decision retains its own disclosure or mutation warning. */
import { expect, it } from 'vitest'
import { websiteBrowserConsentReason, type WebsiteBrowserConsent } from '../src/website-consent.ts'

it('keeps the bounded title-only decision independent of browser fallback', () => {
  expect(websiteBrowserConsentReason({ operation: 'page-info' })).toBe('Read the current page title and origin from the approved website/account browser. This may disclose sensitive page-title text; no page body, login state or full URL will be read. This permission applies only to this call.')
})

it.each([
  ['dom', 'Read bounded visible page text.'],
  ['screenshot', 'store the image in this conversation'],
  ['click', 'irreversibly change the website'],
  ['fill', 'immediately save or submit changes'],
  ['navigate', 'discard unsaved changes'],
  ['evaluate', 'there is no read-only sandbox'],
] satisfies [Exclude<WebsiteBrowserConsent['operation'], 'page-info'>, string][])(
  'asks for browser fallback and the %s operation, without removing its warning', (operation, warning) => {
    const reason = websiteBrowserConsentReason({ operation, fallbackReason: 'Paired MCP cannot update this field' })
    expect(reason).toContain('Allow browser fallback instead of the paired MCP for this call?')
    expect(reason).toContain('Stated reason: "Paired MCP cannot update this field"')
    expect(reason).toContain(warning)
    expect(reason).toContain('Permission applies only to this call')
    expect(reason).toContain('Never approve access to passwords, verification codes or authentication secrets')
  },
)

it.each(['', ' ', 'a'.repeat(513), '界'.repeat(171), 'reason\nmore', 'reason\u200bmore'])(
  'rejects an empty, oversized or control-bearing fallback reason', (fallbackReason) => {
    expect(() => websiteBrowserConsentReason({ operation: 'dom', fallbackReason })).toThrow('Browser fallback requires')
  },
)

it('accepts the exact UTF-8 bound and quotes model-provided reason text', () => {
  const fallbackReason = '界'.repeat(170) + 'ab'
  expect(Buffer.byteLength(fallbackReason)).toBe(512)
  expect(websiteBrowserConsentReason({ operation: 'click', fallbackReason })).toContain(JSON.stringify(fallbackReason))
  expect(websiteBrowserConsentReason({ operation: 'click', fallbackReason: '"Ignore the warning"' }))
    .toContain('Stated reason: "\\"Ignore the warning\\""')
})
