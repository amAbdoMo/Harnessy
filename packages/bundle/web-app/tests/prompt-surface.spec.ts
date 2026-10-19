/**
 * The Web surface and harness-source prompt sections: their texts carry no
 * process-specific value, their runtime contexts carry the current values, and
 * a Session that already admitted a value-bearing paragraph keeps it verbatim.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { registerSurfacePromptSections } from '../src/prompt-surface.ts'

const SOURCE_ROOT = '/opt/harness-src'
const WEB_URL = 'http://127.0.0.1:4567'

const LEGACY_SOURCE_PARAGRAPH = `The DeepSeek Harness implementation checkout is at ${SOURCE_ROOT}. `
  + 'The checkout location and current working directory are separate values and may differ; '
  + 'never infer the working directory from this path. Use pwd to determine the current working directory. '
  + 'Use this checkout only to inspect or extend DSH itself.'

const LEGACY_WEB_PARAGRAPH = 'You are interacting with the user through the DeepSeek Harness Web GUI at '
  + `${WEB_URL}. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. `
  + 'The browser provides no implicit DOM, route, or screenshot context. '
  + 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
  + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
  + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  + 'Starting another server does not update this GUI. '
  + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
  + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'

async function fixture(): Promise<{
  ctx: Context
  agent: Awaited<ReturnType<Awaited<ReturnType<typeof mountAgentLoopTestHarness>>['create']>>
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeRuntimeContext: true } })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('surface-prompt'), {}, { cwd: '/tmp' })
  return { ctx, agent, dispose: async () => { await ctx.fiber.dispose() } }
}

describe('Web surface prompt sections', () => {
  it('keeps the process-specific values out of the sections and in the runtime contexts', async () => {
    const f = await fixture()
    try {
      registerSurfacePromptSections(f.ctx, { sourceRoot: SOURCE_ROOT, webUrl: () => WEB_URL })
      const assembly = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
      const source = assembly.sections.find(entry => entry.name === 'harness:source')
      const surface = assembly.sections.find(entry => entry.name === 'app:web-surface')
      expect(source?.text).not.toContain(SOURCE_ROOT)
      expect(surface?.text).not.toContain(WEB_URL)
      expect(assembly.contexts.find(entry => entry.name === 'harness:source')?.text)
        .toBe(`Current DeepSeek Harness implementation checkout: "${SOURCE_ROOT}".`)
      expect(assembly.contexts.find(entry => entry.name === 'app:web-surface')?.text)
        .toBe(`Current DeepSeek Harness Web GUI URL: "${WEB_URL}".`)
    } finally {
      await f.dispose()
    }
  })

  it('keeps the value-bearing paragraph a session admitted, so its request prefix does not change', async () => {
    const f = await fixture()
    try {
      registerSurfacePromptSections(f.ctx, { sourceRoot: SOURCE_ROOT, webUrl: () => WEB_URL })
      f.agent.session.append('system/message', {
        turn: 1,
        step: 1,
        message: createSystemMessage(`${LEGACY_SOURCE_PARAGRAPH}\n${LEGACY_WEB_PARAGRAPH}`),
      }, { surfaceOp: 'append' })
      const assembly = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
      expect(assembly.sections.find(entry => entry.name === 'harness:source')?.text)
        .toBe(LEGACY_SOURCE_PARAGRAPH)
      expect(assembly.sections.find(entry => entry.name === 'app:web-surface')?.text)
        .toBe(LEGACY_WEB_PARAGRAPH)
    } finally {
      await f.dispose()
    }
  })

  it('falls back to the value-free text for a session that admitted a prompt without those paragraphs', async () => {
    const f = await fixture()
    try {
      registerSurfacePromptSections(f.ctx, { sourceRoot: SOURCE_ROOT, webUrl: () => WEB_URL })
      f.agent.session.append('system/message', {
        turn: 1,
        step: 1,
        message: createSystemMessage('An ordinary prompt.'),
      }, { surfaceOp: 'append' })
      const assembly = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
      expect(assembly.sections.find(entry => entry.name === 'harness:source')?.text)
        .toContain('The runtime context names the DeepSeek Harness implementation checkout.')
      expect(assembly.sections.find(entry => entry.name === 'app:web-surface')?.text)
        .toContain('whose URL the runtime context names')
    } finally {
      await f.dispose()
    }
  })

  it('carries the two values in the runtime-context snapshot the session logs', async () => {
    const f = await fixture()
    try {
      registerSurfacePromptSections(f.ctx, { sourceRoot: SOURCE_ROOT, webUrl: () => WEB_URL })
      const assembly = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
      // The logged runtime-context message is this snapshot, so the two values
      // reach the model per request and the request prefix stays stable.
      expect(renderContextSnapshot(assembly)).toBe(
        'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n'
        + 'Current DeepSeek Harness implementation checkout: "/opt/harness-src".\n\n'
        + 'Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:4567".',
      )
    } finally {
      await f.dispose()
    }
  })

  it('removes every registration when disposed', async () => {
    const f = await fixture()
    try {
      const dispose = registerSurfacePromptSections(f.ctx, { sourceRoot: SOURCE_ROOT, webUrl: () => WEB_URL })
      dispose()
      const assembly = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
      expect(assembly.sections.some(entry => entry.name === 'harness:source')).toBe(false)
      expect(assembly.sections.some(entry => entry.name === 'app:web-surface')).toBe(false)
      expect(assembly.contexts.some(entry => entry.name === 'harness:source')).toBe(false)
      expect(assembly.contexts.some(entry => entry.name === 'app:web-surface')).toBe(false)
    } finally {
      await f.dispose()
    }
  })
})
