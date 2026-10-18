/** Source-only Desktop preparation with synthetic payloads and no target execution. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '', pnpm: '11.7.0' as string | undefined, failure: '' }))

vi.mock('../scripts/desktop-build-paths.mjs', () => ({
  resolveDesktopBuildTarget: () => 'mac-arm64',
  resolveDesktopTargetBuildPaths: () => {
    if (!state.root) throw new Error('fixture root is not allocated')
    return {
      runtime: join(state.root, 'runtime'), electron: join(state.root, 'electron'), downloads: join(state.root, 'downloads'),
    }
  },
}))
vi.mock('@electron/get', () => ({ downloadArtifact: async () => join(state.root, 'synthetic-electron.zip') }))
vi.mock('extract-zip', () => ({ default: async () => {} }))
vi.mock('node:child_process', () => ({
  execFileSync: (command: string) => {
    if (command === '/usr/libexec/PlistBuddy') return '12.0\n'
    if (command === join(state.root, 'electron', 'Electron.app/Contents/MacOS/Electron')) return '24.18.1\n'
    throw new Error(`unexpected child process: ${command}`)
  },
}))
vi.mock('../scripts/prepare-command-link.ts', () => ({
  prepareCommandLink: () => {
    if (state.failure === 'command-link') throw new Error('synthetic command-link failure')
  },
}))
// Journals must never use an inherited packaging run directory.
vi.mock('../scripts/packaging-step.mjs', () => ({
  packagingStep: async (_directory: string | undefined, stage: string, action: () => Promise<unknown>) => {
    if (stage.startsWith('prepare:')) expect(existsSync(join(state.root, 'runtime', 'versions.json'))).toBe(false)
    if (state.failure === stage) throw new Error(`synthetic ${stage} failure`)
    const result = await action()
    if (stage.startsWith('prepare:')) expect(existsSync(join(state.root, 'runtime', 'versions.json'))).toBe(false)
    return result
  },
}))
// Compiled inputs are synthetic; only checked-in launcher assets are copied.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, cpSync: (...args: Parameters<typeof actual.cpSync>) => {
    const source = String(args[0])
    const destination = String(args[1])
    const destinationRelative = relative(state.root, resolve(destination))
    if (!state.root || destinationRelative.startsWith('..') || resolve(destination) === resolve(state.root)) {
      throw new Error('copy destination is outside the fixture')
    }
    if (source.endsWith(join('lib', 'command-manager-entry.js'))) {
      if (state.failure === 'command-manager') throw new Error('synthetic command-manager failure')
      actual.writeFileSync(args[1], '// synthetic command manager\n')
    } else if (source.endsWith(join('scripts', 'node-bin')) || source.endsWith(join('scripts', 'command-path.ps1'))) {
      actual.cpSync(...args)
    } else {
      throw new Error(`unexpected copy source: ${source}`)
    }
  } }
})
// The shared builder owns downloads, archive extraction, native probes and materialization.
vi.mock('../scripts/prepare-primary-runtime.ts', () => ({
  preparePrimaryRuntime: async () => {
    const root = join(state.root, 'runtime', 'primary-runtime')
    const pnpm = join(root, 'dependencies', 'pnpm', 'bin')
    mkdirSync(pnpm, { recursive: true })
    writeFileSync(join(pnpm, 'pnpm.mjs'), '// synthetic pnpm\n')
    if (state.failure === 'primary-payload') throw new Error('synthetic primary-payload failure')
    writeFileSync(join(root, 'runtime.json'), JSON.stringify({
      desktopVersion: '0.0.0', platform: 'darwin', arch: 'arm64', python: '3.12.0', node: '24.19.0',
      ...(state.pnpm === undefined ? {} : { pnpm: state.pnpm }), pythonPackages: {},
    }))
  },
}))

beforeEach(() => {
  vi.resetModules()
  state.root = mkdtempSync(join(tmpdir(), 'desktop-runtime-preparation-'))
  state.pnpm = '11.7.0'
  state.failure = ''
  vi.stubGlobal('process', { ...process, argv: [process.execPath, 'prepare-runtime.ts'] })
  vi.stubGlobal('fetch', () => { throw new Error('network is forbidden in this fixture') })
  vi.stubEnv('DSH_DESKTOP_PACKAGING_RUN_DIR', undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(state.root, { recursive: true, force: true })
  state.root = ''
})

it('replaces stale resources with one shared pnpm and publishes the primary manifest version', async () => {
  const runtime = join(state.root, 'runtime')
  mkdirSync(join(runtime, 'pnpm', 'bin'), { recursive: true })
  writeFileSync(join(runtime, 'pnpm', 'bin', 'pnpm.mjs'), 'stale')
  writeFileSync(join(runtime, 'versions.json'), 'stale')

  await import('../scripts/prepare-runtime.ts')

  expect(existsSync(join(runtime, 'pnpm'))).toBe(false)
  expect(readFileSync(join(runtime, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'), 'utf8')).toBe('// synthetic pnpm\n')
  const pnpmEntries = readdirSync(runtime, { recursive: true }).map(String)
    .filter(entry => entry.endsWith('pnpm.mjs'))
  expect(pnpmEntries).toEqual([join('primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')])
  expect(existsSync(join(runtime, 'bin', 'node'))).toBe(true)
  expect(existsSync(join(runtime, 'cli', 'bin', 'dsh'))).toBe(true)
  expect(existsSync(join(runtime, 'cli', 'command-manager.js'))).toBe(true)
  const manifest = JSON.parse(readFileSync(join(runtime, 'primary-runtime', 'runtime.json'), 'utf8'))
  expect(JSON.parse(readFileSync(join(runtime, 'versions.json'), 'utf8'))).toEqual({
    schemaVersion: 1, node: '24.18.1', pnpm: manifest.pnpm,
  })
})

it('does not publish versions when the primary manifest omits pnpm', async () => {
  state.pnpm = undefined

  await expect(import('../scripts/prepare-runtime.ts')).rejects.toThrow(/pnpm/u)

  expect(existsSync(join(state.root, 'runtime', 'versions.json'))).toBe(false)
})

it.each(['prepare:cli', 'command-link', 'command-manager', 'prepare:primary-runtime', 'primary-payload'])(
  'does not publish versions when %s fails', async (failure) => {
    state.failure = failure

    await expect(import('../scripts/prepare-runtime.ts')).rejects.toThrow(`synthetic ${failure} failure`)

    expect(existsSync(join(state.root, 'runtime', 'versions.json'))).toBe(false)
  },
)
