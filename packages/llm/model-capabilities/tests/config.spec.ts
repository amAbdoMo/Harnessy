import { describe, expect, it } from 'vitest'
import {
  assertServiceableConfig,
  MAX_CACHE_TTL_MS,
  MODEL_CAPABILITIES_DEFAULTS,
  MODEL_CAPABILITIES_NAMESPACE,
  ModelCapabilitiesConfigSchema,
  parseCacheTtl,
  resolvePolicy,
} from '@deepseek-ai/dsh-model-capabilities'
import type { ModelCapabilitiesConfig } from '@deepseek-ai/dsh-model-capabilities'

/** One config with the defaults, overridable per test. */
function config(publicMetadata: Partial<ModelCapabilitiesConfig['publicMetadata']> = {}): ModelCapabilitiesConfig {
  return { publicMetadata: { ...MODEL_CAPABILITIES_DEFAULTS.publicMetadata, ...publicMetadata } }
}

/**
 * Resolve one raw settings section through the schema.
 *
 * The input is deliberately untyped: these cases are the documents a user can
 * write, which the schema is what validates.
 * @param raw - the section as a settings document states it.
 * @returns the resolved section.
 */
function resolveSection(raw: unknown): unknown {
  return (ModelCapabilitiesConfigSchema as unknown as (value: unknown) => unknown)(raw)
}

describe('the settings namespace', () => {
  it('is the hyphenated identifier the settings seam accepts', () => {
    expect(MODEL_CAPABILITIES_NAMESPACE).toBe('model-capabilities')
  })
})

describe('defaults', () => {
  it('keeps the layer on, refreshing automatically on a weekly cadence', () => {
    expect(MODEL_CAPABILITIES_DEFAULTS).toEqual({
      publicMetadata: { enabled: true, refresh: 'auto', cacheTtl: '7d' },
    })
  })

  it('resolves an absent section to the defaults', () => {
    expect(resolveSection({})).toEqual(MODEL_CAPABILITIES_DEFAULTS)
  })

  it('resolves a partially stated section, taking the default for each absent field', () => {
    expect(resolveSection({ publicMetadata: { refresh: 'never' } })).toEqual({
      publicMetadata: { enabled: true, refresh: 'never', cacheTtl: '7d' },
    })
  })

  it('keeps the section the user stated', () => {
    expect(resolveSection({ publicMetadata: { enabled: false, refresh: 'manual', cacheTtl: '1h' } }))
      .toEqual({ publicMetadata: { enabled: false, refresh: 'manual', cacheTtl: '1h' } })
  })

  it('refuses a refresh mode outside the three the layer implements', () => {
    expect(() => resolveSection({ publicMetadata: { refresh: 'sometimes' } })).toThrow()
  })
})

describe('parseCacheTtl', () => {
  it('reads each accepted unit', () => {
    expect(parseCacheTtl('500ms')).toBe(500)
    expect(parseCacheTtl('30s')).toBe(30_000)
    expect(parseCacheTtl('15m')).toBe(900_000)
    expect(parseCacheTtl('12h')).toBe(43_200_000)
    expect(parseCacheTtl('7d')).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('reads the whole accepted range', () => {
    expect(parseCacheTtl('1ms')).toBe(1)
    expect(parseCacheTtl('365d')).toBe(MAX_CACHE_TTL_MS)
  })

  it('refuses every form this grammar does not accept', () => {
    for (const value of [
      '',
      '7',
      'd7',
      '7 days',
      '7D',
      '-7d',
      '7.5d',
      '1d12h',
      '+7d',
      '7dd',
      ' 7d',
      '7d ',
      '7w',
      '1e3d',
    ]) {
      expect(() => parseCacheTtl(value), value).toThrow(/must be a positive integer with one unit/u)
    }
  })

  it('refuses zero, a value over the ceiling, and one that overflows a safe integer', () => {
    expect(() => parseCacheTtl('0d')).toThrow(/must be greater than 0 and at most 365d/u)
    expect(() => parseCacheTtl('366d')).toThrow(/must be greater than 0 and at most 365d/u)
    expect(() => parseCacheTtl('999999999999999d')).toThrow(/must be greater than 0 and at most 365d/u)
  })
})

describe('resolvePolicy', () => {
  it('converts the configured duration once, so no consumer parses it again', () => {
    expect(resolvePolicy(config({ cacheTtl: '3d' }))).toEqual({ enabled: true, refresh: 'auto', cacheTtlMs: 259_200_000 })
  })

  it('carries the switch and the mode through unchanged', () => {
    expect(resolvePolicy(config({ enabled: false, refresh: 'manual' })))
      .toMatchObject({ enabled: false, refresh: 'manual' })
  })

  it('refuses an unreadable duration rather than resolving a policy nobody can serve', () => {
    expect(() => resolvePolicy(config({ cacheTtl: 'weekly' }))).toThrow(/cacheTtl/u)
  })
})

describe('assertServiceableConfig', () => {
  it('accepts an accepted duration and refuses an unreadable one', () => {
    expect(() => { assertServiceableConfig(config({ cacheTtl: '2d' })) }).not.toThrow()
    expect(() => { assertServiceableConfig(config({ cacheTtl: '' })) }).toThrow(/cacheTtl/u)
  })
})
