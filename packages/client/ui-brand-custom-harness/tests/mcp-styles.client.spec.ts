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

  it('keeps Session server names and status together without an unused action column', () => {
    // Regression: healthy rows stacked three lines and reserved an empty action track.
    const styles = readFileSync(new URL('../src/client/McpSessionStatus.module.css', import.meta.url), 'utf8')
    expect(styles).toContain(`.server {
  grid-template-columns: max-content minmax(0, 1fr);`)
    expect(styles).toContain(`.server:has(> .reconnect),
.activityRow {
  grid-template-columns: max-content minmax(0, 1fr) max-content;
}`)
    expect(styles).toContain(`.serverHeader {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;`)
    expect(styles).toContain(`.serverHeader strong {
  flex: 1 1 120px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}`)
    expect(styles).toContain(`.statusDot {
  align-self: start;
  margin-top: calc((var(--dsw-font-xxs-12-line-height) - 7px) / 2);
}`)
    expect(styles).not.toMatch(/font-weight:\s*[6-9]\d{2}/u)
    expect(styles).not.toMatch(/(?:^|\n)\s*color:\s*var\(--dsw-alias-label-tertiary\)/u)
    expect(styles).toContain(`@media (max-width: 360px) {
  .server:has(> .reconnect) {
    grid-template-columns: max-content minmax(0, 1fr);
  }

  .reconnect {
    grid-column: 2;
    justify-self: start;
  }
}`)
  })

  it('separates the last Session server from activity while keeping scrolling inside the viewport', () => {
    const styles = readFileSync(new URL('../src/client/McpSessionStatus.module.css', import.meta.url), 'utf8')
    expect(styles).toContain(`.servers {
  max-height: 250px;
  padding: 6px 0 12px;
}`)
    expect(styles).toContain(`.servers,
.activity {
  display: grid;
  min-height: 0;
  margin-inline: 6px;
  overflow: auto;
  --dsh-scrollbar-track-margin: 6px;
}`)
    expect(styles).toContain('grid-template-rows: auto minmax(0, auto) auto minmax(0, auto);')
    expect(styles).toContain('width: min(420px, calc(100vw - 24px));')
    expect(styles).toContain('max-height: min(620px, calc(100vh - 24px));')
    expect(styles).not.toContain('::-webkit-scrollbar')
  })
})
