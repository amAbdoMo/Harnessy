import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { LEGACY_PROFILE_CORE_MIGRATION_FILE, migrateLegacyProfileCorePackages } from '../src/legacy-profile-migration.ts'

const roots: string[] = []
const core = '@deepseek-ai/dsh-web-app'
const plugin = '@example/plugin'
const legacyNames = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-custom-harness',
  '@deepseek-ai/dsh-desktop-host',
  core,
].sort((left, right) => left.localeCompare(right))

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-legacy-profile-'))
  roots.push(root)
  mkdirSync(join(root, 'node_modules', core), { recursive: true })
  mkdirSync(join(root, 'node_modules', plugin), { recursive: true })
  writeFileSync(join(root, 'node_modules', core, 'package.json'), JSON.stringify({ name: core, version: '0.1.5-alpha.1' }))
  writeFileSync(join(root, 'node_modules', plugin, 'package.json'), JSON.stringify({ name: plugin, version: '1.0.0' }))
  writeFileSync(join(root, 'desktop-packages.json'), JSON.stringify({
    schemaVersion: 1,
    packages: legacyNames.map((name, index) => ({
      name, version: '0.1.5-alpha.1', file: `${String(index)}.tgz`, bytes: 1, integrity: 'sha512-YQ==',
    })),
  }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    dependencies: { [core]: 'file:./desktop-packages/core.tgz', [plugin]: '1.0.0' },
    optionalDependencies: { [core]: '0.1.5-alpha.1' },
    pnpm: { overrides: { [core]: 'file:./desktop-packages/core.tgz', retained: '2.0.0' } },
    dsh: { profile: { bundles: [core, plugin] } },
  }))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), `nodeLinker: hoisted\noverrides:\n  '${core}': file:./desktop-packages/core.tgz\n  retained: 2.0.0\n`)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'legacy resolutions\n')
  writeFileSync(join(root, 'cordis.patch.yml'), '[]\n')
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('removes recorded core packages once while preserving plugins, bundle selection, and configuration', () => {
  const root = fixture()

  migrateLegacyProfileCorePackages(root)

  expect(existsSync(join(root, 'node_modules', core))).toBe(false)
  expect(existsSync(join(root, 'node_modules', plugin))).toBe(true)
  expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toEqual({
    dependencies: { [plugin]: '1.0.0' }, optionalDependencies: {},
    pnpm: { overrides: { retained: '2.0.0' } }, dsh: { profile: { bundles: [core, plugin] } },
  })
  expect(load(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')))
    .toEqual({ nodeLinker: 'hoisted', overrides: { retained: '2.0.0' } })
  expect(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
  expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(false)
  expect(JSON.parse(readFileSync(join(root, LEGACY_PROFILE_CORE_MIGRATION_FILE), 'utf8'))).toEqual({ schemaVersion: 1 })

  mkdirSync(join(root, 'node_modules', core), { recursive: true })
  writeFileSync(join(root, 'node_modules', core, 'package.json'), JSON.stringify({ name: core, version: '2.0.0' }))
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'new plugin resolutions\n')
  migrateLegacyProfileCorePackages(root)
  expect(existsSync(join(root, 'node_modules', core))).toBe(true)
  expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe('new plugin resolutions\n')
})

it('does nothing when the profile has no released legacy package inventory', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-current-profile-'))
  roots.push(root)
  mkdirSync(join(root, 'node_modules', core), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [core]: '2.0.0' } }))

  migrateLegacyProfileCorePackages(root)

  expect(existsSync(join(root, 'node_modules', core))).toBe(true)
  expect(existsSync(join(root, LEGACY_PROFILE_CORE_MIGRATION_FILE))).toBe(false)
})

it('rejects a damaged completion marker without repeating the migration', () => {
  const root = fixture()
  writeFileSync(join(root, LEGACY_PROFILE_CORE_MIGRATION_FILE), '{"schemaVersion":2}\n')

  expect(() => { migrateLegacyProfileCorePackages(root) }).toThrow('invalid completion marker')

  expect(existsSync(join(root, 'node_modules', core))).toBe(true)
  expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(true)
})

it('rejects invalid legacy metadata before changing the profile', () => {
  const root = fixture()
  writeFileSync(join(root, 'desktop-packages.json'), '{"schemaVersion":1,"packages":[{"name":"../../outside"}]}')
  const manifest = readFileSync(join(root, 'package.json'), 'utf8')

  expect(() => { migrateLegacyProfileCorePackages(root) }).toThrow('invalid package record')

  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest)
  expect(existsSync(join(root, 'node_modules', core))).toBe(true)
  expect(existsSync(join(root, LEGACY_PROFILE_CORE_MIGRATION_FILE))).toBe(false)
})

it('refuses redirected package parents without touching their targets', () => {
  const root = fixture()
  const target = join(root, 'external-scope')
  mkdirSync(join(target, 'dsh-web-app'), { recursive: true })
  rmSync(join(root, 'node_modules', '@deepseek-ai'), { recursive: true })
  symlinkSync(target, join(root, 'node_modules', '@deepseek-ai'), process.platform === 'win32' ? 'junction' : 'dir')

  expect(() => { migrateLegacyProfileCorePackages(root) }).toThrow('not a real directory')

  expect(lstatSync(join(root, 'node_modules', '@deepseek-ai')).isSymbolicLink()).toBe(true)
  expect(existsSync(join(target, 'dsh-web-app'))).toBe(true)
  expect(existsSync(join(root, LEGACY_PROFILE_CORE_MIGRATION_FILE))).toBe(false)
})
