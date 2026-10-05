/** Cold approval replay through the shipped Web profile; no decision or model runs. */
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, WEB_FIXTURE_TIME } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/approval-composer/session.v4.jsonl', import.meta.url))

it('cold approval remains a read-only permission checkpoint in light and dark themes', async () => {
  const scaffold = await launchWebScaffold()
  try {
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), 'approval-checkpoint-cold', undefined, { createdAt: WEB_FIXTURE_TIME })
    const browser = await chromium.launch({ headless: true })
    try {
      await mkdir('.artifacts', { recursive: true })
      const evidence = await mkdtemp('.artifacts/website-approval-checkpoint-')
      const page = await newEnglishPage(browser)
      await page.clock.setFixedTime(WEB_FIXTURE_TIME)
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await page.locator('[role="treeitem"]').first().click()
      await page.locator('[role="treeitem"]').nth(1).click()
      const checkpoint = page.getByRole('region', { name: 'Approval: bash', exact: true, includeHidden: true })
      await expandOwningTurnProcess(page, checkpoint)
      await checkpoint.waitFor({ state: 'visible' })
      expect(await checkpoint.innerText()).toContain('Permission granted once')
      expect(await checkpoint.getByRole('button').count()).toBe(0)
      expect(await checkpoint.getByRole('textbox').count()).toBe(0)
      expect(await checkpoint.innerText()).not.toContain('tok63z')
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe(theme === 'dark' ? '' : null)
        await checkpoint.scrollIntoViewIfNeeded()
        await checkpoint.screenshot({ path: join(evidence, `${theme}.png`), animations: 'disabled' })
      }
      await page.reload()
      await expandOwningTurnProcess(page, checkpoint)
      await checkpoint.waitFor({ state: 'visible' })
      expect(await checkpoint.innerText()).toContain('Permission granted once')
      expect(await checkpoint.getByRole('button').count()).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
