/** Real Harnessy composition selects an individual provider reset through generated Remotes. */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed, vi } from 'vitest'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const OVERLAY = fileURLToPath(new URL('../../../packages/bundle/custom-harness/cordis.patch.yml', import.meta.url))
const MANIFEST = fileURLToPath(new URL('../../../packages/bundle/custom-harness/package.json', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/banked-reset-chooser/dialog.expected.md', import.meta.url))
const DETAILS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
let scaffold: WebScaffold
let browser: Browser
let page: Page
const redemptions: Array<{ readonly credit_id: string; readonly redeem_request_id: string }> = []
const redemptionGate = Promise.withResolvers<undefined>()
let redemptionSignal: AbortSignal | undefined
let didReset = false
let credits = [
  { id: 'credit-earlier', reset_type: 'codex_rate_limits', status: 'available', expires_at: '2030-10-23T00:00:00Z', title: 'Full reset (Weekly + 5 hr)' },
  { id: 'credit-chosen', reset_type: 'codex_rate_limits', status: 'available', expires_at: '2030-10-29T07:31:00Z', title: 'Full reset (Weekly + 5 hr)' },
]

beforeAll(async () => {
  const original = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== DETAILS_URL && url !== `${DETAILS_URL}/consume` && url !== 'https://chatgpt.com/backend-api/wham/usage') return original(input, init)
    expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('reset-fixture-account')
    if (url === `${DETAILS_URL}/consume`) {
      if (typeof init?.body !== 'string') throw new Error('redemption must send JSON text')
      const payload: unknown = JSON.parse(init.body)
      if (typeof payload !== 'object' || payload === null || !('credit_id' in payload) || !('redeem_request_id' in payload)
        || typeof payload.credit_id !== 'string' || typeof payload.redeem_request_id !== 'string') throw new Error('redemption omitted the selected credit')
      redemptions.push({ credit_id: payload.credit_id, redeem_request_id: payload.redeem_request_id })
      if (redemptions.length <= 2) return Response.json({ error: 'fixture transient outage' }, { status: 503 })
      redemptionSignal = init?.signal ?? undefined
      await redemptionGate.promise
      credits = credits.filter(credit => credit.id !== payload.credit_id)
      didReset = true
      return Response.json({ code: 'reset', windows_reset: 2 })
    }
    if (url === DETAILS_URL) return Response.json({ credits, available_count: credits.length })
    return Response.json({ rate_limit_reset_credits: { available_count: credits.length }, rate_limit: {
      primary_window: { used_percent: didReset ? 0 : 80, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: didReset ? 0 : 95, limit_window_seconds: 604_800 },
    } })
  })
  scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: [MANIFEST] })
  const jwt = `header.${Buffer.from(JSON.stringify({
    'https://api.openai.com/profile': { email: 'reset-fixture@example.invalid', name: 'Reset Fixture' },
    'https://api.openai.com/auth': { chatgpt_account_id: 'reset-fixture-account', chatgpt_user_id: 'fixture-user', chatgpt_plan_type: 'plus' },
  })).toString('base64url')}.signature`
  await scaffold.ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () => Promise.resolve({ kind: 'grant', payload: {
    type: 'oauth', access: jwt, refresh: 'fixture-not-a-live-token', accountId: 'reset-fixture-account', expires: Date.now() + 3_600_000,
  } }))
  await scaffold.ctx.accountsController.refreshUsage(new AbortController().signal)
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
}, 120_000)

afterAll(async () => {
  redemptionGate.resolve(undefined)
  await browser?.close()
  await scaffold?.close()
  vi.restoreAllMocks()
})

