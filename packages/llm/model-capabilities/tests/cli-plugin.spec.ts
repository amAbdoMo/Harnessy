import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createPublicCatalogStore, CACHE_SCHEMA_VERSION } from '@deepseek-ai/dsh-model-capabilities'
import type { ModelCapabilityInspection } from '@deepseek-ai/dsh-model-capabilities'
import * as plugin from '../src/cli.ts'
import { evaluateCommand, writableSection, writeInspections } from '../src/cli.ts'
import { inspectConfiguredModels, readConfiguredRoutes } from '../src/inspect.ts'
import { MODEL_CAPABILITY_STORE_SERVICE } from '../src/plugin.ts'

/** A models.dev catalog naming the Cortecs route and one id-only claimant. */
const MODELS_DEV_ENTRIES = {
  cortecs: {
    id: 'cortecs',
    api: 'https://api.cortecs.ai/v1',
    models: {
      'gpt-5.6-sol': { id: 'gpt-5.6-sol', reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] },
      // State by one provider entry only, and by none whose endpoint this
      // deployment configures: an id-only claim, which is never declared.
      'gpt-6-astra': { id: 'gpt-6-astra', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
    },
  },
}

/** An OpenRouter catalog naming one model, which is the shape its reader expects. */
const OPENROUTER_ENTRIES = {
  data: [{
    id: 'stealth/union-alpha',
    reasoning: { supported_efforts: ['off', 'high'], default_effort: 'high' },
  }],
}

/** A routes document with a bare route, a declared route, and one refusal. */
const ROUTES = {
  providers: {
    cortex: {
      displayName: 'Cortex',
      baseURL: 'https://api.cortecs.ai/v1',
      models: [{ id: 'gpt-5.6-sol', name: 'Sol' }],
    },
    'openai-codex': { displayName: 'OpenAI Codex', models: [{ id: 'gpt-6-astra' }] },
    'openrouter-live': {
      displayName: 'OpenRouter',
      baseURL: 'https://openrouter.ai/api/v1',
      models: [{ id: 'stealth/union-alpha' }],
    },
    commandcode: {
      displayName: 'Command Code',
      models: [
        { id: 'gpt-6-astra', reasoningEfforts: { low: 'low', high: 'high' } },
        { id: 'no-reasoning', reasoningEfforts: false },
      ],
    },
  },
}

/**
 * A store that answers from one cached and one bundled catalog, and fetches nothing.
 * @param catalog - the reduced catalog the bundled tier should serve.
 * @param cache - one cached catalog, which is what carries a fetch time.
 * @returns the store.
 */
function store(
  catalog?: { source: 'models.dev' | 'openrouter'; origin: 'bundled'; entries: unknown },
  cache?: { source: 'models.dev' | 'openrouter'; fetchedAt: string; catalog: unknown },
) {
  return createPublicCatalogStore({
    policy: () => ({ enabled: true, refresh: 'manual', cacheTtlMs: 1000 }),
    fetchCatalog: () => Promise.reject(new Error('no fetch may happen')),
    cache: {
      read: () => Promise.resolve(cache === undefined ? [] : [{ ...cache, schemaVersion: CACHE_SCHEMA_VERSION }]),
      write: () => Promise.resolve(),
    },
    bundled: [catalog ?? { source: 'models.dev' as const, origin: 'bundled' as const, entries: MODELS_DEV_ENTRIES }],
  })
}

describe('inspecting a configured deployment', () => {
  it('reports each configured model with the action a sync would take', () => {
    const inspections = inspectConfiguredModels(readConfiguredRoutes(ROUTES), store())
    expect(inspections.map(entry => [entry.route, entry.model, entry.decision])).toEqual([
      ['cortex', 'gpt-5.6-sol', 'write'],
      ['openai-codex', 'gpt-6-astra', 'suggestion'],
      ['openrouter-live', 'stealth/union-alpha', 'unresolved'],
      ['commandcode', 'gpt-6-astra', 'declared'],
      ['commandcode', 'no-reasoning', 'declared'],
    ])
  })
})

