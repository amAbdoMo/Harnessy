import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertClientBuildEnvironment,
  CLIENT_BUILD_RECORD_PATH,
  clientBuildEnvironmentDefines,
  clientBuildProcessEnvironment,
  officialClientBuildEnvironment,
  readClientBuildRecord,
  repositoryClientBuildEnvironment,
  repositoryCommitHash,
  repositoryGitDirty,
  repositoryVersion,
  resolveClientBuildEnvironment,
  resolveClientBundlerEnvironment,
  resolveCompleteClientBuildEnvironment,
  writeClientBuildRecord,
} from './client-build-environment.ts'
import { clientBundle } from '../packages/client/tsdown.client.ts'

const root = resolve(import.meta.dirname, '..')
const PROBE_NAME = 'DSH_CLIENT_BUILD_TEST'
const COMMIT_HASH = '0123456789abcdef0123456789abcdef01234567'
const PROBE_KEY = `process.env.${PROBE_NAME}`
const harnessyEnvironment = {
  DSH_CLIENT_BUILD_PROFILE: 'custom-harness',
  DSH_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
  DSH_CLIENT_ICON_PATH: '/harnessy.png',
  DSH_CLIENT_MANIFEST_SHORT_NAME: 'Harnessy',
  DSH_CLIENT_MARK_PATH: '/harnessy-mark.png',
  DSH_CLIENT_PRODUCT_NAME: 'Harnessy',
  DSH_CLIENT_PRODUCT_SLUG: 'custom-harness',
  DSH_CLIENT_PRODUCT_URL: 'https://github.com/amAbdoMo/Harnessy',
  DSH_CLIENT_SUPPORT_URL: 'https://github.com/amAbdoMo/Harnessy/issues',
  DSH_CLIENT_TITLE: 'Harnessy',
  DSH_CLIENT_VERSION: '1.2.3',
} as const
const originalProbe = process.env[PROBE_NAME]
const roots: string[] = []
const dshBuildWorkflows = [
  'build-exe-for-python-sdk.yml',
  'ci.yml',
  'e2e.yml',
  'release.yml',
  'release-publish.yml',
  'sandbox.yml',
]

afterEach(() => {
  vi.unstubAllEnvs()
  if (originalProbe === undefined) Reflect.deleteProperty(process.env, PROBE_NAME)
  else process.env[PROBE_NAME] = originalProbe
  vi.resetModules()
  for (const fixtureRoot of roots.splice(0)) rmSync(fixtureRoot, { recursive: true, force: true })
})

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function buildFixture(environment: Record<string, string>): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-client-build-'))
  roots.push(fixtureRoot)
  write(join(fixtureRoot, 'apps/web/dist/index.html'), '<main></main>')
  write(join(fixtureRoot, 'packages/client/example/lib/client.js'), 'module.exports = {}\n')
  writeClientBuildRecord(fixtureRoot, environment)
  return fixtureRoot
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function repositoryFixture(version = '1.2.3-rc.4'): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-client-build-repository-'))
  roots.push(fixtureRoot)
  write(join(fixtureRoot, 'package.json'), `${JSON.stringify({ version })}\n`)
  write(join(fixtureRoot, 'tracked.txt'), 'committed\n')
  git(fixtureRoot, ['init'])
  git(fixtureRoot, ['config', 'user.name', 'DSH test'])
  git(fixtureRoot, ['config', 'user.email', 'dsh-test@example.invalid'])
  git(fixtureRoot, ['config', 'commit.gpgsign', 'false'])
  git(fixtureRoot, ['add', 'package.json', 'tracked.txt'])
  git(fixtureRoot, ['commit', '-m', 'fixture'])
  return fixtureRoot
}

