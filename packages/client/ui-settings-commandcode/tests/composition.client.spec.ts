// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { COMMAND_CODE_DELEGATION_NAMESPACE } from '../src/client/contract.ts'
import type { DelegationOperations } from '../src/client/DelegationSection.tsx'

afterEach(() => { vi.unstubAllEnvs() })

const HOLE = 'settings.section'
const HARNESSY_PROFILE = 'custom-harness'

/** The parameters one `settings.section` registration carried. */
interface RegisteredPage {
  readonly id: string
  readonly order: number
  readonly locale: string
  readonly label: () => string
  readonly inject: (bound: unknown) => { readonly operations: DelegationOperations }
}

/**
 * A client root carrying the services the section injects, with the real Slot
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

  // The Remote namespace answers with result envelopes, as the generated
  // client does; the section unwraps `ok`/`value` itself.
  const health = vi.fn(async () => ({
    ok: true, value: { command: 'cmdc', installed: true, authenticated: true },
  }))
  const catalog = vi.fn(async () => ({ ok: true, value: { models: [] } }))
  const delegation = vi.fn(async (workspace: string | null) => ({
    ok: true,
    value: {
      workspaceKey: workspace, maxConcurrentRuns: 2, timeoutMs: 60_000, maxTurns: 5, lanes: [],
    },
  }))
  const commandcode = { health, catalog, delegation }
  const mutate = vi.fn(async () => {})
  const boundNamespaces: string[] = []
  const localeNamespaces = new Set<string>()

  ctx.provide('remote', { commandcode } as never)
  ctx.provide('remote.commandcode', commandcode as never)
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
        getSnapshot: () => ({ status: 'ready', writable: true, value: undefined }),
        subscribe: () => () => {},
        mutate,
      }
    },
  } as never)

  const register = vi.spyOn(slots, 'register')
  return { ctx, slots, register, health, catalog, delegation, mutate, boundNamespaces, localeNamespaces }
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

describe('Harnessy Delegation client composition', () => {
  it('declares exactly the services the page reads', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.commandcode', 'settingsScope'])
  })

  it('registers one Delegation page in the Harnessy build profile', async () => {
    const subject = await bench()
    await activate(subject, HARNESSY_PROFILE)

    expect(subject.slots.entries(HOLE)).toHaveLength(1)
    const registered = page(subject)
    expect(registered.id).toBe('commandcode-delegation')
    expect(registered.locale).toBe('commandCodeDelegation')
    expect(registered.label()).toBe('commandCodeDelegation.nav')
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

  it('binds the settings namespace and reaches the Host through the Command Code Remote', async () => {
    const subject = await bench()
    await activate(subject, HARNESSY_PROFILE)

    expect(subject.boundNamespaces).toEqual([COMMAND_CODE_DELEGATION_NAMESPACE])
    const { operations } = page(subject).inject({ sync: () => {} })

    const signal = new AbortController().signal
    await operations.health(signal)
    expect(subject.health).toHaveBeenCalledWith(signal)

    await operations.view('a:\\work', signal)
    expect(subject.delegation).toHaveBeenCalledWith('a:\\work', signal)

    await operations.write({ maxConcurrentRuns: 3 })
    expect(subject.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['maxConcurrentRuns'], value: 3 },
    ])
  })

  it('removes the page and its dictionaries with the fiber', async () => {
    const subject = await bench()
    const fiber = await activate(subject, HARNESSY_PROFILE)
    expect(subject.localeNamespaces.has('commandCodeDelegation')).toBe(true)

    await fiber.dispose()
    expect(subject.slots.entries(HOLE)).toHaveLength(0)
    expect(subject.localeNamespaces.size).toBe(0)
  })
})
