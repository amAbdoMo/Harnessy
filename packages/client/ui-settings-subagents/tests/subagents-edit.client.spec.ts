import { describe, expect, it } from 'vitest'
import type { SubagentDefinition, SubagentSettings } from '@deepseek-ai/dsh-api-remotes/client'
import { SUBAGENT_ID_PATTERN } from '../src/client/contract.ts'
import {
  SUBAGENT_OVERRIDE_FIELDS,
  changedFields,
  definitionById,
  deriveSubagentId,
  duplicateDefinition,
  effectiveDefinition,
  isDefinitionOverridden,
  overriddenFields,
  parseToolNames,
  resetWorkspace,
  resetWorkspaceDefinition,
  resetWorkspaceField,
  toolRestriction,
  withAutomaticRouting,
  withDefinition,
  withExecution,
  withNewDefinition,
  withWorkspaceField,
  withoutDefinition,
} from '../src/client/edit.ts'

const WORKSPACE = 'a:\\work'
const OTHER = 'a:\\other'

function definition(id: string, overrides: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    id,
    name: id,
    enabled: true,
    purpose: `${id} purpose`,
    whenToUse: '',
    invocation: 'automatic',
    model: { mode: 'fixed' },
    access: 'inherit',
    instructions: '',
    execution: { backend: 'spawn', background: 'auto' },
    ...overrides,
  }
}

function settings(overrides: Partial<SubagentSettings> = {}): SubagentSettings {
  return {
    subagents: [definition('code'), definition('review')],
    overrides: {},
    automaticRouting: { enabled: false, allowedModels: [] },
    limits: { maxConcurrentRuns: 2, defaultTimeoutMs: 3_600_000 },
    ...overrides,
  }
}

describe('definition edits', () => {
  it('replaces one definition and leaves every other one alone', () => {
    const next = withDefinition(settings(), 'review', definition('review', { name: 'Reviewer' }))
    expect(definitionById(next, 'review')?.name).toBe('Reviewer')
    expect(definitionById(next, 'code')?.name).toBe('code')
    expect(settings().subagents[1]?.name).toBe('review')
  })

  it('ignores an edit naming a definition that no longer exists', () => {
    const base = settings()
    expect(withDefinition(base, 'ghost', definition('ghost'))).toBe(base)
  })

  it('drops an optional field the edit cleared instead of storing a value', () => {
    const base = settings({
      subagents: [
        definition('code', { tools: { allow: ['read'] }, maxDepth: 3 }),
        definition('review'),
      ],
    })
    // Clearing a field means the edit carries no key for it, which is the shape
    // the page produces when both tool lists and the depth cap are emptied.
    const { tools, maxDepth, ...cleared } = base.subagents[0]!
    expect(tools).toEqual({ allow: ['read'] })
    expect(maxDepth).toBe(3)

    const next = withDefinition(base, 'code', cleared)
    const stored = definitionById(next, 'code')!
    expect(Object.hasOwn(stored, 'tools')).toBe(false)
    expect(Object.hasOwn(stored, 'maxDepth')).toBe(false)
  })

  it('drops a cleared execution bound', () => {
    const base = settings({
      subagents: [definition('code', { execution: { backend: 'spawn', background: 'auto', timeoutMs: 1000 } })],
    })
    const next = withDefinition(base, 'code', {
      ...base.subagents[0]!,
      execution: withExecution(base.subagents[0]!.execution, { timeoutMs: undefined }),
    })
    expect(Object.hasOwn(definitionById(next, 'code')!.execution, 'timeoutMs')).toBe(false)
  })

  it('appends one fully specified definition', () => {
    const next = withNewDefinition(settings(), definition('docs'))
    expect(next.subagents.map(entry => entry.id)).toEqual(['code', 'review', 'docs'])
  })

  it('refuses to add a definition whose id is taken', () => {
    expect(() => withNewDefinition(settings(), definition('code'))).toThrow(/already exists/u)
  })

  it('copies a definition under a fresh id, disabled', () => {
    const next = duplicateDefinition(settings(), 'code')
    expect(next.subagents.map(entry => entry.id)).toEqual(['code', 'review', 'code-copy'])
    const copy = definitionById(next, 'code-copy')!
    expect(copy.name).toBe('code copy')
    expect(copy.enabled).toBe(false)
    expect(copy.purpose).toBe('code purpose')
  })

  it('ignores a duplicate naming a definition that no longer exists', () => {
    const base = settings()
    expect(duplicateDefinition(base, 'ghost')).toBe(base)
  })

  it('removes a definition together with every override and removal that named it', () => {
    const base = settings({
      overrides: {
        [WORKSPACE]: { subagents: { code: { name: 'Patched' }, review: { access: 'read-only' } } },
        [OTHER]: { subagents: { code: { access: 'workspace-write' } } },
      },
    })
    const next = withoutDefinition(base, 'code')
    expect(next.subagents.map(entry => entry.id)).toEqual(['review'])
    expect(next.overrides[WORKSPACE]?.subagents.code).toBeUndefined()
    expect(next.overrides[WORKSPACE]?.subagents.review?.access).toBe('read-only')
    // A workspace whose only override named the deleted definition disappears whole.
    expect(next.overrides[OTHER]).toBeUndefined()
  })

  it('removes the deleted id from a workspace removal list', () => {
    const base = settings({ overrides: { [WORKSPACE]: { subagents: {}, removed: ['code', 'review'] } } })
    const next = withoutDefinition(base, 'code')
    expect(next.overrides[WORKSPACE]?.removed).toEqual(['review'])
  })
})

