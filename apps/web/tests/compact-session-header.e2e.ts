/** Built Harnessy header geometry and dropdowns, using a recorded conversation and authored work. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-schedule'
import {
  compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const CUSTOM_OVERLAY = fileURLToPath(new URL('../../../packages/bundle/custom-harness/cordis.patch.yml', import.meta.url))
const CUSTOM_MANIFEST = fileURLToPath(new URL('../../../packages/bundle/custom-harness/package.json', import.meta.url))
const HEADER_OVERLAY = fileURLToPath(new URL('./compact-session-header.overlay.yml', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/compact-session-header/header.expected.md', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
const SESSION = SessionId('compact-header-fixture')

function header(page: Page) {
  return page.locator('header').filter({ has: page.getByRole('navigation', { name: 'Session hierarchy' }) })
}

describe('Harnessy compact session header', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const settle: Array<(value: JobOutcome) => void> = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: [CUSTOM_OVERLAY, HEADER_OVERLAY], extraInstallAnchors: [CUSTOM_MANIFEST] })
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SESSION)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.setViewportSize({ width: 1280, height: 900 })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const group = page.getByRole('treeitem').first()
    await group.waitFor({ timeout: 30_000 })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await page.getByRole('treeitem').nth(1).click()
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 30_000 })
    const agent = scaffold.ctx.agents.get(SESSION)
    if (agent === undefined) throw new Error('opened recorded session has no live Agent')
    for (let index = 0; index < 6; index += 1) {
      agent.session.append('subagent/catalog', {
        version: 0, childId: SessionId(`compact-child-${index}`), childCreatedAt: index + 1,
        mode: 'one-shot', label: `Header worker ${index + 1}`,
      })
    }
    for (let index = 0; index < 10; index += 1) {
      const { promise: done, resolve: complete } = Promise.withResolvers<JobOutcome>()
      settle.push(complete)
      scaffold.ctx.jobs.start({
        kind: 'bash', owner: SESSION, label: `Header job ${index + 1}`,
        run: () => ({ done, cancel: () => { complete({ status: 'killed' }) } }),
      })
    }
    await page.getByRole('button', { name: '0 working, 6 done', exact: true }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '10 background jobs running', exact: true }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    for (const complete of settle) complete({ status: 'completed' })
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('removes only the brief button and retains the normal command and result card', async () => {
    onTestFailed(() => saveFailureShot(page, 'compact-header-brief'))
    expect(await header(page).getByRole('button', { name: /create workspace brief/i }).count()).toBe(0)
    const agent = scaffold.ctx.agents.get(SESSION)
    if (agent === undefined) throw new Error('opened Agent disappeared')
    expect(scaffold.ctx.commands.list(agent).some(command => command.name === 'workspace-brief')).toBe(true)
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, '/workspace-brief')
    const suggestions = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await suggestions.waitFor()
    await input.press('Escape')
    await expect.poll(() => suggestions.count()).toBe(0)
    await input.press('Enter')
    const card = page.getByRole('article', { name: 'Workspace Brief' })
    await card.waitFor({ timeout: 15_000 })
    await expect.poll(() => card.getAttribute('data-state')).toBe('error')
    expect(await card.innerText()).toContain('this session is not attached to a registered workspace')
    expect(await page.getByRole('button', { name: '0 working, 6 done', exact: true }).innerText()).toBe('6 done')
    expect(await page.getByRole('button', { name: '10 background jobs running', exact: true }).innerText()).toBe('10')
    await expect.poll(() => header(page).getByRole('group', { name: 'Session controls', exact: true }).getByRole('button').count()).toBe(0)
    await compareOrRefreshGolden(EXPECTED, await header(page).ariaSnapshot(), webSnapshotMode())
    await page.setViewportSize({ width: 320, height: 900 })
    await expect.poll(() => page.getByRole('button', { name: 'More session controls', exact: true }).isVisible()).toBe(false)
  }, 30_000)

  it('fits narrow panes on one row and keeps both detail dropdowns and secondary controls usable', async () => {
    onTestFailed(() => saveFailureShot(page, 'compact-header-narrow'))
    for (let index = 1; index <= 2; index += 1) {
      await scaffold.ctx.schedule.create(SESSION, {
        prompt: 'Header fixture; do not run during this scenario.', title: `Header reminder ${index}`,
        after_seconds: 86_400,
      })
    }
    for (const width of [820, 560, 400, 320]) {
      await page.setViewportSize({ width, height: 900 })
      const agents = page.getByRole('button', { name: '0 working, 6 done', exact: true })
      const jobs = page.getByRole('button', { name: '10 background jobs running', exact: true })
      await expect.poll(async () => {
        const rowWidth = await header(page).getByRole('navigation', { name: 'Session hierarchy' })
          .evaluate(element => element.parentElement!.parentElement!.getBoundingClientRect().width)
        return await agents.innerText() === (rowWidth <= 560 ? '6' : '6 done')
      }).toBe(true)
      await expect.poll(async () => header(page).evaluate((element) => {
        const buttons = [...element.querySelectorAll<HTMLButtonElement>('button')]
          .filter(button => button.getClientRects().length > 0 && button.closest('[role="tablist"]') === null)
        const boxes = buttons.map(button => button.getBoundingClientRect())
        const bounds = element.getBoundingClientRect()
        return boxes.every(box => box.left >= bounds.left - 1 && box.right <= bounds.right + 1)
          && boxes.every(box => Math.abs(box.top + box.height / 2 - (boxes[0]!.top + boxes[0]!.height / 2)) <= 2)
      })).toBe(true)
      expect(await jobs.innerText()).toBe('10')
    }
    await mkdir(ARTIFACTS, { recursive: true })
    await header(page).screenshot({ path: join(ARTIFACTS, 'compact-header-320.png') })
    const more = page.getByRole('button', { name: 'More session controls', exact: true })
    await more.click()
    const controls = page.getByRole('group', { name: 'Session controls', exact: true })
    expect(await controls.isVisible()).toBe(true)
    await controls.getByRole('button', { name: '2 reminders', exact: true }).click()
    const reminders = page.getByRole('list', { name: 'Active reminders', exact: true })
    await reminders.waitFor()
    await reminders.getByRole('button', { name: 'Delete reminder: Header reminder 1', exact: true }).click()
    await expect.poll(() => reminders.getByRole('button', { name: 'Delete reminder: Header reminder 1', exact: true }).count()).toBe(0)
    expect(await more.getAttribute('aria-expanded')).toBe('true')
    expect(await reminders.isVisible()).toBe(true)
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect.poll(() => more.isVisible()).toBe(false)
    expect(await reminders.isVisible()).toBe(true)
    await page.setViewportSize({ width: 320, height: 900 })
    await expect.poll(() => more.getAttribute('aria-expanded')).toBe('true')
    expect(await reminders.isVisible()).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => reminders.isVisible()).toBe(false)
    expect(await more.getAttribute('aria-expanded')).toBe('true')
    await page.keyboard.press('Escape')
    await expect.poll(() => more.getAttribute('aria-expanded')).toBe('false')
    expect(await more.evaluate(element => element === document.activeElement)).toBe(true)

    const jobs = page.getByRole('button', { name: '10 background jobs running', exact: true })
    await jobs.click()
    const list = page.getByRole('list', { name: 'Background jobs' })
    await list.waitFor()
    const jobBounds = await list.boundingBox()
    expect(jobBounds!.x).toBeGreaterThanOrEqual(0)
    expect(jobBounds!.x + jobBounds!.width).toBeLessThanOrEqual(320)
    await page.keyboard.press('Escape')
    const agents = page.getByRole('button', { name: '0 working, 6 done', exact: true })
    await agents.click()
    await page.getByRole('tree', { name: 'Subagent sessions' }).waitFor()
    await page.getByRole('treeitem', { name: /6 completed subagents/ }).click()
    await page.getByRole('treeitem', { name: /Header worker 1/ }).waitFor()
    await page.keyboard.press('Escape')
    await expect.poll(() => agents.getAttribute('aria-expanded')).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})
