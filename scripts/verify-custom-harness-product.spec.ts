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

  it.each([
    "ctx.sidebarRightTabs.register({ kind: 'device-preview', guide: [{ id: 'new' }] })",
    "ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'device-preview' }, DevicePreview)",
  ])('rejects restored standalone Device Preview registration: %s', (registration) => {
    const current = readCustomHarnessProductEvidence(root)
    expect(customHarnessProductViolations({
      ...current, devicePreviewClient: `${current.devicePreviewClient}\n${registration}\n`,
    })).toContain('Device Preview must contribute inside Browser without a separate guide or tab')
  })

  it.each([
    ['devicePreviewClient', 'Device Preview must register Browser responsive content'],
    ['browserClient', 'Browser must declare its responsive content slot'],
  ] as const)('rejects removed responsive composition in %s despite stale comments', (owner, failure) => {
    const current = readCustomHarnessProductEvidence(root)
    const regressed = current[owner].replaceAll('sidebar.right.pane.tab.browser.responsive', 'removed.responsive')
    expect(regressed).not.toBe(current[owner])
    expect(customHarnessProductViolations({
      ...current,
      [owner]: `${regressed}\n// ${current[owner].replaceAll('\n', '\n// ')}\n`,
    })).toContain(failure)
  })

  it('rejects restoring the retired responsive viewport in the default Browser', () => {
    const current = readCustomHarnessProductEvidence(root)
    expect(customHarnessProductViolations({
      ...current, browserBody: `${current.browserBody}\nrenderSlot('sidebar.right.pane.tab.browser.responsive', {})\n`,
    })).toContain('Browser must keep legacy responsive controls out of its default viewport')
  })

  it.each(['BrowserControl', 'BrowserFeedback'])('rejects removing %s despite stale comments', (component) => {
    const current = readCustomHarnessProductEvidence(root)
    expect(customHarnessProductViolations({
      ...current, browserBody: `${current.browserBody.replaceAll(`<${component}`, '<Removed')}\n// <${component} />\n`,
    })).toContain(`Browser must render ${component}`)
  })

  it('ignores inactive standalone Device Preview examples', () => {
    const current = readCustomHarnessProductEvidence(root)
    expect(customHarnessProductViolations({
      ...current,
      devicePreviewClient: `${current.devicePreviewClient}\n// ctx.sidebarRightTabs.register({ kind: 'device-preview' })\n`,
    })).toEqual([])
  })

  it('rejects Windows release qualification that omits product verification', () => {
    const current = readCustomHarnessProductEvidence(root)
    expect(customHarnessProductViolations({
      ...current,
      rootManifest: {
        ...current.rootManifest,
        scripts: { ...current.rootManifest.scripts, 'release:win:x64:qualify': 'vitest run apps/desktop/tests/update-coordinator.spec.ts' },
      },
    })).toContain('Windows release qualification must run verify:harnessy-product first')
  })

  it('rejects release qualification that skips upgrade verification', () => {
    const current = readCustomHarnessProductEvidence(root)
    expect(customHarnessProductViolations({
      ...current,
      rootManifest: {
        ...current.rootManifest,
        scripts: { ...current.rootManifest.scripts, 'release:win:x64:qualify': 'pnpm run verify:harnessy-product && vitest run' },
      },
    })).toContain('Windows release qualification must run verify:harnessy-upgrade')
  })

  it('rejects Windows CI that skips upgrade verification', () => {
    const current = readCustomHarnessProductEvidence(root)
    expect(customHarnessProductViolations({
      ...current, windowsWorkflow: current.windowsWorkflow.replace('run: pnpm run verify:harnessy-upgrade', 'run: echo skipped'),
    })).toContain('Harnessy Windows CI must run verify:harnessy-upgrade')
  })

  it.each([
    'apps/desktop/tests/upgrade-settings-preservation.spec.ts',
    'apps/desktop/tests/taskbar-unread.spec.ts',
    'apps/desktop/tests/taskbar-badge.spec.ts',
    'apps/desktop/tests/taskbar-badge-windows.spec.ts',
    'packages/client/ui-brand-custom-harness/tests/native-taskbar.client.spec.ts',
    'packages/api/settings-controller/tests/accounts-controller.host.spec.ts',
    'packages/api/settings-controller/tests/mcp-manager.host.spec.ts',
    'apps/desktop-host/tests/companion-activation.spec.ts',
    'apps/desktop-host/tests/companion-deployment.spec.ts',
    'apps/desktop/tests/companion-native.spec.ts',
    'packages/host/companion-host/tests/session-management.spec.ts',
    'packages/client/ui-brand-custom-harness/tests/companion-disclosure-composition.client.spec.tsx',
  ])('rejects upgrade verification without %s', (owner) => {
    const current = readCustomHarnessProductEvidence(root)
    const verify = current.rootManifest.scripts!['verify:harnessy-upgrade']!
    expect(customHarnessProductViolations({
      ...current,
      rootManifest: {
        ...current.rootManifest,
        scripts: { ...current.rootManifest.scripts, 'verify:harnessy-upgrade': verify.replace(owner, '') },
      },
    })).toContain(`Harnessy upgrade verification must include ${owner}`)
  })
})
