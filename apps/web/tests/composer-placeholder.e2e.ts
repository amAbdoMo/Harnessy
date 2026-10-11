/** Built composer guidance and draft retention through phone navigation. */
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

it('hides the placeholder for typed and pasted spaces and restores it after deletion', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const browser = await chromium.launch()
    let failurePage: Page | undefined
    try {
      const page = await newEnglishPage(browser)
      failurePage = page
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await connectFreshWorkspace(page, scaffold.workspaceCwd, 'composer-placeholder')
      const input = page.locator('[data-composer-input][contenteditable="true"]').first()
      const placeholder = page.locator('[data-composer-placeholder]').first()
      const observations: string[] = []
      const observe = async (label: string, visible: boolean) => {
        await expect.poll(() => placeholder.isVisible()).toBe(visible)
        observations.push(`- ${label}: placeholder ${visible ? 'visible' : 'hidden'}`)
      }
      const clear = async () => {
        await input.click()
        await page.keyboard.press('ControlOrMeta+KeyA')
        await page.keyboard.press('Backspace')
      }
      await observe('Empty draft', true)
      await input.click()
      await page.keyboard.press('Space')
      await observe('Single space', false)
      await page.keyboard.press('Space')
      await page.keyboard.press('Space')
      await observe('Consecutive spaces', false)
      await page.keyboard.press('Tab')
      await input.click()
      await observe('Focus restored', false)
      const draftMarkup = await input.innerHTML()
      await page.keyboard.press('Enter')
      expect(await input.innerHTML()).toBe(draftMarkup)
      await observe('Whitespace submission rejected', false)
      await clear()
      await observe('All content deleted', true)
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.evaluate(() => navigator.clipboard.writeText('   '))
      await page.keyboard.press('ControlOrMeta+KeyV')
      await expect.poll(() => input.textContent()).toBe('   ')
      await observe('Pasted spaces', false)
      await clear()
      await observe('Pasted content deleted', true)
      await assertFixtureInventory(
        fileURLToPath(new URL('./expected/composer-placeholder', import.meta.url)), ['visibility.expected.md'],
      )
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
      await compareOrRefreshGolden(
        fileURLToPath(new URL('./expected/composer-placeholder/visibility.expected.md', import.meta.url)),
        observations.join('\n'), webSnapshotMode(),
      )
    } catch (error) {
      if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-composer-placeholder')
      throw error
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})

it('keeps a phone draft mounted while opening and dismissing the shipped Session navigator', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const browser = await chromium.launch()
    let failurePage: Page | undefined
    try {
      const page = await newEnglishPage(browser)
      failurePage = page
      await page.setViewportSize({ width: 390, height: 844 })
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await connectFreshWorkspace(page, scaffold.workspaceCwd, 'phone-composer-draft')
      const input = page.locator('[data-composer-input][contenteditable="true"]').first()
      await input.fill('Keep this phone draft')
      const editor = await input.elementHandle()
      if (editor === null) throw new Error('Phone composer did not mount')
      try {
        const toggle = page.getByRole('button', { name: 'Toggle sidebar', exact: true })
        await toggle.click()
        const dialog = page.getByRole('dialog', { name: 'Toggle sidebar', exact: true })
        await dialog.waitFor({ state: 'visible' })
        const bounds = await dialog.boundingBox()
        if (bounds === null) throw new Error('Phone navigator did not mount')
        expect(bounds.x).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
        const sidebarBounds = await dialog.locator('[data-slot="sidebar"] > *').boundingBox()
        if (sidebarBounds === null) throw new Error('Phone sidebar did not mount')
        expect(sidebarBounds.x).toBeGreaterThanOrEqual(bounds.x)
        expect(sidebarBounds.x + sidebarBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width)
        await dialog.getByRole('button', { name: 'Close', exact: true }).click()
        await dialog.waitFor({ state: 'hidden' })
        expect(await editor.evaluate(element => element.isConnected)).toBe(true)
        expect(await input.textContent()).toBe('Keep this phone draft')
        expect(await toggle.evaluate(element => document.activeElement === element)).toBe(true)
        await page.setViewportSize({ width: 800, height: 600 })
        await toggle.waitFor({ state: 'hidden' })
        expect(await editor.evaluate(element => element.isConnected)).toBe(true)
        expect(await input.textContent()).toBe('Keep this phone draft')
        expect(tripwire.pageErrors).toEqual([])
        expect(tripwire.warnings).toEqual([])
      } finally {
        await editor.dispose()
      }
    } catch (error) {
      if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-phone-composer-draft')
      throw error
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
