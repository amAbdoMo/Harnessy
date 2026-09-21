// @vitest-environment jsdom
/**
 * Packaged-loader regression: the Subagents client entry boots through the
 * vendored Loader the way the assembled browser boots it — the real plugin
 * module behind `@deepseek-ai/dsh-client-ui-settings-subagents`, over a Remote
 * carrier whose namespace reads resolve through the context exactly as the
 * generated Gateway client resolves them. The composition is exercised with
 * the optional Command Code namespace mounted and without it.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import * as subagentsPlugin from '../src/client/index.ts'
import { COMMAND_CODE_BACKEND } from '../src/client/contract.ts'
import type { SubagentsOperations } from '../src/client/SubagentsSection.tsx'

afterEach(() => { vi.unstubAllEnvs() })

const PACKAGE = '@deepseek-ai/dsh-client-ui-settings-subagents'
const HOLE = 'settings.section'
const HARNESSY_PROFILE = 'custom-harness'

/**
 * The assembled Gateway carrier: a service whose namespace reads resolve
 * through the context (`ctx.remote.<namespace>`), so a namespace read the
 * reading fiber never injected is refused by name.
 */
class RemoteCarrier extends Service {}

/** One `settings.section` registration's parameters, as the slot registry stores them. */
interface RegisteredPage {
  readonly id: string | undefined
  readonly inject: (bound: unknown) => { readonly operations: SubagentsOperations }
}

/** The reads each composed Remote namespace answers. */
type ComposedNamespaces = Record<string, Record<string, unknown>>

/** Let every scope this composition starts settle before a test reads it. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * Compose the Gateway: one carrier service plus the namespaces it mounts.
 *
 * Every namespace lives in the Gateway's own scope, never the root's, which is
 * what makes an undeclared read of one fail here the way the shipped boot
 * failed with `cannot get property "remote.commandcode" without inject`.
 * @param ctx - client root context to mount into.
 * @param namespaces - namespace name → the reads it answers, per composition.
 */
function mountGateway(ctx: Context, namespaces: ComposedNamespaces): void {
  ctx.plugin({
    apply: (scope: Context) => {
      new RemoteCarrier(scope, 'remote')
      for (const [namespace, reads] of Object.entries(namespaces)) {
        scope.provide(`remote.${namespace}`, reads as never)
      }
    },
  })
}

/**
 * Boot the Subagents client entry through the Loader with the services the
 * assembled client composes, optionally including the Command Code namespace.
 * @param namespaces - Remote namespaces mounted beside the roster and session.
 * @returns the booted context, the created entry, and the slot registry.
 */
async function boot(namespaces: ComposedNamespaces) {
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.internal = {
    version: 'client',
    async import(specifier: string) {
      if (specifier !== PACKAGE) throw new Error(`unexpected Loader import: ${specifier}`)
      return subagentsPlugin
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots')
  if (slots === undefined) throw new Error('the slot registry did not mount')
  slots.register({
    name: 'root',
    children: { [HOLE]: { kind: 'list', scope: 'root' } },
  } as never, () => null)

  const storedRoster = async () => ({
    ok: true, value: { subagents: [], limits: { maxConcurrentRuns: 2, defaultTimeoutMs: 3_600_000 } },
  })
  const modelCatalog = async () => ({
    ok: true, value: { default: { provider: 'p', model: 'm' }, routableProviders: [], groups: [], failures: [] },
  })
  const resolvedRoster = async () => ({ ok: true, value: { workspaceKey: null, subagents: [] } })
  const automaticRouting = async () => ({ ok: true, value: { enabled: false, allowedModels: [] } })
  mountGateway(ctx, {
    subagentRoster: { storedRoster, resolvedRoster, automaticRouting },
    session: { modelCatalog },
    ...namespaces,
  })
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

  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', HARNESSY_PROFILE)
  const id = await ctx.loader.create({ name: PACKAGE })
  await ctx.loader.await()
  await settle()
  return { ctx, entry: ctx.loader.resolve(id), slots }
}

/** The single page the composition registered, in the shape the registry stores. */
function page(slots: NonNullable<Context['slots']>): RegisteredPage {
  const [registered] = slots.entries(HOLE)
  if (registered === undefined) throw new Error('no settings page was registered')
  return {
    id: registered.options.id,
    inject: registered.inject as unknown as RegisteredPage['inject'],
  }
}

describe('Subagents client entry through the packaged loader', () => {
  it('activates with the optional Command Code namespace mounted', async () => {
    const health = vi.fn(async () => ({ ok: true, value: { command: 'cmdc', installed: true, authenticated: true } }))
    const catalog = vi.fn(async () => ({ ok: true, value: { models: [{ id: 'local-model', description: 'local' }] } }))
    const { ctx, entry, slots } = await boot({ commandcode: { health, catalog } })

    expect(entry.fiber).toBeDefined()
    const registered = page(slots)
    expect(registered.id).toBe('subagents')

    const { operations } = registered.inject({ sync: () => {} })
    expect(operations.backendProbe?.backend).toBe(COMMAND_CODE_BACKEND)
    await expect(operations.backendProbe?.health(new AbortController().signal))
      .resolves.toEqual({ command: 'cmdc', installed: true, authenticated: true })
    await ctx.fiber.dispose()
  })

  it('still activates without the Command Code namespace', async () => {
    const { ctx, entry, slots } = await boot({})

    expect(entry.fiber).toBeDefined()
    const { operations } = page(slots).inject({ sync: () => {} })
    // The page is mounted and functional; only backend-specific state is absent.
    expect(operations.backendProbe).toBeUndefined()
    await expect(operations.storedRoster(new AbortController().signal)).resolves.toBeTruthy()
    await ctx.fiber.dispose()
  })

  it('refuses an entry that reads the namespace without injecting it', async () => {
    // The harness's own teeth: the entry shape that used to ship fails with the
    // packaged message, so the two cases above pin the fix rather than the
    // absence of a carrier.
    const ctx = new Context()
    await ctx.plugin(Loader)
    const reader = {
      name: 'namespaced-reader',
      apply: (scope: Context) => {
        const reads = (scope.remote as unknown as { commandcode: unknown }).commandcode
        if (reads === undefined) return
      },
    }
    ctx.loader.internal = {
      version: 'client',
      async import(specifier: string) {
        if (specifier !== 'namespaced-reader') throw new Error(`unexpected Loader import: ${specifier}`)
        return { inject: ['remote'], ...reader }
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    mountGateway(ctx, { commandcode: { health: async () => ({}) } })

    const failure = ctx.loader.create({ name: 'namespaced-reader' })
    await expect(failure).rejects.toThrow('cannot get property "remote.commandcode" without inject')
    await expect(failure).rejects.toThrow(/failed to apply loader entry \S+ \(namespaced-reader\)/)
    await ctx.fiber.dispose()
  })
})
