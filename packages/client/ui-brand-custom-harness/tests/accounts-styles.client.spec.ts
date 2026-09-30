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

  it('starts the account pane toolbar level with the provider rail first row', () => {
    // One shared first-row inset: the rail pads its rows by it, and the pane's
    // top inset uses it too, so the toolbar's first line has no extra gap.
    expect(declarations('.managerLayout')).toContain('--dsh-accounts-row-inset: 18px')
    expect(declarations('.providerRail')).toContain('padding: var(--dsh-accounts-row-inset) 12px')
    expect(declarations('.accountPane')).toContain('padding: var(--dsh-accounts-row-inset) 20px 20px')
    expect(declarations('.accountToolbar')).toContain('margin: 0 0 12px')
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
