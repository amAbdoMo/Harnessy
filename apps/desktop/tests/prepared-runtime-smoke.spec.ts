import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { smokePreparedRuntime } from '../scripts/smoke-prepared-runtime.ts'
import { smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { verifyDesktopRuntime, writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const { payload } = vi.hoisted(() => ({ payload: vi.fn(async (..._args: unknown[]) => ({ stdout: '' })) }))
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  return { ...await importOriginal<typeof import('node:child_process')>(),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: payload }) }
})
vi.mock('../scripts/smoke-runtime.ts', () => ({ smokeDesktopRuntime: vi.fn(async () => {}) }))

const roots: string[] = []
const hostArch = Object.getOwnPropertyDescriptor(process, 'arch')!
afterEach(() => {
  Object.defineProperty(process, 'arch', hostArch)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

it('smokes an x64 target verified on an arm64 build host without revalidating against the host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-runtime-target-'))
  roots.push(root)
  const fixture = runtimeFixture(root)
  const target = { platform: 'darwin' as const, arch: 'x64' }
  writeDesktopRuntime(root, fixture.release, fixture.sharedPackages.map(entry => entry.name), target)
  Object.defineProperty(process, 'arch', { ...hostArch, value: 'arm64' })
  await expect(verifyDesktopRuntime(root, fixture.release.version, { ...target, arch: process.arch }))
    .rejects.toThrow(/incompatible/u)
  const descriptor = await verifyDesktopRuntime(root, fixture.release.version, target)
  const electron = join(root, 'target-electron')
  const resources = join(root, 'runtime')
  await smokePreparedRuntime(root, electron, resources, descriptor)
  expect(payload.mock.calls[0]![0]).toBe(electron)
  expect(payload.mock.calls[0]![1]).toEqual(expect.arrayContaining([root, resources]))
  expect(smokeDesktopRuntime).toHaveBeenCalledWith(root, electron, descriptor, expect.any(Object), resources)
  const environment = vi.mocked(smokeDesktopRuntime).mock.calls[0]![3]
  expect(existsSync(environment.NARB_NATIVE_CACHE_DIR!)).toBe(false)
})

it('retains partial payload progress and termination details, cleans its cache and refuses Host smoke after failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-runtime-failure-'))
  roots.push(root)
  const fixture = runtimeFixture(root)
  const target = { platform: process.platform, arch: process.arch }
  writeDesktopRuntime(root, fixture.release, fixture.sharedPackages.map(entry => entry.name), target)
  const descriptor = await verifyDesktopRuntime(root, fixture.release.version, target)
  const failure = Object.assign(new Error('payload did not drain'), {
    code: null, killed: true, signal: 'SIGTERM',
    stdout: 'payload-checks-complete; waiting for natural drain', stderr: 'payload native diagnostic',
  })
  payload.mockRejectedValueOnce(failure)
  const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(smokePreparedRuntime(root, join(root, 'electron'), join(root, 'runtime'), descriptor)).rejects.toBe(failure)
  expect(smokeDesktopRuntime).not.toHaveBeenCalled()
  const options = payload.mock.calls[0]?.[2]
  if (typeof options !== 'object' || options === null || !('env' in options)) throw new Error('Payload command must own an environment')
  const environment = options.env
  if (typeof environment !== 'object' || environment === null || !('NARB_NATIVE_CACHE_DIR' in environment)
    || typeof environment.NARB_NATIVE_CACHE_DIR !== 'string') throw new Error('Payload command must own a private cache')
  expect(existsSync(environment.NARB_NATIVE_CACHE_DIR)).toBe(false)
  const line: unknown = diagnostics.mock.calls.flat().find(value => (
    typeof value === 'string' && value.startsWith('desktop payload smoke: ')
  ))
  if (typeof line !== 'string') throw new Error('Payload failure must report termination details')
  const details: unknown = JSON.parse(line.slice('desktop payload smoke: '.length))
  expect(details).toMatchObject({ code: null, killed: true, signal: 'SIGTERM' })
  expect(diagnostics).toHaveBeenCalledWith(failure.stdout)
  expect(diagnostics).toHaveBeenCalledWith(failure.stderr)
})
