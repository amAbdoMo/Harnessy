import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const commit = 'a'.repeat(40)
  return {
    commit,
    blockmapHash: 'c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c',
    signatureMode: 'unsigned',
    feed: 'version: 1.2.3\nfiles:\n  - url: Harnessy-Setup-1.2.3-win-x64.exe\n    sha512: FGl0QHAcOIX3yNX6pZ8za0ccqGMyA07/DT/dwC3JsYuDVuhA21SCPI/S8svQkGlpzxMs+Lucc9x2m0/9gXvSPQ==\n    size: 8\n',
    configuration: "owner: amAbdoMo\nrepo: Harnessy\nprovider: github\nchannel: latest\nreleaseType: release\nupdaterCacheDirName: '@deepseek-aidsh-desktop-updater'\n",
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
vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }))
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
        commit: fixture.commit, dirty: false, signatureMode: fixture.signatureMode,
        artifacts: ['Harnessy-Setup-1.2.3-win-x64.exe', 'Harnessy-Setup-1.2.3-win-x64.exe.blockmap', 'latest.yml']
          .map(name => ({ name, size: 8, sha256: name.endsWith('.blockmap') ? fixture.blockmapHash
            : 'c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c' })) })
    }
    if (value.endsWith('latest.yml')) {
      return fixture.feed
    }
    if (value.endsWith('packaged-app-update.yml')) return fixture.configuration
    if (value.endsWith('package.json')) return JSON.stringify({ version: '1.2.3' })
    throw new Error(`unexpected read: ${value}`)
  }),
}))
const originalSpawn = fixture.spawnSync.getMockImplementation()
if (originalSpawn === undefined) throw new Error('The release fixture requires its default process adapter')
const originalConfiguration = fixture.configuration

afterEach(() => {
  fixture.blockmapHash = 'c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c'
  fixture.signatureMode = 'unsigned'
  fixture.configuration = originalConfiguration
  fixture.spawnSync.mockImplementation(originalSpawn)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.resetModules()
})

