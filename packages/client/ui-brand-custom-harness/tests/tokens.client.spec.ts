import { describe, expect, it } from 'vitest'
import { CUSTOM_HARNESS_THEME_TOKENS } from '../src/client/tokens.ts'

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (light! + 0.05) / (dark! + 0.05)
}

describe('Harnessy theme tokens', () => {
  it('defines complete reversible light and dark values', () => {
    expect(Object.keys(CUSTOM_HARNESS_THEME_TOKENS).length).toBeGreaterThanOrEqual(45)
    for (const modes of Object.values(CUSTOM_HARNESS_THEME_TOKENS)) {
      expect(modes.light).not.toBe('')
      expect(modes.dark).not.toBe('')
    }
  })

  it.each(['light', 'dark'] as const)('keeps primary and secondary text readable in %s mode', (mode) => {
    const value = (token: string) => CUSTOM_HARNESS_THEME_TOKENS[token]![mode]
    expect(contrast(value('--dsw-alias-label-primary'), value('--dsw-alias-bg-base'))).toBeGreaterThanOrEqual(7)
    expect(contrast(value('--dsw-alias-label-secondary'), value('--dsw-alias-bg-base'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(value('--dsw-alias-label-primary-foreground'), value('--dsw-alias-brand-primary')))
      .toBeGreaterThanOrEqual(4.5)
  })
})
