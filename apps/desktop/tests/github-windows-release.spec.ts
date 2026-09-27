import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const commit = 'a'.repeat(40)
  return {
    commit,
    blockmapHash: 'c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c',
    spawnSync: vi.fn((executable: string, args: readonly string[]) => {
      if (executable === 'git') return { status: 0, stdout: `${commit}\n` }
      if (executable === 'gh' && args[0] === 'release' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({
          tagName: 'v1.2.3', isDraft: true, isPrerelease: false,
          assets: [
            { name: 'Harnessy-Setup-1.2.3-win-x64.exe', size: 8, digest: 'sha256:c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c' },
            { name: 'Harnessy-Setup-1.2.3-win-x64.exe.blockmap', size: 8, digest: 'sha256:c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c' },
            { name: 'latest.yml', size: 8, digest: 'sha256:c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c' },
          ],
        }) }
      }
      throw new Error(`unexpected command: ${executable} ${args.join(' ')}`)
    }),
  }
})

vi.mock('node:child_process', () => ({ spawnSync: fixture.spawnSync }))
vi.mock('node:fs', () => ({
  createReadStream: vi.fn(() => {
    const listeners = new Map<string, (value?: string) => void>()
    queueMicrotask(() => { listeners.get('data')?.('artifact'); listeners.get('end')?.() })
    return { on(name: string, listener: (value?: string) => void) { listeners.set(name, listener); return this } }
  }),
}))
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(async () => ({ isFile: () => true, size: 8 })),
  readFile: vi.fn(async (path: URL | string) => {
    const value = String(path)
    if (value.endsWith('win-x64-release.json')) {
      return JSON.stringify({ schemaVersion: 1, target: 'win-x64', version: '1.2.3', environment: 'production',
        commit: fixture.commit, dirty: false, signerThumbprint: 'A'.repeat(40),
        artifacts: ['Harnessy-Setup-1.2.3-win-x64.exe', 'Harnessy-Setup-1.2.3-win-x64.exe.blockmap', 'latest.yml']
          .map(name => ({ name, size: 8, sha256: name.endsWith('.blockmap') ? fixture.blockmapHash
            : 'c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c' })) })
    }
    if (value.endsWith('latest.yml')) {
      return 'version: 1.2.3\nfiles:\n  - url: Harnessy-Setup-1.2.3-win-x64.exe\n    sha512: FGl0QHAcOIX3yNX6pZ8za0ccqGMyA07/DT/dwC3JsYuDVuhA21SCPI/S8svQkGlpzxMs+Lucc9x2m0/9gXvSPQ==\n    size: 8\n'
    }
    if (value.endsWith('package.json')) return JSON.stringify({ version: '1.2.3' })
    throw new Error(`unexpected read: ${value}`)
  }),
}))
vi.mock('../scripts/windows-runtime-signature.mjs', () => ({
  inspectWindowsRuntimeSignature: vi.fn(async () => ({ status: 'Valid', timestamped: true, thumbprint: 'A'.repeat(40) })),
}))

afterEach(() => {
  fixture.blockmapHash = 'c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c'
  vi.clearAllMocks()
  vi.resetModules()
})

it('checks signed stable release inputs without contacting GitHub', async () => {
  const original = process.argv[2]
  process.argv[2] = 'check'
  try {
    await import('../scripts/github-windows-release.ts')
  }
  finally {
    if (original === undefined) process.argv.splice(2, 1)
    else process.argv[2] = original
  }
  expect(fixture.spawnSync).toHaveBeenCalledWith('git', ['rev-parse', 'v1.2.3^{commit}'], expect.any(Object))
  expect(fixture.spawnSync.mock.calls.some(([executable]) => executable === 'gh')).toBe(false)
})

it('rejects a blockmap whose bytes differ from the packaging completion record', async () => {
  const original = process.argv[2]
  fixture.blockmapHash = '0'.repeat(64)
  process.argv[2] = 'check'
  try {
    await expect(import('../scripts/github-windows-release.ts')).rejects.toThrow(/artifact bytes do not match/)
  }
  finally {
    if (original === undefined) process.argv.splice(2, 1)
    else process.argv[2] = original
  }
})

it('verifies a clean tagged signed stable draft without publishing it', async () => {
  const original = process.argv[2]
  process.argv[2] = 'verify'
  try {
    await import('../scripts/github-windows-release.ts')
  }
  finally {
    if (original === undefined) process.argv.splice(2, 1)
    else process.argv[2] = original
  }
  expect(fixture.spawnSync).toHaveBeenCalledWith('git', ['rev-parse', 'v1.2.3^{commit}'], expect.any(Object))
  expect(fixture.spawnSync).toHaveBeenCalledWith('gh', expect.arrayContaining([
    'release', 'view', 'v1.2.3', '--repo', 'amAbdoMo/Harnessy',
  ]), expect.any(Object))
  expect(fixture.spawnSync.mock.calls.some(([, args]) => args[1] === 'edit' || args[1] === 'create')).toBe(false)
})
