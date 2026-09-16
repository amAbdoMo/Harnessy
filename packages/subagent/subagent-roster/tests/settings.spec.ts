/**
 * The stored roster document and its per-workspace resolution: schema
 * defaults, the write-time rejections, field-level inheritance, and the
 * failure a caller sees when it names a role the roster cannot run.
 */

import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  defaultSubagentDefinitions,
  defaultSubagentSettings,
  DEFAULT_SUBAGENT_DEFINITIONS,
  DEFAULT_SUBAGENT_LIMITS,
} from '../src/defaults.ts'
import {
  canonicalWorkspaceKey,
  requireEnabledSubagent,
  resolveSubagentRoster,
  SubagentSettingsSchema,
  subagentRosterView,
  validateSubagentSettings,
} from '../src/settings.ts'
import type { ResolvedSubagentDefinition, SubagentSettings } from '../src/types.ts'
import { definition, documentOf } from './harness.ts'

/** Validate one raw settings document through the namespace schema. */
function parse(value: object): SubagentSettings {
  // The schema's input position is typed as the resolved section; these tests
  // deliberately feed the raw, partially specified documents a user writes.
  return SubagentSettingsSchema(value as SubagentSettings)
}

/** Judge one raw document the way a settings write does, through both layers. */
function validate(value: object): void {
  validateSubagentSettings(parse(value))
}

describe('SubagentSettingsSchema', () => {
  it('supplies the shipped directory and bounds for an empty document', () => {
    const settings = parse({})
    expect(settings.subagents.map(item => item.id))
      .toEqual(['code', 'review', 'tests', 'docs', 'research', 'architecture'])
    expect(settings.overrides).toEqual({})
    expect(settings.automaticRouting).toEqual({ enabled: false, allowedModels: [] })
    expect(settings.limits).toEqual(DEFAULT_SUBAGENT_LIMITS)
    expect(defaultSubagentSettings().limits).toEqual(DEFAULT_SUBAGENT_LIMITS)
    expect(defaultSubagentDefinitions()).toHaveLength(6)
    // A detached copy: two reads share neither the array nor its definitions.
    const first = defaultSubagentDefinitions()
    const second = defaultSubagentDefinitions()
    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(second[0])
    expect(first[0]).toEqual(second[0])
  })

  it('defaults a user definition to the safest reading of every omitted field', () => {
    const settings = parse({
      subagents: [{ id: 'perf', name: 'Perf', purpose: 'Measure.', execution: { backend: 'spawn' } }],
    })
    expect(settings.subagents[0]).toEqual({
      id: 'perf',
      name: 'Perf',
      enabled: true,
      purpose: 'Measure.',
      whenToUse: '',
      invocation: 'automatic',
      // The user owns the child's model unless a definition opts into automatic routing.
      model: { mode: 'fixed' },
      access: 'inherit',
      instructions: '',
      execution: { backend: 'spawn', background: 'auto' },
    })
    // An empty `{ allow: [] }` would deny every tool, so omission is preserved.
    expect(settings.subagents[0]?.tools).toBeUndefined()
    expect(settings.subagents[0]?.maxDepth).toBeUndefined()
  })

  it('ships every built-in role as a fixed definition that names no route of its own', () => {
    expect(DEFAULT_SUBAGENT_DEFINITIONS).toHaveLength(6)
    for (const definition of DEFAULT_SUBAGENT_DEFINITIONS) {
      expect({ id: definition.id, model: definition.model })
        .toEqual({ id: definition.id, model: { mode: 'fixed' } })
    }
  })

  it.each<[string, object]>([
    ['a concurrency cap below one', { limits: { maxConcurrentRuns: 0 } }],
    ['a concurrency cap above the ceiling', { limits: { maxConcurrentRuns: 99 } }],
    ['an id that is not an argv-safe token', { subagents: [{ id: 'Not Ok', name: 'x', purpose: 'y', execution: { backend: 'b' } }] }],
    ['an id starting with a digit', { subagents: [{ id: '1code', name: 'x', purpose: 'y', execution: { backend: 'b' } }] }],
    ['an access outside the ladder', { subagents: [{ id: 'code', name: 'x', purpose: 'y', access: 'root', execution: { backend: 'b' } }] }],
    ['an invocation outside the vocabulary', { subagents: [{ id: 'code', name: 'x', purpose: 'y', invocation: 'always', execution: { backend: 'b' } }] }],
    ['an unknown model mode', { subagents: [{ id: 'code', name: 'x', purpose: 'y', model: { mode: 'pinned' }, execution: { backend: 'b' } }] }],
    ['a background policy outside the vocabulary', { subagents: [{ id: 'code', name: 'x', purpose: 'y', execution: { backend: 'b', background: 'sometimes' } }] }],
  ])('rejects %s', (_label, value) => {
    expect(() => parse(value)).toThrow()
  })

  it('keeps a definition and its workspace override exactly as written', () => {
    const settings = parse({
      subagents: [{
        id: 'perf',
        name: 'Perf',
        purpose: 'Measure.',
        whenToUse: 'Use it when timing matters.',
        invocation: 'manual',
        model: { mode: 'fixed', route: { provider: 'alpha', model: 'small', reasoningEffort: 'high' } },
        access: 'read-only',
        tools: { deny: ['write'] },
        instructions: 'Only measure.',
        maxDepth: 2,
        execution: { backend: 'commandcode', background: 'background', timeoutMs: 1000 },
      }],
      overrides: { '/work': { subagents: { perf: { access: 'workspace-write' } } } },
    })
    expect(settings.subagents[0]).toEqual({
      id: 'perf',
      name: 'Perf',
      enabled: true,
      purpose: 'Measure.',
      whenToUse: 'Use it when timing matters.',
      invocation: 'manual',
      model: { mode: 'fixed', route: { provider: 'alpha', model: 'small', reasoningEffort: 'high' } },
      access: 'read-only',
      tools: { deny: ['write'] },
      instructions: 'Only measure.',
      maxDepth: 2,
      execution: { backend: 'commandcode', background: 'background', timeoutMs: 1000 },
    })
    expect(settings.overrides['/work']?.subagents.perf).toEqual({ access: 'workspace-write' })
  })
})

