/** Harnessy product-composition verification for local and CI use. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CUSTOM_HARNESS_PRODUCT } from './custom-harness-product.ts'

interface ProductIdentityEvidence {
  readonly displayName: string
  readonly slug: string
  readonly windowsAppId: string
  readonly dataDirectoryName: string
  readonly nativeDeepSeekOnboarding: boolean
  readonly automaticUpdates: boolean
  readonly desktopProfileBundles: readonly string[]
}

interface RootManifest {
  readonly scripts?: Readonly<Record<string, string>>
}

interface BundleManifest {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly dsh?: {
    readonly bundle?: {
      readonly patch?: readonly string[]
    }
  }
}

interface CustomHarnessProductEvidence {
  readonly product: ProductIdentityEvidence
  readonly rootManifest: RootManifest
  readonly bundleManifest: BundleManifest
  readonly bundlePatch: string
  readonly desktopDevelopmentLauncher: string
  readonly desktopPackageTarget: string
  readonly windowsWorkflow: string
}

const EXPECTED_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-custom-harness',
] as const

const REQUIRED_BUNDLE_PATCHES = [
  './cordis.patch.yml',
  './presets/standard.patch.yml',
  './presets/ptc.patch.yml',
  './presets/minimal.patch.yml',
  './presets/cordis.patch.yml',
] as const

const REQUIRED_CUSTOM_DEPENDENCIES = [
  '@deepseek-ai/dsh-authorization',
  '@deepseek-ai/dsh-client-ui-brand-custom-harness',
  '@deepseek-ai/dsh-client-ui-settings-subagents',
  '@deepseek-ai/dsh-client-ui-workspace-brief',
  '@deepseek-ai/dsh-model-capabilities',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-subagent-commandcode',
  '@deepseek-ai/dsh-subagent-roster',
  '@deepseek-ai/dsh-workspace-brief',
] as const

const REQUIRED_PATCH_ROWS = [
  'custom-harness-policy',
  'authorization',
  'workspace-brief',
  'harnessy-shared-skills',
  'ui-brand-custom-harness',
  'commandcode-delegation',
  'model-capabilities',
  'subagent-roster',
  'ui-settings-subagents',
  'ui-workspace-brief',
] as const

const DISABLED_STOCK_ROWS = [
  'ui-brand-official',
  'ui-settings-account',
  'ui-settings-subagent',
  'tool-subagent',
  'tool-subagent-fork',
  'llm-deepseek',
] as const

function hasPatchRow(source: string, id: string): boolean {
  return new RegExp(`^\\s*- id: ${id}\\s*$`, 'mu').test(source)
}

function hasDisabledPatchRow(source: string, id: string): boolean {
  return new RegExp(`^\\s*- id: ${id}\\s*\\r?\\n\\s+disabled: true\\s*$`, 'mu').test(source)
}

function verifyProductIdentity(product: ProductIdentityEvidence): string[] {
  const failures: string[] = []
  if (product.displayName !== 'Harnessy') failures.push('product display name must remain Harnessy')
  if (product.slug !== 'custom-harness') failures.push('product slug must remain custom-harness')
  if (product.windowsAppId !== 'com.amabdmo.customharness') failures.push('Windows application id must remain isolated')
  if (product.dataDirectoryName !== 'CustomHarness') failures.push('local application data must remain isolated under CustomHarness')
  if (product.nativeDeepSeekOnboarding) failures.push('stock DeepSeek onboarding must remain disabled')
  if (!product.automaticUpdates) failures.push('signed Harnessy automatic updates must remain enabled')
  if (JSON.stringify(product.desktopProfileBundles) !== JSON.stringify(EXPECTED_BUNDLES)) {
    failures.push('desktop profile must compose base, web-app, and custom-harness bundles in order')
  }
  return failures
}

function verifyRootScripts(manifest: RootManifest): string[] {
  const failures: string[] = []
  if (manifest.scripts?.['build:custom-harness'] !== 'tsx scripts/build.ts --profile custom-harness') {
    failures.push('build:custom-harness must build the custom-harness profile')
  }
  if (manifest.scripts?.['dev:desktop'] !== 'pnpm --filter @deepseek-ai/dsh-desktop run dev') {
    failures.push('dev:desktop must use the guarded Desktop development launcher')
  }
  if (!manifest.scripts?.['verify:harnessy-product']?.startsWith('tsx scripts/verify-custom-harness-product.ts')) {
    failures.push('verify:harnessy-product must run the static product verifier first')
  }
  return failures
}

function verifyBundle(manifest: BundleManifest, patch: string): string[] {
  const failures: string[] = []
  if (JSON.stringify(manifest.dsh?.bundle?.patch) !== JSON.stringify(REQUIRED_BUNDLE_PATCHES)) {
    failures.push('custom-harness bundle must apply every product and preset patch')
  }
  for (const dependency of REQUIRED_CUSTOM_DEPENDENCIES) {
    if (manifest.dependencies?.[dependency] === undefined) failures.push(`custom-harness bundle is missing ${dependency}`)
  }
  for (const id of REQUIRED_PATCH_ROWS) {
    if (!hasPatchRow(patch, id)) failures.push(`custom-harness patch is missing ${id}`)
  }
  for (const id of DISABLED_STOCK_ROWS) {
    if (!hasDisabledPatchRow(patch, id)) failures.push(`custom-harness patch must disable stock row ${id}`)
  }
  return failures
}

function verifyDevelopmentAndCi(evidence: CustomHarnessProductEvidence): string[] {
  const failures: string[] = []
  if (!evidence.desktopDevelopmentLauncher.includes("runPackageScript('build:custom-harness'")) {
    failures.push('Desktop development must build the custom-harness profile')
  }
  if (!evidence.desktopDevelopmentLauncher.includes('resolveCustomHarnessPaths')) {
    failures.push('Desktop development must use the Harnessy state resolver')
  }
  if (!evidence.desktopPackageTarget.includes("execute(['run', 'build:custom-harness']")) {
    failures.push('Desktop packaging must build the custom-harness profile')
  }
  if (!/['"]--client-profile['"],\s*['"]custom-harness['"]/u.test(evidence.desktopPackageTarget)) {
    failures.push('Desktop packaging must pack the custom-harness client profile')
  }
  if (!evidence.windowsWorkflow.includes('run: pnpm run verify:harnessy-product')) {
    failures.push('Harnessy Windows CI must run verify:harnessy-product')
  }
  return failures
}

/**
 * Validate the product identity, custom bundle, development launcher, and fork CI evidence.
 * @param evidence - parsed repository evidence or a test fixture.
 * @returns deterministic descriptions of every product regression.
 */
