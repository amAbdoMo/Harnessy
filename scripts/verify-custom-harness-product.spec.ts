/** Harnessy product-composition verification tests. */

import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  customHarnessProductViolations,
  readCustomHarnessProductEvidence,
} from './verify-custom-harness-product.ts'

const root = resolve(import.meta.dirname, '..')

describe('Harnessy product contract', () => {
  it('accepts the repository product composition', () => {
    expect(customHarnessProductViolations(readCustomHarnessProductEvidence(root))).toEqual([])
  })

  it('rejects a stock Desktop launcher and missing custom owners', () => {
    const current = readCustomHarnessProductEvidence(root)
    const regressed = {
      ...current,
      bundleManifest: {
        ...current.bundleManifest,
        dependencies: {},
      },
      bundlePatch: current.bundlePatch
        .replace('    - id: ui-brand-custom-harness', '    - id: ui-brand-stock')
        .replace('- id: tool-subagent\n  disabled: true', '- id: tool-subagent\n  disabled: false'),
      desktopDevelopmentLauncher: 'await runPackageScript(\'build:official\', REPOSITORY_ROOT)',
      windowsWorkflow: 'jobs: {}\n',
    }

    const failures = customHarnessProductViolations(regressed)
    expect(failures).toContain('custom-harness patch is missing ui-brand-custom-harness')
    expect(failures).toContain('custom-harness patch must disable stock row tool-subagent')
    expect(failures).toContain('Desktop development must build the custom-harness profile')
    expect(failures).toContain('Desktop development must use the Harnessy state resolver')
    expect(failures).toContain('Harnessy Windows CI must run verify:harnessy-product')
    expect(failures).toContain('custom-harness bundle is missing @deepseek-ai/dsh-subagent-roster')
  })
})
