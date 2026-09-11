import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CUSTOM_HARNESS_PRODUCT } from './custom-harness-product.ts'
import { resolveCustomHarnessPaths } from './run-custom-harness.ts'

describe('Harnessy storage isolation', () => {
  it('uses product-owned directories and ignores ambient DSH_HOME', () => {
    const local = resolve('C:/phase-three-local-app-data')
    const paths = resolveCustomHarnessPaths({
      LOCALAPPDATA: local,
      DSH_HOME: resolve('C:/stock-harness-home'),
      DSH_AGENTS_HOME: resolve('C:/stock-agents-home'),
    })
    const data = join(local, CUSTOM_HARNESS_PRODUCT.dataDirectoryName)
    expect(paths).toEqual({
      data,
      home: join(data, CUSTOM_HARNESS_PRODUCT.harnessHomeDirectoryName),
      agents: join(data, CUSTOM_HARNESS_PRODUCT.agentsHomeDirectoryName),
      logs: join(data, CUSTOM_HARNESS_PRODUCT.logDirectoryName),
      cache: join(data, CUSTOM_HARNESS_PRODUCT.cacheDirectoryName),
    })
    expect(paths.home).not.toContain('stock-harness-home')
    expect(paths.agents).not.toContain('stock-agents-home')
  })

  it('keeps an explicit product home separate from the stock home', () => {
    const custom = resolve('C:/isolated/custom-harness')
    expect(resolveCustomHarnessPaths({
      CUSTOM_HARNESS_HOME: custom,
      DSH_HOME: resolve('C:/isolated/deepseek-harness'),
    }).home).toBe(custom)
  })
})
