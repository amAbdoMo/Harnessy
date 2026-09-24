import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** The `node:fs` functions one probe call reaches, replaced one test at a time. */
interface ProbeFsOverrides {
  mkdtempSync?: (prefix: string) => string
  symlinkSync?: (target: string, path: string, type?: string) => void
  lstatSync?: (path: string) => { isSymbolicLink: () => boolean }
  rmSync?: (path: string) => void
}

const tempDirs: string[] = []
let platformDescriptor: PropertyDescriptor | undefined

/** Report `value` from `process.platform` for the rest of the test. */
function stubPlatform(value: NodeJS.Platform): void {
  platformDescriptor ??= Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

/** Create a real temporary directory the probe's cleanup can be observed on. */
function trackingMkdtemp(prefix: string): string {
  const dir = mkdtempSync(prefix)
  tempDirs.push(dir)
  return dir
}

/**
 * Import a probe module whose `node:fs` surface carries `overrides`, so a
 * Windows-only capability can be exercised on any host.
 */
async function loadProbe(overrides: ProbeFsOverrides = {}): Promise<typeof import('../src/index.ts')> {
  vi.resetModules()
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.doMock('node:fs', () => ({
    ...actual,
    mkdtempSync: overrides.mkdtempSync ?? actual.mkdtempSync,
    symlinkSync: overrides.symlinkSync ?? actual.symlinkSync,
    lstatSync: overrides.lstatSync ?? actual.lstatSync,
    rmSync: overrides.rmSync ?? actual.rmSync,
  }))
  return await import('../src/index.ts')
}

afterEach(() => {
  vi.doUnmock('node:fs')
  vi.resetModules()
  if (platformDescriptor !== undefined) {
    Object.defineProperty(process, 'platform', platformDescriptor)
    platformDescriptor = undefined
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('symlinksUsable', () => {
  it('answers for the real host without throwing', async () => {
    const { symlinksUsable } = await import('../src/index.ts')
    expect(typeof symlinksUsable()).toBe('boolean')
  })

  it('reports a usable capability off Windows without touching the filesystem', async () => {
    stubPlatform('linux')
    const probe = await loadProbe({
      mkdtempSync: () => { throw new Error('the probe must not create a directory off Windows') },
    })
    expect(probe.symlinksUsable()).toBe(true)
    expect(tempDirs).toEqual([])
  })

  it('reports a usable capability when Windows creates a symbolic link from an explicit file type', async () => {
    stubPlatform('win32')
    const links: Array<{ target: string; path: string; type: string | undefined }> = []
    const probe = await loadProbe({
      mkdtempSync: trackingMkdtemp,
      symlinkSync: (target, path, type) => { links.push({ target, path, type }) },
      lstatSync: () => ({ isSymbolicLink: () => true }),
    })

    expect(probe.symlinksUsable()).toBe(true)
    const dir = tempDirs[0]!
    expect(links).toEqual([{ target: join(dir, 'target'), path: join(dir, 'link'), type: 'file' }])
    expect(existsSync(dir)).toBe(false)
  })

  it('reports an unusable capability when Windows refuses the symlink', async () => {
    stubPlatform('win32')
    const probe = await loadProbe({
      mkdtempSync: trackingMkdtemp,
      symlinkSync: () => { throw new Error('EPERM: operation not permitted, symlink') },
    })

    expect(probe.symlinksUsable()).toBe(false)
    const dir = tempDirs[0]!
    expect(existsSync(dir)).toBe(false)
  })

  it('reports an unusable capability when the created link is not symbolic', async () => {
    stubPlatform('win32')
    const probe = await loadProbe({
      mkdtempSync: trackingMkdtemp,
      symlinkSync: () => {},
      lstatSync: () => ({ isSymbolicLink: () => false }),
    })

    expect(probe.symlinksUsable()).toBe(false)
  })

  it('reports an unusable capability when no temporary directory can be created', async () => {
    stubPlatform('win32')
    const probe = await loadProbe({
      mkdtempSync: () => { throw new Error('EACCES: permission denied, mkdtemp') },
    })

    expect(probe.symlinksUsable()).toBe(false)
  })

  it('keeps the capability answer when removing the temporary directory fails', async () => {
    stubPlatform('win32')
    const probe = await loadProbe({
      mkdtempSync: trackingMkdtemp,
      symlinkSync: () => {},
      lstatSync: () => ({ isSymbolicLink: () => true }),
      rmSync: (path) => {
        rmSync(path, { recursive: true, force: true })
        throw new Error('EPERM: operation not permitted, rm')
      },
    })

    expect(probe.symlinksUsable()).toBe(true)
    expect(existsSync(tempDirs[0]!)).toBe(false)
  })

  it('probes at most once per process', async () => {
    stubPlatform('win32')
    let created = 0
    const probe = await loadProbe({
      mkdtempSync: (prefix) => { created += 1; return trackingMkdtemp(prefix) },
      symlinkSync: () => {},
      lstatSync: () => ({ isSymbolicLink: () => true }),
    })

    expect([probe.symlinksUsable(), probe.symlinksUsable(), probe.symlinksUsable()]).toEqual([true, true, true])
    expect(created).toBe(1)
    expect(tempDirs).toHaveLength(1)
  })
})
