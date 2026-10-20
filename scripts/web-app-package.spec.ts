/** Regression for shared runtime chunks omitted from the published Web bundle. */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { x as extractTar } from 'tar'
import { expect, it } from 'vitest'
import { resolveWorkspacePnpm } from './primary-runtime/workspace-pnpm.ts'

it('publishes every shared runtime chunk needed by both Web entry points', async () => {
  const repository = fileURLToPath(new URL('..', import.meta.url))
  const manifest: unknown = JSON.parse(readFileSync(join(repository, 'packages/bundle/web-app/package.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('files' in manifest)
    || !Array.isArray(manifest.files) || !manifest.files.every(path => typeof path === 'string')) throw new Error('Missing Web package files')
  const root = mkdtempSync(join(tmpdir(), 'web-app-packed-chunk-'))
  try {
    const source = join(root, 'source')
    const packed = join(root, 'packed')
    const extracted = join(root, 'extracted')
    for (const path of [join(source, 'lib', 'types'), packed, extracted]) mkdirSync(path, { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: 'web-shared-chunk-fixture', version: '1.0.0', type: 'module', files: manifest.files,
    }))
    for (const entry of ['index', 'startup']) {
      writeFileSync(join(source, 'lib', `${entry}.js`), "export { shared } from './startup-fixtureHash.js'\n")
    }
    writeFileSync(join(source, 'lib', 'startup-fixtureHash.js'), "export const shared = 'fixture-shared-chunk'\n")
    writeFileSync(join(source, 'lib', 'types', 'private.js'), "throw new Error('compiler output must not ship')\n")
    const pnpm = join(resolveWorkspacePnpm(repository).directory, 'bin', 'pnpm.mjs')
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
      /^(?:path|systemroot|windir|comspec|temp|tmp|ELECTRON_RUN_AS_NODE)$/iu.test(name)
    )))
    await promisify(execFile)(process.execPath, [pnpm, 'pack', '--pack-destination', packed], {
      cwd: source, timeout: 15_000, windowsHide: true,
      env: { ...environment, HOME: root, USERPROFILE: root, pnpm_config_verify_deps_before_run: 'false' },
    })
    const archives = readdirSync(packed)
    expect(archives).toHaveLength(1)
    await extractTar({ file: join(packed, archives[0]!), cwd: extracted })
    const packageRoot = join(extracted, 'package')
    expect(readdirSync(join(packageRoot, 'lib'))).toContain('startup-fixtureHash.js')
    expect(readdirSync(join(packageRoot, 'lib'))).not.toContain('types')
    const entries = ['index', 'startup'].map(entry => pathToFileURL(join(packageRoot, 'lib', `${entry}.js`)).href)
    const program = `const entries = await Promise.all(${JSON.stringify(entries)}.map(path => import(path))); console.log(entries.map(entry => entry.shared).join('|'))`
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], {
      timeout: 10_000, windowsHide: true, env: environment,
    })
    expect(stdout.trim()).toBe('fixture-shared-chunk|fixture-shared-chunk')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