it('lists expiry dates, fits both themes and narrow windows, and redeems the second chosen credit', async () => {
  const consoleWatch = watchConsole(page)
  onTestFailed(async () => {
    await writeFile(fileURLToPath(new URL('../../../.artifacts/banked-resets-failure.md', import.meta.url)), await page.locator('body').ariaSnapshot())
    await page.screenshot({ path: fileURLToPath(new URL('../../../.artifacts/banked-resets-failure.png', import.meta.url)) })
  })
  await page.getByRole('button', { name: /Reset Fixture/ }).click()
  await page.getByRole('menuitem', { name: /Reset Fixture/ }).click()
  const action = page.getByRole('button', { name: 'View banked resets for Reset Fixture', exact: true })
  await action.click()
  const dialog = page.getByRole('dialog', { name: 'Banked resets', exact: true })
  await dialog.getByRole('button', { name: /Use reset —/ }).nth(1).waitFor()
  expect(redemptions).toEqual([])
  expect(await dialog.getByText('Reset Fixture', { exact: true }).count()).toBe(0)
  await mkdir(fileURLToPath(new URL('./expected/banked-reset-chooser/', import.meta.url)), { recursive: true })
  await compareOrRefreshGolden(EXPECTED, await dialog.ariaSnapshot(), webSnapshotMode())
  await mkdir(fileURLToPath(new URL('../../../.artifacts', import.meta.url)), { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)
    await page.setViewportSize({ width: 900, height: 720 })
    await dialog.screenshot({ path: fileURLToPath(new URL(`../../../.artifacts/banked-resets-${theme}.png`, import.meta.url)) })
    await page.setViewportSize({ width: 320, height: 640 })
    await expect.poll(async () => dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
        && element.scrollWidth <= element.clientWidth
    })).toBe(true)
    for (const button of await dialog.getByRole('button', { name: /Use reset —/ }).all()) {
      const box = await button.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x + box!.width).toBeLessThanOrEqual(320)
    }
  }
  await page.keyboard.press('Escape')
  await expect.poll(() => dialog.isVisible()).toBe(false)
  expect(await action.evaluate(element => element === document.activeElement)).toBe(true)
  credits.push(...Array.from({ length: 20 }, (_, index) => ({
    id: `credit-extra-${index}`, reset_type: 'codex_rate_limits', status: 'available', expires_at: '2030-11-01T00:00:00Z', title: 'Full reset (Weekly + 5 hr)',
  })))
  await action.click()
  const resetButtons = dialog.getByRole('button', { name: /Use reset —/ })
  await expect.poll(() => resetButtons.count()).toBe(22)
  await resetButtons.last().scrollIntoViewIfNeeded()
  await expect.poll(async () => {
    const button = await resetButtons.last().boundingBox()
    return button !== null && button.y >= 0 && button.y + button.height <= 640
  }).toBe(true)
  expect(await dialog.getByRole('button', { name: 'Close', exact: true }).isVisible()).toBe(true)
  await dialog.screenshot({ path: fileURLToPath(new URL('../../../.artifacts/banked-resets-narrow.png', import.meta.url)) })
  const platformMarkers = await page.evaluate(() => ({
    platform: document.documentElement.getAttribute('data-platform'),
    titlebar: document.documentElement.hasAttribute('data-windows-titlebar'),
    titlebarHeight: document.documentElement.style.getPropertyValue('--dsh-windows-titlebar-height'),
  }))
  try {
    for (const platform of ['darwin', 'win32']) {
      await page.evaluate((value) => {
        const root = document.documentElement
        root.setAttribute('data-platform', value)
        root.toggleAttribute('data-windows-titlebar', value === 'win32')
        root.style.setProperty('--dsh-windows-titlebar-height', '36px')
      }, platform)
      await expect.poll(() => dialog.evaluate((element) => {
        const parent = element.parentElement
        if (parent === null) throw new Error('dialog lost its Modal layer')
        const inset = Number.parseFloat(getComputedStyle(parent).paddingTop)
        const rect = element.getBoundingClientRect()
        return rect.top >= inset && rect.bottom <= innerHeight - inset && element.scrollWidth <= element.clientWidth
      })).toBe(true)
      await resetButtons.last().scrollIntoViewIfNeeded()
      const last = await resetButtons.last().boundingBox()
      expect(last).not.toBeNull()
      expect(last!.y + last!.height).toBeLessThanOrEqual(640)
    }
  } finally {
    await page.evaluate((saved) => {
      const root = document.documentElement
      if (saved.platform === null) root.removeAttribute('data-platform')
      else root.setAttribute('data-platform', saved.platform)
      root.toggleAttribute('data-windows-titlebar', saved.titlebar)
      if (saved.titlebarHeight === '') root.style.removeProperty('--dsh-windows-titlebar-height')
      else root.style.setProperty('--dsh-windows-titlebar-height', saved.titlebarHeight)
    }, platformMarkers)
  }
  const closeAccounts = async (): Promise<void> => {
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: 'Accounts', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
  }
  const reopenChooser = async (): Promise<void> => {
    await page.getByRole('button', { name: /Reset Fixture/ }).click()
    await page.getByRole('menuitem', { name: /Reset Fixture/ }).click()
    await action.click()
    await resetButtons.nth(1).waitFor()
  }
  await resetButtons.nth(1).click()
  await page.getByRole('alert').filter({ hasText: 'Could not use this reset. Try again.' }).waitFor()
  await expect.poll(() => redemptions.length).toBe(1)
  expect(redemptions[0]?.credit_id).toBe('credit-chosen')
  await resetButtons.nth(0).click()
  await expect.poll(() => redemptions.length).toBe(2)
  expect(redemptions[1]?.credit_id).toBe('credit-earlier')
  expect(redemptions[1]?.redeem_request_id).not.toBe(redemptions[0]?.redeem_request_id)
  await closeAccounts()
  await reopenChooser()
  await resetButtons.nth(1).click()
  await expect.poll(() => redemptions.length).toBe(3)
  expect(redemptions[2]).toEqual(redemptions[0])
  expect(redemptions[2]?.redeem_request_id.length).toBeGreaterThan(0)
  await closeAccounts()
  expect(redemptionSignal?.aborted).toBe(false)
  await reopenChooser()
  await resetButtons.nth(1).click()
  await dialog.getByRole('button', { name: /Use reset —/ }).filter({ hasText: 'Using reset…' }).waitFor()
  await closeAccounts()
  expect(redemptionSignal?.aborted).toBe(false)
  redemptionGate.resolve(undefined)
  await page.getByRole('alert').filter({ hasText: 'Usage limits reset.' }).waitFor()
  expect(redemptions).toHaveLength(3)
  expect(await dialog.isVisible()).toBe(false)
  expect(await page.getByRole('dialog', { name: 'Accounts', exact: true }).isVisible()).toBe(false)
  await page.getByRole('button', { name: /Reset Fixture/ }).click()
  await page.getByRole('menuitem', { name: /Reset Fixture/ }).click()
  await action.click()
  await expect.poll(() => dialog.getByRole('button', { name: /Use reset —/ }).count()).toBe(21)
  expect(credits.some(credit => credit.id === 'credit-earlier')).toBe(true)
  await page.mouse.click(4, 200)
  await expect.poll(() => dialog.isVisible()).toBe(false)
  expect(await page.getByRole('dialog', { name: 'Accounts', exact: true }).isVisible()).toBe(true)
  expect(consoleWatch.pageErrors).toEqual([])
  expect(consoleWatch.warnings).toEqual([])
})
