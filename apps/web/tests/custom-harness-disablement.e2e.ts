// Harnessy product-composition coverage for the per-message feedback
// disablement. It exercises the real Host, authenticated HTTP gateway, built
// browser roster, and a cold-seeded session without mounting the omitted rows.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-api-settings-controller'
import type {} from '@deepseek-ai/dsh-agent-preset'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import {
  launchWebScaffold, seedSession, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const CUSTOM_OVERLAY = fileURLToPath(new URL(
  '../../../packages/bundle/custom-harness/cordis.patch.yml', import.meta.url,
))
const CUSTOM_BUNDLE_MANIFEST = fileURLToPath(new URL(
  '../../../packages/bundle/custom-harness/package.json', import.meta.url,
))
const OLD_SESSION = fileURLToPath(new URL(
  '../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url,
))
const OLD_SESSION_ID = 'custom-harness-disabled-feedback'

const customOptions = {
  extraOverlayPath: CUSTOM_OVERLAY,
  extraInstallAnchors: [CUSTOM_BUNDLE_MANIFEST],
}

/** Assert Host, Remote, and retained-neighbor composition facts. */
async function expectFeedbackDisabled(scaffold: WebScaffold): Promise<void> {
  expect(scaffold.ctx.get('messageFeedback')).toBeUndefined()

  for (const operation of ['list', 'put', 'delete'] as const) {
    const method = `messageFeedback/${operation}`
    const response = await scaffold.hostFetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `disabled-message-feedback-${operation}`,
        method,
        payload: { args: { request: { sessionId: OLD_SESSION_ID } } },
      }),
    })
    expect(response.status).toBe(404)
  }

  const handle = await scaffold.ctx.agents.create({
    sessionId: SessionId('custom-harness-disabled-feedback-tools'),
    setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx).then(() => undefined),
  })
  try {
    const toolNames = scaffold.ctx.tools.schemas(handle.agent).map(schema => schema.name)
    expect(toolNames).toContain('read')

    // Session-level /feedback is a separate retained command; the product
    // disables only per-message ratings and notes.
    expect(scaffold.ctx.commands.list(handle.agent)).toContainEqual({
      definitionId: '@deepseek-ai/dsh-command-feedback',
      name: 'feedback',
      description: 'Record feedback about this session',
      input: { hint: '<text>' },
    })
  } finally {
    await handle.dispose()
  }
}

/** Assert the product's OpenAI browser-login flow is live end to end. */
async function expectOpenAIAccountLogin(scaffold: WebScaffold): Promise<void> {
  const key = credentialKey('llm-pi-ai', 'openai-codex')
  expect(scaffold.ctx.get('authorization')?.describe(key)).toMatchObject({
    key,
    inFlight: false,
    methods: [{ id: 'oauth' }],
  })
  await expect(scaffold.ctx.openAIAccountController.describe()).resolves.toMatchObject({
    available: true,
    inFlight: false,
  })
}

/** Open the only cold-seeded session in the expanded workspace group. */
async function openOldSession(page: Page): Promise<void> {
  const groupRow = page.locator('[role="treeitem"]').first()
  await groupRow.waitFor({ timeout: 15_000 })
  if (await groupRow.getAttribute('aria-expanded') !== 'true') await groupRow.click()
  const sessionRow = page.locator('[role="treeitem"]').nth(1)
  await sessionRow.waitFor({ timeout: 15_000 })
  await sessionRow.click()
  await page.getByText('DONE', { exact: true }).waitFor({ timeout: 30_000 })
}

describe('Harnessy disables per-message feedback', () => {
  let first: WebScaffold
  let restarted: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    first = await launchWebScaffold(customOptions)
    await expectFeedbackDisabled(first)
    await expectOpenAIAccountLogin(first)
    await first.close()

    restarted = await launchWebScaffold(customOptions)
    await seedSession(restarted, await readFile(OLD_SESSION, 'utf8'), OLD_SESSION_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(restarted.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await restarted?.close()
  })

  it('keeps the Host and alternate invocation paths disabled after restart', async () => {
    await expectFeedbackDisabled(restarted)
    await expectOpenAIAccountLogin(restarted)
    const bootIds = await page.evaluate(() => {
      const boot = Reflect.get(window, '__DSH_BOOT__') as { entries?: Array<{ id?: string }> } | undefined
      return boot?.entries?.map(entry => entry.id) ?? []
    })
    expect(bootIds).not.toContain('@deepseek-ai/dsh-client-ui-message-feedback')
  })

  it('renders the Codex browser sign-in entry from the assembled product profile', async () => {
    await page.getByRole('button', { name: /No accounts saved/ }).click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.getByText('Models', { exact: true }).click()
    await page.getByRole('region', { name: 'AI account manager' }).waitFor()
    await page.getByRole('button', { name: 'Manage Accounts', exact: true }).click()
    const accounts = page.getByRole('dialog', { name: 'Accounts', exact: true })
    await accounts.getByRole('navigation', { name: 'Account providers' }).getByRole('button', { name: 'Codex', exact: true }).click()
    expect(await accounts.getByRole('button', { name: 'Add account', exact: true }).isEnabled()).toBe(true)
    await accounts.getByText('Add an account and finish sign-in in your browser.', { exact: true }).waitFor()
    await accounts.getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(() => accounts.isVisible()).toBe(false)
  })

  it('opens old sessions without feedback controls while retaining message actions', async () => {
    await openOldSession(page)
    expect(await page.getByRole('button', { name: 'Good response' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Bad response' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Add a note' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Copy' }).count()).toBeGreaterThan(0)
  })
})
