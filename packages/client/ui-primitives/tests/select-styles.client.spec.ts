/**
 * Select's popup scroll ownership as CSS text. jsdom has no layout, so the
 * component spec can only prove the viewport element exists; which of the two
 * elements scrolls, and which rail the rows use, live in the stylesheet.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/Select.module.css', import.meta.url)), 'utf8')
const declarationText = css.replace(/\/\*[\s\S]*?\*\//g, ' ')

/** Declarations of one rule, comments stripped. */
function declarations(selector: string): string[] {
  const rule = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.[\]():*+^$\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(declarationText)
  if (rule === null) throw new Error(`Select.module.css has no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('Select.module.css popup', () => {
  it('scrolls the row viewport, not the card carrying the material', () => {
    // The card clips; MenuSurface paints the material as its child, so a
    // scrolling card would carry that background away with the rows.
    expect(declarations('.list')).toContain('overflow: hidden')
    expect(declarations('.viewport')).toEqual(expect.arrayContaining([
      'overflow-y: auto',
      'min-height: 0',
    ]))
  })

  it('keeps the l2 thumb rebind and the inset rail MenuView renders', () => {
    expect(declarations('.list')).toEqual(expect.arrayContaining([
      '--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)',
      '--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2)',
      '--dsh-scrollbar-width: 6px',
      '--dsh-scrollbar-thumb-border: 2px',
      '--dsh-scrollbar-track-margin: 12px',
    ]))
  })

  it('paints the row holding the highlight with the themed hover fill', () => {
    expect(declarations('.optionActive')).toContain('background: var(--dsw-alias-interactive-bg-hover)')
  })
})
