import { describe, expect, it } from 'vitest'
import { normalizeDefaultEffort, normalizeEfforts } from '@deepseek-ai/dsh-model-capabilities'

describe('normalizeEfforts', () => {
  it('keeps the levels a public claim publishes, in escalation order', () => {
    expect(normalizeEfforts(['high', 'low', 'medium'])).toEqual({
      levels: ['low', 'medium', 'high'],
      dropped: [],
    })
    expect(normalizeEfforts(['low', 'medium', 'high', 'xhigh', 'max'])).toEqual({
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      dropped: [],
    })
  })

  it('reads the published token `none` as the harness level `off`', () => {
    expect(normalizeEfforts(['none', 'low', 'high'])).toEqual({
      levels: ['off', 'low', 'high'],
      dropped: [],
    })
  })

  it('deduplicates a level published twice under both spellings', () => {
    expect(normalizeEfforts(['none', 'off', 'off', 'high'])).toEqual({
      levels: ['off', 'high'],
      dropped: [],
    })
  })

  it('drops an unknown token and keeps the levels beside it', () => {
    expect(normalizeEfforts(['low', 'turbo', 'max'])).toEqual({
      levels: ['low', 'max'],
      dropped: ['turbo'],
    })
  })

  it('treats a claim offering only `off` as no capability', () => {
    // Not thinking is the parameter's absence rather than a selectable level.
    expect(normalizeEfforts(['none'])).toEqual({ levels: [], dropped: [] })
    expect(normalizeEfforts(['off'])).toEqual({ levels: [], dropped: [] })
  })

  it('reads nothing usable from a list that is not one', () => {
    expect(normalizeEfforts(undefined)).toEqual({ levels: [], dropped: [] })
    expect(normalizeEfforts('high')).toEqual({ levels: [], dropped: [] })
    expect(normalizeEfforts({ 0: 'high' })).toEqual({ levels: [], dropped: [] })
    expect(normalizeEfforts([42, null, '', 'high'])).toEqual({ levels: ['high'], dropped: [] })
  })

  it('returns a detached list a caller cannot mutate', () => {
    const published = ['low', 'high']
    expect(normalizeEfforts(published).levels).not.toBe(published)
  })
})

describe('normalizeDefaultEffort', () => {
  it('accepts a default that names one of the normalized levels', () => {
    expect(normalizeDefaultEffort('high', ['low', 'high'])).toBe('high')
    expect(normalizeDefaultEffort('none', ['off', 'low'])).toBe('off')
  })

  it('drops a default that names no level the claim offers', () => {
    expect(normalizeDefaultEffort('xhigh', ['low', 'high'])).toBeUndefined()
    expect(normalizeDefaultEffort('turbo', ['low', 'high'])).toBeUndefined()
  })

  it('drops a default that is not a usable token', () => {
    expect(normalizeDefaultEffort(undefined, ['low'])).toBeUndefined()
    expect(normalizeDefaultEffort('', ['low'])).toBeUndefined()
    expect(normalizeDefaultEffort(42, ['low'])).toBeUndefined()
  })
})