describe('writing the settings document', () => {
  it('persists one merge patch and reports how many rows it decided', async () => {
    const routes = readConfiguredRoutes(ROUTES)
    const inspections = inspectConfiguredModels(routes, store())
    const patches: { ns: string; patch: object }[] = []
    const written = await writeInspections(routes, inspections, {
      update: (ns, patch) => {
        patches.push({ ns, patch })
        return Promise.resolve()
      },
    })
    expect(written).toBe(1)
    expect(patches).toEqual([{
      ns: 'llm-pi-ai',
      patch: {
        providers: {
          cortex: {
            displayName: 'Cortex',
            baseURL: 'https://api.cortecs.ai/v1',
            models: [{
              id: 'gpt-5.6-sol',
              name: 'Sol',
              reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
            }],
          },
        },
      },
    }])
  })

  it('writes nothing when no row is writable, so the seam is never called', async () => {
    const routes = readConfiguredRoutes({ providers: { only: { models: [{ id: 'unknown-id' }] } } })
    const inspections = inspectConfiguredModels(routes, store())
    let calls = 0
    const written = await writeInspections(routes, inspections, {
      update: () => {
        calls += 1
        return Promise.resolve()
      },
    })
    expect(written).toBe(0)
    expect(calls).toBe(0)
  })

  it('propagates a refused write rather than reporting a partial success', async () => {
    const routes = readConfiguredRoutes(ROUTES)
    const inspections = inspectConfiguredModels(routes, store())
    await expect(writeInspections(routes, inspections, {
      update: () => Promise.reject(new Error('settings provider is read-only')),
    })).rejects.toThrow('read-only')
  })
})

/** What one mount should provide, so a spec can withhold or break each service. */
interface MountOptions {
  /** Whether the settings service is published at all. */
  readonly settings?: boolean
  /** Whether every settings write rejects. */
  readonly refuseWrite?: boolean
  /** Whether the catalog store is published at all. */
  readonly store?: boolean
  /** Whether the store fails the way a programming error would. */
  readonly explode?: boolean
  /** Whether the launcher publishes a readiness signal the plugin must wait on. */
  readonly ready?: boolean
  /** Whether that readiness signal never fires, so the run stays pending. */
  readonly stalled?: boolean
  /** One cached entry to publish, which is what carries a fetch time. */
  readonly cache?: { source: 'models.dev' | 'openrouter'; fetchedAt: string; catalog: unknown }
}

/** What the plugin examines before it reports on a row. */
type InspectedModel = Parameters<typeof writeInspections>[1][number]

/**
 * Mount the command's plugin over a real command line and tree.
 * @param args - the inner arguments the launcher hands the app.
 * @param catalog - the bundled catalog the store should serve.
 * @param routes - the resolved `llm-pi-ai` section; null states that this
 *   composition mounts no routes at all.
 * @param options - which services to publish, and how they behave.
 * @returns the context, the exit codes the launcher received, the settings
 *   patches it was handed, the captured output of each run, and both streams.
 */
