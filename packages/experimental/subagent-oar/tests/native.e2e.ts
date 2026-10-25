/** Opt-in installed-agent tests using the machine's configured native authentication. */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { externalTestParent } from './fixtures/test-parent.ts'
import * as oar from '../src/index.ts'

it.skipIf(process.env.DSH_OAR_E2E !== '1').for(['codex', 'claude'])(
  'delegates a file task to installed %s through the registered OAR provider',
  { timeout: 180_000, retry: 0 },
  async (runtime, test) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-oar-live-${runtime}-`))
    const ctx = new Context()
    test.onTestFinished(async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })
    const nonce = `${randomUUID()}\n`
    await writeFile(join(root, 'input.txt'), nonce)
    const parent = await externalTestParent(ctx, root)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(oar, {
      runtime,
      providerName: 'oar-live',
      timeoutMs: 120_000,
      launchArgs: runtime === 'claude'
        ? ['--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--no-session-persistence']
        : ['-c', 'sandbox_mode="workspace-write"'],
    })
    const run = await ctx.subagents.start('oar-live', {
      parent,
      signal: test.signal,
      prompt: [{ type: 'text', text: 'Read input.txt and create output.txt with exactly the same bytes. Only change output.txt. Do not use git or install software. Reply OAR_NATIVE_OK when finished.' }],
    })
    const result = await run.result
    await run.dispose()
    expect(result.stopReason, result.diagnostic).toBe('completed')
    expect(await readFile(join(root, 'output.txt'), 'utf8')).toBe(nonce)
    expect(await readFile(join(root, 'input.txt'), 'utf8')).toBe(nonce)
    expect(result.output.filter(block => block.type === 'text').map(block => block.text).join('')).toContain('OAR_NATIVE_OK')
  },
)
