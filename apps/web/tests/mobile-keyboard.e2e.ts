/** Browser focus for mobile and desktop composer submission and existing pickers. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/mobile-keyboard', import.meta.url))

it('dismisses the mobile keyboard after Send while retaining desktop focus', async () => {
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const observations: string[] = []
  for (const mobile of [false, true]) {
    const scaffold = await launchWebScaffold({
      replayFixture: fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url)),
      compareReplaySession: false,
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    })
    let scenarioError: unknown
    try {
      const page = await browser.newPage({
        viewport: { width: mobile ? 390 : 1280, height: 844 },
        locale: 'en-US', timezoneId: 'Asia/Shanghai',
        ...mobile ? {
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
          isMobile: true, hasTouch: true,
        } : {},
      })
      const tripwire = watchConsole(page)
      const platform = mobile ? 'Mobile' : 'Desktop'
      let finished = false
      const off = scaffold.ctx.on('session/event', (_session, event) => {
        if (event.type === 'turn/end') finished = true
      })
      try {
        await page.goto(scaffold.authenticatedUrl)
        await connectFreshWorkspace(page, scaffold.workspaceCwd, `submission-${platform}`)
        const input = page.locator('[data-composer-input][contenteditable="true"]')
        await page.getByRole('button', { name: /^Select model/ }).click()
        const dialog = page.getByRole('dialog', { name: 'Model & thinking level' })
        const modelSearch = dialog.getByRole('textbox', { name: 'Search available models' })
        await expect.poll(() => modelSearch.evaluate(element => document.activeElement === element)).toBe(!mobile)
        await modelSearch.click()
        expect(await modelSearch.evaluate(element => document.activeElement === element)).toBe(true)
        await modelSearch.press('Escape')
        await input.fill('/model')
        await page.getByRole('option', { name: /^Model/ }).click()
        const commandSearch = page.getByRole('textbox', { name: 'Filter options', exact: true })
        await commandSearch.waitFor()
        expect(await commandSearch.evaluate(element => document.activeElement === element)).toBe(!mobile)
        await commandSearch.click()
        expect(await commandSearch.evaluate(element => document.activeElement === element)).toBe(true)
        await commandSearch.press('Escape')
        await input.fill('Reply with a one-sentence description of event sourcing, then stop.')
        expect(await input.evaluate(element => document.activeElement === element)).toBe(true)
        const send = page.getByRole('button', { name: 'Send message', exact: true })
        if (mobile) await send.tap()
        else await send.click()
        await expect.poll(() => input.textContent()).toBe('')
        await expect.poll(() => input.evaluate(element => document.activeElement === element)).toBe(!mobile)
        await expect.poll(() => finished, { timeout: 60_000 }).toBe(true)
        expect(await input.evaluate(element => document.activeElement === element)).toBe(!mobile)
        observations.push(`- ${platform}: automatic model and command search focus ${mobile ? 'suppressed' : 'retained'}; explicit focus available; Send clears the draft; editor ${mobile ? 'unfocused' : 'focused'} through response completion`)
        expect(tripwire.pageErrors).toEqual([])
        if (webSnapshotMode() !== 'record') expect(tripwire.warnings).toEqual([])
      } catch (error) {
        await saveFailureShot(page, `web-e2e-composer-submission-${platform}`)
        throw error
      } finally {
        off()
        await page.close()
      }
    } catch (error) {
      scenarioError = error
      throw error
    } finally {
      try { await scaffold.close() }
      catch (error) {
        if (scenarioError !== undefined) throw new AggregateError([scenarioError, error], 'Browser interaction and scaffold cleanup failed')
        throw error
      }
    }
  }
  await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'submission.expected.md'), observations.join('\n'), webSnapshotMode())
  await assertFixtureInventory(SNAPSHOT_DIR, ['submission.expected.md'])
}, 180_000)
