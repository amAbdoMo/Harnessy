/**
 * The one-shot migration from the two pre-roster namespaces: what it carries,
 * what it leaves exactly as it found it, and every stored value it refuses to
 * act on.
 */

import { Context } from '@deepseek-ai/cordis'
import { SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import z from '@deepseek-ai/schemastery'
import { describe, expect, it, vi } from 'vitest'
import { defaultSubagentSettings, defaultWhenToUse } from '../src/defaults.ts'
import { migrateSubagentSettings } from '../src/migrate.ts'
import type { LegacyCommandCodeDelegation, LegacySubagentConfiguration } from '../src/migrate.ts'
import {
  LEGACY_COMMAND_CODE_NAMESPACE,
  migrateStoredSubagentConfiguration,
} from '../src/migration.ts'
import { SUBAGENT_ROSTER_NAMESPACE, SubagentSettingsSchema, validateSubagentSettings } from '../src/settings.ts'
import type { SubagentSettings } from '../src/types.ts'
import { bootRoster, delegate, headerAgent, MemorySettings, text } from './harness.ts'

/**
 * The lane namespace as its owner resolves it, mirrored so this suite mounts it
 * without the Command Code plugin. The containers stay unconstrained: this
 * suite feeds the projection stored values a permissive registrant could hold,
 * which is what the read has to survive.
 */
const LegacyCommandCodeSchema = z.object({
  maxConcurrentRuns: z.number().default(2),
  timeoutMs: z.number().default(3_600_000),
  lanes: z.any().default([]),
  projects: z.any().default({}),
})

/** The selection namespace as its owner resolves it, mirrored for the same reason. */
const LegacyModelSelectionSchema = z.object({
  enabled: z.boolean().default(false),
  allowedModels: z.any().default([]),
})

/** One complete stored lane configuration, as the pre-roster section held it. */
function legacyLanes(): LegacyCommandCodeDelegation {
  return {
    maxConcurrentRuns: 3,
    timeoutMs: 120_000,
    lanes: [
      {
        id: 'code',
        name: 'Code',
        purpose: 'Implement a change.',
        instructions: 'Keep the diff small.',
        model: 'deepseek/deepseek-v4.1-flash',
        effort: 'high',
        access: 'full-access',
        enabled: true,
      },
      {
        id: 'perf',
        name: 'Perf',
        purpose: 'Measure.',
        instructions: '',
        model: 'local-model',
        effort: 'medium',
        access: 'read-only',
        enabled: false,
      },
    ],
    projects: {
      '/work': { lanes: { code: { model: 'alpha/small', effort: 'low' }, perf: { name: 'Perf (work)' } } },
    },
  }
}

/** One complete stored selection, as the pre-roster namespace held it. */
function legacySelection(): Record<string, unknown> {
  return { enabled: true, allowedModels: [{ provider: 'alpha', model: 'small' }] }
}

/** The same document behind storage that refuses every write. */
class ReadOnlySettings extends MemorySettings {
  override get writable(): boolean { return false }
}

/** One booted settings document with the roster section installed and the legacy namespaces mounted. */
interface MigrationBench {
  readonly ctx: Context
  readonly settings: MemorySettings
}

/** Which legacy namespaces a bench mounts. */
type MountedNamespace = 'commandCode' | 'modelSelection'

/**
 * Mount the roster's own settings registration over a real in-memory document,
 * exactly as the plugin registers it, with the legacy namespaces the deployment
 * also mounts.
 *
 * The two legacy schemas are mirrored rather than loaded from their owning
 * packages: the lane namespace belongs to a single product's backend package,
 * which this package must not depend on. The composition test in that package
 * mounts both real rows and fails if either namespace name drifts.
 * @param doc - the stored document the provider serves.
 * @param mounted - the legacy namespaces this composition registers.
 * @param writable - whether the provider accepts writes, as a read-only deployment does not.
 * @returns the context and the provider the migration reads and writes through.
 */
async function boot(
  doc: Record<string, unknown> = {},
  mounted: readonly MountedNamespace[] = ['commandCode', 'modelSelection'],
  writable = true,
): Promise<MigrationBench> {
  const ctx = new Context()
  await ctx.plugin(writable ? MemorySettings : ReadOnlySettings, { doc })
  const settings = ctx.settings as MemorySettings
  if (mounted.includes('commandCode')) settings.register(LEGACY_COMMAND_CODE_NAMESPACE, LegacyCommandCodeSchema)
  if (mounted.includes('modelSelection')) {
    settings.register(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, LegacyModelSelectionSchema)
  }
  settings.installSection(ctx, SUBAGENT_ROSTER_NAMESPACE, SubagentSettingsSchema, defaultSubagentSettings(), {
    setSource: () => {},
    validate: (value) => { validateSubagentSettings(value) },
    onChange: () => {},
  })
  return { ctx, settings }
}

/** The roster document one bench stored, or undefined while the migration wrote none. */
function storedRoster(settings: MemorySettings): SubagentSettings | undefined {
  return settings.doc[SUBAGENT_ROSTER_NAMESPACE] as SubagentSettings | undefined
}

describe('what the migration carries', () => {
  it('projects every stored lane, its run bounds, and its workspace overrides', async () => {
    const doc = { [LEGACY_COMMAND_CODE_NAMESPACE]: legacyLanes() }
    const { ctx, settings } = await boot(doc)

    await migrateStoredSubagentConfiguration(ctx, settings)

    expect(storedRoster(settings)).toEqual({
      subagents: [
        {
          id: 'code',
          name: 'Code',
          enabled: true,
          purpose: 'Implement a change.',
          whenToUse: defaultWhenToUse('code'),
          invocation: 'automatic',
          model: { mode: 'fixed', route: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'high' } },
          access: 'danger-full-access',
          instructions: 'Keep the diff small.',
          execution: { backend: 'commandcode', background: 'auto' },
        },
        {
          id: 'perf',
          name: 'Perf',
          enabled: false,
          purpose: 'Measure.',
          whenToUse: '',
          invocation: 'automatic',
          model: { mode: 'fixed', route: { provider: 'commandcode', model: 'local-model', reasoningEffort: 'medium' } },
          access: 'read-only',
          instructions: '',
          execution: { backend: 'commandcode', background: 'auto' },
        },
      ],
      overrides: {
        '/work': {
          subagents: {
            code: { model: { mode: 'fixed', route: { provider: 'commandcode', model: 'alpha/small', reasoningEffort: 'low' } } },
            perf: { name: 'Perf (work)' },
          },
        },
      },
      automaticRouting: { enabled: false, allowedModels: [] },
      limits: { maxConcurrentRuns: 3, defaultTimeoutMs: 120_000 },
    })
    expect(settings.writes).toEqual([SUBAGENT_ROSTER_NAMESPACE])
  })

  it('carries the stored selection into the automatic-routing authority', async () => {
    const doc = {
      [LEGACY_COMMAND_CODE_NAMESPACE]: legacyLanes(),
      [SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE]: legacySelection(),
    }
    const { ctx, settings } = await boot(doc)

    await migrateStoredSubagentConfiguration(ctx, settings)

    expect(storedRoster(settings)?.automaticRouting)
      .toEqual({ enabled: true, allowedModels: [{ provider: 'alpha', model: 'small' }] })
  })

  it('runs for a stored selection even when the lanes were never configured', async () => {
    const doc = { [SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE]: legacySelection() }
    const { ctx, settings } = await boot(doc)

    await migrateStoredSubagentConfiguration(ctx, settings)

    expect(settings.writes).toEqual([SUBAGENT_ROSTER_NAMESPACE])
    expect(storedRoster(settings)?.automaticRouting)
      .toEqual({ enabled: true, allowedModels: [{ provider: 'alpha', model: 'small' }] })
  })

  it('reports the migration and the number of roles it carried', async () => {
    const { ctx, settings } = await boot({ [LEGACY_COMMAND_CODE_NAMESPACE]: legacyLanes() })
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => ctx.logger)

    await migrateStoredSubagentConfiguration(ctx, settings)

    expect(info).toHaveBeenCalledWith(expect.stringContaining('migrated %d legacy subagent role(s)'), 2)
  })
})