export function customHarnessProductViolations(evidence: CustomHarnessProductEvidence): string[] {
  return [
    ...verifyProductIdentity(evidence.product),
    ...verifyRootScripts(evidence.rootManifest),
    ...verifyBundle(evidence.bundleManifest, evidence.bundlePatch),
    ...verifyDevelopmentAndCi(evidence),
  ]
}

/**
 * Read the product evidence owned by a repository checkout.
 * @param root - repository root.
 * @returns parsed product evidence.
 */
export function readCustomHarnessProductEvidence(root: string): CustomHarnessProductEvidence {
  return {
    product: CUSTOM_HARNESS_PRODUCT,
    rootManifest: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as RootManifest,
    bundleManifest: JSON.parse(readFileSync(resolve(root, 'packages/bundle/custom-harness/package.json'), 'utf8')) as BundleManifest,
    bundlePatch: readFileSync(resolve(root, 'packages/bundle/custom-harness/cordis.patch.yml'), 'utf8'),
    desktopDevelopmentLauncher: readFileSync(resolve(root, 'apps/desktop/scripts/dev.ts'), 'utf8'),
    desktopPackageTarget: readFileSync(resolve(root, 'apps/desktop/scripts/package-target.ts'), 'utf8'),
    windowsWorkflow: readFileSync(resolve(root, '.github/workflows/custom-harness-windows.yml'), 'utf8'),
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..')
  const failures = customHarnessProductViolations(readCustomHarnessProductEvidence(root))
  if (failures.length > 0) {
    console.error('verify-custom-harness-product: Harnessy product regression(s):')
    for (const failure of failures) console.error(`  ${failure}`)
    process.exitCode = 1
  } else {
    console.log('verify-custom-harness-product: Harnessy identity, composition, state, and CI are protected.')
  }
}
