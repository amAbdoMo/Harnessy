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
