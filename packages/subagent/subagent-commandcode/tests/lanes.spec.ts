import { describe, expect, it } from 'vitest'
import {
  canonicalWorkspaceKey,
  composeCommandCodeBrief,
  DEFAULT_COMMAND_CODE_LANES,
  DEFAULT_COMMAND_CODE_MODEL,
  laneDirectory,
  resolveLanes,
  assertCommandCodeDelegationSettings,
} from '../src/lanes.ts'
import type { CommandCodeDelegationSettings, ResolvedCommandCodeLane } from '../src/types.ts'

/** A section with the shipped defaults and no overrides. */
function defaults(): CommandCodeDelegationSettings {
  return {
    maxConcurrentRuns: 2,
    timeoutMs: 3_600_000,
    maxTurns: 60,
    lanes: DEFAULT_COMMAND_CODE_LANES.map(lane => ({ ...lane })),
    projects: {},
  }
}

describe('built-in lanes', () => {
  it('ships the six documented lanes on the documented model', () => {
    expect(DEFAULT_COMMAND_CODE_LANES.map(lane => lane.id))
      .toEqual(['code', 'review', 'tests', 'docs', 'research', 'architecture'])
    expect(DEFAULT_COMMAND_CODE_LANES.every(lane => lane.model === DEFAULT_COMMAND_CODE_MODEL)).toBe(true)
    expect(DEFAULT_COMMAND_CODE_LANES.every(lane => lane.effort === 'default')).toBe(true)
    expect(DEFAULT_COMMAND_CODE_LANES.every(lane => lane.enabled)).toBe(true)
  })

  it('gives write access only to the lanes that produce changes', () => {
    const access = Object.fromEntries(DEFAULT_COMMAND_CODE_LANES.map(lane => [lane.id, lane.access]))
    expect(access).toEqual({
      code: 'full-access',
      review: 'read-only',
      tests: 'full-access',
      docs: 'full-access',
      research: 'read-only',
      architecture: 'read-only',
    })
  })
})

describe('canonicalWorkspaceKey', () => {
  it('resolves one directory to one key', () => {
    expect(canonicalWorkspaceKey('a/../b')).toBe(canonicalWorkspaceKey('b'))
  })

  it('folds case only where the filesystem does', () => {
    const mixed = canonicalWorkspaceKey('/Work/Project')
    expect(mixed === '/Work/Project').toBe(process.platform !== 'win32')
  })
})

describe('resolveLanes', () => {
  it('inherits every field the workspace does not override', () => {
    const settings = defaults()
    const [code] = resolveLanes(settings, '/work') as [ResolvedCommandCodeLane]
    expect(code.model).toBe(DEFAULT_COMMAND_CODE_MODEL)
    expect(code.access).toBe('full-access')
    expect(Object.values(code.overrides).every(value => value === false)).toBe(true)
  })

  it('applies a project patch field by field and records provenance', () => {
    const settings = defaults()
    settings.projects[canonicalWorkspaceKey('/work')] = {
      lanes: { review: { model: 'local/model', access: 'full-access' } },
    }
    const lanes = resolveLanes(settings, canonicalWorkspaceKey('/work'))
    const review = lanes.find(lane => lane.id === 'review')
    expect(review?.model).toBe('local/model')
    expect(review?.access).toBe('full-access')
    expect(review?.purpose).toBe(DEFAULT_COMMAND_CODE_LANES[1]?.purpose)
    expect(review?.overrides.model).toBe(true)
    expect(review?.overrides.access).toBe(true)
    expect(review?.overrides.name).toBe(false)
    expect(review?.overrides.purpose).toBe(false)
  })

  it('keeps another workspace on the global values', () => {
    const settings = defaults()
    settings.projects[canonicalWorkspaceKey('/other')] = { lanes: { review: { name: 'Renamed' } } }
    const review = resolveLanes(settings, canonicalWorkspaceKey('/work'))
      .find(lane => lane.id === 'review')
    expect(review?.name).toBe('Review')
    expect(review?.overrides.name).toBe(false)
  })

  it('uses the global lanes when the session has no workspace', () => {
    const settings = defaults()
    settings.projects[canonicalWorkspaceKey('/work')] = { lanes: { code: { model: 'other' } } }
    const code = resolveLanes(settings, null).find(lane => lane.id === 'code')
    expect(code?.model).toBe(DEFAULT_COMMAND_CODE_MODEL)
    expect(code?.overrides.model).toBe(false)
  })

  it('ignores an override keyed by a lane that no longer exists', () => {
    const settings = defaults()
    settings.projects['/work'] = { lanes: { ghost: { name: 'Ghost' } } }
    expect(resolveLanes(settings, '/work')).toHaveLength(DEFAULT_COMMAND_CODE_LANES.length)
  })

  it('carries a workspace that clears the lane instructions', () => {
    const settings = defaults()
    settings.lanes = settings.lanes.map(lane =>
      lane.id === 'code' ? { ...lane, instructions: 'Be terse.' } : lane)
    settings.projects['/work'] = { lanes: { code: { instructions: '' } } }
    const code = resolveLanes(settings, '/work').find(lane => lane.id === 'code')
    expect(code?.instructions).toBe('')
    expect(code?.overrides.instructions).toBe(true)
  })
})