describe('tool restrictions', () => {
  it('parses comma-separated names, dropping blanks', () => {
    expect(parseToolNames(' read , , write ')).toEqual(['read', 'write'])
    expect(parseToolNames('   ')).toEqual([])
  })

  it('stores each list the user named, omitting the empty one', () => {
    expect(toolRestriction('read', '')).toEqual({ allow: ['read'] })
    expect(toolRestriction('', 'bash')).toEqual({ deny: ['bash'] })
    expect(toolRestriction('read', 'bash')).toEqual({ allow: ['read'], deny: ['bash'] })
  })

  it('clears the restriction when both lists are blank, rather than denying every tool', () => {
    expect(toolRestriction('', '')).toBeUndefined()
  })
})

describe('execution edits', () => {
  it('replaces only the fields the patch names', () => {
    const base = { backend: 'spawn', background: 'auto' as const, timeoutMs: 1000 }
    expect(withExecution(base, { backend: 'fork' })).toEqual({ backend: 'fork', background: 'auto', timeoutMs: 1000 })
    expect(withExecution(base, { background: 'background' })).toEqual({ backend: 'spawn', background: 'background', timeoutMs: 1000 })
    expect(withExecution(base, { timeoutMs: 2000 })).toEqual({ backend: 'spawn', background: 'auto', timeoutMs: 2000 })
  })

  it('clears a bound the patch set to undefined', () => {
    expect(withExecution({ backend: 'spawn', background: 'auto', timeoutMs: 1000 }, { timeoutMs: undefined }))
      .toEqual({ backend: 'spawn', background: 'auto' })
  })
})

