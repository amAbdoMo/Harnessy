/** Owner-local layout guards for the compact companion card and long translated controls. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const styles = readFileSync(new URL('../src/client/CompanionRow.module.css', import.meta.url), 'utf8')

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`).exec(styles)
  if (rule === null) throw new Error(`Missing companion style rule: ${selector}`)
  return rule[1]!
}

it('uses settings-card tokens without a literal palette or heavy type', () => {
  expect(declarations('.frame')).toContain('padding-block: 16px;')
  const root = declarations('.root')
  expect(root).toContain('border-radius: var(--dsw-radius-xl);')
  expect(root).toContain('background: var(--dsw-alias-settings-card-fill);')
  expect(root).toContain('border: 0.5px solid var(--dsw-alias-settings-card-stroke);')
  expect(styles).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|data-theme|prefers-color-scheme/iu)
  expect(styles).not.toMatch(/font-weight:\s*[6-9]00/u)
})

it('stacks equal-width actions at the card width and wraps long localized labels', () => {
  expect(declarations('.root')).toContain('container: companion / inline-size;')
  expect(declarations('.body')).toContain('grid-template-columns: minmax(0, 1fr) 162px;')
  expect(declarations('.actions')).toContain('grid-template-columns: minmax(0, 1fr);')
  const action = declarations('.actions > .action')
  for (const declaration of ['width: 100%;', 'min-width: 0;', 'height: auto;',
    'min-height: 36px;', 'white-space: normal;', 'overflow-wrap: anywhere;']) {
    expect(action).toContain(declaration)
  }
  expect(declarations('.statusLine')).toContain('flex-wrap: wrap;')
  expect(styles).toMatch(/@container companion \(max-width: 420px\)\s*\{\s*\.body\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/u)
})

it('rotates the disclosure chevron from the native open attribute without animated motion', () => {
  expect(declarations('.disclosureSummary')).toContain('justify-content: space-between;')
  expect(declarations('.chevron')).toContain('flex: none;')
  expect(declarations('.disclosure[open] > .disclosureSummary > .chevron')).toContain('transform: rotate(90deg);')
  expect(styles).not.toMatch(/outline:\s*(none|0)|transition:|animation:/u)
})
