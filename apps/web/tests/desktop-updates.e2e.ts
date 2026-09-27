/** Built workspace chrome with a controlled Desktop carrier; no Electron or installer is exercised. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { presentDesktopUpdate } from '../../desktop/src/update-presentation.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { openSettings } from './support.ts'

// Mirrors the preload's presentation-only API; importing Client projects would mix compiler faces.
type Presentation = ReturnType<typeof presentDesktopUpdate>
interface CarrierFixture {
  publish(state: Presentation): void
  opens: number
  checks: number
  cancels: number
  listeners: Set<(state: Presentation) => void>
}
type FixtureWindow = Window & typeof globalThis & { updateFixture: CarrierFixture }

describe('web e2e: Desktop update workspace chrome', () => {
  it.each(['zh-CN', 'en-US'])('renders update states and routes explicit actions in %s', async (locale) => {
    const scaffold = await launchWebScaffold({})
    try {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale })
        await page.addInitScript(() => {
          let current: Presentation = { phase: 'idle' }
          const listeners = new Set<(state: Presentation) => void>()
          const fixture: CarrierFixture = {
            opens: 0, checks: 0, cancels: 0, listeners,
            publish(state) { current = state; for (const listener of listeners) listener(state) },
          }
          Object.assign(window, {
            updateFixture: fixture,
            dshDesktop: { protocolVersion: 1, updates: {
              status: async () => current,
              check: async () => { fixture.checks += 1 },
              open: async () => { fixture.opens += 1 },
              cancelRestart: async () => { fixture.cancels += 1 },
              subscribe(listener: (state: Presentation) => void) { listeners.add(listener); return () => listeners.delete(listener) },
            } },
          })
        })
        const tripwire = watchConsole(page)
        const evidenceRoot = fileURLToPath(new URL('../../desktop/.desktop-build/qualification/', import.meta.url))
        await mkdir(evidenceRoot, { recursive: true })
        const evidence = await mkdtemp(join(evidenceRoot, `workspace-updates-${locale}-`))
        try {
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          await page.waitForSelector('[class*="frame"]')
          await expect.poll(() => page.evaluate(() => (window as FixtureWindow).updateFixture.listeners.size)).toBe(1)
          const availableLabel = locale === 'zh-CN' ? '新版本' : 'Update'
          const retryLabel = locale === 'zh-CN' ? '重试更新' : 'Retry update'
          const errorDetail = locale === 'zh-CN' ? '下载更新失败，请重试。' : 'Could not download the update. Please try again.'
          const readyLabel = locale === 'zh-CN' ? '安装并重启' : 'Install and Restart'
          const checkingLabel = locale === 'zh-CN' ? '正在检查更新…' : 'Checking for updates…'
          const downloadingTitle = locale === 'zh-CN' ? '正在下载更新' : 'Downloading update'
          const waitingLabel = locale === 'zh-CN' ? '等待安装' : 'Update scheduled'
          const cancelLabel = locale === 'zh-CN' ? '取消重启' : 'Cancel restart'
          const checkLabel = locale === 'zh-CN' ? '检查更新' : 'Check for updates'
          const version = '0.1.5-nightly.20260911'
          // The carrier classification deliberately uses English shell copy; Web copy follows its own locale.
          const publish = async (state: Presentation) => page.evaluate((value) => {
            (window as FixtureWindow).updateFixture.publish(value)
          }, state)
          const counts = async () => page.evaluate(() => {
            const { opens, checks, cancels } = (window as FixtureWindow).updateFixture
            return { opens, checks, cancels }
          })

          // Available: the workspace-header control replaces the retired
          // bottom-of-sidebar pill, so it paints inside the sidebar header row.
          await publish(presentDesktopUpdate({ phase: 'available', version }))
          const update = page.getByRole('button', { name: availableLabel, exact: true })
          await update.waitFor()
          expect(await update.getAttribute('aria-disabled')).toBe('false')
          expect(await counts()).toEqual({ opens: 0, checks: 0, cancels: 0 })
          const geometry = await update.boundingBox()
          expect(geometry).not.toBeNull()
          expect(geometry!.x).toBeLessThan(350)
          // The workspace-header row, not the sidebar foot the control left.
          expect(geometry!.y).toBeLessThan(300)
          await page.screenshot({ path: join(evidence, 'available.png') })
          await update.click()
          await expect.poll(async () => (await counts()).opens).toBe(1)

          // Checking holds an indeterminate treatment and refuses the click.
          await publish(presentDesktopUpdate({ phase: 'checking' }))
          const checking = page.getByRole('button', { name: checkingLabel, exact: true })
          await checking.waitFor()
          expect(await checking.getAttribute('aria-disabled')).toBe('true')
          // Force dispatch past Playwright's aria-disabled guard to verify the product's click guard.
          await checking.click({ force: true })
          expect((await counts()).opens).toBe(1)

          // Downloading renders determinate progress around the download icon,
          // and its click opens the version/percent/bytes popover. The shell's
          // presentation builder carries the phase; this fixture adds the
          // transfer counts the same way the real downloader reports them.
          await publish({
            ...presentDesktopUpdate({ phase: 'downloading', version, percent: 58 }),
            transferredBytes: 4_404_019,
            totalBytes: 12_582_912,
          })
          const downloading = page.getByRole('button', {
            name: locale === 'zh-CN' ? '正在下载更新：58%' : 'Downloading update: 58%', exact: true,
          })
          await downloading.waitFor()
          expect(await downloading.getAttribute('aria-disabled')).toBe('false')
          // The determinate ring sits around the download icon it reuses.
          expect(await downloading.locator('circle').count()).toBe(2)
          expect(await downloading.locator('svg').count()).toBe(2)
          await downloading.click()
          const progress = page.getByRole('dialog', { name: downloadingTitle, exact: true })
          await progress.waitFor()
          expect(await progress.textContent()).toContain('58%')
          expect(await progress.textContent()).toContain(version)
          const progressGeometry = await progress.boundingBox()
          const viewport = page.viewportSize()
          expect(progressGeometry).not.toBeNull()
          expect(viewport).not.toBeNull()
          expect(progressGeometry!.x).toBeGreaterThanOrEqual(0)
          expect(progressGeometry!.y).toBeGreaterThanOrEqual(0)
          expect(progressGeometry!.x + progressGeometry!.width).toBeLessThanOrEqual(viewport!.width)
          expect(progressGeometry!.y + progressGeometry!.height).toBeLessThanOrEqual(viewport!.height)
          expect(await page.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('58')
          expect(await counts()).toEqual({ opens: 1, checks: 0, cancels: 0 })
          await page.screenshot({ path: join(evidence, 'downloading.png') })
          await page.keyboard.press('Escape')
          await expect.poll(() => progress.count()).toBe(0)

          // Ready installs through the shell-owned open action.
          await publish(presentDesktopUpdate({ phase: 'ready', version }))
          const ready = page.getByRole('button', { name: readyLabel, exact: true })
          await ready.waitFor()
          expect(await ready.getAttribute('aria-disabled')).toBe('false')
          await page.screenshot({ path: join(evidence, 'ready.png') })
          await ready.click()
          await expect.poll(async () => (await counts()).opens).toBe(2)

          // Failure keeps the warning accent, its classified tooltip, and retry.
          await publish(presentDesktopUpdate({ phase: 'error', version, failedOperation: 'download', message: 'HTTP 503' }))
          const retry = page.getByRole('button', { name: retryLabel, exact: true })
          await retry.waitFor()
          await retry.hover()
          const tooltip = page.getByRole('tooltip', { name: errorDetail, exact: true })
          await expect.poll(() => tooltip.evaluateAll(elements => elements.map(element => getComputedStyle(element).opacity))).toEqual(['1'])
          await page.screenshot({ path: join(evidence, 'error.png') })
          await retry.click()
          await expect.poll(async () => (await counts()).opens).toBe(3)

          // A staged restart explains the schedule and cancels through the shell.
          await publish(presentDesktopUpdate({ phase: 'waiting', version }))
          const waiting = page.getByRole('button', { name: waitingLabel, exact: true })
          await waiting.waitFor()
          await waiting.click()
          const staged = page.getByRole('dialog', { name: waitingLabel, exact: true })
          await staged.waitFor()
          await page.screenshot({ path: join(evidence, 'waiting.png') })
          await staged.getByRole('button', { name: cancelLabel, exact: true }).click()
          await expect.poll(async () => (await counts()).cancels).toBe(1)

          // The collapsed rail keeps the shared status as its badge and drops
          // the header control with the expanded sidebar.
          const collapse = locale === 'zh-CN' ? '收起侧边栏' : 'Collapse sidebar'
          const expand = locale === 'zh-CN' ? '打开侧边栏' : 'Open sidebar'
          await page.getByRole('button', { name: collapse, exact: true }).click()
          const toggle = page.getByRole('button', { name: expand, exact: true })
          await toggle.getByRole('img', { name: waitingLabel, exact: true }).waitFor()
          await expect.poll(() => waiting.count()).toBe(0)
          await page.screenshot({ path: join(evidence, 'collapsed.png') })
          await toggle.click()
          await waiting.waitFor()

          // General Settings carries the version row's Desktop-only check.
          await openSettings(page, locale === 'zh-CN' ? 'zh' : 'en')
          const check = page.getByRole('button', { name: checkLabel, exact: true })
          await check.waitFor()
          await page.screenshot({ path: join(evidence, 'settings.png') })
          await check.click()
          await expect.poll(async () => (await counts()).checks).toBe(1)
          expect(await counts()).toEqual({ opens: 3, checks: 1, cancels: 1 })

          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
          expect(await page.evaluate(() => (window as FixtureWindow).updateFixture.listeners.size)).toBe(1)
          await writeFile(join(evidence, 'result.json'), JSON.stringify({ locale, geometry,
            passed: true, explicitActions: 5, carrier: 'substituted', host: 'real Web composition',
            electron: false, installerExecuted: false }, null, 2) + '\n')
          console.log(`Desktop workspace chrome evidence: ${evidence}`)
        } catch (error) {
          await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
          throw error
        }
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  })
})
