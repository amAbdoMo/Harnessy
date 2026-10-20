import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { afterEach, expect, it } from 'vitest'
import { stageRuntimeDependencyPatches } from '../scripts/runtime-dependency-patches.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(): { workspace: string; project: string; settings: string } {
  const root = mkdtempSync(join(tmpdir(), 'desktop-runtime-patches-'))
  roots.push(root)
  const workspace = join(root, 'source')
  const project = join(root, 'runtime')
  mkdirSync(join(workspace, 'patches'), { recursive: true })
  mkdirSync(project)
  const settings = dump({ packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false, allowBuilds: { 'node-pty': true } })
  writeFileSync(join(project, 'pnpm-workspace.yaml'), settings)
  writeFileSync(join(workspace, 'patches', 'terminal.patch'), 'opaque patch bytes\r\n')
  writeFileSync(join(workspace, 'patches', 'signing.patch'), 'build-only patch bytes\n')
  writeFileSync(join(workspace, 'pnpm-workspace.yaml'), dump({ patchedDependencies: {
    'node-pty@1.2.0-beta.15': 'patches/terminal.patch', '@electron/osx-sign@1.3.3': 'patches/signing.patch',
  } }))
  writeFileSync(join(project, 'pnpm-lock.yaml'), dump({ packages: { 'node-pty@1.2.0-beta.15': {}, 'other@1.0.0': {} } }))
  return { workspace, project, settings }
}

it('carries only selected production patches with their bytes and preserves native build settings', () => {
  const { workspace, project } = fixture()
  expect(stageRuntimeDependencyPatches(project, workspace)).toBe(true)
  expect(readFileSync(join(project, 'patches', 'terminal.patch'))).toEqual(readFileSync(join(workspace, 'patches', 'terminal.patch')))
  expect(existsSync(join(project, 'patches', 'signing.patch'))).toBe(false)
  const settings: unknown = load(readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8'))
  expect(settings).toMatchObject({ nodeLinker: 'hoisted', autoInstallPeers: false, allowBuilds: { 'node-pty': true },
    patchedDependencies: { 'node-pty@1.2.0-beta.15': 'patches/terminal.patch' } })
})

it('leaves metadata unchanged when no workspace patch matches the production lockfile', () => {
  const { workspace, project, settings } = fixture()
  writeFileSync(join(project, 'pnpm-lock.yaml'), dump({ packages: { 'other@1.0.0': {} } }))
  expect(stageRuntimeDependencyPatches(project, workspace)).toBe(false)
  expect(readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8')).toBe(settings)
  expect(existsSync(join(project, 'patches'))).toBe(false)
})

it('rejects a selected patch outside the source checkout before copying it', () => {
  const { workspace, project } = fixture()
  writeFileSync(join(workspace, 'pnpm-workspace.yaml'), dump({ patchedDependencies: { 'node-pty@1.2.0-beta.15': '../outside.patch' } }))
  expect(() => stageRuntimeDependencyPatches(project, workspace)).toThrow(/escapes workspace/u)
  expect(existsSync(join(project, 'patches'))).toBe(false)
})

it.each([
  ['pnpm-workspace.yaml', 'patchedDependencies', 'sequence', []],
  ['pnpm-lock.yaml', 'packages', 'sequence', []],
  ['pnpm-workspace.yaml', 'patchedDependencies', 'timestamp', new Date('2026-01-01T00:00:00Z')],
] as const)('rejects %s %s as a %s instead of silently omitting patches', (name, field, _kind, invalid) => {
  const { workspace, project } = fixture()
  writeFileSync(join(name === 'pnpm-workspace.yaml' ? workspace : project, name), dump({ [field]: invalid }))
  expect(() => stageRuntimeDependencyPatches(project, workspace)).toThrow(new RegExp(`invalid ${field}`, 'u'))
})
