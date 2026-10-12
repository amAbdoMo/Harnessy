/** Optional activation and complete endpoint budget validation. */
import { describe, expect, it } from 'vitest'
import { MAX_NORMALIZED_RELAY_FRAME_BYTES } from '@deepseek-ai/dsh-companion-protocol'
import { Config, resolveConfig } from '../src/config.ts'
import { config } from './composition.ts'

describe('companion Host deployment configuration', () => {
  it('leaves an omitted origin disabled without synthesizing budgets', () => {
    expect(resolveConfig(Config({}))).toBeUndefined()
  })

  it('retains explicitly configured cryptographic queue limits', () => {
    expect(resolveConfig(Config(config))?.budgets.channel).toEqual(config.budgets.channel)
  })

  it('admits complete normalized relay frames and rejects a receiver floor one byte too small before socket construction', () => {
    const boundary = { ...config, budgets: { ...config.budgets, maxFrameBytes: MAX_NORMALIZED_RELAY_FRAME_BYTES } }
    expect(resolveConfig(Config(boundary))?.budgets.maxFrameBytes).toBe(MAX_NORMALIZED_RELAY_FRAME_BYTES)
    const tooSmall = { ...boundary, budgets: { ...boundary.budgets, maxFrameBytes: MAX_NORMALIZED_RELAY_FRAME_BYTES - 1 } }
    expect(() => Config(tooSmall)).toThrow()
    expect(() => resolveConfig(tooSmall)).toThrow('inconsistent budgets')
  })

  it.each([
    { httpsOrigin: config.httpsOrigin },
    { budgets: config.budgets },
    { ...config, budgets: { ...config.budgets, channel: undefined } },
    { ...config, budgets: { ...config.budgets, channel: {} } },
    { ...config, budgets: { ...config.budgets, channel: { ...config.budgets.channel, maxPendingSends: 1025 } } },
  ])('rejects incomplete or invalid deployment limits %#', (input) => {
    expect(() => {
      // Schemastery's callable validates unknown JSON although its source generic requires decoded Config.
      const parse = Config as (value: unknown) => Config
      resolveConfig(parse(input))
    }).toThrow()
  })
})
