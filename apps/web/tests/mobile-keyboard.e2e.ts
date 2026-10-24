/** Browser focus for mobile and desktop composer submission and existing pickers. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const CUSTOM_OVERLAY = fileURLToPath(new URL('../../../packages/bundle/custom-harness/cordis.patch.yml', import.meta.url))
const CUSTOM_MANIFEST = fileURLToPath(new URL('../../../packages/bundle/custom-harness/package.json', import.meta.url))

/**
 * Keep the visible composer still when keyboard panning changes viewport coordinates.
 * @param page - Page with the focused composer.
 * @returns The observed page and composer scroll behavior.
 */
async function exerciseKeyboardViewport(page: Page): Promise<string> {
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  const restore = await input.evaluateHandle((element) => {
    const viewport = window.visualViewport
    if (viewport === null) throw new Error('Expected a visual viewport')
    const style = document.documentElement.style
    const height = style.getPropertyValue('height')
    const priority = style.getPropertyPriority('height')
    const scroll = window.scrollY
    const offset = Object.getOwnPropertyDescriptor(viewport, 'offsetTop')
    style.setProperty('height', `${window.innerHeight * 2}px`)
    window.scrollTo(0, Math.max(1, element.getBoundingClientRect().top - 120))
    // Safari can report the keyboard's page displacement as offsetTop even
    // though DOM rectangles already account for that page scroll.
    Object.defineProperty(viewport, 'offsetTop', { configurable: true, get: () => window.scrollY })
    return () => {
      if (offset === undefined) Reflect.deleteProperty(viewport, 'offsetTop')
      else Object.defineProperty(viewport, 'offsetTop', offset)
      if (height === '') style.removeProperty('height')
      else style.setProperty('height', height, priority)
      window.scrollTo(0, scroll)
    }
  })
  try {
    const before = await input.evaluate(el => ({ top: el.getBoundingClientRect().top, scroll: window.scrollY }))
    expect(before.scroll).toBeGreaterThan(0)
    expect(before.top).toBeGreaterThan(0)
    await page.keyboard.insertText('z')
    const after = await input.evaluate(el => new Promise<{ top: number; scroll: number }>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve({ top: el.getBoundingClientRect().top, scroll: window.scrollY })
      }))
    }))
    expect(after).toEqual(before)
    return '- typing with a keyboard-panned viewport preserves page scroll and composer position'
  } finally {
    await restore.evaluate((dispose) => { dispose() })
    await restore.dispose()
  }
}


const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/mobile-keyboard', import.meta.url))

it('dismisses the mobile keyboard after Send while retaining desktop focus', async () => {
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const observations: string[] = []
  for (const mobile of [false, true]) {
    const scaffold = await launchWebScaffold({
      replayFixture: fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url)),
      compareReplaySession: false,
      extraOverlayPath: [CUSTOM_OVERLAY, fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url))],
      extraInstallAnchors: [CUSTOM_MANIFEST],
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
        await expect.poll(() => page.title()).toBe('Harnessy')
        await input.fill('alpha beta')
        await input.press('ArrowLeft')
        await input.press('Shift+ArrowLeft')
        const retained = await input.elementHandle()
        expect(retained).not.toBeNull()
        const state = () => input.evaluate(element => ({ focused: document.activeElement === element,
          text: element.textContent, selection: window.getSelection()?.toString() }))
        const beforeResize = await state()
        expect(beforeResize.selection).toBe('t')
        for (const width of [390, 768, 1680]) {
          await page.setViewportSize({ width, height: 1000 })
          expect(await retained!.evaluate(element => element.isConnected)).toBe(true)
          expect(await state()).toEqual(beforeResize)
        }
        await page.setViewportSize({ width: mobile ? 390 : 1280, height: 844 })
        observations.push('- ' + platform + ': responsive resize retains the editor, focus, draft and caret')
        observations.push('- ' + platform + ': ' + (await exerciseKeyboardViewport(page)).slice(2))

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
