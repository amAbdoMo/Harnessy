import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { readStagingSelection, updateStagingRuntime } from '../scripts/staging-runtime-store.ts'

function store(): string {
  const root = mkdtempSync(join(tmpdir(), 'staging-store-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

async function materialize(directory: string): Promise<void> {
  for (const name of [
    'electron/electron.exe', 'app/package.json', 'app/lib/main.js', 'app/lib/preload-app.cjs',
    'app/dsh/desktop-runtime.json', 'runtime/primary-runtime/runtime.json',
    'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs', 'app/scripts/node-bin/node.cmd',
  ]) {
    const path = join(directory, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'original\n')
  }
}

describe('protected staging runtime selection', () => {
  it('seals the shared pnpm entry without materializing a second distribution', async () => {
    const root = store()
    const id = await updateStagingRuntime(root, materialize, async () => {})
    const directory = join(root, 'generations', id)
    const record = JSON.parse(readFileSync(join(directory, 'verified.json'), 'utf8')) as { schemaVersion: number; checks: { path: string; sha256: string }[] }
    expect(record.schemaVersion).toBe(2)
    const pnpmCheck = record.checks.find(check => check.path === 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
    expect(pnpmCheck?.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(existsSync(join(directory, 'runtime', 'pnpm'))).toBe(false)
  })

  it.each(['missing', 'modified during smoke'])('keeps selection and prior generations when shared pnpm is %s', async (failure) => {
    const root = store()
    const first = await updateStagingRuntime(root, materialize, async () => {})
    const before = readFileSync(join(root, 'active.json'), 'utf8')
    const pnpm = 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'
    let verified = false
    await expect(updateStagingRuntime(root, async (directory) => {
      await materialize(directory)
      if (failure === 'missing') {
        unlinkSync(join(directory, pnpm))
        const legacy = join(directory, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
        mkdirSync(dirname(legacy), { recursive: true })
        writeFileSync(legacy, 'not a fallback\n')
      }
    }, async (directory) => {
      verified = true
      writeFileSync(join(directory, pnpm), 'corrupted during smoke\n')
    })).rejects.toThrow(failure === 'missing' ? /ENOENT/u : /smoke modified runtime\/primary-runtime\/dependencies\/pnpm/u)
    expect(verified).toBe(failure !== 'missing')
    expect(readFileSync(join(root, 'active.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(root, 'generations', first, pnpm), 'utf8')).toBe('original\n')
  })

  it('selects a verified candidate and retains its predecessor without rewriting it', async () => {
    const root = store()
    const first = await updateStagingRuntime(root, materialize, async () => {})
    const firstPath = join(root, 'generations', first, 'app', 'lib', 'main.js')
    const second = await updateStagingRuntime(root, async (directory) => {
      cpSync(join(root, 'generations', first), directory, { recursive: true, filter: source => !source.endsWith('verified.json') })
      writeFileSync(join(directory, 'app', 'lib', 'main.js'), 'updated\n')
    }, async (directory) => {
      expect(readStagingSelection(root)?.current).toBe(first)
      expect(readFileSync(join(directory, 'app', 'lib', 'main.js'), 'utf8')).toBe('updated\n')
    })
    expect(readStagingSelection(root)).toEqual({ schemaVersion: 1, current: second, previous: first })
    expect(readFileSync(firstPath, 'utf8')).toBe('original\n')
  })

  it.for(['prepare', 'smoke', 'mutation', 'link'] as const)('keeps the selected runtime after %s failure', async (failure) => {
    const root = store()
    const first = await updateStagingRuntime(root, materialize, async () => {})
    const before = readFileSync(join(root, 'active.json'), 'utf8')
    const error = failure === 'link' ? /linked entry/u : failure === 'mutation' ? /smoke modified/u : /fixture failure/u
    await expect(updateStagingRuntime(root, async (directory) => {
      await materialize(directory)
      if (failure === 'prepare') throw new Error('fixture failure')
      if (failure === 'link') {
        symlinkSync(join(root, 'generations', first), join(directory, 'workspace'), process.platform === 'win32' ? 'junction' : 'dir')
      }
    }, async (directory) => {
      if (failure === 'smoke') throw new Error('fixture failure')
      if (failure === 'mutation') writeFileSync(join(directory, 'app', 'lib', 'main.js'), 'changed during smoke\n')
    })).rejects.toThrow(error)
    expect(readFileSync(join(root, 'active.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(root, 'generations', first, 'app', 'lib', 'main.js'), 'utf8')).toBe('original\n')
  })

  it('does not select an incomplete first candidate or infer fallback from another directory', async () => {
    const root = store()
    await expect(updateStagingRuntime(root, async () => {}, async () => {})).rejects.toThrow(/ENOENT/u)
    expect(readStagingSelection(root)).toBeUndefined()
  })

  it('rejects a traversing durable selection before invoking a build', async () => {
    const root = store()
    writeFileSync(join(root, 'active.json'), JSON.stringify({ schemaVersion: 1, current: '../outside', previous: null }))
    let prepared = false
    await expect(updateStagingRuntime(root, async () => { prepared = true }, async () => {})).rejects.toThrow(/invalid active.json/u)
    expect(prepared).toBe(false)
  })
})