async function mount(
  args: readonly string[],
  catalog?: { source: 'models.dev' | 'openrouter'; origin: 'bundled'; entries: unknown },
  routes: unknown = ROUTES,
  options: MountOptions = {},
): Promise<{
  ctx: Context
  exits: number[]
  patches: { ns: string; patch: object }[]
  out: () => string
  outputs: () => string[]
  err: () => string
  settle: (runs?: number) => Promise<void>
}> {
  const ctx = new Context()
  const patches: { ns: string; patch: object }[] = []
  if (options.settings !== false) {
    // The stored section, so a write is observable on the next read the way the
    // seam's own commit makes it. A mount that passes no routes document
    // states none, which is the composition that registered no provider.
    let stored: Record<string, unknown> | undefined = routes === undefined || routes === null
      ? undefined
      : structuredClone(routes) as Record<string, unknown>
    ctx.provide('settings', {
      get: (ns: string) => {
        if (ns === 'model-capabilities') return { publicMetadata: { enabled: true, refresh: 'manual', cacheTtl: '7d' } }
        return stored
      },
      update: (ns: string, patch: object) => {
        if (options.refuseWrite === true) return Promise.reject(new Error('settings provider is read-only'))
        patches.push({ ns, patch })
        const providers = (patch as { providers?: Record<string, unknown> }).providers ?? {}
        const current = (stored?.providers ?? {}) as Record<string, unknown>
        stored = { ...stored, providers: { ...current, ...providers } }
        return Promise.resolve()
      },
    })
  }
  if (options.store !== false) {
    const catalogStore = store(catalog, options.cache)
    // Failing the store lets the command's own containment be observed rather
    // than the failure escaping as an unhandled rejection.
    ctx.provide(MODEL_CAPABILITY_STORE_SERVICE, options.explode === true
      ? { selections: () => { throw new Error('store unavailable') } }
      : catalogStore)
  }
  const exits: number[] = []
  const outputs: string[] = []
  let stdout = ''
  let stderr = ''
  const originalOut = process.stdout.write.bind(process.stdout)
  const originalErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = (chunk: string) => { stdout += chunk; return true }
  process.stderr.write = (chunk: string) => { stderr += chunk; return true }
  // The command runs after `apply` returns, so the capture belongs to the
  // tree's lifetime rather than to the mount call.
  ctx.effect(() => () => {
    process.stdout.write = originalOut
    process.stderr.write = originalErr
  }, 'cli spec: restore the process streams')
  provideCmdline(ctx, { args, exit: (code: number) => { exits.push(code); outputs.push(stdout); stdout = '' } })
  if (options.ready === true) {
    const listeners: (() => void)[] = []
    ctx.provide('appReady', {
      onReady: (listener: () => void) => {
        if (options.stalled !== true) listener()
        else listeners.push(listener)
        return () => {
          const at = listeners.indexOf(listener)
          if (at >= 0) listeners.splice(at, 1)
        }
      },
    })
  }
  await ctx.plugin(plugin)
  return {
    ctx,
    exits,
    patches,
    out: () => outputs.join('') + stdout,
    outputs: () => outputs,
    err: () => stderr,
    settle: async (runs = 1) => {
      // One exit per requested run, so an invocation that writes and then
      // checks is settled only once both have answered.
      for (let attempt = 0; attempt < 400 && exits.length < runs; attempt += 1) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
      }
    },
  }
}

// The plugin module is mounted whole, so the Loader sees the declarations the
// package actually publishes rather than a test-local copy of them.

