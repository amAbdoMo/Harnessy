import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../src/client/AccountsManagerCard.module.css', import.meta.url), 'utf8')
const launcherStyles = readFileSync(new URL('../src/client/AccountLauncher.module.css', import.meta.url), 'utf8')

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
