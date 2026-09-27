import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  approvalPhrase,
  normalizeRemoteUrl,
  parsePromoteInvocation,
  parseWorktreeList,
  promoteWindowsRelease,
  requireStableVersion,
  requireWindowsX64Host,
  sameCheckoutPath,
  selectMasterWorktree,
  type PromoteCommand,
  type PromoteCommandAdapter,
  type PromoteCommandResult,
  type PromoteWindowsReleaseResult,
} from '../scripts/promote-windows-release.ts'

const VERSION = '1.2.3'
const TAG = `v${VERSION}`
const BASE = '1'.repeat(40)
const MID = '2'.repeat(40)
const COMMIT = '3'.repeat(40)
const AHEAD = '4'.repeat(40)
/** Commit order used by the fixture's ancestry answers, oldest first. */
const HISTORY = [BASE, MID, COMMIT, AHEAD]

const ORIGIN = 'https://github.com/amAbdoMo/Harnessy.git'
const VERSION_RUN = `pnpm run release:dsh ${VERSION}`
const PACKAGE_CHECK_RUN = 'pnpm --dir apps/desktop run check:package:win:x64:production'
const QUALIFY_RUN = 'pnpm run release:win:x64:qualify'
const PACKAGE_RUN = 'pnpm --dir apps/desktop run package:win:x64:production'
const CHECK_RUN = 'pnpm --dir apps/desktop run release:github:win:x64:check'
const DRAFT_RUN = 'pnpm --dir apps/desktop run release:github:win:x64:draft'
const VERIFY_RUN = 'pnpm --dir apps/desktop run release:github:win:x64:verify'
const TAG_PUSH = `git push origin refs/tags/${TAG}:refs/tags/${TAG}`
const MASTER_PUSH = `git push --force-with-lease=refs/heads/master:${MID} origin ${COMMIT}:refs/heads/master`

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** One command the approval ran or inspected, in call order. */
interface RecordedCall {
  readonly kind: 'run' | 'inspect'
  readonly command: PromoteCommand
}

/** Mutable state the fixture derives its git and gh answers from. */
interface HarnessState {
  declaredVersion: string
  stagingStatus: string
  masterStatus: string
  originUrl: string
  masterOriginUrl: string
  authenticated: boolean
  localTag: string | undefined
  remoteTag: string | undefined
  masterHead: string
  originMaster: string
  mergeFails: boolean
  packageFails: boolean
  artifactsReady: boolean
  draftVerified: boolean
  draftFails: boolean
}

/** Fixture inputs; each one stands for a state an approval can meet. */
interface FixtureOptions {
  readonly declaredVersion?: string
  readonly stagingStatus?: string
  readonly masterStatus?: string
  readonly originUrl?: string
  readonly masterOriginUrl?: string
  readonly authenticated?: boolean
  readonly localTag?: string
  readonly remoteTag?: string
  readonly masterHead?: string
  readonly originMaster?: string
  readonly mergeFails?: boolean
  readonly packageFails?: boolean
  readonly artifactsReady?: boolean
  readonly draftVerified?: boolean
  readonly draftFails?: boolean
  readonly platform?: NodeJS.Platform
  readonly arch?: string
}

/** One staging worktree with scripted git, gh, and pnpm answers. */
interface PromoteFixture {
  readonly stagingRoot: string
  readonly masterRoot: string
  readonly state: HarnessState
  readonly calls: RecordedCall[]
  readonly log: string[]
  /** Number of run calls already recorded when the operator confirmed. */
  readonly confirmation: { count: number; after: number }
  run(decline?: boolean): Promise<PromoteWindowsReleaseResult>
}

function isAncestor(left: string | undefined, right: string | undefined): boolean {
  const leftIndex = HISTORY.indexOf(left ?? '')
  const rightIndex = HISTORY.indexOf(right ?? '')
  return leftIndex >= 0 && rightIndex >= 0 && leftIndex <= rightIndex
}

