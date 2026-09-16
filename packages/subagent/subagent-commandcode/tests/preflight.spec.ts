import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SettingsFileProvider from '@deepseek-ai/dsh-settings-file'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { CommandCodeHealth } from '../src/types.ts'
import CommandCodeController from '../src/index.ts'
import { fakeChild, type FakeChild } from './fake-child.ts'

/** Wait until a condition holds, without racing the probe's own awaits. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
  throw new Error('the awaited condition never held')
}

interface Mounted {
  readonly controller: CommandCodeController
  /** The helper processes the probe started, in order. */
  readonly spawned: FakeChild[]
  readonly dispose: () => Promise<void>
}

/**
 * Mount the real Host services the controller injects, with only the spawned
 * managed process replaced: the probe's own argv, stream, and settlement
 * handling stay under test.
 */
async function mount(): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SettingsFileProvider, {
    path: join(mkdtempSync(join(tmpdir(), 'dsh-commandcode-preflight-')), 'settings.yaml'),
  })
  await ctx.plugin(CommandCodeController)

  const spawned: FakeChild[] = []
  // `ctx.get` reads the global service store; the `ctx.<name>` property proxy
  // is topology-sensitive and would not resolve a child-fiber registration.
  const subprocess = ctx.get('subprocess')
  const controller = ctx.get('commandCodeController')
  if (subprocess === undefined || controller === undefined) {
    throw new Error('the controller composition did not publish its services')
  }
  subprocess.spawn = (spec) => {
    const child = fakeChild(spec, {
      // `probeCommandCode` reads `--version` first, then `status`.
      stdoutTail: spec.argv.includes('--version') ? '1.54.0\n' : 'Authenticated as tester\n',
      settleOnTerminate: false,
    })
    spawned.push(child)
    return child.handle
  }

  return { controller, spawned, dispose: async () => { await ctx.fiber.dispose() } }
}

let mounted: Mounted | undefined
afterEach(async () => {
  await mounted?.dispose()
  mounted = undefined
})

describe('the shared Command Code probe', () => {
  it('lets joined callers share one probe without sharing cancellation authority', async () => {
    mounted = await mount()
    const leaving = new AbortController()
    const staying = new AbortController()

    const firstCaller = mounted.controller.health(leaving.signal)
    await waitFor(() => mounted!.spawned.length === 1)
    const secondCaller = mounted.controller.health(staying.signal)
    await Promise.resolve()
    // The second caller joined the in-flight probe instead of starting its own.
    expect(mounted.spawned).toHaveLength(1)

    // The first caller leaves; its cancellation must not become the probe's.
    leaving.abort(new Error('the first caller left'))
    await expect(firstCaller).rejects.toThrow(/the first caller left/u)

    mounted.spawned[0]!.exit()
    await waitFor(() => mounted!.spawned.length === 2)
    mounted.spawned[1]!.exit()

    await expect(secondCaller).resolves.toMatchObject({
      installed: true,
      authenticated: true,
      version: '1.54.0',
    } satisfies Partial<CommandCodeHealth>)
  })

  it('stops waiting for a joined caller that cancels, while the probe still finishes', async () => {
    mounted = await mount()
    const staying = new AbortController()
    const leaving = new AbortController()

    const firstCaller = mounted.controller.health(staying.signal)
    await waitFor(() => mounted!.spawned.length === 1)
    const secondCaller = mounted.controller.health(leaving.signal)
    await Promise.resolve()

    // The probe has not answered yet, so this rejection is the caller's own
    // cancellation being honoured rather than the probe's outcome.
    leaving.abort(new Error('the joined caller left'))
    await expect(secondCaller).rejects.toThrow(/the joined caller left/u)

    mounted.spawned[0]!.exit()
    await waitFor(() => mounted!.spawned.length === 2)
    mounted.spawned[1]!.exit()
    await expect(firstCaller).resolves.toMatchObject({ installed: true, authenticated: true })
  })

  it('rejects a caller that was already cancelled instead of starting a probe', async () => {
    mounted = await mount()
    const cancelled = new AbortController()
    cancelled.abort(new Error('already gone'))

    await expect(mounted.controller.health(cancelled.signal)).rejects.toThrow(/already gone/u)
    expect(mounted.spawned).toHaveLength(0)
  })

  it('reuses the probe for a later caller once the first one settles', async () => {
    mounted = await mount()
    const first = mounted.controller.health(new AbortController().signal)
    await waitFor(() => mounted!.spawned.length === 1)
    mounted.spawned[0]!.exit()
    await waitFor(() => mounted!.spawned.length === 2)
    mounted.spawned[1]!.exit()
    await expect(first).resolves.toMatchObject({ installed: true })

    const second = mounted.controller.health(new AbortController().signal)
    await waitFor(() => mounted!.spawned.length === 3)
    mounted.spawned[2]!.exit()
    await waitFor(() => mounted!.spawned.length === 4)
    mounted.spawned[3]!.exit()
    await expect(second).resolves.toMatchObject({ installed: true })
  })
})
