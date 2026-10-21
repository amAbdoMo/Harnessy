/** Native companion controls in the built Harnessy settings UI, using public synthetic bridge status. */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

let scaffold: WebScaffold | undefined
let browser: Browser | undefined
let page: Page

beforeAll(async () => {
  scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('../../../packages/bundle/custom-harness/cordis.patch.yml', import.meta.url)),
    extraInstallAnchors: [fileURLToPath(new URL('../../../packages/bundle/custom-harness/package.json', import.meta.url))],
  })
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.addInitScript(() => {
    let reads = 0
    Object.defineProperty(window, 'dshDesktop', { value: { companion: {
      describe: async () => ({ available: ++reads > 1, connected: reads > 1, pairedCount: 2 }),
      open: async () => { throw new Error('private fixture management failure') },
    } } })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await scaffold?.close()
})

it('fits wide and narrow settings, refreshes native status, and shows errors outside collapsed guidance', async () => {
  await page.getByRole('button', { name: /No accounts saved/ }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  const card = page.getByRole('region', { name: 'Android phone companion', exact: true })
  await card.waitFor()
  expect(await card.getByRole('status').textContent()).toBe('Unavailable')
  expect(await card.locator('details').getAttribute('open')).toBeNull()
  const output = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
  await mkdir(output, { recursive: true })
  // Desktop's native window minimum is 520px; its settings navigation stays beside the card.
  for (const width of [1100, 520]) {
    await page.setViewportSize({ width, height: 900 })
    await card.scrollIntoViewIfNeeded()
    const bounds = await card.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    const buttons = await Promise.all(['Phone settings', 'Refresh status'].map(name => card.getByRole('button', { name, exact: true }).boundingBox()))
    expect(buttons.every(button => button !== null && button.width >= 140), JSON.stringify({ width, bounds, buttons })).toBe(true)
    expect(Math.abs(buttons[0]!.width - buttons[1]!.width)).toBeLessThan(1)
    await card.screenshot({ path: `${output}/phone-companion-${width}.png` })
  }
  await card.getByRole('button', { name: 'Phone settings', exact: true }).click()
  await card.getByRole('alert').waitFor()
  expect(await card.getByRole('alert').textContent()).not.toContain('private fixture')
  expect(await card.locator('details').getAttribute('open')).toBeNull()
  expect(await card.locator('details [role="alert"]').count()).toBe(0)
  await card.getByRole('button', { name: 'Refresh status', exact: true }).click()
  await expect.poll(() => card.getByRole('status').textContent()).toBe('Connected')
  expect(await card.getByRole('alert').count()).toBe(0)
  await card.locator('summary').click()
  expect(await card.locator('details').getAttribute('open')).not.toBeNull()
  await card.screenshot({ path: `${output}/phone-companion-connected.png` })
})