async function writeManifests(root: string, version: string): Promise<void> {
  await mkdir(join(root, 'apps', 'desktop'), { recursive: true })
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'root', version })}\n`)
  await writeFile(join(root, 'apps', 'desktop', 'package.json'), `${JSON.stringify({ name: 'desktop', version })}\n`)
}

async function createStagingRoot(version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-promote-'))
  roots.push(root)
  await writeManifests(root, version)
  return root
}

/** Answer one captured command from the fixture state, refusing anything unscripted. */
function inspectCommand(command: PromoteCommand, state: HarnessState, masterRoot: string): PromoteCommandResult {
  if (command.executable === 'gh') return { status: state.authenticated ? 0 : 1, stdout: '' }
  if (command.label === VERIFY_RUN) return { status: state.draftVerified ? 0 : 1, stdout: '' }
  if (command.label === CHECK_RUN) return { status: state.artifactsReady ? 0 : 1, stdout: '' }
  if (command.executable !== 'git') throw new Error(`unexpected command: ${command.label}`)
  const inMaster = sameCheckoutPath(command.cwd, masterRoot)
  const ok = (stdout: string): PromoteCommandResult => ({ status: 0, stdout })
  const [subcommand, ...rest] = command.args
  switch (subcommand) {
    case 'worktree':
      return ok([
        `worktree ${command.cwd}`,
        `HEAD ${COMMIT}`,
        'branch refs/heads/feature/staging',
        '',
        `worktree ${masterRoot}`,
        `HEAD ${state.masterHead}`,
        'branch refs/heads/master',
        '',
      ].join('\n'))
    case 'remote':
      return ok(inMaster ? state.masterOriginUrl : state.originUrl)
    case 'status':
      return ok(inMaster ? state.masterStatus : state.stagingStatus)
    case 'tag':
      return ok(state.localTag === undefined ? '' : TAG)
    case 'rev-list':
      return ok(state.localTag ?? '')
    case 'rev-parse':
      if (rest[0] === 'HEAD') return ok(inMaster ? state.masterHead : COMMIT)
      if (rest[0] === 'origin/master') return ok(state.originMaster)
      break
    case 'ls-remote':
      return ok(state.remoteTag === undefined ? '' : `${state.remoteTag}\trefs/tags/${TAG}`)
    case 'merge-base': {
      const [left, right] = rest.slice(1)
      return { status: isAncestor(left, right) ? 0 : 1, stdout: '' }
    }
    default:
      break
  }
  throw new Error(`unexpected command: ${command.label}`)
}

/** Apply the effect one executed command has on the fixture state. */
async function applyRun(command: PromoteCommand, state: HarnessState, stagingRoot: string): Promise<void> {
  if (command.label === 'git fetch origin master') return
  if (command.label === PACKAGE_CHECK_RUN || command.label === QUALIFY_RUN) return
  if (command.label === PACKAGE_RUN) {
    if (state.packageFails) throw new Error(`promote: ${command.label} exited with 1`)
    state.artifactsReady = true
    return
  }
  if (command.label === CHECK_RUN) return
  if (command.label === VERSION_RUN) {
    await writeManifests(stagingRoot, VERSION)
    state.declaredVersion = VERSION
    return
  }
  if (command.label === `git tag ${TAG} ${COMMIT}`) {
    state.localTag = COMMIT
    return
  }
  if (command.label === `git merge --ff-only ${COMMIT}`) {
    if (state.mergeFails) throw new Error(`promote: ${command.label} exited with 1`)
    state.masterHead = COMMIT
    return
  }
  if (command.label === TAG_PUSH) {
    state.remoteTag = COMMIT
    return
  }
  if (command.label === MASTER_PUSH) {
    state.originMaster = COMMIT
    return
  }
  if (command.label === DRAFT_RUN) {
    if (state.draftFails) throw new Error(`promote: ${command.label} exited with 1`)
    state.draftVerified = true
    return
  }
  if (command.label === VERIFY_RUN) {
    state.draftVerified = true
    return
  }
  throw new Error(`unexpected command: ${command.label}`)
}

async function createFixture(options: FixtureOptions = {}): Promise<PromoteFixture> {
  const stagingRoot = await createStagingRoot(options.declaredVersion ?? VERSION)
  const masterRoot = resolve('fixture-master')
  const state: HarnessState = {
    declaredVersion: options.declaredVersion ?? VERSION,
    stagingStatus: options.stagingStatus ?? '',
    masterStatus: options.masterStatus ?? '',
    originUrl: options.originUrl ?? ORIGIN,
    masterOriginUrl: options.masterOriginUrl ?? ORIGIN,
    authenticated: options.authenticated ?? true,
    localTag: options.localTag,
    remoteTag: options.remoteTag,
    masterHead: options.masterHead ?? MID,
    originMaster: options.originMaster ?? MID,
    mergeFails: options.mergeFails ?? false,
    packageFails: options.packageFails ?? false,
    artifactsReady: options.artifactsReady ?? false,
    draftVerified: options.draftVerified ?? false,
    draftFails: options.draftFails ?? false,
  }
  const calls: RecordedCall[] = []
  const log: string[] = []
  const confirmation = { count: 0, after: 0 }
  const adapter: PromoteCommandAdapter = {
    run: async (command) => {
      calls.push({ kind: 'run', command })
      await applyRun(command, state, stagingRoot)
    },
    inspect: (command) => {
      calls.push({ kind: 'inspect', command })
      return inspectCommand(command, state, masterRoot)
    },
  }
  const fixture: PromoteFixture = {
    stagingRoot,
    masterRoot,
    state,
    calls,
    log,
    confirmation,
    run: async (decline = false) => {
      const result = await promoteWindowsRelease({
        version: VERSION,
        stagingRoot,
        adapter,
        confirm: async (phrase) => {
          confirmation.count += 1
          confirmation.after = calls.length
          expect(phrase).toBe(approvalPhrase(TAG))
          return !decline
        },
        platform: options.platform ?? 'win32',
        arch: options.arch ?? 'x64',
        releaseEnvironment: () => 'production',
        log: (message) => { log.push(message) },
      })
      return result
    },
  }
  return fixture
}

function runs(fixture: PromoteFixture): string[] {
  return fixture.calls.filter(call => call.kind === 'run').map(call => call.command.label)
}

function runIndex(fixture: PromoteFixture, label: string): number {
  return runs(fixture).indexOf(label)
}

function callIndex(fixture: PromoteFixture, label: string): number {
  return fixture.calls.findIndex(call => call.command.label === label)
}

describe('promote Windows release command line', () => {
  it('requires an explicit stable version', () => {
    expect(() => parsePromoteInvocation([])).toThrow(/--version <stable-semver> is required/)
    expect(() => parsePromoteInvocation(['--version', VERSION])).not.toThrow()
    expect(parsePromoteInvocation(['--version', VERSION]).masterPath).toBeUndefined()
    expect(parsePromoteInvocation(['--', '--version', VERSION, '--master', 'C:/checkout'])).toEqual({
      version: VERSION,
      tag: TAG,
      masterPath: resolve('C:/checkout'),
    })
  })

  it('rejects prerelease, loose, and missing versions', () => {
    expect(() => requireStableVersion('1.2.3-rc.1')).toThrow(/stable semantic version/)
    expect(() => requireStableVersion('v1.2.3')).toThrow(/stable semantic version/)
    expect(() => requireStableVersion('1.2')).toThrow(/stable semantic version/)
    expect(() => requireStableVersion('1.2.3+build.1')).toThrow(/stable semantic version/)
    expect(requireStableVersion(VERSION)).toBe(VERSION)
  })

  it('runs only on a Windows x64 host', () => {
    expect(() => { requireWindowsX64Host('win32', 'x64') }).not.toThrow()
    expect(() => { requireWindowsX64Host('darwin', 'arm64') }).toThrow(/Windows x64 host/)
    expect(() => { requireWindowsX64Host('linux', 'x64') }).toThrow(/Windows x64 host/)
    expect(() => { requireWindowsX64Host('win32', 'arm64') }).toThrow(/Windows x64 host/)
  })
})

describe('promote Windows release worktree discovery', () => {
  const porcelain = [
    'worktree C:/work/staging',
    `HEAD ${COMMIT}`,
    'branch refs/heads/feature/staging',
    '',
    'worktree C:/work/master',
    `HEAD ${MID}`,
    'branch refs/heads/master',
    '',
    'worktree C:/work/detached',
    `HEAD ${BASE}`,
    'detached',
    '',
    'worktree C:/work/other',
    `HEAD ${MID}`,
    'branch refs/heads/master',
    '',
  ].join('\n')

  it('parses registered worktrees with their branches', () => {
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: 'C:/work/staging', branch: 'feature/staging' },
      { path: 'C:/work/master', branch: 'master' },
      { path: 'C:/work/detached', branch: undefined },
      { path: 'C:/work/other', branch: 'master' },
    ])
    expect(parseWorktreeList('')).toEqual([])
  })

  it('selects the only master worktree, or the explicitly named one', () => {
    const single = parseWorktreeList(porcelain).filter(worktree => worktree.path !== 'C:/work/other')
    expect(selectMasterWorktree(single, 'C:/work/staging')).toMatchObject({ path: 'C:/work/master' })
    expect(selectMasterWorktree(parseWorktreeList(porcelain), 'C:/work/staging', 'C:/work/other'))
      .toMatchObject({ path: 'C:/work/other' })
    expect(() => selectMasterWorktree(parseWorktreeList(porcelain), 'C:/work/staging')).toThrow(/2 master worktrees are registered/)
  })

  it('refuses ambiguous, unregistered, and wrong-branch master worktrees', () => {
    const withoutMaster = parseWorktreeList(porcelain).filter(worktree => worktree.branch !== 'master')
    expect(() => selectMasterWorktree(withoutMaster, 'C:/work/staging')).toThrow(/no linked master worktree/)
    expect(() => selectMasterWorktree(parseWorktreeList(porcelain), 'C:/work/staging', 'C:/work/missing'))
      .toThrow(/not a worktree of the staging repository/)
    expect(() => selectMasterWorktree(parseWorktreeList(porcelain), 'C:/work/staging', 'C:/work/staging'))
      .toThrow(/not master/)
  })

  it('compares checkout paths for the host filesystem', () => {
    expect(sameCheckoutPath('C:/work/master', 'C:\\work\\master')).toBe(true)
    expect(sameCheckoutPath('C:/work/master', 'C:/work/other')).toBe(false)
  })

  it('compares origin URLs by host and path', () => {
    const expected = normalizeRemoteUrl('https://github.com/amAbdoMo/Harnessy')
    expect(normalizeRemoteUrl(ORIGIN)).toBe(expected)
    expect(normalizeRemoteUrl('git@github.com:amAbdoMo/Harnessy.git')).toBe(expected)
    expect(normalizeRemoteUrl('ssh://git@github.com/amAbdoMo/Harnessy.git/')).toBe(expected)
    expect(normalizeRemoteUrl('https://github.com/deepseek-ai/deepseek-harness.git')).not.toBe(expected)
  })
})

describe('promote Windows release approval', () => {
  it('packages and checks before it moves master, then pushes and drafts', async () => {
    const fixture = await createFixture()
    const result = await fixture.run()

    expect(result).toEqual({
      version: VERSION,
      tag: TAG,
      commit: COMMIT,
      masterPath: fixture.masterRoot,
      masterPushed: true,
      tagPushed: true,
      draftCreated: true,
    })
    expect(fixture.state.masterHead).toBe(COMMIT)
    expect(fixture.state.originMaster).toBe(COMMIT)
    expect(fixture.state.remoteTag).toBe(COMMIT)
    expect(runs(fixture)).toEqual([
      'git fetch origin master',
      PACKAGE_CHECK_RUN,
      QUALIFY_RUN,
      `git tag ${TAG} ${COMMIT}`,
      PACKAGE_RUN,
      CHECK_RUN,
      'git fetch origin master',
      TAG_PUSH,
      DRAFT_RUN,
      VERIFY_RUN,
      `git merge --ff-only ${COMMIT}`,
      MASTER_PUSH,
    ])
    expect(runIndex(fixture, PACKAGE_CHECK_RUN)).toBeLessThan(runIndex(fixture, QUALIFY_RUN))
    expect(runIndex(fixture, QUALIFY_RUN)).toBeLessThan(runIndex(fixture, PACKAGE_RUN))
    expect(runIndex(fixture, PACKAGE_RUN)).toBeLessThan(runIndex(fixture, CHECK_RUN))
    expect(runIndex(fixture, CHECK_RUN)).toBeLessThan(runIndex(fixture, TAG_PUSH))
    expect(runIndex(fixture, TAG_PUSH)).toBeLessThan(runIndex(fixture, DRAFT_RUN))
    expect(runIndex(fixture, VERIFY_RUN)).toBeLessThan(runIndex(fixture, `git merge --ff-only ${COMMIT}`))
    expect(runIndex(fixture, `git merge --ff-only ${COMMIT}`)).toBeLessThan(runIndex(fixture, MASTER_PUSH))
    expect(fixture.confirmation.count).toBe(1)
    // Only the origin/master fetch precedes the prompt, so the operator approves after seeing fresh remote state.
    expect(fixture.calls.slice(0, fixture.confirmation.after)
      .filter(call => call.kind === 'run').map(call => call.command.label)).toEqual(['git fetch origin master'])
    expect(callIndex(fixture, 'gh auth status')).toBeLessThan(callIndex(fixture, 'git fetch origin master'))
  })

  it('never names or runs the publish command', async () => {
    const fixture = await createFixture()
    await fixture.run()
    const published = fixture.calls.filter(call =>
      call.command.label.includes('publish') || call.command.args.some(argument => argument.includes('publish')))
    expect(published).toEqual([])
    // The recorded calls only prove the executed path; the source must not reach a publish command at all.
    const source = await readFile(new URL('../scripts/promote-windows-release.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('release:github:win:x64:publish')
  })

  it('rejects a confirmation the operator did not type exactly', async () => {
    const fixture = await createFixture()
    await expect(fixture.run(true)).rejects.toThrow(/declined/)
    expect(runs(fixture)).toEqual(['git fetch origin master'])
    expect(fixture.state.masterHead).toBe(MID)
    expect(fixture.state.originMaster).toBe(MID)
    expect(fixture.state.localTag).toBeUndefined()
  })

  it('rejects a version that is not a stable release before running anything', async () => {
    const fixture = await createFixture()
    await expect(promoteWindowsRelease({
      version: '1.2.3-rc.1',
      stagingRoot: fixture.stagingRoot,
      adapter: { run: () => Promise.reject(new Error('no command may run')), inspect: () => ({ status: 0, stdout: '' }) },
      confirm: () => Promise.resolve(true),
      platform: 'win32',
      arch: 'x64',
    })).rejects.toThrow(/stable semantic version/)
    expect(fixture.calls).toEqual([])
  })

  it('rejects a host that cannot sign the Windows x64 package', async () => {
    const fixture = await createFixture({ platform: 'darwin', arch: 'arm64' })
    await expect(fixture.run()).rejects.toThrow(/Windows x64 host/)
    expect(fixture.calls).toEqual([])
  })

  it('refuses the test deployment before any release step', async () => {
    const fixture = await createFixture()
    await expect(promoteWindowsRelease({
      version: VERSION,
      stagingRoot: fixture.stagingRoot,
      adapter: { run: () => Promise.reject(new Error('no command may run')), inspect: () => ({ status: 0, stdout: '' }) },
      confirm: () => Promise.resolve(true),
      platform: 'win32',
      arch: 'x64',
      releaseEnvironment: () => 'test',
    })).rejects.toThrow(/DSH_DESKTOP_AUTO_UPDATE_ENV=production/)
  })

  it('refuses a dirty staging worktree before any release step', async () => {
    const fixture = await createFixture({ stagingStatus: ' M apps/desktop/package.json' })
    await expect(fixture.run()).rejects.toThrow(/staging worktree .* has uncommitted changes/)
    expect(runs(fixture)).toEqual([])
  })

  it('refuses a dirty master worktree before any release step', async () => {
    const fixture = await createFixture({ masterStatus: '?? scratch.txt' })
    await expect(fixture.run()).rejects.toThrow(/master worktree .* has uncommitted changes/)
    expect(runs(fixture)).toEqual([])
  })

  it('refuses a checkout whose origin is not the Harnessy repository', async () => {
    const staging = await createFixture({ originUrl: 'https://github.com/deepseek-ai/deepseek-harness.git' })
    await expect(staging.run()).rejects.toThrow(/expected https:\/\/github.com\/amAbdoMo\/Harnessy/)
    const master = await createFixture({ masterOriginUrl: 'git@github.com:someone/Harnessy.git' })
    await expect(master.run()).rejects.toThrow(/expected https:\/\/github.com\/amAbdoMo\/Harnessy/)
    expect(runs(staging)).toEqual([])
    expect(runs(master)).toEqual([])
  })

  it('refuses an unauthenticated gh before the first mutation', async () => {
    const fixture = await createFixture({ authenticated: false })
    await expect(fixture.run()).rejects.toThrow(/gh is not authenticated/)
    expect(runs(fixture)).toEqual([])
  })

  it('leaves master and the remotes untouched when packaging fails', async () => {
    const fixture = await createFixture({ packageFails: true })
    await expect(fixture.run()).rejects.toThrow(/package:win:x64:production exited with 1/)
    // The local version commit and tag are retained so the same approval can safely retry.
    expect(fixture.state.localTag).toBe(COMMIT)
    expect(fixture.state.masterHead).toBe(MID)
    expect(fixture.state.originMaster).toBe(MID)
    expect(fixture.state.remoteTag).toBeUndefined()
    expect(runs(fixture).some(label => label.startsWith('git push'))).toBe(false)
    expect(runIndex(fixture, DRAFT_RUN)).toBe(-1)
  })

  it('reuses the signed package after draft creation fails without moving master', async () => {
    const fixture = await createFixture({ draftFails: true })
    await expect(fixture.run()).rejects.toThrow(/release:github:win:x64:draft exited with 1/)
    expect(fixture.state.masterHead).toBe(MID)
    expect(fixture.state.originMaster).toBe(MID)
    expect(fixture.state.remoteTag).toBe(COMMIT)
    const packageRuns = runs(fixture).filter(label => label === PACKAGE_RUN).length
    fixture.state.draftFails = false
    await expect(fixture.run()).resolves.toMatchObject({ masterPushed: true, tagPushed: false, draftCreated: true })
    expect(runs(fixture).filter(label => label === PACKAGE_RUN)).toHaveLength(packageRuns)
  })

  it('refuses a master that is not a fast-forward of origin/master', async () => {
    const fixture = await createFixture({ originMaster: AHEAD })
    await expect(fixture.run()).rejects.toThrow(/is not an ancestor of/)
    expect(runs(fixture).some(label => label.startsWith('git push'))).toBe(false)
    expect(runIndex(fixture, DRAFT_RUN)).toBe(-1)
  })

  it('does not move origin/master when the final local fast-forward fails', async () => {
    const fixture = await createFixture({ mergeFails: true })
    await expect(fixture.run()).rejects.toThrow(/merge --ff-only/)
    expect(fixture.state.masterHead).toBe(MID)
    expect(fixture.state.originMaster).toBe(MID)
    expect(fixture.state.remoteTag).toBe(COMMIT)
    expect(fixture.state.draftVerified).toBe(true)
  })

  it('refuses a release tag that names another commit', async () => {
    const fixture = await createFixture({ localTag: BASE })
    await expect(fixture.run()).rejects.toThrow(new RegExp(`${TAG} already names ${BASE}`))
    expect(runIndex(fixture, PACKAGE_RUN)).toBe(-1)
  })

  it('accepts a repeated run whose master, tag, and draft already qualified', async () => {
    const fixture = await createFixture({
      localTag: COMMIT,
      remoteTag: COMMIT,
      masterHead: COMMIT,
      originMaster: COMMIT,
      artifactsReady: true,
      draftVerified: true,
    })
    const result = await fixture.run()
    expect(result).toMatchObject({ masterPushed: false, tagPushed: false, draftCreated: false })
    expect(runs(fixture)).toEqual(['git fetch origin master', PACKAGE_CHECK_RUN, QUALIFY_RUN, 'git fetch origin master'])
  })

  it('commits the family version only when the manifests declare another one', async () => {
    const stale = await createFixture({ declaredVersion: '1.2.2' })
    await stale.run()
    expect(runIndex(stale, VERSION_RUN)).toBeGreaterThan(-1)
    expect(stale.state.declaredVersion).toBe(VERSION)
    expect(runIndex(stale, VERSION_RUN)).toBeLessThan(runIndex(stale, `git tag ${TAG} ${COMMIT}`))
    expect(runIndex(stale, VERSION_RUN)).toBeLessThan(runIndex(stale, PACKAGE_RUN))

    const current = await createFixture()
    await current.run()
    expect(runIndex(current, VERSION_RUN)).toBe(-1)
    expect(runIndex(current, `git tag ${TAG} ${COMMIT}`)).toBeGreaterThan(-1)
  })
})