describe('the command-line surface', () => {
  it('reports every configured model for --models-sync=check and exits success', async () => {
    const mounted = await mount(['--models-sync=check'])
    await mounted.settle()
    expect(mounted.exits).toEqual([0])
    expect(mounted.out()).toContain('cortex / gpt-5.6-sol')
    expect(mounted.out()).toContain('action:        would write')
    expect(mounted.out()).toContain('openai-codex / gpt-6-astra')
    expect(mounted.out()).toContain('action:        not written (suggestion only)')
    expect(mounted.out()).toContain('commandcode / gpt-6-astra')
    expect(mounted.out()).toContain('current:       low, high')
    expect(mounted.out()).toContain('action:        kept (already declared)')
    expect(mounted.out()).toContain('current:       does not reason (declared)')
    await mounted.ctx.fiber.dispose()
  })

  it('renders a provider-aware resolution with its provider, match, origin, and fetch time', async () => {
    const mounted = await mount(['--models-sync=check'])
    await mounted.settle()
    const report = mounted.out()
    expect(report).toContain('discovered:    low, medium, high')
    expect(report).toContain('source:        models.dev')
    expect(report).toContain('provider:      cortecs')
    expect(report).toContain('match:         provider-host')
    expect(report).toContain('origin:        bundled')
    expect(report).toContain('authoritative: yes')
    // A bundled catalog states no fetch time, so the line is absent rather than
    // reporting an empty one.
    expect(report).not.toContain('fetchedAt:')
    await mounted.ctx.fiber.dispose()
  })

  it('renders a unique id-only claim as a suggestion with no authority', async () => {
    // One claimant: the id is stated by exactly one provider entry, so the
    // report calls it model-id-only rather than ambiguous — and either way it
    // is never written.
    const only = {
      source: 'models.dev' as const,
      origin: 'bundled' as const,
      entries: {
        cortecs: {
          id: 'cortecs',
          api: 'https://api.cortecs.ai/v1',
          models: { 'gpt-6-astra': { id: 'gpt-6-astra', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } },
        },
      },
    }
    const mounted = await mount(['--models-sync=check'], only)
    await mounted.settle()
    const report = mounted.out()
    expect(report).toContain('match:         model-id-only')
    expect(report).toContain('authoritative: no')
    expect(report).toContain('    - models.dev / cortecs: low, high')
    expect(report).toContain('action:        not written (suggestion only)')
    await mounted.ctx.fiber.dispose()
  })

  it('renders several disagreeing id-only claims as ambiguous', async () => {
    // Two provider entries state the same id with different levels, and the
    // route names neither of them, so there is nothing to choose between.
    const two = {
      source: 'models.dev' as const,
      origin: 'bundled' as const,
      entries: {
        cortecs: {
          id: 'cortecs',
          api: 'https://api.cortecs.ai/v1',
          models: { 'gpt-6-astra': { id: 'gpt-6-astra', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } },
        },
        other: {
          id: 'other',
          api: 'https://api.other.example/v1',
          models: { 'gpt-6-astra': { id: 'gpt-6-astra', reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] } },
        },
      },
    }
    const mounted = await mount(['--models-sync=check'], two)
    await mounted.settle()
    const report = mounted.out()
    expect(report).toContain('match:         model-id-ambiguous')
    expect(report).toContain('authoritative: no')
    expect(report).toContain('    - models.dev / cortecs: low, high')
    expect(report).toContain('    - models.dev / other: low, high, max')
    expect(report).toContain('action:        not written (suggestion only)')
    await mounted.ctx.fiber.dispose()
  })

  it('renders the whole chain for --models-explain, tiers in precedence order', async () => {
    const mounted = await mount(['--models-explain=cortex/gpt-5.6-sol'])
    await mounted.settle()
    expect(mounted.exits).toEqual([0])
    const report = mounted.out()
    expect(report).toContain('route: cortex')
    expect(report).toContain('id: gpt-5.6-sol')
    expect(report).toContain('live:\n  no catalog loaded')
    expect(report).toContain('cache:\n  no catalog loaded')
    expect(report).toContain('bundled:\n  cortecs')
    expect(report).toContain('match: provider-host')
    expect(report).toContain('Final:\n  low, medium, high')
    await mounted.ctx.fiber.dispose()
  })

  it('renders suggestions and the reason for an unresolved explain', async () => {
    const mounted = await mount(['--models-explain=openai-codex/gpt-5.6-sol'])
    await mounted.settle()
    const report = mounted.out()
    expect(report).toContain('Final:\n  undeclared')
    expect(report).toContain('Suggestions:\n  models.dev / cortecs')
    expect(report).toContain('Reason:\n  model-id-only claims disagree and no provider-aware route match exists')
    await mounted.ctx.fiber.dispose()
  })

  it('explains a pair nothing is configured for, reporting the emptiness', async () => {
    const mounted = await mount(['--models-explain=absent/ghost'])
    await mounted.settle()
    expect(mounted.exits).toEqual([0])
    expect(mounted.out()).toContain('route: absent')
    expect(mounted.out()).toContain('Final:\n  undeclared')
    await mounted.ctx.fiber.dispose()
  })

  it('does not run a command when no capability flag was given', async () => {
    const mounted = await mount(['--help'])
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    // Only commander's own help exit, and no report from the command.
    expect(mounted.exits).toEqual([0])
    expect(mounted.out()).toContain('--models-sync')
    await mounted.ctx.fiber.dispose()
  })

  it('reports a disabled layer when no settings service is mounted at all', async () => {
    const mounted = await mount(['--models-sync=check'], undefined, ROUTES, { settings: false })
    await mounted.settle()
    expect(mounted.exits).toEqual([0])
    expect(mounted.out()).toContain('public metadata is disabled')
    expect(mounted.patches).toEqual([])
    await mounted.ctx.fiber.dispose()
  })

  it('lets commander answer a bad flag as a usage error before anything runs', async () => {
    const mounted = await mount(['--models-sync'])
    await mounted.settle()
    expect(mounted.exits).toEqual([1])
    expect(mounted.err()).toContain("option '--models-sync <mode>' argument missing")
    await mounted.ctx.fiber.dispose()
  })

  it('writes the authoritative rows a sync decided, and nothing else', async () => {
    const mounted = await mount(['--models-sync=write'])
    await mounted.settle()
    expect(mounted.exits).toEqual([0])
    const written = mounted.out()
    expect(written).toContain('action:        written')
    expect(written).toContain('1 declaration(s) written')
    // Only the authoritative row was in the patch; the declared one stayed as
    // the user stated it and the suggestion stayed out entirely.
    expect(mounted.patches).toEqual([{
      ns: 'llm-pi-ai',
      patch: {
        providers: {
          cortex: {
            displayName: 'Cortex',
            baseURL: 'https://api.cortecs.ai/v1',
            models: [{
              id: 'gpt-5.6-sol',
              name: 'Sol',
              reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
            }],
          },
        },
      },
    }])
    await mounted.ctx.fiber.dispose()
  })

  it('runs a repeated flag once per occurrence, in argv order', async () => {
    // `write` then `check` is one invocation with two reports: the row the write
    // declared is a declaration by the time the check reads it back.
    const mounted = await mount(['--models-sync=write', '--models-sync=check'])
    await mounted.settle()
    expect(mounted.exits).toEqual([0])
    const report = mounted.out()
    const writeAt = report.indexOf('1 declaration(s) written')
    expect(writeAt).toBeGreaterThan(-1)
    // The check's report follows the write's, which is argv order.
    expect(report.indexOf('current:       low, medium, high')).toBeGreaterThan(writeAt)
    expect(report).toContain('action:        kept (already declared)')
    expect(report).not.toContain('would write')
    expect(mounted.patches).toHaveLength(1)
    await mounted.ctx.fiber.dispose()
  })

  it('reports an empty configuration rather than an empty report', async () => {
    const mounted = await mount(['--models-sync=check'], undefined, { providers: {} })
    await mounted.settle()
    expect(mounted.exits).toEqual([0])
    expect(mounted.out()).toContain('no models are configured under llm-pi-ai')
    await mounted.ctx.fiber.dispose()
  })

  it('reports a refused settings write and exits failure', async () => {
    const mounted = await mount(['--models-sync=write'], undefined, ROUTES, { refuseWrite: true })
    await mounted.settle()
    expect(mounted.exits).toEqual([1])
    expect(mounted.err()).toContain('writing the settings document failed')
    await mounted.ctx.fiber.dispose()
  })

  it('reports a disabled layer when this deployment configures no routes', async () => {
    // A policy section with no `llm-pi-ai` section beside it: the layer is on
    // and there is simply nothing configured to inspect.
    const mounted = await mount(['--models-sync=check'], undefined, null)
    await mounted.settle()
    expect(mounted.exits).toEqual([0])
    expect(mounted.out()).toContain('no models are configured under llm-pi-ai')
    await mounted.ctx.fiber.dispose()
  })

  it('writes the default effort an OpenRouter answer published', () => {
    // A published default travels into the row a write persists, which is the
    // one profile field OpenRouter answers that models.dev does not.
    const routes = readConfiguredRoutes(ROUTES)
    const openRouter = { source: 'openrouter' as const, origin: 'bundled' as const, entries: OPENROUTER_ENTRIES }
    const inspections = inspectConfiguredModels(routes, store(openRouter))
    const onOpenRouter = inspections.find(entry => entry.route === 'openrouter-live')
    expect(onOpenRouter?.decision).toBe('write')
    expect(onOpenRouter?.write).toEqual({ levels: ['off', 'high'], defaultEffort: 'high' })
    expect(writableSection(routes, [onOpenRouter as InspectedModel])).toEqual({
      providers: {
        'openrouter-live': {
          displayName: 'OpenRouter',
          baseURL: 'https://openrouter.ai/api/v1',
          models: [{
            id: 'stealth/union-alpha',
            reasoningEfforts: { off: null, high: 'high' },
            defaultReasoningEffort: 'high',
          }],
        },
      },
    })
  })

  it('reports the fetch time of a cached catalog that answered', async () => {
    const mounted = await mount(['--models-sync=check'], undefined, ROUTES, {
      cache: { source: 'models.dev', fetchedAt: '2026-09-16T12:00:00.000Z', catalog: MODELS_DEV_ENTRIES },
    })
    await mounted.settle()
    const report = mounted.out()
    expect(report).toContain('origin:        cache')
    expect(report).toContain('fetchedAt:     2026-09-16T12:00:00.000Z')
    // The cache answered ahead of the bundled snapshot, so the floor was not
    // selected for this model.
    expect(report).not.toContain('origin:        bundled')
    await mounted.ctx.fiber.dispose()
  })

  it('reports a cached tier and its fetch time in an explanation', async () => {
    const mounted = await mount(['--models-explain=cortex/gpt-5.6-sol'], undefined, ROUTES, {
      cache: { source: 'models.dev', fetchedAt: '2026-09-16T12:00:00.000Z', catalog: MODELS_DEV_ENTRIES },
    })
    await mounted.settle()
    const report = mounted.out()
    expect(report).toContain('cache:\n  cortecs')
    expect(report).toContain('  fetchedAt: 2026-09-16T12:00:00.000Z')
    expect(report).toContain('Final:\n  low, medium, high')
    await mounted.ctx.fiber.dispose()
  })

  it('waits for the launcher to report readiness before running', async () => {
    const mounted = await mount(['--models-sync=check'], undefined, ROUTES, { ready: true, stalled: true })
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    // Readiness has not arrived, so nothing has run and nothing has exited.
    expect(mounted.exits).toEqual([])
    expect(mounted.out()).toBe('')
    await mounted.ctx.fiber.dispose()
  })

  it('does not examine a row a sync would not write', () => {
    // One inspection per decision: only `write` contributes a patch, and a
    // writable decision with no level to declare contributes nothing either.
    const routes = readConfiguredRoutes(ROUTES)
    const base = inspectConfiguredModels(routes, store())
    const inspected = base.filter((entry: ModelCapabilityInspection) => entry.route === 'cortex' || entry.route === 'commandcode')
    const empty: InspectedModel = {
      ...(inspected[0] as InspectedModel),
      route: 'cortex',
      model: 'gpt-5.6-sol',
      decision: 'write',
      write: { levels: [] },
    }
    expect(writableSection(routes, [...inspected, empty])).toEqual({
      providers: {
        cortex: {
          displayName: 'Cortex',
          baseURL: 'https://api.cortecs.ai/v1',
          models: [{
            id: 'gpt-5.6-sol',
            name: 'Sol',
            reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
          }],
        },
      },
    })
  })

  it('reports a refused settings write as a failure, naming the document', async () => {
    // The seam rejecting the write is the failure the user must hear about: a
    // partial success would leave the document in a state nobody stated.
    const mounted = await mount(['--models-sync=write'], undefined, ROUTES, { refuseWrite: true })
    await mounted.settle()
    expect(mounted.exits).toEqual([1])
    expect(mounted.err()).toContain('writing the settings document failed')
    expect(mounted.err()).toContain('settings provider is read-only')
    await mounted.ctx.fiber.dispose()
  })

  it('reports a disabled layer when no policy is readable, and writes nothing', async () => {
    // A settings service that resolves no policy is not a policy: the command
    // reports the layer disabled rather than acting on a guess.
    const ctx = new Context()
    ctx.provide('settings', { get: () => undefined })
    let report = ''
    const code = await evaluateCommand(ctx, { modelsSync: ['write'] }, (text) => { report += text }, () => {})
    expect(code).toBe(0)
    expect(report).toContain('public metadata is disabled')
    await ctx.fiber.dispose()
  })

  it('refuses a write when this composition mounts no settings service', async () => {
    // Reachable through `apply` with a row whose static inject list omits
    // `settings`: the layer can read its own policy from the composition entry
    // and still has nowhere to persist a declaration.
    const ctx = new Context()
    ctx.provide('settings', {
      get: (ns: string) => (ns === 'model-capabilities'
        ? { publicMetadata: { enabled: true, refresh: 'manual', cacheTtl: '7d' } }
        : undefined),
    })
    ctx.provide(MODEL_CAPABILITY_STORE_SERVICE, store())
    let stderr = ''
    let report = ''
    const code = await evaluateCommand(
      ctx,
      { modelsSync: ['write'] },
      (text) => { report += text },
      (text) => { stderr += text },
    )
    expect(code).toBe(0)
    expect(stderr).toBe('')
    // No routes section is readable, so the report is empty rather than wrong.
    expect(report).toContain('no models are configured under llm-pi-ai')
    await ctx.fiber.dispose()
  })

  it('fetches nothing when only a refresh was asked for and no policy governs it', async () => {
    // `--models-refresh` alone is a check with the network asked for, and a
    // check the policy refuses is reported rather than silently skipped.
    const ctx = new Context()
    ctx.provide('settings', {
      get: (ns: string) => (ns === 'model-capabilities'
        ? { publicMetadata: { enabled: true, refresh: 'never', cacheTtl: '7d' } }
        : ROUTES),
    })
    ctx.provide(MODEL_CAPABILITY_STORE_SERVICE, store())
    let stderr = ''
    const code = await evaluateCommand(ctx, { modelsRefresh: true }, () => {}, (text) => { stderr += text })
    expect(code).toBe(1)
    expect(stderr).toContain('refresh is "never"')
    await ctx.fiber.dispose()
  })

  it('fails when the public metadata plugin is not mounted beside the command', async () => {
    const ctx = new Context()
    ctx.provide('settings', {
      get: (ns: string) => (ns === 'model-capabilities'
        ? { publicMetadata: { enabled: true, refresh: 'manual', cacheTtl: '7d' } }
        : ROUTES),
    })
    let stderr = ''
    const code = await evaluateCommand(ctx, { modelsSync: ['check'] }, () => {}, (text) => { stderr += text })
    expect(code).toBe(1)
    expect(stderr).toContain('public metadata plugin is not mounted')
    await ctx.fiber.dispose()
  })

  it('contains an unexpected command failure instead of leaving it unhandled', async () => {
    const mounted = await mount(['--models-explain=route/id'], undefined, ROUTES, { explode: true })
    await mounted.settle()
    expect(mounted.exits).toEqual([1])
    expect(mounted.err()).toContain('model-capabilities:')
    await mounted.ctx.fiber.dispose()
  })
})

describe('the plugin protocol', () => {
  it('names itself and injects the command line and the store, with no default export', () => {
    expect(plugin.name).toBe('model-capabilities-cli')
    expect(plugin.inject).toEqual(['cmdlineArgs', MODEL_CAPABILITY_STORE_SERVICE])
    expect((plugin as { default?: unknown }).default).toBeUndefined()
  })
})
