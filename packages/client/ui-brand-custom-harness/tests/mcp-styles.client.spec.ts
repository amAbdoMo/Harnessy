import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Harnessy MCP server styles', () => {
  it('keeps connection failure copy readable against its alert fill', () => {
    // Regression: the 2026-09-19 MCP card used error colors for both text and fill.
    const styles = readFileSync(new URL('../src/client/McpServersSection.module.css', import.meta.url), 'utf8')
    expect(styles).toContain(`.error,
.cardError {
  color: var(--dsw-alias-label-primary-foreground);
  background: var(--dsw-alias-state-error-primary);
}`)
  })

  it('uses the complete card border for connection state without a left rail', () => {
    const styles = readFileSync(new URL('../src/client/McpServersSection.module.css', import.meta.url), 'utf8')
    expect(styles).toContain(`.status-connected {
  border-color: var(--dsw-static-green-400);
}`)
    expect(styles).toContain(`.status-error {
  border-color: var(--dsw-static-red-400);
}`)
    expect(styles).not.toContain('.serverCard::before')
  })
})
