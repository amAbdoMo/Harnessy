/** Application decisions use the shared approval card through the shipped Web composition. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-computer-use'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

// Darwin's optional bundle prepares a real helper; this scenario exercises only the non-native composition.
it.skipIf(process.platform === 'darwin')('answers fixed application actions without launching a native provider', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('../../../packages/experimental/cua-bundle/cordis.patch.yml', import.meta.url)),
    extraInstallAnchors: [fileURLToPath(new URL('../../../packages/experimental/cua-bundle/package.json', import.meta.url))],
  })
  const browser = await chromium.launch()
  try {
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await expect.poll(() => scaffold.ctx.agents.list().length).toBe(1)
    const agent = scaffold.ctx.agents.list()[0]!
    for (const [button, selected] of [
      ['Allow for this session', 'Allow for this session'], ['Reject', 'Deny'], ['Always allow', 'Always allow'],
    ] as const) {
      const result = scaffold.ctx.userQuestions.ask({ agent, questions: [{
        id: 'cua-app-access', question: 'Allow access to the fixture application?',
        detail: 'This is a simulated application decision; no desktop access occurs.',
        options: [{ label: 'Allow for this session' }, { label: 'Deny' }, { label: 'Always allow' }],
        intent: { kind: 'approval', approve: 'Allow for this session', reject: 'Deny', always: 'Always allow',
          subject: { name: 'Fixture application' } },
      }] }).then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }))
      const card = page.locator('[data-approval-key]')
      await card.waitFor({ state: 'visible' })
      await card.getByRole('button', { name: button, exact: true }).click()
      expect(await result).toMatchObject({ ok: true, value: { answers: [{ id: 'cua-app-access', selected: [selected] }] } })
      await card.waitFor({ state: 'detached' })
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    if (process.platform !== 'darwin') expect(scaffold.ctx.get('computerUse')?.providerName).toBeUndefined()
  } finally {
    try { await browser.close() } finally { await scaffold.close() }
  }
}, 120_000)