it('checks unsigned stable release inputs without contacting GitHub', async () => {
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

it('rejects a non-unsigned completion record before contacting GitHub', async () => {
  const original = process.argv[2]
  fixture.signatureMode = 'authenticode'
  process.argv[2] = 'check'
  try {
    await expect(import('../scripts/github-windows-release.ts')).rejects.toThrow(/completion record/)
  }
  finally {
    if (original === undefined) process.argv.splice(2, 1)
    else process.argv[2] = original
  }
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

it('verifies a clean tagged unsigned stable draft without publishing it', async () => {
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

/** Simulate Git/GitHub responses while retaining the real publication orchestration. */
function hostedFixture(options: {
  existing?: 'draft' | 'published'
  stagedCommit?: string
  tagCommit?: string
  latest?: string
  draftDigest?: string
  leaseRejected?: boolean
  ancestor?: boolean
  publicFeed?: string
} = {}) {
  let master = options.existing === 'published' ? fixture.commit : 'b'.repeat(40)
  let exists = options.existing !== undefined
  let draft = options.existing !== 'published'
  let latest = options.latest ?? (draft ? 'v1.2.2' : 'v1.2.3')
  let tagCommit = options.tagCommit ?? (exists ? fixture.commit : '')
  const writes: string[] = []
  for (const [name, value] of Object.entries({
    GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'amAbdoMo/Harnessy',
    GITHUB_REF: 'refs/heads/staging', GITHUB_SHA: fixture.commit, RELEASE_VERSION: '1.2.3',
  })) vi.stubEnv(name, value)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(options.publicFeed ?? fixture.feed)))
  fixture.spawnSync.mockImplementation((executable, args) => {
    const success = (stdout = '') => ({ status: 0, stdout })
    if (executable === 'git') {
      if (args[0] === 'tag') return success(args[1] === '--list' ? 'v1.2.3' : '')
      if (args[0] === 'remote') return success('https://github.com/amAbdoMo/Harnessy.git')
      if (args[0] === 'fetch') return success()
      if (args[0] === 'merge-base') return options.ancestor === false ? { status: 1, stdout: '' } : success()
      if (args[0] === 'rev-parse') {
        if (args[1] === 'refs/remotes/origin/master') return success(master)
        if (args[1] === 'refs/remotes/origin/staging') return success(options.stagedCommit ?? fixture.commit)
        return success(fixture.commit)
      }
      if (args[0] === 'ls-remote') {
        return success(args[2] === 'refs/heads/master' ? `${master}\trefs/heads/master`
          : tagCommit === '' ? '' : `${tagCommit}\trefs/tags/v1.2.3`)
      }
      if (args[0] === 'push') {
        writes.push(args.join(' '))
        if (args[1]?.startsWith('--force-with-lease=')) {
          if (options.leaseRejected) return { status: 1, stdout: '' }
          master = fixture.commit
        } else tagCommit = fixture.commit
        return success()
      }
    }
    if (executable === 'gh') {
      if (args[1] === 'list') return success(JSON.stringify(exists ? [{ tagName: 'v1.2.3' }] : []))
      if (args[1] === 'create') { exists = true; writes.push('draft'); return success() }
      if (args[1] === 'edit') { draft = false; latest = 'v1.2.3'; writes.push('publish'); return success() }
      if (args[1] === 'view') {
        if (args[2] === '--repo') return success(JSON.stringify({ tagName: latest, isDraft: false, isPrerelease: false }))
        return success(JSON.stringify({ tagName: 'v1.2.3', isDraft: draft, isPrerelease: false,
          assets: ['Harnessy-Setup-1.2.3-win-x64.exe', 'Harnessy-Setup-1.2.3-win-x64.exe.blockmap', 'latest.yml']
            .map(name => ({ name, size: 8, digest: options.draftDigest ?? 'sha256:c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c' })),
        }))
      }
    }
    throw new Error(`unexpected command: ${executable} ${args.join(' ')}`)
  })
  return { writes, state: () => ({ master, tagCommit, draft, latest }) }
}

async function runHosted(): Promise<void> {
  const original = process.argv[2]
  process.argv[2] = 'hosted'
  try { await import('../scripts/github-windows-release.ts') }
  finally {
    if (original === undefined) process.argv.splice(2, 1)
    else process.argv[2] = original
  }
}

it('publishes a qualified package, promotes remote master and checks its public updater feed', async () => {
  const host = hostedFixture()
  await runHosted()
  expect(host.state()).toEqual({ master: fixture.commit, tagCommit: fixture.commit, draft: false, latest: 'v1.2.3' })
  expect(host.writes).toEqual([
    'push origin refs/tags/v1.2.3:refs/tags/v1.2.3', 'draft',
    `push --force-with-lease=refs/heads/master:${'b'.repeat(40)} origin ${fixture.commit}:refs/heads/master`, 'publish',
  ])
  expect(fetch).toHaveBeenCalledWith('https://github.com/amAbdoMo/Harnessy/releases/latest/download/latest.yml', expect.any(Object))
})

it.each(['draft', 'published'] as const)('resumes an identical existing %s without recreating release assets', async (existing) => {
  const host = hostedFixture({ existing })
  await runHosted()
  expect(host.state().draft).toBe(false)
  expect(host.writes).not.toContain('draft')
  if (existing === 'published') expect(host.writes).toEqual([])
})

it.each([
  { label: 'moved staging', options: { stagedCommit: 'c'.repeat(40) }, error: /staging moved/ },
  { label: 'divergent master', options: { ancestor: false }, error: /git exited/ },
  { label: 'older version', options: { latest: 'v1.2.4' }, error: /must be newer/ },
  { label: 'conflicting tag', options: { tagCommit: 'c'.repeat(40) }, error: /remote tag/ },
])('refuses $label before any remote writes', async ({ options, error }) => {
  const host = hostedFixture(options)
  await expect(runHosted()).rejects.toThrow(error)
  expect(host.writes).toEqual([])
})

it.each([
  { label: 'unverified draft bytes', options: { existing: 'draft' as const, draftDigest: 'sha256:wrong' }, error: /byte-identical/ },
  { label: 'concurrent master movement', options: { leaseRejected: true }, error: /git exited/ },
])('keeps the update unpublished for $label', async ({ options, error }) => {
  const host = hostedFixture(options)
  await expect(runHosted()).rejects.toThrow(error)
  expect(host.writes).not.toContain('publish')
  expect(host.state().master).toBe('b'.repeat(40))
})

it('rejects a mismatched production updater channel before remote writes', async () => {
  const host = hostedFixture()
  fixture.configuration = fixture.configuration.replace('channel: latest', 'channel: nightly')
  await expect(runHosted()).rejects.toThrow(/updater configuration/)
  expect(host.writes).toEqual([])
})

it.each([
  { name: 'GITHUB_REF', value: 'refs/heads/master', error: /staging dispatch/ },
  { name: 'GITHUB_SHA', value: 'c'.repeat(40), error: /checkout differs/ },
  { name: 'RELEASE_VERSION', value: '1.2.4', error: /package identity/ },
])('rejects mismatched dispatch $name before remote writes', async ({ name, value, error }) => {
  const host = hostedFixture()
  vi.stubEnv(name, value)
  await expect(runHosted()).rejects.toThrow(error)
  expect(host.writes).toEqual([])
})

it('reports failure when the public updater feed differs after publication', async () => {
  const host = hostedFixture({ publicFeed: 'version: 1.2.2' })
  await expect(runHosted()).rejects.toThrow(/public latest release\/feed/)
  expect(host.state().draft).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(5)
})