describe('validateSubagentSettings', () => {
  it('rejects a duplicate id', () => {
    expect(() => {
      validate({ subagents: [
        { id: 'code', name: 'One', purpose: 'a', execution: { backend: 'b' } },
        { id: 'code', name: 'Two', purpose: 'b', execution: { backend: 'b' } },
      ] })
    }).toThrow(/duplicate subagent id "code"/u)
  })

  it('rejects blank required text', () => {
    expect(() => { validate({ subagents: [{ id: 'code', name: ' ', purpose: 'a', execution: { backend: 'b' } }] }) })
      .toThrow(/needs a non-blank name/u)
    expect(() => { validate({ subagents: [{ id: 'code', name: 'a', purpose: ' ', execution: { backend: 'b' } }] }) })
      .toThrow(/needs a non-blank purpose/u)
    expect(() => { validate({ subagents: [{ id: 'code', name: 'a', purpose: 'b', execution: { backend: ' ' } }] }) })
      .toThrow(/needs a non-blank backend/u)
  })

  it('rejects a blank route half', () => {
    expect(() => {
      validate({ subagents: [{
        id: 'code', name: 'a', purpose: 'b',
        model: { mode: 'fixed', route: { provider: ' ', model: 'm' } },
        execution: { backend: 'b' },
      }] })
    }).toThrow(/needs a non-blank route provider/u)
    expect(() => {
      validate({ subagents: [{
        id: 'code', name: 'a', purpose: 'b',
        model: { mode: 'fixed', route: { provider: 'p', model: ' ' } },
        execution: { backend: 'b' },
      }] })
    }).toThrow(/needs a non-blank route model/u)
  })

  it('accepts a fixed definition that names no route, because it then inherits the parent route', () => {
    expect(() => {
      validate({ subagents: [{
        id: 'code', name: 'a', purpose: 'b',
        model: { mode: 'fixed' },
        execution: { backend: 'b' },
      }] })
    }).not.toThrow()
  })

  it('accepts the shipped document exactly as it ships', () => {
    expect(() => { validateSubagentSettings(defaultSubagentSettings()) }).not.toThrow()
    expect(() => { validate({}) }).not.toThrow()
  })

  it('rejects enabled routing with no authorized route', () => {
    expect(() => { validate({ automaticRouting: { enabled: true, allowedModels: [] } }) })
      .toThrow(/enabled automatic routing needs at least one allowed model/u)
    expect(() => {
      validate({ automaticRouting: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'small' }] } })
    }).not.toThrow()
  })

  it('rejects an empty override key and an invalid removed id', () => {
    expect(() => { validate({ overrides: { '': { subagents: {} } } }) })
      .toThrow(/an override key must not be empty/u)
    expect(() => { validate({ overrides: { '/work': { subagents: {}, removed: ['Not Ok'] } } }) })
      .toThrow(/removes an invalid subagent id/u)
    expect(() => { validate({ overrides: { '/work': { subagents: {}, removed: ['code'] } } }) })
      .not.toThrow()
  })

  it('judges a workspace override the same way it judges a definition', () => {
    expect(() => {
      validate({ overrides: { '/work': { subagents: { code: { model: { mode: 'fixed' } } } } } })
    }).not.toThrow()
    expect(() => {
      validate({ overrides: { '/work': { subagents: { code: { model: { mode: 'fixed', route: { provider: ' ', model: 'm' } } } } } } })
    }).toThrow(/needs a non-blank route provider/u)
    expect(() => { validate({ overrides: { '/work': { subagents: { code: { name: ' ' } } } } }) })
      .toThrow(/needs a non-blank name/u)
  })

  it('rejects an override keyed by an id that is not a valid token', () => {
    // The dict key carries the id, so only this layer can refuse it.
    expect(() => { validate({ overrides: { '/work': { subagents: { 'Not Ok': { name: 'x' } } } } }) })
      .toThrow(/is not a valid subagent id/u)
  })
})