describe('laneDirectory', () => {
  it('reports enabled lanes and nothing else', () => {
    const settings = defaults()
    settings.lanes = settings.lanes.map(lane =>
      lane.id === 'docs' ? { ...lane, enabled: false } : { ...lane, instructions: 'secret policy' })
    const directory = laneDirectory(resolveLanes(settings, null))
    expect(directory.map(entry => entry.id)).not.toContain('docs')
    expect(JSON.stringify(directory)).not.toContain('secret policy')
    expect(Object.keys(directory[0] ?? {}).sort())
      .toEqual(['access', 'effort', 'id', 'model', 'name', 'purpose'])
  })
})

describe('composeCommandCodeBrief', () => {
  it('prepends the lane instructions to the task', () => {
    expect(composeCommandCodeBrief('Follow the house style.', 'Add a test.'))
      .toBe('Follow the house style.\n\nAdd a test.')
  })

  it('uses the task alone when the lane has no instructions', () => {
    expect(composeCommandCodeBrief('   ', 'Add a test.')).toBe('Add a test.')
  })

  it('rejects an empty task', () => {
    expect(() => composeCommandCodeBrief('guidance', '   ')).toThrow(/task must not be empty/u)
  })
})

describe('assertCommandCodeDelegationSettings', () => {
  it('accepts the shipped defaults', () => {
    expect(() => { assertCommandCodeDelegationSettings(defaults()) }).not.toThrow()
  })

  it('rejects two lanes sharing one id', () => {
    const settings = defaults()
    settings.lanes.push({ ...DEFAULT_COMMAND_CODE_LANES[0]! })
    expect(() => { assertCommandCodeDelegationSettings(settings) }).toThrow(/duplicate lane id/u)
  })

  it('rejects an empty workspace key', () => {
    const settings = defaults()
    settings.projects[''] = { lanes: {} }
    expect(() => { assertCommandCodeDelegationSettings(settings) }).toThrow(/must not be empty/u)
  })

  it('rejects an override that blanks the model', () => {
    const settings = defaults()
    settings.projects['/work'] = { lanes: { code: { model: '' } } }
    expect(() => { assertCommandCodeDelegationSettings(settings) }).toThrow(/override for lane "code" needs a non-blank model/u)
  })

  it('rejects a lane whose model is only whitespace', () => {
    const settings = defaults()
    settings.lanes = settings.lanes.map(lane => lane.id === 'code' ? { ...lane, model: '   ' } : lane)
    expect(() => { assertCommandCodeDelegationSettings(settings) }).toThrow(/lane "code" needs a non-blank model/u)
  })

  it('rejects an override whose model is only whitespace', () => {
    const settings = defaults()
    settings.projects['/work'] = { lanes: { review: { model: '\t ' } } }
    expect(() => { assertCommandCodeDelegationSettings(settings) }).toThrow(/override for lane "review" needs a non-blank model/u)
  })

  it('leaves an exact model id otherwise unrestricted', () => {
    const settings = defaults()
    settings.lanes = settings.lanes.map(lane =>
      lane.id === 'code' ? { ...lane, model: ' local/model:v1 ' } : lane)
    expect(() => { assertCommandCodeDelegationSettings(settings) }).not.toThrow()
  })
})