describe('what the migration leaves alone', () => {
  it('never touches the legacy sections it read', async () => {
    const doc = {
      [LEGACY_COMMAND_CODE_NAMESPACE]: legacyLanes(),
      [SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE]: legacySelection(),
    }
    const { ctx, settings } = await boot(doc)
    const before = structuredClone(doc)

    await migrateStoredSubagentConfiguration(ctx, settings)

    expect(settings.doc[LEGACY_COMMAND_CODE_NAMESPACE]).toEqual(before[LEGACY_COMMAND_CODE_NAMESPACE])
    expect(settings.doc[SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE])
      .toEqual(before[SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE])
  })

  it('leaves a user-edited roster document in place', async () => {
    const mine = { ...defaultSubagentSettings(), subagents: [{ ...defaultSubagentSettings().subagents[0]!, name: 'Mine' }] }
    const doc = { [SUBAGENT_ROSTER_NAMESPACE]: mine, [LEGACY_COMMAND_CODE_NAMESPACE]: legacyLanes() }
    const { ctx, settings } = await boot(doc)

    await migrateStoredSubagentConfiguration(ctx, settings)

    expect(settings.writes).toEqual([])
    expect(storedRoster(settings)).toEqual(mine)
  })

  it('treats a roster document whose roles the user removed as the user\'s own', async () => {
    const doc = {
      [SUBAGENT_ROSTER_NAMESPACE]: { subagents: [] },
      [LEGACY_COMMAND_CODE_NAMESPACE]: legacyLanes(),
    }
    const { ctx, settings } = await boot(doc)

    await migrateStoredSubagentConfiguration(ctx, settings)

    expect(settings.writes).toEqual([])
    expect(storedRoster(settings)).toEqual({ subagents: [] })
  })
})

