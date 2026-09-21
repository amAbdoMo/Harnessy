// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { COMMAND_CODE_BACKEND } from '../src/client/contract.ts'
import type { SubagentsOperations } from '../src/client/SubagentsSection.tsx'

afterEach(() => { vi.unstubAllEnvs() })

const HOLE = 'settings.section'
const HARNESSY_PROFILE = 'custom-harness'

/**
 * The packaged Remote carrier: a service whose namespace reads resolve through
 * the context (`ctx.remote.<namespace>`), so an undeclared namespace read
 * throws exactly as it does behind the real Gateway client.
 */
class RemoteCarrier extends Service {}

/** One `settings.section` registration's parameters. */
interface RegisteredPage {
  readonly inject: (bound: unknown) => { readonly operations: SubagentsOperations }
}

/** Let every scope this composition starts settle before a test reads it. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * A client root carrying the services the page injects, optionally with the
 * Command Code Remote namespace mounted beside them.
 */
async function bench(commandcode?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots')
  if (slots === undefined) throw new Error('the slot registry did not mount')
  slots.register({
    name: 'root',
    children: { [HOLE]: { kind: 'list', scope: 'root' } },
  } as never, () => null)

  const storedRoster = vi.fn(async () => ({
    ok: true, value: { subagents: [], limits: { maxConcurrentRuns: 2, defaultTimeoutMs: 3_600_000 } },
  }))
  const resolvedRoster = vi.fn(async () => ({ ok: true, value: { workspaceKey: null, subagents: [] } }))
  const automaticRouting = vi.fn(async () => ({ ok: true, value: { enabled: false, allowedModels: [] } }))
  const modelCatalog = vi.fn(async () => ({
    ok: true, value: { default: { provider: 'p', model: 'm' }, routableProviders: [], groups: [], failures: [] },
  }))

  new RemoteCarrier(ctx, 'remote')
  ctx.provide('remote.subagentRoster', { storedRoster, resolvedRoster, automaticRouting } as never)
  ctx.provide('remote.session', { modelCatalog } as never)
  if (commandcode !== undefined) ctx.provide('remote.commandcode', commandcode as never)
  ctx.provide('locale', {
    register: () => () => {},
    bind: (namespace: string) => (key: string) => `${namespace}.${key}`,
  } as never)
  ctx.provide('settingsScope', {
    bind: () => ({
      getSnapshot: () => ({ status: 'ready', writable: true, revision: 3, value: undefined }),
      subscribe: () => () => {},
      mutate: async () => {},
    }),
  } as never)

  const register = vi.spyOn(slots, 'register')
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', HARNESSY_PROFILE)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  await settle()
  const call = register.mock.calls.find(([params]) => (params as { name?: string }).name === HOLE)
  if (call === undefined) throw new Error('no settings page was registered')
  return { operations: (call[0] as unknown as RegisteredPage).inject({ sync: () => {} }).operations, fiber }
}

describe('Subagents backend probe composition', () => {
  it('composes no probe without the Command Code Remote namespace', async () => {
    const { operations } = await bench()
    // The page mounts in a build without that namespace, so the probe is absent
    // rather than required, and nothing else it reads changed.
    expect(operations.backendProbe).toBeUndefined()
    await expect(operations.storedRoster(new AbortController().signal)).resolves.toBeTruthy()
  })

  it('answers for the Command Code backend through its own Remote namespace', async () => {
    const health = vi.fn(async () => ({ ok: true, value: { command: 'cmdc', installed: true, authenticated: true } }))
    const catalog = vi.fn(async () => ({ ok: true, value: { models: [{ id: 'local-model', description: 'local' }] } }))
    const { operations } = await bench({ health, catalog })

    expect(operations.backendProbe?.backend).toBe(COMMAND_CODE_BACKEND)
    const signal = new AbortController().signal
    await expect(operations.backendProbe?.health(signal))
      .resolves.toEqual({ command: 'cmdc', installed: true, authenticated: true })
    expect(health).toHaveBeenCalledWith(signal)
    await expect(operations.backendProbe?.catalog(signal))
      .resolves.toEqual({ models: [{ id: 'local-model', description: 'local' }] })
    expect(catalog).toHaveBeenCalledWith(signal)
  })

  it('reports a refused backend read as a failure instead of a value', async () => {
    const { operations } = await bench({
      health: async () => ({ ok: false, error: { message: 'probe unavailable' } }),
      catalog: async () => ({ ok: false, error: { message: 'catalog unavailable' } }),
    })

    await expect(operations.backendProbe?.health(new AbortController().signal))
      .rejects.toThrow('probe unavailable')
    await expect(operations.backendProbe?.catalog(new AbortController().signal))
      .rejects.toThrow('catalog unavailable')
  })

  it('drops the probe when the page leaves with its backend namespace', async () => {
    const health = async () => ({ ok: true, value: { command: 'cmdc', installed: true, authenticated: true } })
    const catalog = async () => ({ ok: true, value: { models: [] } })
    const { operations, fiber } = await bench({ health, catalog })
    expect(operations.backendProbe).toBeDefined()

    await fiber.dispose()
    expect(operations.backendProbe).toBeUndefined()
  })
})
