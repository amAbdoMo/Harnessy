// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { SUBAGENT_ROSTER_NAMESPACE } from '../src/client/contract.ts'
import type { SubagentsOperations } from '../src/client/SubagentsSection.tsx'

afterEach(() => { vi.unstubAllEnvs() })

const HOLE = 'settings.section'
const HARNESSY_PROFILE = 'custom-harness'

/** The parameters one `settings.section` registration carried. */
interface RegisteredPage {
  readonly id: string
  readonly order: number
  readonly locale: string
  readonly label: () => string
  readonly inject: (bound: unknown) => { readonly operations: SubagentsOperations }
}

/**
 * A client root carrying the services the page injects, with the real Slot
 * registry so the page registers into the hole the shipped catalog declares.
 */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots')
  if (slots === undefined) throw new Error('the slot registry did not mount')
  slots.register({
    name: 'root',
    children: { [HOLE]: { kind: 'list', scope: 'root' } },
  } as never, () => null)

  // The Remote namespaces answer with result envelopes, as the generated client
  // does; the page's operations unwrap `ok`/`value` themselves.
  const storedRoster = vi.fn(async () => ({
    ok: true, value: { subagents: [], limits: { maxConcurrentRuns: 2, defaultTimeoutMs: 3_600_000 } },
  }))
  const resolvedRoster = vi.fn(async (workspace: string | null) => ({
    ok: true, value: { workspaceKey: workspace, subagents: [] },
  }))
  const automaticRouting = vi.fn(async () => ({ ok: true, value: { enabled: false, allowedModels: [] } }))
  const modelCatalog = vi.fn(async () => ({
    ok: true, value: { default: { provider: 'p', model: 'm' }, routableProviders: [], groups: [], failures: [] },
  }))
  const subagentRoster = { storedRoster, resolvedRoster, automaticRouting }
  const session = { modelCatalog }
  const mutate = vi.fn(async () => {})
  const boundNamespaces: string[] = []
  const localeNamespaces = new Set<string>()

  ctx.provide('remote', { subagentRoster, session } as never)
  ctx.provide('remote.subagentRoster', subagentRoster as never)
  ctx.provide('remote.session', session as never)
  ctx.provide('locale', {
    register: (namespace: string) => {
      localeNamespaces.add(namespace)
      return () => { localeNamespaces.delete(namespace) }
    },
    bind: (namespace: string) => (key: string) => `${namespace}.${key}`,
  } as never)
  ctx.provide('settingsScope', {
    bind: (spec: { namespace: string }) => {
      boundNamespaces.push(spec.namespace)
      return {
        getSnapshot: () => ({ status: 'ready', writable: true, revision: 3, value: undefined }),
        subscribe: () => () => {},
        mutate,
      }
    },
  } as never)

  const register = vi.spyOn(slots, 'register')
  return {
    ctx, slots, register, storedRoster, resolvedRoster, automaticRouting, modelCatalog,
    mutate, boundNamespaces, localeNamespaces,
  }
}

/** Start the plugin in one build profile. */
async function activate(subject: Awaited<ReturnType<typeof bench>>, profile: string | undefined) {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', profile)
  const fiber = subject.ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return fiber
}

/** The single page this composition registered. */
function page(subject: Awaited<ReturnType<typeof bench>>): RegisteredPage {
  const call = subject.register.mock.calls.find(([params]) =>
    (params as { name?: string }).name === HOLE)
  if (call === undefined) throw new Error('no settings page was registered')
  return call[0] as unknown as RegisteredPage
}

describe('Harnessy Subagents client composition', () => {
  it('declares exactly the services the page reads', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'remote', 'remote.subagentRoster', 'remote.session', 'settingsScope',
    ])
  })

  it('registers one Subagents page in the Harnessy build profile', async () => {
    const subject = await bench()
    await activate(subject, HARNESSY_PROFILE)

    expect(subject.slots.entries(HOLE)).toHaveLength(1)
    const registered = page(subject)
    expect(registered.id).toBe('subagents')
    expect(registered.order).toBe(20)
    expect(registered.locale).toBe('settings.subagents')
    expect(registered.label()).toBe('settings.subagents.nav')
  })

  it('registers nothing outside the Harnessy build profile', async () => {
    for (const profile of ['official', 'local', undefined]) {
      const subject = await bench()
      await activate(subject, profile)
      expect(subject.slots.entries(HOLE)).toHaveLength(0)
      expect(subject.register).not.toHaveBeenCalled()
      expect(subject.boundNamespaces).toEqual([])
    }
  })

  it('binds the roster namespace and reads both Remote namespaces', async () => {
    const subject = await bench()
    await activate(subject, HARNESSY_PROFILE)

    expect(subject.boundNamespaces).toEqual([SUBAGENT_ROSTER_NAMESPACE])
    const { operations } = page(subject).inject({ sync: () => {} })

    const signal = new AbortController().signal
    await operations.storedRoster(signal)
    expect(subject.storedRoster).toHaveBeenCalledWith(signal)

    await operations.resolvedRoster('a:\\work', signal)
    expect(subject.resolvedRoster).toHaveBeenCalledWith('a:\\work', signal)

    await operations.automaticRouting(signal)
    expect(subject.automaticRouting).toHaveBeenCalledWith(signal)

    await operations.modelCatalog()
    expect(subject.modelCatalog).toHaveBeenCalledWith()

    await operations.write({ automaticRouting: { enabled: false, allowedModels: [] } }, 3)
    expect(subject.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['automaticRouting'], value: { enabled: false, allowedModels: [] } },
    ], 3)
  })

  it('reports a failed Remote read as an error instead of a value', async () => {
    const subject = await bench()
    await activate(subject, HARNESSY_PROFILE)
    subject.resolvedRoster.mockResolvedValueOnce({ ok: false, error: { message: 'roster unavailable' } } as never)

    const { operations } = page(subject).inject({ sync: () => {} })
    await expect(operations.resolvedRoster(null, new AbortController().signal))
      .rejects.toThrow('roster unavailable')
  })

  it('removes the page and its dictionaries with the fiber', async () => {
    const subject = await bench()
    const fiber = await activate(subject, HARNESSY_PROFILE)
    expect(subject.localeNamespaces.has('settings.subagents')).toBe(true)

    await fiber.dispose()
    expect(subject.slots.entries(HOLE)).toHaveLength(0)
    expect(subject.localeNamespaces.size).toBe(0)
  })
})
