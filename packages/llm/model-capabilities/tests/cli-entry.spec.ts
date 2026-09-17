/**
 * The command's `apply` contract, exercised against a real launcher shape.
 *
 * This file mounts the plugin module itself rather than driving the operation
 * directly, so the outcome only `apply` owns is observed here: an invocation
 * that asked for no command still lets the app boot.
 */

import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createPublicCatalogStore } from '@deepseek-ai/dsh-model-capabilities'
import { MODEL_CAPABILITY_STORE_SERVICE } from '../src/plugin.ts'

/** A minimal deployment, so a mount reaches the command's own decisions. */
function prepare(ctx: Context): void {
  ctx.provide('settings', {
    get: (ns: string) => (ns === 'model-capabilities'
      ? { publicMetadata: { enabled: true, refresh: 'manual', cacheTtl: '7d' } }
      : { providers: {} }),
    update: () => Promise.resolve(),
  })
  ctx.provide(MODEL_CAPABILITY_STORE_SERVICE, createPublicCatalogStore({
    policy: () => ({ enabled: true, refresh: 'manual', cacheTtlMs: 1000 }),
    fetchCatalog: () => Promise.reject(new Error('no fetch may happen')),
    cache: { read: () => Promise.resolve([]), write: () => Promise.resolve() },
  }))
}

describe('the command plugin entry point', () => {
  beforeEach(() => { vi.resetModules() })

  it('reports a launcher that provides no bounded exit, and runs nothing', async () => {
    const plugin = await import('../src/cli.ts')
    const ctx = new Context()
    prepare(ctx)
    let stderr = ''
    // The launcher handed the app a command line without a way to answer with a
    // code, which is the one case the command declines to run in.
    const originalErr = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk: string) => { stderr += chunk; return true }
    try {
      expect(plugin.boundedExit(ctx, { modelsSync: ['check'] })).toBeUndefined()
    } finally {
      process.stderr.write = originalErr
    }
    expect(stderr).toContain('provides no bounded exit')
    await ctx.fiber.dispose()
  })

  it('runs no command and reports nothing when the invocation asked for nothing', async () => {
    const plugin = await import('../src/cli.ts')
    const ctx = new Context()
    prepare(ctx)
    const exits: number[] = []
    let stdout = ''
    const originalOut = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string) => { stdout += chunk; return true }
    let state: number
    try {
      provideCmdline(ctx, { args: [], exit: (code: number) => { exits.push(code) } })
      const fiber = await ctx.plugin(plugin)
      state = fiber.state
      await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    } finally {
      process.stdout.write = originalOut
    }
    // No flag asked for a command: the plugin mounts and lets the app boot,
    // answering neither a report nor an exit code of its own.
    expect(state).toBe(2)
    expect(exits).toEqual([])
    expect(stdout).toBe('')
    await ctx.fiber.dispose()
  })
})
