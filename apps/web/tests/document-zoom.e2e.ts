/** Shared document controls through Harnessy's shipped image and PDF renderers. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { pdfFixture } from '../../../packages/client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

/** Reveal the toolbar through its owning viewport rather than forcing visibility. */
async function revealZoom(page: Page, preview: Locator): Promise<Locator> {
  const bounds = await preview.locator('[data-document-zoom-frame]').boundingBox()
  if (bounds === null) throw new Error('Document viewport is unavailable')
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 8)
  await expect.poll(() => preview.locator('[data-document-zoom-controls]').getAttribute('data-document-zoom-visible')).toBe('true')
  return preview.getByRole('button', { name: 'Choose zoom', exact: true })
}

it('keeps Harnessy image and PDF fitting, presets and owner toolbar placement', async () => {
  const scaffold = await launchWebScaffold({
    replayFixture: fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v3.jsonl', import.meta.url)),
    compareReplaySession: false,
    extraOverlayPath: [
      fileURLToPath(new URL('../../../packages/bundle/custom-harness/cordis.patch.yml', import.meta.url)),
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    ],
    extraInstallAnchors: [fileURLToPath(new URL('../../../packages/bundle/custom-harness/package.json', import.meta.url))],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'document-zoom-harnessy'))
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd, 'zoom')
  await expect.poll(() => page.title()).toBe('Harnessy')
  const settled = scaffold.whenTurnSettled()
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  await input.fill('Reply with the single word LIGHTHOUSE and stop.')
  await input.press('Enter')
  const sessionId = await settled
  await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
  const cwd = scaffold.ctx.agents.get(sessionId)?.session.header.cwd
  if (cwd === undefined) throw new Error('Session workspace is unavailable')
  await Promise.all([
    writeFile(join(cwd, 'zoom.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="teal"/></svg>'),
    writeFile(join(cwd, 'zoom.pdf'), pdfFixture()),
  ])
  const column = page.locator('[data-rightbar-col]')
  await page.locator('[data-sidebar-right-expand]').click()
  await column.locator('[data-sidebar-right-guide-entry="files"]').click()
  await column.locator('[data-files-state="tree"]').waitFor()
  await column.locator('[data-files-reload]').click()
  const files = column.locator('[data-dockkit-tab]').filter({ has: page.getByText('Files', { exact: true }) })
  const preview = column.locator('[data-textpreview-url]')
  for (const name of ['zoom.svg', 'zoom.pdf']) {
    await files.click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name, exact: true }).click()
    const image = preview.getByRole('img', { name: name.endsWith('.pdf') ? 'PDF page 1' : `Image preview: ${name}`, exact: true })
    await image.waitFor({ timeout: 30_000 })
    const menu = await revealZoom(page, preview)
    await menu.click()
    expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Fit width', '25%', '50%', '100%', '150%', '200%'])
    await page.getByRole('menuitem', { name: '200%', exact: true }).click()
    await expect.poll(() => menu.innerText()).toBe('200%')
    expect(await image.isVisible()).toBe(true)
    await (await revealZoom(page, preview)).click()
    await page.getByRole('menuitem', { name: 'Fit width', exact: true }).click()
    await expect.poll(() => menu.innerText()).not.toBe('200%')
  }
  const controls = preview.locator('[data-document-zoom-controls]')
  await controls.evaluate((node) => { node.classList.add('zoom-owner-placement') })
  const style = await page.addStyleTag({ content: '.zoom-owner-placement { bottom: 78px; max-width: 200px; }' })
  try {
    for (const first of [true, false]) {
      await style.evaluate((node, prepend) => { if (prepend) document.head.prepend(node); else document.head.append(node) }, first)
      expect(await controls.evaluate(node => ({ bottom: getComputedStyle(node).bottom, maximum: getComputedStyle(node).maxWidth })))
        .toEqual({ bottom: '78px', maximum: '200px' })
    }
  } finally {
    await controls.evaluate((node) => { node.classList.remove('zoom-owner-placement') })
    await style.evaluate((node) => { node.parentNode?.removeChild(node) })
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
