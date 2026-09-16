import { describe, expect, it } from 'vitest'
import {
  deriveLaneId,
  isOverridden,
  laneById,
  projectOverride,
  resetProjectField,
  resetProjectLane,
  withLaneField,
  withNewLane,
  withProjectField,
  withoutLane,
} from '../src/client/edit.ts'
import type { CommandCodeDelegationSettings, CommandCodeLaneSetting } from '../src/client/contract.ts'

function lane(id: string, overrides: Partial<CommandCodeLaneSetting> = {}): CommandCodeLaneSetting {
  return {
    id,
    name: id,
    purpose: `${id} purpose`,
    instructions: '',
    model: 'deepseek/deepseek-v4.1-flash',
    effort: 'default',
    access: 'read-only',
    enabled: true,
    ...overrides,
  }
}

function settings(overrides: Partial<CommandCodeDelegationSettings> = {}): CommandCodeDelegationSettings {
  return {
    maxConcurrentRuns: 2,
    timeoutMs: 3_600_000,
    maxTurns: 60,
    lanes: [lane('code'), lane('review')],
    projects: {},
    ...overrides,
  }
}

describe('lane edits', () => {
  it('replaces one field and leaves every other lane alone', () => {
    const next = withLaneField(settings(), 'review', 'model', 'local/model')
    expect(laneById(next, 'review')?.model).toBe('local/model')
    expect(laneById(next, 'code')?.model).toBe('deepseek/deepseek-v4.1-flash')
    expect(settings().lanes[1]?.model).toBe('deepseek/deepseek-v4.1-flash')
  })

  it('adds a fully specified lane', () => {
    const next = withNewLane(settings(), lane('perf'))
    expect(next.lanes.map(entry => entry.id)).toEqual(['code', 'review', 'perf'])
  })

  it('refuses to add a lane whose id is taken', () => {
    expect(() => withNewLane(settings(), lane('code'))).toThrow(/already exists/u)
  })

  it('removes a lane together with every override that patched it', () => {
    const withOverrides = settings({
      projects: {
        '/work': { lanes: { code: { model: 'local/model' }, review: { name: 'R' } } },
        '/other': { lanes: { code: { access: 'full-access' } } },
      },
    })
    const next = withoutLane(withOverrides, 'code')
    expect(next.lanes.map(entry => entry.id)).toEqual(['review'])
    expect(next.projects['/work']?.lanes.code).toBeUndefined()
    expect(next.projects['/work']?.lanes.review?.name).toBe('R')
    // A workspace whose only override named the deleted lane disappears whole.
    expect(next.projects['/other']).toBeUndefined()
  })
})

describe('workspace overrides', () => {
  it('records one overridden field and reports it as overridden', () => {
    const next = withProjectField(settings(), '/work', 'review', 'access', 'full-access')
    expect(isOverridden(next, '/work', 'review', 'access')).toBe(true)
    expect(isOverridden(next, '/work', 'review', 'model')).toBe(false)
    expect(projectOverride(next, '/work', 'review')).toEqual({ access: 'full-access' })
  })

  it('reports nothing overridden without a workspace', () => {
    const next = withProjectField(settings(), '/work', 'review', 'access', 'full-access')
    expect(isOverridden(next, null, 'review', 'access')).toBe(false)
    expect(projectOverride(next, null, 'review')).toBeUndefined()
  })

  it('resets one field back to inherited', () => {
    const overridden = withProjectField(
      withProjectField(settings(), '/work', 'review', 'access', 'full-access'),
      '/work', 'review', 'model', 'local/model',
    )
    const next = resetProjectField(overridden, '/work', 'review', 'access')
    expect(projectOverride(next, '/work', 'review')).toEqual({ model: 'local/model' })
  })

  it('drops the lane entry when its last field is reset', () => {
    const overridden = withProjectField(settings(), '/work', 'review', 'access', 'full-access')
    const next = resetProjectField(overridden, '/work', 'review', 'access')
    expect(projectOverride(next, '/work', 'review')).toBeUndefined()
    // The emptied workspace entry disappears rather than persisting as noise.
    expect(next.projects['/work']).toBeUndefined()
  })

  it('leaves another workspace untouched', () => {
    const overridden = withProjectField(settings(), '/other', 'review', 'access', 'full-access')
    const next = resetProjectField(overridden, '/work', 'review', 'access')
    expect(projectOverride(next, '/other', 'review')).toEqual({ access: 'full-access' })
  })

  it('resets every field one lane carries', () => {
    let overridden = withProjectField(settings(), '/work', 'review', 'access', 'full-access')
    overridden = withProjectField(overridden, '/work', 'review', 'instructions', 'Be terse.')
    const next = resetProjectLane(overridden, '/work', 'review')
    expect(projectOverride(next, '/work', 'review')).toBeUndefined()
  })
})

describe('deriveLaneId', () => {
  it('lower-cases and hyphenates a display name', () => {
    expect(deriveLaneId(settings(), 'Security Audit')).toBe('security-audit')
  })

  it('avoids an id already in use', () => {
    expect(deriveLaneId(settings(), 'Code')).toBe('code-2')
  })

  it('keeps the derived id inside the stored id pattern', () => {
    const id = deriveLaneId(settings(), '2 Fast!! 数据')
    expect(id).toMatch(/^[a-z][a-z0-9-]{0,39}$/u)
  })
})
