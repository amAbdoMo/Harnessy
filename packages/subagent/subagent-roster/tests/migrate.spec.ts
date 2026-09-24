/**
 * The projection from the two stored pre-roster namespaces into one roster
 * document: every lane field value survives, the projection is idempotent and
 * side-effect free, and nothing it was handed is aliased.
 */

import { describe, expect, it } from 'vitest'
import { defaultSubagentSettings } from '../src/defaults.ts'
import {
  MIGRATED_SUBAGENT_BACKEND,
  migrateSubagentSettings,
} from '../src/migrate.ts'
import type {
  LegacyCommandCodeDelegation,
  LegacySubagentConfiguration,
} from '../src/migrate.ts'
import { validateSubagentSettings } from '../src/settings.ts'

/** One complete legacy configuration, as the two old namespaces stored it. */
function legacy(overrides: Partial<LegacyCommandCodeDelegation> = {}): LegacySubagentConfiguration {
  return {
    commandCode: {
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
          id: 'review',
          name: 'Review',
          purpose: 'Review a change.',
          instructions: '',
          model: 'deepseek/deepseek-v4.1-flash',
          effort: 'default',
          access: 'read-only',
          enabled: false,
        },
        {
          id: 'perf',
          name: 'Perf',
          purpose: 'Measure.',
          instructions: '',
          model: 'local-model',
          effort: 'medium',
          access: 'read-only',
          enabled: true,
        },
      ],
      projects: {
        '/work': {
          lanes: {
            code: { model: 'alpha/small', effort: 'low' },
            review: { access: 'full-access', enabled: true },
            perf: { name: 'Perf (work)' },
          },
        },
      },
      ...overrides,
    },
    modelSelection: {
      enabled: true,
      allowedModels: [{ provider: 'alpha', model: 'small' }],
    },
  }
}

describe('lane projection', () => {
  it('preserves every stored lane field value', () => {
    const settings = migrateSubagentSettings(legacy())
    expect(settings.subagents).toEqual([
      {
        id: 'code',
        name: 'Code',
        enabled: true,
        purpose: 'Implement a change.',
        whenToUse: defaultSubagentSettings().subagents[0]?.whenToUse,
        invocation: 'automatic',
        model: {
          mode: 'fixed',
          route: { provider: MIGRATED_SUBAGENT_BACKEND, model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'high' },
        },
        access: 'danger-full-access',
        instructions: 'Keep the diff small.',
        execution: { backend: MIGRATED_SUBAGENT_BACKEND, background: 'auto' },
      },
      {
        id: 'review',
        name: 'Review',
        enabled: false,
        purpose: 'Review a change.',
        whenToUse: defaultSubagentSettings().subagents[1]?.whenToUse,
        invocation: 'automatic',
        model: {
          mode: 'fixed',
          route: { provider: MIGRATED_SUBAGENT_BACKEND, model: 'deepseek/deepseek-v4.1-flash' },
        },
        access: 'read-only',
        instructions: '',
        execution: { backend: MIGRATED_SUBAGENT_BACKEND, background: 'auto' },
      },
      {
        id: 'perf',
        name: 'Perf',
        enabled: true,
        purpose: 'Measure.',
        // The old lanes had no routing guidance, and this id ships none.
        whenToUse: '',
        invocation: 'automatic',
        model: { mode: 'fixed', route: { provider: MIGRATED_SUBAGENT_BACKEND, model: 'local-model', reasoningEffort: 'medium' } },
        access: 'read-only',
        instructions: '',
        execution: { backend: MIGRATED_SUBAGENT_BACKEND, background: 'auto' },
      },
    ])
  })

  it('maps the lane effort vocabulary onto route-owned efforts', () => {
    const settings = migrateSubagentSettings(legacy())
    // `default` means "the model's own default", which is an omitted effort.
    expect(settings.subagents[1]?.model.route).not.toHaveProperty('reasoningEffort')
    expect(settings.subagents[0]?.model.route?.reasoningEffort).toBe('high')
    expect(settings.subagents[2]?.model.route?.reasoningEffort).toBe('medium')
  })

  it('projects the run bounds from the lane namespace', () => {
    const settings = migrateSubagentSettings(legacy())
    expect(settings.limits).toEqual({ maxConcurrentRuns: 3, defaultTimeoutMs: 120_000 })
  })

  it('projects the model-selection namespace into automatic routing', () => {
    const settings = migrateSubagentSettings(legacy())
    expect(settings.automaticRouting).toEqual({
      enabled: true,
      allowedModels: [{ provider: 'alpha', model: 'small' }],
    })
  })

  it('projects a disabled selection into disabled routing with no routes', () => {
    const settings = migrateSubagentSettings({
      ...legacy(),
      modelSelection: { enabled: false, allowedModels: [] },
    })
    expect(settings.automaticRouting).toEqual({ enabled: false, allowedModels: [] })
  })
})