describe('workspace overrides', () => {
  it('records one overridden field and reports it as overridden', () => {
    const next = withWorkspaceField(settings(), WORKSPACE, 'review', 'access', 'read-only')
    expect(isDefinitionOverridden(next, WORKSPACE, 'review', 'access')).toBe(true)
    expect(isDefinitionOverridden(next, WORKSPACE, 'review', 'name')).toBe(false)
    expect(next.overrides[WORKSPACE]?.subagents.review).toEqual({ access: 'read-only' })
  })

  it('reports nothing overridden without a workspace', () => {
    const next = withWorkspaceField(settings(), WORKSPACE, 'review', 'access', 'read-only')
    expect(isDefinitionOverridden(next, null, 'review', 'access')).toBe(false)
    expect(overriddenFields(next, null, 'review')).toEqual([])
  })

  it('resetting a field clears the override instead of recording an undefined value', () => {
    const next = withWorkspaceField(settings(), WORKSPACE, 'review', 'tools', undefined)
    expect(isDefinitionOverridden(next, WORKSPACE, 'review', 'tools')).toBe(false)
    expect(next.overrides[WORKSPACE]).toBeUndefined()
  })

  it('lists the overridden fields in editor order', () => {
    let next = withWorkspaceField(settings(), WORKSPACE, 'review', 'name', 'Reviewer')
    next = withWorkspaceField(next, WORKSPACE, 'review', 'enabled', false)
    expect(overriddenFields(next, WORKSPACE, 'review')).toEqual(['enabled', 'name'])
  })

  it('resolves the effective definition from the override layer', () => {
    const base = settings({ subagents: [definition('code', { purpose: 'global', access: 'inherit' }), definition('review')] })
    const next = withWorkspaceField(base, WORKSPACE, 'code', 'purpose', 'local')
    const effective = effectiveDefinition(next, WORKSPACE, 'code')!
    expect(effective.purpose).toBe('local')
    expect(effective.access).toBe('inherit')
    expect(effective.name).toBe('code')
    expect(effectiveDefinition(next, WORKSPACE, 'ghost')).toBeUndefined()
  })

  it('resolves the untouched definition to itself', () => {
    const base = settings({ subagents: [definition('code')] })
    expect(effectiveDefinition(base, WORKSPACE, 'code')).toBe(base.subagents[0])
  })

  it('resets one field back to inherited', () => {
    let next = withWorkspaceField(settings(), WORKSPACE, 'review', 'access', 'read-only')
    next = withWorkspaceField(next, WORKSPACE, 'review', 'name', 'Reviewer')
    const reset = resetWorkspaceField(next, WORKSPACE, 'review', 'access')
    expect(reset.overrides[WORKSPACE]?.subagents.review).toEqual({ name: 'Reviewer' })
  })

  it('drops the definition entry when its last field is reset', () => {
    const overridden = withWorkspaceField(settings(), WORKSPACE, 'review', 'access', 'read-only')
    const reset = resetWorkspaceField(overridden, WORKSPACE, 'review', 'access')
    expect(reset.overrides[WORKSPACE]).toBeUndefined()
  })

  it('leaves another workspace untouched when one field is reset', () => {
    const overridden = withWorkspaceField(settings(), OTHER, 'review', 'access', 'read-only')
    const reset = resetWorkspaceField(overridden, WORKSPACE, 'review', 'access')
    expect(reset.overrides[OTHER]?.subagents.review).toEqual({ access: 'read-only' })
  })

  it('resets every field one definition carries for a workspace', () => {
    let next = withWorkspaceField(settings(), WORKSPACE, 'review', 'access', 'read-only')
    next = withWorkspaceField(next, WORKSPACE, 'review', 'name', 'Reviewer')
    const reset = resetWorkspaceDefinition(next, WORKSPACE, 'review')
    expect(reset.overrides[WORKSPACE]).toBeUndefined()
  })

  it('keeps a workspace removal list when its last field override is reset', () => {
    const base = settings({
      overrides: { [WORKSPACE]: { subagents: { review: { name: 'Reviewer' } }, removed: ['code'] } },
    })
    const reset = resetWorkspaceDefinition(base, WORKSPACE, 'review')
    expect(reset.overrides[WORKSPACE]).toEqual({ subagents: {}, removed: ['code'] })
  })

  it('resets every override one workspace carries', () => {
    let next = withWorkspaceField(settings(), WORKSPACE, 'review', 'access', 'read-only')
    next = withWorkspaceField(next, OTHER, 'code', 'name', 'Patched')
    const reset = resetWorkspace(next, WORKSPACE)
    expect(reset.overrides[WORKSPACE]).toBeUndefined()
    expect(reset.overrides[OTHER]?.subagents.code).toEqual({ name: 'Patched' })
  })

  it('covers every override field the Host resolves', () => {
    expect(SUBAGENT_OVERRIDE_FIELDS).toHaveLength(11)
  })
})

describe('automatic routing and field diffs', () => {
  it('replaces the authority', () => {
    const next = withAutomaticRouting(settings(), { enabled: true, allowedModels: [{ provider: 'p', model: 'm' }] })
    expect(next.automaticRouting).toEqual({ enabled: true, allowedModels: [{ provider: 'p', model: 'm' }] })
  })

  it('reports only the top-level fields an edit moved', () => {
    const base = settings()
    const moved = withWorkspaceField(base, WORKSPACE, 'review', 'access', 'read-only')
    expect(changedFields(base, moved)).toEqual({ overrides: moved.overrides })

    const renamed = withDefinition(base, 'code', definition('code', { name: 'Renamed' }))
    expect(changedFields(base, renamed)).toEqual({ subagents: renamed.subagents })

    expect(changedFields(base, base)).toEqual({})
  })
})

describe('deriveSubagentId', () => {
  it('lower-cases and hyphenates a display name', () => {
    expect(deriveSubagentId(settings(), 'Security Audit')).toBe('security-audit')
  })

  it('avoids an id already in use', () => {
    expect(deriveSubagentId(settings(), 'Code')).toBe('code-2')
  })

  it('keeps every derived id inside the Host pattern', () => {
    for (const name of ['2 Fast!! 数据', '--', 'Code', 'A'.repeat(80), '___', 'ünïcode']) {
      expect(deriveSubagentId(settings(), name)).toMatch(SUBAGENT_ID_PATTERN)
    }
  })
})
