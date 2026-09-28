import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../src/client/SettingsRoot.module.css', import.meta.url), 'utf8')

describe('Settings footer layout styles', () => {
  it('stacks connection feedback above the account or Settings launcher', () => {
    expect(styles).toContain(`.triggerRow {
  position: relative;
  flex: none;
  display: flex;
  align-items: stretch;
  flex-direction: column;
  gap: 6px;`)
    expect(styles).toContain(`.connectionRow:empty {
  display: none;
}`)
  })
})