describe('workspace resolution', () => {
  const global = definition({
    id: 'code',
    name: 'Code',
    purpose: 'Global purpose.',
    whenToUse: 'Global guidance.',
    invocation: 'automatic',
    model: { mode: 'automatic' },
    access: 'workspace-write',
    instructions: 'Global instructions.',
    maxDepth: 2,
    execution: { backend: 'spawn', background: 'auto' },
  })

  /** The same settings resolved for one workspace key. */
  function resolveFor(settings: SubagentSettings, workspaceKey: string | null): ResolvedSubagentDefinition {
    const [resolved] = resolveSubagentRoster(settings, workspaceKey)
    if (resolved === undefined) throw new Error('expected one resolved definition')
    return resolved
  }

  it('resolves a global definition with no override at all', () => {
    expect(resolveFor(documentOf([global]), null)).toEqual({
      ...global,
      overrides: {
        name: false, enabled: false, purpose: false, whenToUse: false, invocation: false,
        model: false, access: false, tools: false, instructions: false, maxDepth: false,
        execution: false,
      },
    })
  })

  it('reports one overridden field without disturbing the others', () => {
    const settings = documentOf([global], {
      overrides: { '/work': { subagents: { code: { purpose: 'Workspace purpose.' } } } },
    })
    const resolved = resolveFor(settings, '/work')
    expect(resolved.purpose).toBe('Workspace purpose.')
    expect(resolved.overrides.purpose).toBe(true)
    for (const field of ['name', 'enabled', 'whenToUse', 'invocation', 'model', 'access', 'instructions', 'maxDepth', 'execution'] as const) {
      expect(resolved.overrides[field]).toBe(false)
    }
    expect({
      name: resolved.name,
      enabled: resolved.enabled,
      whenToUse: resolved.whenToUse,
      invocation: resolved.invocation,
      model: resolved.model,
      access: resolved.access,
      instructions: resolved.instructions,
      maxDepth: resolved.maxDepth,
      execution: resolved.execution,
    }).toEqual({
      name: global.name,
      enabled: global.enabled,
      whenToUse: global.whenToUse,
      invocation: global.invocation,
      model: global.model,
      access: global.access,
      instructions: global.instructions,
      maxDepth: global.maxDepth,
      execution: global.execution,
    })
  })

  it.each<[string, Partial<ResolvedSubagentDefinition>]>([
    ['name', { name: 'Local name' }],
    ['purpose', { purpose: 'Local purpose.' }],
    ['whenToUse', { whenToUse: 'Local guidance.' }],
    ['invocation', { invocation: 'manual' }],
    ['model', { model: { mode: 'fixed', route: { provider: 'alpha', model: 'small' } } }],
    ['access', { access: 'read-only' }],
    ['instructions', { instructions: 'Local instructions.' }],
    ['maxDepth', { maxDepth: 7 }],
    ['execution', { execution: { backend: 'commandcode', background: 'background' } }],
    ['enabled', { enabled: false }],
  ])('round-trips %s through override and reset', (field, patch) => {
    const key = field as keyof ResolvedSubagentDefinition['overrides']
    const overridden = resolveFor(documentOf([global], {
      overrides: { '/work': { subagents: { code: patch } } },
    }), '/work')
    expect(overridden.overrides[key]).toBe(true)
    expect(overridden[field as 'name']).toEqual(patch[field as 'name'])

    const reset = resolveFor(documentOf([global], {
      overrides: { '/work': { subagents: { code: {} } } },
    }), '/work')
    expect(reset.overrides[key]).toBe(false)
    expect(reset[field as 'name']).toEqual(global[field as 'name'])
  })

  it('removes a definition for one workspace only', () => {
    const settings = documentOf([global], {
      overrides: { '/work': { subagents: {}, removed: ['code'] } },
    })
    expect(resolveSubagentRoster(settings, '/work')).toHaveLength(0)
    expect(resolveSubagentRoster(settings, '/other')).toHaveLength(1)
  })

  it('ignores an override key naming a definition that no longer exists', () => {
    const settings = documentOf([global], {
      overrides: { '/work': { subagents: { deleted: { purpose: 'stale' } } } },
    })
    const resolved = resolveSubagentRoster(settings, '/work')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.overrides.purpose).toBe(false)
  })

  it('carries the resolved routing authority and run bounds into the view', () => {
    const settings = documentOf([global], {
      automaticRouting: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'small' }] },
      limits: { maxConcurrentRuns: 5, defaultTimeoutMs: 1000 },
    })
    const view = subagentRosterView(settings, null)
    expect(view.workspaceKey).toBeNull()
    expect(view.automaticRouting).toEqual({
      enabled: true, allowedModels: [{ provider: 'alpha', model: 'small' }],
    })
    expect(view.limits).toEqual({ maxConcurrentRuns: 5, defaultTimeoutMs: 1000 })
    // The view detaches the routing list, so a caller cannot reach back into settings.
    expect(view.automaticRouting.allowedModels).not.toBe(settings.automaticRouting.allowedModels)
    expect(view.automaticRouting.allowedModels[0])
      .not.toBe(settings.automaticRouting.allowedModels[0])
    expect(view.automaticRouting.allowedModels[0]).toEqual({ provider: 'alpha', model: 'small' })
  })

  it('shares one override entry between two spellings of the same directory', () => {
    const key = canonicalWorkspaceKey(process.cwd())
    expect(key).toBe(canonicalWorkspaceKey('.'))
    expect(canonicalWorkspaceKey(resolve('.'))).toBe(key)
    const settings = documentOf([global], {
      overrides: { [key]: { subagents: { code: { purpose: 'Shared.' } } } },
    })
    expect(subagentRosterView(settings, '.').subagents[0]?.purpose).toBe('Shared.')
  })
})