describe('client build environment', () => {
  it('requires an exact public environment for a named artifact profile', () => {
    const expected = {
      DSH_CLIENT_BUILD_PROFILE: 'official',
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      DSH_CLIENT_TITLE: 'DeepSeek Harness',
      DSH_CLIENT_VERSION: '1.2.3',
    } as const

    expect(() => { assertClientBuildEnvironment({ PATH: '/bin', ...expected }, expected) }).not.toThrow()
    expect(() => { assertClientBuildEnvironment({}, expected) }).toThrow(/DSH_CLIENT_TITLE/)
    expect(() => { assertClientBuildEnvironment({ DSH_CLIENT_TITLE: 'Other' }, expected) }).toThrow(/DSH_CLIENT_TITLE/)
    expect(() => {
      assertClientBuildEnvironment({ ...expected, DSH_CLIENT_UNDECLARED: 'value' }, expected)
    }).toThrow(/DSH_CLIENT_UNDECLARED/)
  })

  it('inherits public values by default and isolates an explicit official profile', () => {
    const parent = {
      PATH: '/bin',
      DSH_BUILD_CLIENT_PROFILE: 'official',
      DSH_CLIENT_BUILD_PROFILE: 'local',
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      DSH_CLIENT_GIT_DIRTY: 'true',
      DSH_CLIENT_TITLE: 'Local title',
      DSH_CLIENT_VERSION: '1.2.3',
      DSH_CLIENT_EXTRA: 'local-extra',
    }

    expect(resolveClientBuildEnvironment({ DSH_CLIENT_TITLE: 'Local title' })).toEqual({
      DSH_CLIENT_TITLE: 'Local title',
    })
    expect(resolveClientBuildEnvironment(parent)).toEqual({
      DSH_CLIENT_BUILD_PROFILE: 'official',
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      DSH_CLIENT_TITLE: 'DeepSeek Harness',
      DSH_CLIENT_VERSION: '1.2.3',
    })
    expect(() => {
      resolveClientBuildEnvironment({ DSH_BUILD_CLIENT_PROFILE: 'official' })
    }).toThrow(/DSH_CLIENT_COMMIT_HASH/)
    expect(() => {
      resolveClientBuildEnvironment({
        DSH_BUILD_CLIENT_PROFILE: 'official',
        DSH_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      })
    }).toThrow(/DSH_CLIENT_VERSION/)
    expect(() => { resolveClientBuildEnvironment({}, 'unknown') }).toThrow(/unknown client build profile/)
    expect(clientBuildProcessEnvironment(parent, {
      DSH_CLIENT_BUILD_PROFILE: 'official',
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      DSH_CLIENT_TITLE: 'DeepSeek Harness',
      DSH_CLIENT_VERSION: '1.2.3',
    })).toEqual({
      PATH: '/bin',
      DSH_CLIENT_BUILD_PROFILE: 'official',
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      DSH_CLIENT_TITLE: 'DeepSeek Harness',
      DSH_CLIENT_VERSION: '1.2.3',
    })
    expect(repositoryCommitHash('/unused', { DSH_CLIENT_COMMIT_HASH: COMMIT_HASH })).toBe(COMMIT_HASH.slice(0, 7))
  })

  it('isolates the Harnessy product identity in its named build profile', () => {
    const resolved = resolveClientBuildEnvironment({
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      DSH_CLIENT_VERSION: '1.2.3',
      DSH_CLIENT_TITLE: 'ambient title',
      DSH_CLIENT_PRODUCT_URL: 'https://ambient.invalid',
    }, 'custom-harness')

    expect(resolved).toEqual({
      DSH_CLIENT_BUILD_PROFILE: 'custom-harness',
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      DSH_CLIENT_ICON_PATH: '/harnessy.png',
      DSH_CLIENT_MANIFEST_SHORT_NAME: 'Harnessy',
      DSH_CLIENT_MARK_PATH: '/harnessy-mark.png',
      DSH_CLIENT_PRODUCT_NAME: 'Harnessy',
      DSH_CLIENT_PRODUCT_SLUG: 'custom-harness',
      DSH_CLIENT_PRODUCT_URL: 'https://github.com/amAbdoMo/Harnessy',
      DSH_CLIENT_SUPPORT_URL: 'https://github.com/amAbdoMo/Harnessy/issues',
      DSH_CLIENT_TITLE: 'Harnessy',
      DSH_CLIENT_VERSION: '1.2.3',
    })
    expect(() => { resolveClientBuildEnvironment({}, 'custom-harness') })
      .toThrow(/DSH_CLIENT_COMMIT_HASH/)
  })

  it('owns repository version, commit, and dirty metadata for complete builds', () => {
    const fixtureRoot = repositoryFixture()
    const commit = git(fixtureRoot, ['rev-parse', '--short=7', 'HEAD'])

    expect(resolveCompleteClientBuildEnvironment(fixtureRoot, {})).toEqual({
      DSH_CLIENT_COMMIT_HASH: commit, DSH_CLIENT_VERSION: '1.2.3-rc.4',
    })
    expect(repositoryVersion(fixtureRoot)).toBe('1.2.3-rc.4')
    expect(repositoryGitDirty(fixtureRoot)).toBe(false)
    expect(repositoryClientBuildEnvironment(fixtureRoot, {
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH,
      DSH_CLIENT_EXTRA: 'preserved',
      DSH_CLIENT_GIT_DIRTY: 'true',
      DSH_CLIENT_VERSION: 'spoofed',
    })).toEqual({
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      DSH_CLIENT_EXTRA: 'preserved',
      DSH_CLIENT_VERSION: '1.2.3-rc.4',
    })
    expect(officialClientBuildEnvironment(fixtureRoot)).toEqual({
      DSH_CLIENT_BUILD_PROFILE: 'official',
      DSH_CLIENT_COMMIT_HASH: commit,
      DSH_CLIENT_TITLE: 'DeepSeek Harness',
      DSH_CLIENT_VERSION: '1.2.3-rc.4',
    })

    write(join(fixtureRoot, '.gitignore'), 'ignored.txt\n')
    git(fixtureRoot, ['add', '.gitignore'])
    git(fixtureRoot, ['commit', '-m', 'ignore fixture'])
    write(join(fixtureRoot, 'ignored.txt'), 'ignored\n')
    expect(repositoryGitDirty(fixtureRoot)).toBe(false)
    rmSync(join(fixtureRoot, 'ignored.txt'))

    write(join(fixtureRoot, 'tracked.txt'), 'unstaged\n')
    expect(repositoryGitDirty(fixtureRoot)).toBe(true)
    write(join(fixtureRoot, 'tracked.txt'), 'committed\n')
    expect(repositoryGitDirty(fixtureRoot)).toBe(false)

    write(join(fixtureRoot, 'tracked.txt'), 'staged\n')
    git(fixtureRoot, ['add', 'tracked.txt'])
    expect(repositoryGitDirty(fixtureRoot)).toBe(true)
    git(fixtureRoot, ['commit', '-m', 'staged fixture'])
    expect(repositoryGitDirty(fixtureRoot)).toBe(false)

    write(join(fixtureRoot, 'untracked.txt'), 'untracked\n')
    expect(repositoryGitDirty(fixtureRoot)).toBe(true)
    expect(repositoryClientBuildEnvironment(fixtureRoot, {
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH,
    })).toEqual({
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      DSH_CLIENT_GIT_DIRTY: 'true',
      DSH_CLIENT_VERSION: '1.2.3-rc.4',
    })

    rmSync(join(fixtureRoot, 'untracked.txt'))
    const submoduleSource = repositoryFixture('9.8.7')
    git(fixtureRoot, ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'submodule'])
    git(fixtureRoot, ['commit', '-am', 'submodule fixture'])
    expect(repositoryGitDirty(fixtureRoot)).toBe(false)
    write(join(fixtureRoot, 'submodule/tracked.txt'), 'modified submodule\n')
    expect(repositoryGitDirty(fixtureRoot)).toBe(true)
  })

  it('omits dirty metadata when repository metadata is unavailable', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-client-build-no-git-'))
    roots.push(fixtureRoot)
    write(join(fixtureRoot, 'package.json'), '{"version":"2.0.0"}\n')

    expect(repositoryGitDirty(fixtureRoot)).toBeUndefined()
    expect(repositoryClientBuildEnvironment(fixtureRoot, {
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH,
      DSH_CLIENT_GIT_DIRTY: 'true',
    })).toEqual({
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      DSH_CLIENT_VERSION: '2.0.0',
    })
  })

  it('defines only public client values over a non-enumerable fallback', () => {
    expect(clientBuildEnvironmentDefines({
      PATH: '/bin',
      DSH_TEST_API_KEY: 'secret',
      DSH_CLIENT_VARIANT: 'quoted "value"',
      DSH_CLIENT_EMPTY: '',
      DSH_CLIENT_UNSET: undefined,
    })).toEqual({
      'process.env': '{}',
      'process.env.DSH_CLIENT_EMPTY': '""',
      'process.env.DSH_CLIENT_VARIANT': '"quoted \\"value\\""',
    })
  })

  it('feeds the same resolved public identity to dynamic tsdown bundles and the Vite shell', async () => {
    try {
      vi.stubEnv(PROBE_NAME, 'shared-value')
      vi.stubEnv('DSH_BUILD_CLIENT_PROFILE', undefined)
      vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', undefined)
      vi.stubEnv('DSH_CLIENT_COMMIT_HASH', COMMIT_HASH.slice(0, 7))
      vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
      const expected = clientBuildEnvironmentDefines(resolveClientBundlerEnvironment(root, process.env))
      const configs = clientBundle('@deepseek-ai/dsh-client-ui-sidebar', [
        'lib/types/index.js',
      ])({ env: { DSH_BUILD_FACE: 'client' } })
      if (!Array.isArray(configs)) throw new TypeError('client bundle config must be an array')
      const dynamic = configs.find(config => config.name === '@deepseek-ai/dsh-client-ui-sidebar/client')
      expect(dynamic?.define).toMatchObject(expected)
      expect(dynamic?.define).toMatchObject({
        'process.env': '{}',
        [PROBE_KEY]: '"shared-value"',
      })

      const viteConfigPath = '../apps/web/vite.config.ts'
      const viteModule: unknown = await import(viteConfigPath)
      if (typeof viteModule !== 'object' || viteModule === null) {
        throw new TypeError('web Vite config module must be an object')
      }
      const viteConfig: unknown = Reflect.get(viteModule, 'default')
      if (typeof viteConfig === 'function') throw new TypeError('web Vite config must be an object')
      if (typeof viteConfig !== 'object' || viteConfig === null) {
        throw new TypeError('web Vite config must be an object')
      }
      expect(Reflect.get(viteConfig, 'define')).toMatchObject(expected)
      expect(Reflect.get(viteConfig, 'define')).toMatchObject({
        'process.env': '{}',
        [PROBE_KEY]: '"shared-value"',
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('retains Harnessy branding and the custom-plugin profile in a no-env partial build', () => {
    const fixtureRoot = buildFixture(harnessyEnvironment)
    const restored = resolveClientBundlerEnvironment(fixtureRoot, {})

    expect(restored).toEqual(harnessyEnvironment)
    const defines = clientBuildEnvironmentDefines(restored)
    expect({
      fallback: defines['process.env'],
      profile: defines['process.env.DSH_CLIENT_BUILD_PROFILE'],
      title: defines['process.env.DSH_CLIENT_TITLE'],
      product: defines['process.env.DSH_CLIENT_PRODUCT_NAME'],
      slug: defines['process.env.DSH_CLIENT_PRODUCT_SLUG'],
      icon: defines['process.env.DSH_CLIENT_ICON_PATH'],
    }).toMatchInlineSnapshot(`
      {
        "fallback": "{}",
        "icon": "\\\"/harnessy.png\\\"",
        "product": "\\\"Harnessy\\\"",
        "profile": "\\\"custom-harness\\\"",
        "slug": "\\\"custom-harness\\\"",
        "title": "\\\"Harnessy\\\"",
      }
    `)
  })

  it.each(['selector', 'public profile'] as const)(
    'lets an explicit %s replace recorded branding without modifying the record',
    (selection) => {
      const fixtureRoot = buildFixture(harnessyEnvironment)
      const recordPath = join(fixtureRoot, CLIENT_BUILD_RECORD_PATH)
      const before = readFileSync(recordPath, 'utf8')
      const official = {
        DSH_CLIENT_BUILD_PROFILE: 'official',
        DSH_CLIENT_COMMIT_HASH: 'abcdef0',
        DSH_CLIENT_TITLE: 'DeepSeek Harness',
        DSH_CLIENT_VERSION: '2.0.0',
      }
      const caller = selection === 'selector'
        ? {
          ...official,
          DSH_BUILD_CLIENT_PROFILE: 'official',
          DSH_CLIENT_BUILD_PROFILE: 'custom-harness',
          DSH_CLIENT_TITLE: 'ambient title',
        }
        : official

      expect(resolveClientBundlerEnvironment(fixtureRoot, caller)).toEqual(official)
      expect(readFileSync(recordPath, 'utf8')).toBe(before)
      expect(() => { readClientBuildRecord(fixtureRoot, official) }).toThrow(/required artifact profile/)
      expect(readClientBuildRecord(fixtureRoot, harnessyEnvironment).environment).toEqual(harnessyEnvironment)
      expect(() => {
        resolveClientBundlerEnvironment(fixtureRoot, { DSH_BUILD_CLIENT_PROFILE: 'official' })
      }).toThrow(/DSH_CLIENT_COMMIT_HASH/)
    },
  )

  it.each([
    'DSH_CLIENT_TITLE', 'DSH_CLIENT_PRODUCT_SLUG', 'DSH_CLIENT_EXTRA',
    'DSH_CLIENT_COMMIT_HASH', 'DSH_CLIENT_VERSION', 'DSH_CLIENT_GIT_DIRTY',
  ])(
    'rejects a partial %s override rather than dropping recorded identity',
    (name) => {
      const fixtureRoot = buildFixture({ ...harnessyEnvironment, DSH_CLIENT_EXTRA: 'recorded' })
      const recordPath = join(fixtureRoot, CLIENT_BUILD_RECORD_PATH)
      const before = readFileSync(recordPath, 'utf8')

      expect(() => { resolveClientBundlerEnvironment(fixtureRoot, { [name]: 'different' }) })
        .toThrow(/partial client build cannot override a recorded environment/)
      expect(readFileSync(recordPath, 'utf8')).toBe(before)
      expect(readClientBuildRecord(fixtureRoot).environment.DSH_CLIENT_BUILD_PROFILE).toBe('custom-harness')
    },
  )

  it.each([
    { environment: { DSH_CLIENT_BUILD_PROFILE: 'custom-harness' }, error: /DSH_CLIENT_COMMIT_HASH/ },
    { environment: { ...harnessyEnvironment, DSH_CLIENT_TITLE: undefined }, error: /DSH_CLIENT_TITLE/ },
    { environment: { ...harnessyEnvironment, DSH_CLIENT_EXTRA: 'unexpected' }, error: /DSH_CLIENT_EXTRA/ },
    { environment: { ...harnessyEnvironment, DSH_CLIENT_BUILD_PROFILE: 'unknown' }, error: /unknown client build profile/ },
  ])('rejects an incomplete or unsupported public profile ($error)', ({ environment, error }) => {
    const fixtureRoot = buildFixture(harnessyEnvironment)
    expect(() => { resolveClientBundlerEnvironment(fixtureRoot, environment) }).toThrow(error)
  })

  it.each([false, true])('keeps host-only configuration independent of browser identity (host phase %s)', (hostPhase) => {
    try {
      vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'custom-harness')
      vi.stubEnv('DSH_CLIENT_COMMIT_HASH', undefined)
      vi.stubEnv('DSH_CLIENT_VERSION', undefined)
      const bundle = clientBundle('@deepseek-ai/dsh-client-ui-sidebar', ['lib/types/index.js'], { hostPhase })
      expect(() => bundle({ env: { DSH_BUILD_FACE: 'host' } })).not.toThrow()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('preserves a complete build identity while refreshing commit and version rather than copying stale metadata', () => {
    const fixtureRoot = repositoryFixture()
    write(join(fixtureRoot, 'apps/web/dist/index.html'), '<main></main>')
    writeClientBuildRecord(fixtureRoot, harnessyEnvironment)
    const recordPath = join(fixtureRoot, CLIENT_BUILD_RECORD_PATH)
    const before = readFileSync(recordPath, 'utf8')
    const commit = git(fixtureRoot, ['rev-parse', '--short=7', 'HEAD'])

    expect(resolveCompleteClientBuildEnvironment(fixtureRoot, {})).toEqual({
      ...harnessyEnvironment, DSH_CLIENT_COMMIT_HASH: commit, DSH_CLIENT_VERSION: '1.2.3-rc.4',
    })
    expect(resolveCompleteClientBuildEnvironment(fixtureRoot, {}, 'official'))
      .toEqual(officialClientBuildEnvironment(fixtureRoot))
    const local = resolveCompleteClientBuildEnvironment(fixtureRoot, { DSH_CLIENT_TITLE: 'Deliberate local build' })
    expect(local).toEqual({
      DSH_CLIENT_COMMIT_HASH: commit, DSH_CLIENT_VERSION: '1.2.3-rc.4',
      DSH_CLIENT_TITLE: 'Deliberate local build', DSH_CLIENT_GIT_DIRTY: 'true',
    })
    expect(readFileSync(recordPath, 'utf8')).toBe(before)
  })

  it('uses a complete explicit local environment without importing recorded branding', () => {
    const recorded = { ...harnessyEnvironment, DSH_CLIENT_GIT_DIRTY: 'true', DSH_CLIENT_EXTRA: 'recorded' }
    const fixtureRoot = buildFixture(recorded)
    const caller = {
      PATH: '/bin',
      DSH_TEST_API_KEY: 'secret',
      DSH_CLIENT_COMMIT_HASH: 'abcdef0',
      DSH_CLIENT_VERSION: '2.0.0',
      DSH_CLIENT_GIT_DIRTY: 'false',
      DSH_CLIENT_TITLE: 'Harnessy',
      DSH_CLIENT_NEW_EXTENSION: 'caller',
    }

    expect(resolveClientBundlerEnvironment(fixtureRoot, caller)).toEqual({
      DSH_CLIENT_COMMIT_HASH: 'abcdef0',
      DSH_CLIENT_VERSION: '2.0.0',
      DSH_CLIENT_GIT_DIRTY: 'false',
      DSH_CLIENT_TITLE: 'Harnessy',
      DSH_CLIENT_NEW_EXTENSION: 'caller',
    })
    expect(readClientBuildRecord(fixtureRoot, recorded).environment).toEqual(recorded)
  })

  it('restores identity from stale artifacts without blessing the old digest', () => {
    const fixtureRoot = buildFixture(harnessyEnvironment)
    const recordPath = join(fixtureRoot, CLIENT_BUILD_RECORD_PATH)
    const before = readFileSync(recordPath, 'utf8')
    write(join(fixtureRoot, 'packages/client/example/lib/client.js'), 'module.exports = { changed: true }\n')

    expect(() => { readClientBuildRecord(fixtureRoot, harnessyEnvironment) }).toThrow(/artifacts differ/)
    expect(resolveClientBundlerEnvironment(fixtureRoot, {})).toEqual(harnessyEnvironment)
    expect(readFileSync(recordPath, 'utf8')).toBe(before)
    expect(() => { readClientBuildRecord(fixtureRoot, harnessyEnvironment) }).toThrow(/artifacts differ/)
  })

  it.each([
    { name: 'JSON', replacement: '{', error: /invalid JSON/ },
    { name: 'schema', replacement: '{}', error: /invalid top-level schema/ },
    { name: 'version', fields: { formatVersion: 2 }, error: /uses format 2/ },
    {
      name: 'environment value',
      fields: { environment: { DSH_CLIENT_TITLE: 42 } },
      error: /invalid environment entry/,
    },
    {
      name: 'private environment key',
      fields: { environment: { PATH: '/bin' } },
      error: /invalid environment entry/,
    },
    {
      name: 'artifact count',
      fields: { artifacts: { fileCount: 0, sha256: 'a'.repeat(64) } },
      error: /invalid artifact count/,
    },
    {
      name: 'digest',
      fields: { artifacts: { fileCount: 2, sha256: 'invalid' } },
      error: /invalid SHA-256 digest/,
    },
  ])('rejects malformed recorded $name before a partial build can write', ({ replacement, fields, error }) => {
    const fixtureRoot = buildFixture(harnessyEnvironment)
    const recordPath = join(fixtureRoot, CLIENT_BUILD_RECORD_PATH)
    const record = readClientBuildRecord(fixtureRoot)
    const malformed = replacement ?? JSON.stringify({ ...record, ...fields })
    write(recordPath, malformed)

    expect(() => { resolveClientBundlerEnvironment(fixtureRoot, {}) }).toThrow(error)
    expect(() => { readClientBuildRecord(fixtureRoot) }).toThrow(error)
    expect(readFileSync(recordPath, 'utf8')).toBe(malformed)
    expect(readFileSync(join(fixtureRoot, 'apps/web/dist/index.html'), 'utf8')).toBe('<main></main>')
    expect(readFileSync(join(fixtureRoot, 'packages/client/example/lib/client.js'), 'utf8'))
      .toBe('module.exports = {}\n')
  })

  it.each(['empty', 'missing'] as const)('keeps local defaults with an %s record', (state) => {
    const fixtureRoot = buildFixture({})
    if (state === 'missing') rmSync(join(fixtureRoot, CLIENT_BUILD_RECORD_PATH))

    expect(resolveClientBundlerEnvironment(fixtureRoot, {})).toEqual({})
    expect(clientBuildEnvironmentDefines(resolveClientBundlerEnvironment(fixtureRoot, {})))
      .toEqual({ 'process.env': '{}' })
    const caller = { PATH: '/bin', DSH_CLIENT_TITLE: 'Local title', DSH_CLIENT_EXTRA: 'local-extra' }
    if (state === 'missing') {
      expect(resolveClientBundlerEnvironment(fixtureRoot, caller))
        .toEqual({ DSH_CLIENT_TITLE: 'Local title', DSH_CLIENT_EXTRA: 'local-extra' })
    } else {
      expect(() => { resolveClientBundlerEnvironment(fixtureRoot, caller) }).toThrow(/cannot override/)
    }
  })

  it('binds the recorded environment to a complete set of client artifacts', () => {
    const officialEnvironment = {
      DSH_CLIENT_BUILD_PROFILE: 'official',
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      DSH_CLIENT_TITLE: 'DeepSeek Harness',
      DSH_CLIENT_VERSION: '1.2.3',
    }
    const official = buildFixture(officialEnvironment)
    const defaultBuild = buildFixture({})

    expect(readClientBuildRecord(official, officialEnvironment).environment).toEqual(officialEnvironment)
    expect(() => { readClientBuildRecord(defaultBuild, officialEnvironment) }).toThrow(/DSH_CLIENT_/)
    expect(() => { readClientBuildRecord(join(defaultBuild, 'missing')) }).toThrow(/record.*missing/)

    write(join(official, 'apps/web/dist/index.html'), '<main>changed</main>')
    expect(() => { readClientBuildRecord(official) }).toThrow(/artifacts differ/)

    const chunked = buildFixture(officialEnvironment)
    write(join(chunked, 'packages/client/example/lib/client.pdf.js'), 'module.exports = {}\n')
    expect(() => { readClientBuildRecord(chunked) }).toThrow(/artifacts differ/)
  })

  it('keeps public client values out of workflow-wide environments', () => {
    for (const name of dshBuildWorkflows) {
      const path = `.github/workflows/${name}`
      const document: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
      if (typeof document !== 'object' || document === null || Array.isArray(document)) {
        throw new TypeError(`${path} must contain a workflow object`)
      }
      expect(JSON.stringify(document), path).not.toContain('DSH_CLIENT_')
    }
  })
})
