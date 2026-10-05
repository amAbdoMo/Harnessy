// Web e2e scenario: a hand-declared model's `reasoningEfforts` reaches the
// searchable composer picker and saves with the Agent default. Zero model
// calls: declaring, describing, and switching are settings/llm traffic only.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page, Request } from 'playwright'
import { chromium, webkit } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./declared-reasoning.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/declared-reasoning', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/declared-reasoning/ui.expected.md', import.meta.url))
const POINTER_EXPECTED = fileURLToPath(new URL('./expected/declared-reasoning/pointer-menu.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record').each([
  { name: 'Chromium', engine: chromium },
  { name: 'WebKit', engine: webkit },
])('web e2e: declared reasoning efforts reach the composer ($name)', ({ engine }) => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    await scaffold.ctx.settings.update('llm-pi-ai', {
      providers: {
        'acme-gateway': {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [
            { id: 'acme-think', name: 'Acme Think' },
            { id: 'acme-swift', name: 'Acme Swift' },
            { id: 'acme-lite', name: 'Acme Lite' },
          ].map(model => ({
            ...model,
            reasoningEfforts: { off: null, high: 'high', max: 'ultra' },
          })),
        },
      },
    })
    browser = await engine.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('offers exactly the declared levels and records a picked level', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-declared-reasoning-${engine.name()}`))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()

    const dialog = page.getByRole('dialog', { name: '模型与推理等级' })
    const search = dialog.getByRole('textbox', { name: '搜索可用模型' })
    const levels = dialog.getByRole('radiogroup', { name: '推理等级' }).getByRole('radio')
    await expect.poll(async () => levels.allTextContents(), { timeout: 10_000 })
      .toEqual(['Default', 'Off', 'High', 'Max'])
    await expect.poll(() => search.evaluate(element => element === document.activeElement)).toBe(true)
    await compareOrRefreshGolden(
      UI_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd),
      MODE,
    )

    await dialog.getByRole('radio', { name: 'High', exact: true }).dblclick()
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'),
      { timeout: 10_000 },
    ).toContain('reasoningEffort: high')
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('选择模型，当前 Acme Think，推理等级 High')
    await expect.poll(() => dialog.count()).toBe(0)
    await expect.poll(() => trigger.evaluate(element => element === document.activeElement)).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('searches and applies a model and level together', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-model-pointer-${engine.name()}`))
    let selections = 0
    const countSelection = (request: Request): void => {
      if (new URL(request.url()).pathname.endsWith('/session/selectModel')) selections++
    }
    page.on('request', countSelection)
    onTestFinished(() => { page.off('request', countSelection) })

    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '模型与推理等级' })
    const search = dialog.getByRole('textbox', { name: '搜索可用模型' })
    await search.fill('swift')
    await expect.poll(() => dialog.getByRole('radio', { name: /^Acme Think/ }).count()).toBe(0)
    await dialog.getByRole('radio', { name: /^Acme Swift/ }).click()
    expect(selections).toBe(0)
    expect(scaffold.ctx.agentDefaultModel.currentSelection().model).toBe('acme-think')
    await dialog.getByRole('radio', { name: 'Max', exact: true }).click()
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().reasoningEffort, { timeout: 10_000 })
      .toBe('max')
    expect(selections).toBe(1)
    await expect.poll(() => dialog.count()).toBe(0)
  })

  it('keeps the picker open and reports a rejected selection', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-model-rejection-${engine.name()}`))
    await page.route('**/api/session/selectModel', async (route) => {
      const envelope = route.request().postDataJSON() as { rpcId: string }
      await route.fulfill({
        json: {
          type: 'server-response', rpcId: envelope.rpcId,
          result: {
            ok: false,
            error: { code: 'session/writer-held', message: 'writer held', details: { sessionId: 'held-session' } },
          },
        },
      })
    }, { times: 1 })

    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '模型与推理等级' })
    await dialog.getByRole('radio', { name: /^Acme Think/ }).dblclick()
    await page.getByRole('alert').waitFor()
    await expect.poll(() => dialog.count()).toBe(1)
    await compareOrRefreshGolden(
      POINTER_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd),
      MODE,
    )
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md', 'pointer-menu.expected.md'])
  })
})
