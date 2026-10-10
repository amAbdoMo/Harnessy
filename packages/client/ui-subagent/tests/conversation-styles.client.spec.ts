import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const styles = readFileSync(new URL('../src/client/SubagentHeaderLineage.module.css', import.meta.url), 'utf8')

it('draws the completed-group divider only while working subagents are present', () => {
  const base = styles.match(/\.completedGroup\s*\{([^}]*)\}/u)?.[1]
  expect(base).toBeDefined()
  expect(base).not.toMatch(/\bborder(?:-top)?\s*:/u)
  const separated = styles.match(/\.completedGroup\[data-working='true'\]\s*\{([^}]*)\}/u)?.[1]
  expect(separated).toMatch(/\bborder-top\s*:/u)
})

it('keeps equal row insets without artificial indentation for completed roots', () => {
  const row = styles.match(/\.row\s*\{([^}]*)\}/u)?.[1]
  expect(row).toMatch(/padding:\s*6px 7px;/u)
  const group = styles.match(/\.completedGroup\s*\{([^}]*)\}/u)?.[1]
  expect(group).toMatch(/margin:\s*2px 0 1px;/u)
  const roots = styles.match(/\.completedRows\s*\{([^}]*)\}/u)?.[1]
  expect(roots).toMatch(/margin:\s*0;/u)
  expect(styles).not.toContain('.menuBody > .node')
  const children = styles.match(/\.children\s*\{([^}]*)\}/u)?.[1]
  expect(children).toMatch(/margin-left:\s*16px;/u)
})