describe('when there is nothing to migrate', () => {
  it('writes nothing while neither legacy namespace is mounted', async () => {
    const { ctx, settings } = await boot({}, [])

    await migrateStoredSubagentConfiguration(ctx, settings)

    expect(settings.writes).toEqual([])
    expect(storedRoster(settings)).toBeUndefined()
  })

  it('writes nothing while both namespaces resolve the configuration the user never stored', async () => {
    const { ctx, settings } = await boot()

    await migrateStoredSubagentConfiguration(ctx, settings)

    expect(settings.writes).toEqual([])
    expect(storedRoster(settings)).toBeUndefined()
  })

  it('writes nothing for a stored section that holds no keys', async () => {
    const { ctx, settings } = await boot({ [LEGACY_COMMAND_CODE_NAMESPACE]: {} })

    await migrateStoredSubagentConfiguration(ctx, settings)

    expect(settings.writes).toEqual([])
  })

  it.each<[string, Record<string, unknown>]>([
    ['lanes that are not a list', { lanes: 'code,review', projects: {} }],
    ['a lane that is not an object', { lanes: [null], projects: {} }],
    ['projects that are not a map', { lanes: [], projects: 'work' }],
    ['a project whose lanes are not a map', { lanes: [], projects: { '/work': { lanes: 7 } } }],
    ['a lane patch that is not an object', { lanes: [], projects: { '/work': { lanes: { code: null } } } }],
  ])('writes nothing for %s', async (_label, commandCode) => {
    const { ctx, settings } = await boot({ [LEGACY_COMMAND_CODE_NAMESPACE]: commandCode })

    await migrateStoredSubagentConfiguration(ctx, settings)

    expect(settings.writes).toEqual([])
  })
})

describe('refusals', () => {
  it('refuses a projection this roster cannot run and leaves the legacy data alone', async () => {
    const doc = {
      [LEGACY_COMMAND_CODE_NAMESPACE]: {
        ...legacyLanes(),
        lanes: [{ ...legacyLanes().lanes[0]!, id: 'Not Ok' }],
      },
    }
    const { ctx, settings } = await boot(doc)
    const before = structuredClone(doc)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)

    await migrateStoredSubagentConfiguration(ctx, settings)

    expect(settings.writes).toEqual([])
    expect(storedRoster(settings)).toBeUndefined()
    expect(settings.doc[LEGACY_COMMAND_CODE_NAMESPACE]).toEqual(before[LEGACY_COMMAND_CODE_NAMESPACE])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('projects to an invalid document'), expect.stringContaining('is not a valid subagent id'))
  })

  it('contains a write the provider refuses, without failing the load', async () => {
    const { ctx, settings } = await boot({ [LEGACY_COMMAND_CODE_NAMESPACE]: legacyLanes() }, undefined, false)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)

    await expect(migrateStoredSubagentConfiguration(ctx, settings)).resolves.toBeUndefined()

    expect(settings.writes).toEqual([])
    expect(storedRoster(settings)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be written'),
      expect.stringContaining('read-only'),
    )
  })
})

describe('idempotence', () => {
  it('writes once and leaves the document unchanged when it runs twice', async () => {
    const { ctx, settings } = await boot({
      [LEGACY_COMMAND_CODE_NAMESPACE]: legacyLanes(),
      [SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE]: legacySelection(),
    })

    await migrateStoredSubagentConfiguration(ctx, settings)
    const after = structuredClone(settings.doc)
    await migrateStoredSubagentConfiguration(ctx, settings)

    expect(settings.writes).toEqual([SUBAGENT_ROSTER_NAMESPACE])
    expect(settings.doc).toEqual(after)
  })
})

describe('a migrated role before its backend exists', () => {
  /** The projection of the lane fixture, as the migration would have stored it. */
  function migrated(): SubagentSettings {
    const configuration: LegacySubagentConfiguration = {
      commandCode: legacyLanes(),
      modelSelection: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'small' }] },
    }
    return migrateSubagentSettings(configuration)
  }

  it('fails loud on the missing provider and starts nothing instead', async () => {
    const roster = await bootRoster({ settings: migrated() })

    const result = await delegate(roster, { subagent: 'code', task: 'Implement it.' }, headerAgent())

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no subagent provider registered for "commandcode"')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })
})