describe('workspace projection', () => {
  it('projects lane patches under the same field names', () => {
    const settings = migrateSubagentSettings(legacy())
    expect(settings.overrides['/work']?.subagents).toEqual({
      code: { model: { mode: 'fixed', route: { provider: MIGRATED_SUBAGENT_BACKEND, model: 'alpha/small', reasoningEffort: 'low' } } },
      review: { access: 'danger-full-access', enabled: true },
      perf: { name: 'Perf (work)' },
    })
  })

  it('resolves a patch naming only one half of the route against the global lane', () => {
    const settings = migrateSubagentSettings(legacy({
      projects: {
        '/work': { lanes: { code: { model: 'alpha/other' } } },
        '/other': { lanes: { code: { effort: 'low' } } },
      },
    }))
    // The definition stores one whole route, so the untouched half comes from
    // the global lane the patch applies to.
    expect(settings.overrides['/work']?.subagents.code?.model?.route).toEqual({
      provider: MIGRATED_SUBAGENT_BACKEND, model: 'alpha/other', reasoningEffort: 'high',
    })
    expect(settings.overrides['/other']?.subagents.code?.model?.route).toEqual({
      provider: MIGRATED_SUBAGENT_BACKEND, model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'low',
    })
  })

  it('leaves the route absent for a patch that names neither half', () => {
    const settings = migrateSubagentSettings(legacy({
      projects: { '/work': { lanes: { code: { purpose: 'Only here.' } } } },
    }))
    expect(settings.overrides['/work']?.subagents.code).toEqual({ purpose: 'Only here.' })
  })

  it('projects a patch for a lane the global list no longer holds', () => {
    const settings = migrateSubagentSettings(legacy({
      projects: { '/work': { lanes: { deleted: { model: 'alpha/small' } } } },
    }))
    expect(settings.overrides['/work']?.subagents.deleted).toEqual({
      model: { mode: 'fixed', route: { provider: MIGRATED_SUBAGENT_BACKEND, model: 'alpha/small' } },
    })
  })

  it('resolves a patch for a lane nobody holds against the lane vocabulary it was written in', () => {
    const settings = migrateSubagentSettings(legacy({
      projects: { '/work': { lanes: { deleted: { effort: 'low' } } } },
    }))
    expect(settings.overrides['/work']?.subagents.deleted).toEqual({
      model: {
        mode: 'fixed',
        route: { provider: MIGRATED_SUBAGENT_BACKEND, model: '', reasoningEffort: 'low' },
      },
    })
  })

  it('projects a patch naming instructions', () => {
    const settings = migrateSubagentSettings(legacy({
      projects: { '/work': { lanes: { code: { instructions: 'Only here.' } } } },
    }))
    expect(settings.overrides['/work']?.subagents.code).toEqual({ instructions: 'Only here.' })
  })

  it('removes nothing, because the old lanes had no removal concept', () => {
    const settings = migrateSubagentSettings(legacy())
    expect(settings.overrides['/work']?.removed).toBeUndefined()
  })

  it('carries an empty patch set for a workspace with no lanes', () => {
    const settings = migrateSubagentSettings(legacy({ projects: { '/work': { lanes: {} } } }))
    expect(settings.overrides).toEqual({ '/work': { subagents: {} } })
  })
})

describe('projection discipline', () => {
  it('is idempotent', () => {
    const configuration = legacy()
    const first = migrateSubagentSettings(configuration)
    const second = migrateSubagentSettings(configuration)
    expect(second).toEqual(first)
  })

  it('never mutates the document it was handed', () => {
    const configuration = legacy()
    const before = structuredClone(configuration)
    migrateSubagentSettings(configuration)
    expect(configuration).toEqual(before)
  })

  it('never aliases anything it was handed', () => {
    const configuration = legacy()
    const settings = migrateSubagentSettings(configuration)
    const [lane] = configuration.commandCode.lanes
    const [definition] = settings.subagents
    expect(definition).toEqual({
      id: lane?.id,
      name: lane?.name,
      enabled: lane?.enabled,
      purpose: lane?.purpose,
      whenToUse: defaultSubagentSettings().subagents[0]?.whenToUse,
      invocation: 'automatic',
      model: {
        mode: 'fixed',
        route: { provider: MIGRATED_SUBAGENT_BACKEND, model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'high' },
      },
      access: 'danger-full-access',
      instructions: lane?.instructions,
      execution: { backend: MIGRATED_SUBAGENT_BACKEND, background: 'auto' },
    })
    expect(definition).not.toBe(lane)
    expect(settings.overrides['/work']).not.toBe(configuration.commandCode.projects['/work'])
    expect(settings.overrides['/work']?.subagents.code).not.toBe(
      configuration.commandCode.projects['/work']?.lanes.code,
    )
    expect(settings.automaticRouting.allowedModels[0])
      .not.toBe(configuration.modelSelection.allowedModels[0])
  })

  it('produces a document the roster accepts, so the writer may persist it', () => {
    const settings = migrateSubagentSettings(legacy())
    expect(() => { validateSubagentSettings(settings) }).not.toThrow()
    expect(settings.subagents.every(definition => definition.model.mode === 'fixed')).toBe(true)
    expect(settings.subagents.every(definition => definition.model.route !== undefined)).toBe(true)
  })
})
