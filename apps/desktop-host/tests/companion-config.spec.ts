import { describe, expect, it } from 'vitest'
import { resolveConfig } from '@deepseek-ai/dsh-companion-host'
import { config } from '../../../packages/host/companion-host/tests/composition.ts'
import { resolveDesktopCompanionConfig } from '../src/companion.ts'

const budgets = JSON.stringify(config.budgets)

function override(httpsOrigin: string, limits = budgets): NodeJS.ProcessEnv {
  return { DSH_DESKTOP_COMPANION_HTTPS_ORIGIN: httpsOrigin, DSH_DESKTOP_COMPANION_BUDGETS: limits }
}

describe('Desktop built-in companion deployment', () => {
  it('loads a usable package-relative public deployment on ordinary startup without environment settings', () => {
    const deployment = resolveDesktopCompanionConfig({})
    expect(deployment.httpsOrigin).toBe('https://harnessy.abdom.me')
    expect(resolveConfig(deployment)).toBeDefined()
  })

  it('uses a complete override without mixing in the built-in origin or budgets', () => {
    const environment = Object.freeze(override('https://operator.invalid'))
    expect(resolveDesktopCompanionConfig(environment)).toEqual({ ...config, httpsOrigin: 'https://operator.invalid' })
  })

  it.each([
    ['origin only', { DSH_DESKTOP_COMPANION_HTTPS_ORIGIN: config.httpsOrigin }],
    ['budgets only', { DSH_DESKTOP_COMPANION_BUDGETS: budgets }],
    ['blank origin only', { DSH_DESKTOP_COMPANION_HTTPS_ORIGIN: '' }],
    ['blank budgets only', { DSH_DESKTOP_COMPANION_BUDGETS: '' }],
    ['both blank', override('', '')],
    ['blank origin with complete budgets', override('')],
    ['blank budgets with valid origin', override(config.httpsOrigin, '')],
    ['malformed JSON', override(config.httpsOrigin, '{')],
    ['null budgets', override(config.httpsOrigin, 'null')],
    ['incomplete budgets', override(config.httpsOrigin, '{}')],
    ['oversize UTF-8 budgets', override(config.httpsOrigin, JSON.stringify('é'.repeat(4096)))],
    ['insecure origin', override('http://operator.invalid')],
    ['origin with path', override('https://operator.invalid/private')],
    ['schema-invalid budget', override(config.httpsOrigin, JSON.stringify({ ...config.budgets, maxGrants: 0 }))],
    ['schema-valid inconsistent limits', override(config.httpsOrigin,
      JSON.stringify({ ...config.budgets, maxCandidates: config.budgets.maxChannels + 1 }))],
    ['semantic channel limit', override(config.httpsOrigin, JSON.stringify({ ...config.budgets,
      channel: { ...config.budgets.channel, maxPendingSends: 1025 } }))],
  ] satisfies [string, NodeJS.ProcessEnv][])('rejects %s instead of silently falling back', (_name, environment) => {
    expect(() => resolveDesktopCompanionConfig(environment)).toThrow()
  })
})
