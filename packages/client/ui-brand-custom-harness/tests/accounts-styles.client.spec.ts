import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../src/client/AccountsManagerCard.module.css', import.meta.url), 'utf8')
const launcherStyles = readFileSync(new URL('../src/client/AccountLauncher.module.css', import.meta.url), 'utf8')
const declarationText = styles.replace(/\/\*[\s\S]*?\*\//g, ' ')

/** Declarations of one top-level rule, comments stripped. */
function declarations(selector: string): string {
  const rule = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.[\]():*+^$\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(declarationText)
  if (rule === null) throw new Error(`AccountsManagerCard.module.css has no \`${selector}\` rule`)
  return rule[1] ?? ''
}

describe('Harnessy account usage styles', () => {
  it('presents quota windows and banked resets as equal bordered panels', () => {
    expect(styles).toContain(`.usagePanels:has(> .bankedReset) { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.usagePanels:has(> .bankedReset) > .usageGrid { grid-column: span 2; }`)
    expect(styles).toContain(`.usageItem,
.bankedReset {
  min-width: 0;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
}`)
  })

  it('stacks all usage panels in the narrow layout', () => {
    expect(styles).toContain(`.usagePanels:has(> .bankedReset) { grid-template-columns: 1fr; }
  .usagePanels:has(> .bankedReset) > .usageGrid { grid-column: auto; }
  .usageGrid { grid-template-columns: 1fr; }`)
  })

  it('uses equal compact insets without a forced tall empty account pane', () => {
    expect(declarations('.managerLayout')).toContain('--dsh-accounts-row-inset: 16px')
    expect(declarations('.managerLayout')).not.toContain('min-height:')
    for (const selector of ['.providerRail', '.accountPane']) {
      expect(declarations(selector)).toContain('padding: var(--dsh-accounts-row-inset);')
    }
    expect(declarations('.managerContent > div:first-child')).toContain('padding: 16px')
    expect(declarations('.managerContent > div:last-child')).toContain('margin-top: 0')
    expect(declarations('.accountToolbar')).toContain('margin: 0 0 12px')
  })

  it('keeps empty provider logos out of the muted hint text treatment', () => {
    const badge = declarations('.providerMark,\n.avatar,\n.emptyMark')
    expect(badge).toContain('color: var(--dsw-alias-label-primary-foreground);')
    expect(badge).toContain('background: var(--dsw-alias-button-primary-fill);')
    expect(styles).toContain('.empty > span:not(.emptyMark) {\n  color: var(--dsw-alias-label-tertiary);')
    expect(styles).not.toMatch(/\.empty\s+span\s*\{/u)
  })

  it('matches the closed account card inset to the open menu content', () => {
    expect(launcherStyles).toContain(`.trigger {
  min-height: 68px;
  padding: 6px 15px;`)
  })

  it('places circular quota dials beside the account identity', () => {
    expect(launcherStyles).toContain(`.accountSummary {
  display: flex;
  align-items: center;
  min-width: 0;
}`)
    expect(launcherStyles).toContain(`.compactUsageItem {
  position: relative;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;`)
    expect(launcherStyles).toContain(".compactUsageFill[data-level='danger'] {\n  stroke: var(--dsw-alias-state-error-primary);")
  })
})
