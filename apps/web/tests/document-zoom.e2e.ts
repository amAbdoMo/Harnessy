/** Shared document controls through Harnessy's shipped image and PDF renderers. */
import { readFile, writeFile } from 'node:fs/promises'
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

it('keeps Harnessy document zoom, overflowing-image panning and original-file dragging', async () => {
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
  const png = await readFile(fileURLToPath(new URL('../../../snapshots/session/read-image/workspace/red.png', import.meta.url)))
  await Promise.all([
    writeFile(join(cwd, 'zoom.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="teal"/></svg>'),
    writeFile(join(cwd, 'zoom.pdf'), pdfFixture()),
    writeFile(join(cwd, 'tiny.png'), png),
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
    const originalUrl = await image.getAttribute('src')
    const menu = await revealZoom(page, preview)
    await menu.click()
    expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Fit width', '25%', '50%', '100%', '150%', '200%'])
    await page.getByRole('menuitem', { name: '200%', exact: true }).click()
    await expect.poll(() => menu.innerText()).toBe('200%')
    expect(await image.isVisible()).toBe(true)
    if (name.endsWith('.svg')) {
      const scrollport = preview.locator('[data-document-zoom-scrollport]')
      await scrollport.evaluate((node) => { node.scrollLeft = 0; node.scrollTop = 0 })
      await expect.poll(() => image.evaluate(node => getComputedStyle(node).cursor)).toBe('grab')
      expect(await image.evaluate((node: HTMLImageElement) => node.draggable)).toBe(false)
      const bounds = await scrollport.boundingBox()
      if (bounds === null) throw new Error('Image scrollport is unavailable')
      await page.mouse.move(bounds.x + 180, bounds.y + 180)
      await page.mouse.down()
      await page.mouse.move(bounds.x + 100, bounds.y + 100, { steps: 8 })
      await expect.poll(() => scrollport.evaluate(node => [node.scrollLeft, node.scrollTop])).toEqual([80, 80])
      await expect.poll(() => image.evaluate(node => getComputedStyle(node).cursor)).toBe('grabbing')
      await page.mouse.up()
      await expect.poll(() => image.evaluate(node => getComputedStyle(node).cursor)).toBe('grab')
    }
    await (await revealZoom(page, preview)).click()
    await page.getByRole('menuitem', { name: 'Fit width', exact: true }).click()
    await expect.poll(() => menu.innerText()).not.toBe('200%')
    expect(await image.getAttribute('src')).toBe(originalUrl)
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
  await files.click()
  await column.locator('[data-files-entry="file"]').getByRole('button', { name: 'tiny.png', exact: true }).click()
  const tinyImage = preview.getByRole('img', { name: 'Image preview: tiny.png', exact: true })
  await expect.poll(() => tinyImage.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)
  expect(await tinyImage.evaluate((node: HTMLImageElement) => node.draggable)).toBe(true)
  await tinyImage.dragTo(input)
  const dragged = page.getByRole('group', { name: 'Pending attachments', exact: true }).getByRole('img', { name: 'tiny.png', exact: true })
  await dragged.waitFor()
  const original = await dragged.evaluate(async (node: HTMLImageElement) =>
    Array.from(new Uint8Array(await (await fetch(node.src)).arrayBuffer())))
  expect(Buffer.from(original)).toEqual(png)
  expect(await input.innerText()).toBe('')
  expect(await page.getByRole('dialog', { name: 'Image preview', exact: true }).count()).toBe(0)
  await expect.poll(() => page.getByRole('button', { name: 'Send message', exact: true }).isDisabled()).toBe(false)
  await page.getByRole('button', { name: 'Remove image tiny.png', exact: true }).click()
  const detachedDrag = await tinyImage.evaluateHandle((node) => {
    const state = { token: '', started: false, ended: false }
    window.addEventListener('dragstart', (event) => {
      state.token = event.dataTransfer!.getData('application/x-dsh-file')
      state.started = event.isTrusted && state.token !== ''
    }, { once: true })
    node.addEventListener('dragend', (event) => { state.ended = event.isTrusted && !node.isConnected }, { once: true })
    return state
  })
  try {
    const source = await tinyImage.boundingBox()
    const target = await input.boundingBox()
    if (source === null || target === null) throw new Error('Image drag endpoints are unavailable')
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(source.x - 20, source.y, { steps: 4 })
    await expect.poll(() => detachedDrag.evaluate(state => state.started)).toBe(true)
    const tab = column.locator('[data-dockkit-tab]').filter({ has: page.getByText('tiny.png', { exact: true }) })
    await tab.locator('[data-dockkit-tab-close]').evaluate((button: HTMLElement) => { button.click() })
    await tinyImage.waitFor({ state: 'detached' })
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 })
    await page.mouse.up()
    await dragged.waitFor()
    expect(Buffer.from(await dragged.evaluate(async (node: HTMLImageElement) =>
      Array.from(new Uint8Array(await (await fetch(node.src)).arrayBuffer()))))).toEqual(png)
    await expect.poll(() => detachedDrag.evaluate(state => state.ended)).toBe(true)
    await expect.poll(() => page.getByRole('button', { name: 'Send message', exact: true }).isDisabled()).toBe(false)
    await page.getByRole('button', { name: 'Remove image tiny.png', exact: true }).click()
    const token = await detachedDrag.evaluate(state => state.token)
    await input.evaluate((node, retired) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.setData('application/x-dsh-file', retired)
      node.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }))
    }, token)
    expect(await dragged.count()).toBe(0)
  } finally {
    await detachedDrag.dispose()
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
