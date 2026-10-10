/** Workspace bundle discovery after a package moves or is removed. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { build, type TsdownBundle } from 'tsdown'
import { describe, expect, it, onTestFinished } from 'vitest'
import { buildWorkspaceDirectories } from './build-workspace.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

function writeFixture(root: string, path: string, content: string): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-build-workspace-'))
  onTestFinished(() => { removeFixtureSafely(root) })
  writeFixture(root, 'package.json', JSON.stringify({ private: true, type: 'module' }))
  return root
}

describe('repository bundle workspaces', () => {
  it.each(['host', 'client'] as const)('discovers source-only %s packages without requiring build artifacts', (face) => {
    const root = fixtureRoot()
    const customPackage = 'packages/client/ui-brand-custom-harness'
    writeFixture(root, `${customPackage}/package.json`, JSON.stringify({ name: '@deepseek-ai/dsh-ui-brand-custom-harness' }))
    writeFixture(root, 'apps/cli/lib/types/index.js', 'export const stale = true\n')
    writeFixture(root, 'apps/desktop-host/lib/types/index.js', 'export const stale = true\n')
    writeFixture(root, 'vendor/removed/lib/types/index.js', 'export const stale = true\n')
    writeFixture(root, 'packages/client/removed/node_modules/.cache/residue', '')
    writeFixture(root, 'packages/client/removed/lib/types/package.json', '{}')

    expect(buildWorkspaceDirectories(root, face)).toEqual([customPackage])
  })

  it.each(['host', 'client'] as const)('builds live %s packages without bundling a moved package’s residue', async (face) => {
    const root = fixtureRoot()
    const shared = [
      'apps/cli',
      'packages/bundle/custom-harness',
      'packages/client/ui-brand-custom-harness',
      'packages/experimental/session-title-all-prompts-llm',
      'packages/session/session-title-llm',
      'vendor/cordis',
    ]
    const excluded = ['apps/desktop', 'apps/web', 'native/system', 'website', 'packages/ungrouped']
    for (const directory of [...shared, 'apps/desktop-host', ...excluded]) {
      writeFixture(root, `${directory}/package.json`, JSON.stringify({ name: directory.replaceAll('/', '-'), type: 'module' }))
      writeFixture(root, `${directory}/lib/types/index.js`, 'export const executeSessionTitleLlm = "live"\n')
    }
    const staleDirectory = 'packages/session/session-title-all-prompts-llm'
    const staleEntry = `${staleDirectory}/lib/types/index.js`
    const staleCode = 'export { registerSessionTitleLlmProvider } from "../../../session-title-llm/lib/types/index.js"\n'
    writeFixture(root, staleEntry, staleCode)
    writeFixture(root, `${staleDirectory}/node_modules/.cache/residue`, '')

    const workspace = buildWorkspaceDirectories(root, face)
    const expected = [...shared, ...(face === 'host' ? ['apps/desktop-host'] : [])].sort()
    expect(workspace).toEqual(expected)

    let bundles: TsdownBundle[] = []
    try {
      bundles = await build({
        cwd: root, workspace, config: false, tsconfig: false,
        entry: ['lib/types/index.js'], outDir: 'lib', format: 'esm', platform: 'node',
        dts: false, clean: false, report: false, logLevel: 'silent',
      })
      for (const directory of expected) {
        expect(readFileSync(join(root, directory, 'lib/index.mjs'), 'utf8')).toContain('executeSessionTitleLlm')
      }
      expect(readFileSync(join(root, staleEntry), 'utf8')).toBe(staleCode)
      for (const directory of [staleDirectory, ...excluded, ...(face === 'client' ? ['apps/desktop-host'] : [])]) {
        expect(existsSync(join(root, directory, 'lib/index.mjs'))).toBe(false)
      }
    } finally {
      for (const bundle of bundles) await bundle[Symbol.asyncDispose]()
    }
  })
})
