/** Replay a Super Agent worker through the shipped Web composition and render its actual Harnessy panel. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const directory = fileURLToPath(new URL('../../../snapshots/web/superagent-worker', import.meta.url))
const fixture = join(directory, 'session.v4.jsonl')

describe.skipIf(process.platform !== 'win32')('Harnessy Super Agent worker and panel', () => {
  let scaffold: WebScaffold
  let handle: AgentHandle
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      replayFixture: fixture,
      compareReplaySession: true,
      extraOverlayPath: [
        fileURLToPath(new URL('../../../packages/bundle/custom-harness/cordis.patch.yml', import.meta.url)),
        fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      ],
      extraInstallAnchors: [fileURLToPath(new URL('../../../packages/bundle/custom-harness/package.json', import.meta.url))],
      profile: { packages: [{ dir: fileURLToPath(new URL('../../../vendor/superagent', import.meta.url)), enabled: true }] },
    })
    handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('superagent-worker-smoke'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'dsh-superagent-worker' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'dsh-superagent-worker').then(() => undefined),
    })
    const task = fixtureUserPrompts(await readFile(fixture, 'utf8'))[0]
    if (task === undefined) throw new Error('The Super Agent replay has no user task')
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await handle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length) throw new AggregateError(failures, 'Super Agent replay cleanup failed')
    await assertFixtureInventory(directory, ['session.v4.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json', 'ui.expected.md'])
  })

  it('persists a recorded worker turn with PowerShell and its restricted preset tools', () => {
    const header = handle.agent.session.requestHeader()
    expect(header?.tools?.map(tool => tool.name)).toContain('pwsh')
    expect(header?.tools?.map(tool => tool.name)).not.toContain('bash')
    expect(header?.tools?.map(tool => tool.name)).not.toContain('plugin_manager')
    const reply = handle.agent.session.deriveMessages().findLast(message => message.role === 'assistant')
    expect(reply?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')).toBe('PONG')
  })

  it('opens the real panel and its setup controls without a configured GitHub source', async () => {
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Super Agent', exact: true }).click()
    await page.getByRole('heading', { name: 'Super Agent', exact: true }).waitFor()
    const state = await scaffold.hostFetch('/orchestrator/api/state', { headers: { 'x-orchestrator-request': '1' } })
    expect(state.status).toBe(200)
    const denied = await scaffold.hostFetch('/orchestrator/api/state')
    expect(denied.status).toBe(403)
    const aria = await captureStableAria(page, '.dt-page', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(directory, 'ui.expected.md'), aria, webSnapshotMode())
    const artifacts = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
    await mkdir(artifacts, { recursive: true })
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.screenshot({ path: join(artifacts, `superagent-${colorScheme}.png`) })
    }
    expect(tripwire.pageErrors).toEqual([])
  })
})
