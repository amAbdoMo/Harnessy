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

  it.each([
    'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry',
    'product-analytics', 'ui-settings-session-log',
  ])('rejects an enabled upstream data-sharing row %s', (id) => {
    const current = readCustomHarnessProductEvidence(root)
    const failures = customHarnessProductViolations({
      ...current,
      bundlePatch: current.bundlePatch.replace(`- id: ${id}\n  disabled: true`, `- id: ${id}\n  disabled: false`),
    })
    expect(failures).toContain(`custom-harness patch must disable stock row ${id}`)
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
      desktopPackageTarget: "await execute(['run', 'build:official'])\nawait execute(['run', 'release:pack'])\n",
      windowsWorkflow: 'jobs: {}\n',
    }

    const failures = customHarnessProductViolations(regressed)
    expect(failures).toContain('custom-harness patch is missing ui-brand-custom-harness')
    expect(failures).toContain('custom-harness patch must disable stock row tool-subagent')
    expect(failures).toContain('Desktop development must build the custom-harness profile')
    expect(failures).toContain('Desktop development must use the Harnessy state resolver')
    expect(failures).toContain('Desktop packaging must build the custom-harness profile')
    expect(failures).toContain('Desktop packaging must pack the custom-harness client profile')
    expect(failures).toContain('Harnessy Windows CI must run verify:harnessy-product')
    expect(failures).toContain('custom-harness bundle is missing @deepseek-ai/dsh-subagent-roster')
  })
})