describe('requireEnabledSubagent', () => {
  /** One real workspace path and the key its overrides live under. */
  const WORKSPACE = resolve('roster-spec-workspace')
  const KEY = canonicalWorkspaceKey(WORKSPACE)

  it('returns the enabled definition with its workspace override applied', () => {
    const settings = documentOf([
      definition({ id: 'code', name: 'Code' }),
      definition({ id: 'review', name: 'Review' }),
    ], { overrides: { [KEY]: { subagents: { code: { name: 'Local code' } } } } })
    const view = subagentRosterView(settings, WORKSPACE)
    expect(requireEnabledSubagent(view, 'code').name).toBe('Local code')
    // The workspace layer is this view's alone: another workspace keeps the global name.
    expect(subagentRosterView(settings, resolve('other')).subagents[0]?.name).toBe('Code')
  })

  it('names the configured roles when the id is unknown', () => {
    const view = subagentRosterView(documentOf([
      definition({ id: 'code' }),
      definition({ id: 'review' }),
    ]), null)
    expect(() => requireEnabledSubagent(view, 'ghost'))
      .toThrow('no subagent "ghost" exists; configured subagents: code, review')
  })

  it('says so when nothing is configured at all', () => {
    const view = subagentRosterView(documentOf([]), null)
    expect(() => requireEnabledSubagent(view, 'ghost'))
      .toThrow('no subagent "ghost" exists; no subagents are configured')
  })

  it('rejects a definition this workspace disabled', () => {
    const settings = documentOf([definition({ id: 'code' })], {
      overrides: { [KEY]: { subagents: { code: { enabled: false } } } },
    })
    const view = subagentRosterView(settings, WORKSPACE)
    expect(() => requireEnabledSubagent(view, 'code')).toThrow('subagent "code" is disabled')
  })

  it('rejects a definition with no backend', () => {
    const view = subagentRosterView(documentOf([
      definition({ id: 'review', execution: { backend: ' ', background: 'auto' } }),
    ]), null)
    expect(() => requireEnabledSubagent(view, 'review')).toThrow('subagent "review" has no backend configured')
  })

  it('reports a role removed for this workspace as unknown', () => {
    const settings = documentOf([definition({ id: 'code' })], {
      overrides: { [KEY]: { subagents: {}, removed: ['code'] } },
    })
    const view = subagentRosterView(settings, WORKSPACE)
    expect(() => requireEnabledSubagent(view, 'code')).toThrow(/no subagent "code" exists/u)
  })
})
