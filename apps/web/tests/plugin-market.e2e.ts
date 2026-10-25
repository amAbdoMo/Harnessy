/** Keyless Harnessy browser coverage for opt-in markets, retained plugin groups, details, and confirmed installation. */
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import type { PluginSpecInspection, PluginUpdateResult } from '@deepseek-ai/dsh-plugin-manager/types'
import type { PluginDetailDocumentId } from '@deepseek-ai/dsh-plugin-market/types'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/plugin-market', import.meta.url))
const MODE = webSnapshotMode()
const PACKAGE = '@fixture/market-example'

describe('web e2e: Harnessy plugin markets', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let server: Server
  let fixtureRoot: string
  let indexUrl: string
  let registry: string
  let tripwire: ReturnType<typeof watchConsole>

  async function captureThemes(prefix: string): Promise<void> {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
      await page.screenshot({ path: fileURLToPath(new URL(`../../../.artifacts/${prefix}-${colorScheme}.png`, import.meta.url)) })
    }
  }

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'harnessy-market-fixture-'))
    const fixtureBundle = join(fixtureRoot, 'bundle')
    await cp(fileURLToPath(new URL('./fixtures/plugins/fixture-bundle', import.meta.url)), fixtureBundle, { recursive: true })
    await writeFile(join(fixtureBundle, 'README.md'), '# Installed plugin guide\n\nKeep **your current settings**.\n')
    server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ format: 1, title: 'Fixture market', plugins: [{
        name: PACKAGE, title: 'Sample plugin', description: 'A plugin from a configured index.', author: 'Fixture author',
        versions: [{ version: '1.2.0', publishTimestamp: 1789000000, source: { type: 'npm', registry } }],
      }] }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('market fixture has no TCP address')
    registry = `http://127.0.0.1:${String(address.port)}/`
    indexUrl = `${registry}index.json`
    scaffold = await launchWebScaffold({
      extraOverlayPath: [
        fileURLToPath(new URL('../../../packages/bundle/custom-harness/cordis.patch.yml', import.meta.url)),
        fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      ],
      extraInstallAnchors: [
        fileURLToPath(new URL('../../../packages/bundle/custom-harness/package.json', import.meta.url)),
        fileURLToPath(new URL('../../../packages/experimental/plugin-market-bundle/package.json', import.meta.url)),
      ],
      profile: { packages: [{ dir: fixtureBundle }] },
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForFunction(() => document.title === 'Harnessy')
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally {
        if (server?.listening) {
          server.closeAllConnections()
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error === undefined) resolve()
              else reject(error)
            })
          })
        }
        if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true })
      }
    }
  })

  it('adds discovery around the custom groups and confirms an exact version without installing a real package', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-market'))
    await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    await panel.getByRole('heading', { name: 'Plugins', exact: true }).waitFor()
    const groups = () => panel.locator('[data-plugin-group]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-plugin-group')))
    await expect.poll(groups).toEqual(['basic', 'extensions', 'bundles'])
    const optional = panel.locator('[data-plugin-package="@deepseek-ai/dsh-experimental-plugin-market-bundle"]')
    await optional.getByRole('switch').click()
    await panel.getByRole('tab', { name: 'Discover', exact: true }).click()
    await panel.getByRole('button', { name: 'Add index source', exact: true }).click()
    const sources = page.getByRole('dialog', { name: 'Index sources', exact: true })
    await sources.getByRole('textbox', { name: 'Index URL' }).fill(indexUrl)
    await sources.getByRole('button', { name: 'Add', exact: true }).click()
    await expect.poll(() => scaffold.ctx.pluginMarket.listIndexes().map(index => index.url)).toEqual([indexUrl])
    await page.keyboard.press('Escape')
    await panel.locator(`[data-market-entry="${PACKAGE}"]`).waitFor()
    const detail = vi.spyOn(scaffold.ctx.pluginMarket, 'readEntryDetail').mockResolvedValue({
      status: 'found', origin: 'readme', markdown: '# Market plugin guide\n\nA **configured** plugin.\n',
      document: 'market-browser-document' as PluginDetailDocumentId,
    })
    const inspection = Promise.withResolvers<PluginSpecInspection>()
    const inspect = vi.spyOn(scaffold.ctx.pluginManager, 'inspect').mockImplementation(() => inspection.promise)
    const install = vi.spyOn(scaffold.ctx.pluginManager, 'installBundle').mockResolvedValue({
      changed: false, application: 'failed', stage: 'install', target: `${PACKAGE}@1.2.0`,
      error: { code: 'operation-error', diagnostic: 'Fixture installation stopped before package changes.' },
    })
    const snapshots: string[] = []
    const capture = (selector: string) => captureStableAria(page, selector, scaffold.workspaceCwd, {
      replacements: [
        [new URL(registry).host, '<fixture-registry>'],
        [join(fixtureRoot, 'bundle'), '<plugin-fixture>/bundle'],
        [fixtureRoot, '<plugin-fixture>'], [fixtureRoot.replaceAll('\\', '/'), '<plugin-fixture>'],
      ],
    })
    try {
      await panel.getByRole('button', { name: 'View Sample plugin', exact: true }).click()
      await panel.getByRole('heading', { name: 'Market plugin guide' }).waitFor()
      snapshots.push('## Discover details\n', await capture('[data-plugin-panel]'))
      await captureThemes('plugin-market-discover')
      await panel.getByRole('button', { name: 'Install Sample plugin', exact: true }).click()
      const confirmation = page.getByRole('dialog', { name: 'Install "Sample plugin"?', exact: true })
      await confirmation.getByRole('button', { name: 'Install', exact: true }).click()
      await page.locator('[data-install-phase="checking"]').waitFor()
      const checking = page.getByRole('dialog')
      expect(await checking.textContent()).toContain('Sample plugin')
      expect(await checking.textContent()).toContain('1.2.0')
      expect(await checking.getByRole('textbox').count()).toBe(0)
      snapshots.push('## Confirmed installation\n', await capture('[role="dialog"]'))
      inspection.resolve({ status: 'accepted', kind: 'registry', name: PACKAGE, version: '1.2.0', bundle: true, registry })
      await expect.poll(() => install.mock.calls.length).toBe(1)
      expect(install.mock.calls[0]).toEqual([`${PACKAGE}@1.2.0`, expect.objectContaining({ enabled: false, registry })])
      await page.locator('[data-install-phase="failed"]').waitFor()
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await panel.getByRole('tab', { name: 'Installed', exact: true }).click()
      await expect.poll(groups).toEqual(['basic', 'extensions', 'bundles'])
      await panel.locator('[data-plugin-package="@fixture/bundle"]').getByRole('button', { name: 'View @fixture/bundle', exact: true }).click()
      await panel.getByRole('heading', { name: 'Installed plugin guide' }).waitFor()
      snapshots.push('## Installed details\n', await capture('[data-plugin-panel]'))
      await captureThemes('plugin-market')
      expect(await page.locator('[data-slot-error]').count()).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
      await compareOrRefreshGolden(join(EXPECTED, 'ui.expected.md'), snapshots.join('\n'), MODE)
    } finally {
      inspection.resolve({ status: 'refused', problem: 'unknown', reason: 'Fixture closed' })
      detail.mockRestore(); inspect.mockRestore(); install.mockRestore()
    }
  }, 120_000)

  it('checks versions through Refresh and presents a restart-required replacement without changing packages', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-market-versions'))
    const manager = scaffold.ctx.pluginManager
    const list = manager.listBundles.bind(manager)
    const bundles = vi.spyOn(manager, 'listBundles').mockImplementation(async () =>
      (await list()).map(bundle => bundle.name === '@fixture/bundle' ? { ...bundle, updatable: true } : bundle))
    const versions = vi.spyOn(manager, 'listVersions').mockResolvedValue({
      status: 'listed', installed: '0.0.1', registry, attempts: [{ registry }], omitted: 0,
      versions: [{ version: '0.0.2', tags: ['latest'], prerelease: false, bundle: true }],
    })
    const replacement = Promise.withResolvers<PluginUpdateResult>()
    const update = vi.spyOn(manager, 'updateBundle').mockImplementation(async (_name, _version, options) => {
      if (options?.requestId === undefined) throw new Error('update fixture requires a progress request')
      scaffold.ctx.emit('plugin-manager/update-state', { requestId: options.requestId, step: 'checking' })
      scaffold.ctx.emit('plugin-manager/update-state', { requestId: options.requestId, step: 'installing' })
      return await replacement.promise
    })
    const panel = page.locator('[data-plugin-panel]')
    try {
      await panel.getByRole('button', { name: 'Back to plugins', exact: true }).click()
      await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
      await expect.poll(() => versions.mock.calls.length).toBeGreaterThan(0)
      expect(versions).toHaveBeenCalledWith('@fixture/bundle', {}, expect.any(AbortSignal))
      await panel.locator('[data-plugin-package="@fixture/bundle"]').getByRole('button', { name: 'View @fixture/bundle', exact: true }).click()
      await panel.getByText('Update to 0.0.2 available', { exact: true }).waitFor()
      await panel.getByRole('button', { name: 'Update to 0.0.2', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.locator('[data-plugin-update="confirm"]').waitFor()
      expect(await dialog.textContent()).toContain('takes effect after a restart')
      const snapshots = ['## Update confirmation\n', await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd, {
        replacements: [[new URL(registry).host, '<fixture-registry>']],
      })]
      await dialog.getByRole('button', { name: 'Update', exact: true }).click()
      await dialog.locator('[data-plugin-update="running"]').waitFor()
      expect(update).toHaveBeenCalledWith('@fixture/bundle', '0.0.2', expect.objectContaining({ registry }))
      replacement.resolve({ from: '0.0.1', to: '0.0.2', step: 'install', result: {
        changed: true, application: 'restart-required', stage: 'install', target: '@fixture/bundle', version: '0.0.2',
      } })
      await dialog.getByText('0.0.2 installed; it takes effect after a restart', { exact: true }).waitFor()
      snapshots.push('## Restart required\n', await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd, {
        replacements: [[new URL(registry).host, '<fixture-registry>']],
      }))
      await dialog.getByRole('button', { name: 'Done', exact: true }).click()
      expect((await list()).find(bundle => bundle.name === '@fixture/bundle')?.version).toBe('0.0.1')
      expect(tripwire.pageErrors).toEqual([])
      await compareOrRefreshGolden(join(EXPECTED, 'versions.expected.md'), snapshots.join('\n'), MODE)
      await assertFixtureInventory(EXPECTED, ['ui.expected.md', 'versions.expected.md'])
    } finally {
      replacement.resolve({ from: '0.0.1', to: '0.0.2', step: 'check', result: {
        changed: false, application: 'failed', stage: 'install', target: '@fixture/bundle',
      } })
      bundles.mockRestore(); versions.mockRestore(); update.mockRestore()
    }
  }, 120_000)
})
