/** Global interactive-control focus presentation contract. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/styles/field-focus.css', import.meta.url)), 'utf8')

describe('global control focus styles', () => {
  it('changes control borders without adding an outside ring or glow', () => {
    expect(css).toContain('button,')
    expect(css).toContain("input:not([type='hidden'])")
    expect(css).toContain("[contenteditable='true']")
    expect(css).toContain("[role='combobox']")
    expect(css).toContain("[role='switch']")
    expect(css).toContain("[role='tab']")
    expect(css).toContain('border-color: var(--dsw-alias-brand-primary) !important')
    expect(css).toContain('outline: none !important')
    expect(css).toContain('box-shadow: none !important')
  })

  it('excludes only non-interactive hidden inputs', () => {
    expect(css).toContain("input:not([type='hidden'])")
    expect(css).not.toContain("[type='checkbox']")
    expect(css).not.toContain("[type='radio']")
  })
})
