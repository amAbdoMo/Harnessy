/** Real Loader/client/Slots Website controls with an external Electron bridge. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'
import { installWebsiteBridge } from './sidebar-website.bridge.ts'

const OVERLAY = fileURLToPath(new URL('./sidebar-browser.overlay.yml', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/sidebar-website', import.meta.url))
const BAR = '[class*="profileBar"]'

async function captureControls(page: Page, workspace: string, name: string): Promise<void> {
  await compareOrRefreshGolden(join(EXPECTED, `${name}.expected.md`),
    await captureStableAria(page, BAR, workspace), webSnapshotMode())
}

it('removes Website controls and subscriptions before held native cleanup settles', async () => {
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
  onTestFinished(() => scaffold.close())
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const sessionId = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'website-renderer-lifecycle')
  await workspace.attachSession(sessionId)
  await scaffold.ctx.sessionController.rename({ sessionId, title: 'Website lifecycle session' })
  const browser = await chromium.launch()
  let page: Page | undefined
  try {
    page = await newEnglishPage(browser)
    const activePage = page
    const console = watchConsole(page)
    onTestFailed(() => saveFailureShot(activePage, 'web-e2e-sidebar-website'))
    await page.addInitScript(installWebsiteBridge)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('treeitem').filter({ has: page.getByText('Website lifecycle session', { exact: true }) }).click()
    await page.locator('[data-sidebar-right-expand]').click()
    await page.locator('[data-sidebar-right-guide-entry="browser"]').click()
    const right = page.locator('[data-rightbar-col]')
    await right.getByRole('button', { name: 'Saved website profiles', exact: true }).click()
    await page.getByRole('menuitem').filter({ hasText: 'Fixture site' }).click()
    await right.getByText('Human control', { exact: true }).waitFor()
    expect(await right.getByRole('button', { name: 'Resume', exact: true }).isEnabled()).toBe(false)
    expect(await page.evaluate(() => window.websiteBridgeProbe.resumed)).toBe(0)
    await captureControls(page, scaffold.workspaceCwd, 'human')

    await right.getByRole('button', { name: 'Choose a request', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Request website-fixture-request', exact: true }).click()
    await expect.poll(() => right.getByRole('button', { name: 'Resume', exact: true }).isEnabled()).toBe(true)
    await right.getByRole('button', { name: 'Resume', exact: true }).click()
    await right.getByText('Agent control', { exact: true }).waitFor()
    expect(await page.evaluate(() => window.websiteBridgeProbe.preparedSessions)).toEqual([sessionId])
    expect(await page.evaluate(() => window.websiteBridgeProbe.sessionIds
      .every(id => id === window.websiteBridgeProbe.preparedSessions[0]))).toBe(true)
    await captureControls(page, scaffold.workspaceCwd, 'agent')

    await page.evaluate(() => { window.websiteBridgeProbe.hold() })
    await right.getByRole('button', { name: 'Take control', exact: true }).click()
    await right.getByText('Human control', { exact: true }).waitFor()
    expect(await right.getByRole('button', { name: 'Resume', exact: true }).isEnabled()).toBe(false)
    expect(await page.evaluate(() => window.websiteBridgeProbe.revoked)).toBe(1)
    expect(await page.evaluate(() => window.websiteBridgeProbe.drained)).toBe(0)
    await captureControls(page, scaffold.workspaceCwd, 'draining')

    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.id === 'ui-sidebar-browser')
    expect(entry).toBeDefined()
    if (entry === undefined) throw new Error('The shipped Browser entry was not loaded')
    const host = scaffold.ctx.loader.ctx.fiber.uid
    let navigations = 0
    page.on('framenavigated', () => { navigations++ })
    entry.parent.tree.remove(entry.options.id)
    expect([...scaffold.ctx.loader.entries()].includes(entry)).toBe(false)
    await expect.poll(() => right.getByRole('button', { name: 'Saved website profiles', exact: true }).count()).toBe(0)
    await expect.poll(() => activePage.locator(BAR).count()).toBe(0)
    await expect.poll(() => activePage.locator('[data-sidebar-browser-frame="webview"]').count()).toBe(0)
    await expect.poll(() => activePage.evaluate(() => window.websiteBridgeProbe.listeners)).toBe(0)
    expect(await page.evaluate(() => window.websiteBridgeProbe.drained)).toBe(0)
    expect(await page.evaluate(() => window.websiteBridgeProbe.releasesStarted > window.websiteBridgeProbe.releasesSettled)).toBe(true)
    await page.evaluate(() => { window.websiteBridgeProbe.finish(); window.websiteBridgeProbe.notify() })
    await expect.poll(() => activePage.evaluate(() => window.websiteBridgeProbe.drained)).toBe(1)
    await expect.poll(() => activePage.evaluate(() => window.websiteBridgeProbe.releasesStarted
      === window.websiteBridgeProbe.releasesSettled)).toBe(true)
    expect(await page.locator(BAR).count()).toBe(0)
    expect(await page.locator('[data-sidebar-browser-frame="webview"]').count()).toBe(0)
    expect(scaffold.ctx.loader.ctx.fiber.uid).toBe(host)
    expect(navigations).toBe(0)
    expect(console.pageErrors).toEqual([])
  } finally {
    // The page owns native barriers; release them before closing either owner.
    try { await page?.evaluate(() => { window.websiteBridgeProbe?.finish() }) }
    finally { await browser.close() }
  }
})
