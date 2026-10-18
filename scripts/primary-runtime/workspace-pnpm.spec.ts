/** Runtime metadata uses the root dependency even without a Desktop-local pnpm installation. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { resolveWorkspacePnpm } from './workspace-pnpm.ts'

async function createWorkspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-pnpm-')))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

async function writeManifest(directory: string, fields: object): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify(fields))
}

it.each(['absent', 'stale'] as const)('reads the root pnpm installation when the Desktop-local package is %s', async (local) => {
  const root = await createWorkspace()
  const directory = join(root, 'node_modules', 'pnpm')
  await writeManifest(directory, { name: 'pnpm', version: '11.7.0' })
  if (local === 'stale') await writeManifest(join(root, 'apps', 'desktop', 'node_modules', 'pnpm'), { name: 'pnpm', version: '0.0.0' })
  expect(resolveWorkspacePnpm(root)).toEqual({ directory, version: '11.7.0' })
})

it('does not borrow a Desktop-local package when the root dependency is absent', async () => {
  const root = await createWorkspace()
  await writeManifest(join(root, 'apps', 'desktop', 'node_modules', 'pnpm'), { name: 'pnpm', version: '11.7.0' })
  expect(() => resolveWorkspacePnpm(root)).toThrow()
})

it.each([undefined, '', 12])('refuses installed pnpm metadata with no usable version (%s)', async (version) => {
  const root = await createWorkspace()
  await writeManifest(join(root, 'node_modules', 'pnpm'), { name: 'pnpm', version })
  expect(() => resolveWorkspacePnpm(root)).toThrow('workspace pnpm: installed package has no version')
})
