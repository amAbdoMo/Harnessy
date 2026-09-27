/**
 * Approve one stable Harnessy Windows x64 release from a staging worktree.
 *
 * The packaged build, the release tag, `master`, and the GitHub draft must all
 * name one commit, and a tag or draft created before the packaging evidence
 * exists cannot be withdrawn safely. This command therefore fixes the order:
 * validate both worktrees, commit the stable version when the manifests still
 * declare another one, run the focused updater gate, tag the exact commit, create
 * or reuse its verified signed artifact, push the tag, create and verify the
 * draft, then fast-forward and lease-protect `master`.
 *
 * Before the signed package passes the local release-input check, only the
 * version commit and local tag can change. The remote tag and verified draft
 * may remain after a later master race, but master never moves before draft
 * verification. Publishing the draft is a separate command this script never calls.
 *
 * A repeated run accepts a `master`, a tag, or a draft that already names the
 * qualified commit, so an interrupted run continues with the same command.
 */

import { spawn, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { prerelease, valid } from 'semver'
import { CUSTOM_HARNESS_PRODUCT } from '../../../scripts/custom-harness-product.mjs'
import { isEntry, pnpmCommand } from '../../../scripts/release/process.ts'
import { resolveDesktopAutoUpdateEnvironment } from './desktop-auto-update-environment.mjs'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'

/** Windows target this approval signs, tags, and drafts. */
const RELEASE_TARGET = 'win-x64'

/** Directory holding the Desktop package and release scripts. */
const DESKTOP_DIRECTORY = 'apps/desktop'

/** Workspace manifest carrying the release family version. */
const ROOT_MANIFEST = 'package.json'

/** Desktop manifest whose version must equal the release family version. */
const DESKTOP_MANIFEST = `${DESKTOP_DIRECTORY}/package.json`

/** Existing command that rewrites the family version and commits it. */
const VERSION_SCRIPT = 'release:dsh'

/** Hardware-free production configuration and Windows toolchain preflight. */
const PACKAGE_CHECK_SCRIPT = 'check:package:win:x64:production'

/** Focused updater regression gate run before the hardware signing attempt. */
const QUALIFY_SCRIPT = 'release:win:x64:qualify'

/** Existing command that builds and signs the production Windows x64 artifact. */
const PACKAGE_SCRIPT = 'package:win:x64:production'

/** Existing command that validates the packaged release inputs without network writes. */
const CHECK_SCRIPT = 'release:github:win:x64:check'

/** Existing command that creates the GitHub draft release. */
const DRAFT_SCRIPT = 'release:github:win:x64:draft'

/** Existing command that requires the draft to hold the exact signed artifact set. */
const VERIFY_SCRIPT = 'release:github:win:x64:verify'

/** One external command an approval step runs. */
export interface PromoteCommand {
  /** Short name used in progress output and failure messages. */
  readonly label: string
  /** Program to start. */
  readonly executable: string
  /** Program arguments, in order. */
  readonly args: readonly string[]
  /** Directory the program runs in. */
  readonly cwd: string
}

/** What a command produced when its output is captured instead of inherited. */
export interface PromoteCommandResult {
  /** Exit status, or a non-zero substitute when a signal ended the program. */
  readonly status: number
  /** Trimmed standard output. */
  readonly stdout: string
}

/** Runs the approval's commands; tests substitute a recorder. */
export interface PromoteCommandAdapter {
  /**
   * Run one command with the operator's streams attached.
   * @param command - Command to run.
   * @returns Resolves after a zero exit; rejects on any other exit.
   */
  run(command: PromoteCommand): Promise<void>
  /**
   * Run one command with its output captured and its exit status left unjudged.
   * @param command - Command to run.
   * @returns The exit status and trimmed standard output.
   */
  inspect(command: PromoteCommand): PromoteCommandResult
}

/**
 * Ask the operator for the approval phrase.
 * @param phrase - Exact text the operator must type.
 * @returns True only when the typed text equals the phrase.
 */
export type PromoteConfirmation = (phrase: string) => Promise<boolean>

/** Inputs one approval run needs. */
export interface PromoteWindowsReleaseOptions {
  /** Stable version the release publishes. */
  readonly version: string
  /** Staging worktree holding the commit to package. */
  readonly stagingRoot: string
  /** Runs every command of the approval. */
  readonly adapter: PromoteCommandAdapter
  /** Reads the typed confirmation from the operator. */
  readonly confirm: PromoteConfirmation
  /** Master worktree named by `--master`, when the operator named one. */
  readonly masterPath?: string
  /** Host platform, checked against the signed Windows target. */
  readonly platform?: NodeJS.Platform
  /** Host architecture, checked against the signed Windows target. */
  readonly arch?: string
  /** Reads the file-owned update deployment; tests substitute production. */
  readonly releaseEnvironment?: (stagingRoot: string) => 'test' | 'production'
  /** Progress output; defaults to standard output. */
  readonly log?: (message: string) => void
}

/** What one approval run did. */
export interface PromoteWindowsReleaseResult {
  /** Version the release publishes. */
  readonly version: string
  /** Tag naming the packaged commit. */
  readonly tag: string
  /** Commit this run packaged, tagged, and pushed. */
  readonly commit: string
  /** Master worktree that was fast-forwarded. */
  readonly masterPath: string
  /** Whether this run moved `master` on origin. */
  readonly masterPushed: boolean
  /** Whether this run pushed the release tag. */
  readonly tagPushed: boolean
  /** Whether this run created the GitHub draft. */
  readonly draftCreated: boolean
}

/** One worktree registered for the repository. */
export interface PromoteWorktree {
  /** Path git reported for the worktree. */
  readonly path: string
  /** Short branch name, or undefined for a detached or bare worktree. */
  readonly branch: string | undefined
}

/** Command-line request one approval run accepts. */
export interface PromoteInvocation {
  /** Stable version the release publishes. */
  readonly version: string
  /** Tag naming the packaged commit. */
  readonly tag: string
  /** Master worktree named by `--master`, when present. */
  readonly masterPath?: string
}

/** State one approval run threads through its steps. */
interface PromoteSession {
  readonly stagingRoot: string
  readonly adapter: PromoteCommandAdapter
  readonly log: (message: string) => void
}

/**
 * Read one stable semantic version.
 * @param value - Version text to validate.
 * @returns The version, unchanged, when it is exact and has no prerelease segment.
 */
export function requireStableVersion(value: string): string {
  if (valid(value) !== value || prerelease(value) !== null) {
    throw new Error(`promote: --version must be a stable semantic version such as 0.1.7, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Name the tag that identifies one packaged commit.
 * @param version - Stable version the release publishes.
 * @returns The release tag.
 */
export function releaseTag(version: string): string {
  return `v${version}`
}

/**
 * Name the text the operator must type to approve one release.
 * @param tag - Release tag being approved.
 * @returns The exact confirmation text.
 */
export function approvalPhrase(tag: string): string {
  return `APPROVE ${tag} ${RELEASE_TARGET}`
}

/**
 * Refuse a host that cannot build the signed Windows x64 artifact.
 * @param platform - Host Node.js platform.
 * @param arch - Host Node.js architecture.
 */
export function requireWindowsX64Host(platform: NodeJS.Platform = process.platform, arch: string = process.arch): void {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`promote: the signed Windows x64 release requires a Windows x64 host, got ${platform}-${arch}`)
  }
}

/**
 * Read the approval command line.
 * @param argv - Arguments after the script entry point.
 * @returns The requested stable version, its tag, and any named master worktree.
 */
export function parsePromoteInvocation(argv: readonly string[]): PromoteInvocation {
  const { values } = parseArgs({
    // `pnpm run <script> -- --version x` forwards the separator itself, so it can land inside argv.
    args: argv.filter(argument => argument !== '--'),
    options: { version: { type: 'string' }, master: { type: 'string' } },
    allowPositionals: false,
    strict: true,
  })
  if (values.version === undefined) throw new Error('promote: --version <stable-semver> is required')
  const version = requireStableVersion(values.version)
  const master = values.master?.trim()
  return {
    version,
    tag: releaseTag(version),
    ...master === undefined || master === '' ? {} : { masterPath: resolve(master) },
  }
}

/**
 * Parse `git worktree list --porcelain`.
 * @param porcelain - Command output.
 * @returns One entry per registered worktree, in command order.
 */
export function parseWorktreeList(porcelain: string): PromoteWorktree[] {
  const worktrees: PromoteWorktree[] = []
  let path: string | undefined
  let branch: string | undefined
  const flush = (): void => {
    if (path === undefined) return
    worktrees.push({ path, branch })
    path = undefined
    branch = undefined
  }
  for (const line of porcelain.split(/\r?\n/u)) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      flush()
      path = line.slice('worktree '.length)
      continue
    }
    if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '')
  }
  flush()
  return worktrees
}

/**
 * Compare two checkout paths the way the host filesystem does.
 * @param left - One path.
 * @param right - The other path.
 * @returns True when both name the same directory.
 */
export function sameCheckoutPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const absolute = resolve(value)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  return normalize(left) === normalize(right)
}

/**
 * Choose the master worktree the approval fast-forwards.
 * @param worktrees - Worktrees registered for the staging repository.
 * @param stagingRoot - Worktree the approval runs from.
 * @param explicitPath - `--master` value, when the operator named one.
 * @returns The registered master worktree.
 */
export function selectMasterWorktree(
  worktrees: readonly PromoteWorktree[],
  stagingRoot: string,
  explicitPath?: string,
): PromoteWorktree {
  if (explicitPath !== undefined) {
    const named = worktrees.find(worktree => sameCheckoutPath(worktree.path, explicitPath))
    if (named === undefined) {
      throw new Error(`promote: --master ${explicitPath} is not a worktree of the staging repository; register it with git worktree add`)
    }
    if (named.branch !== 'master') {
      throw new Error(`promote: --master ${explicitPath} is on ${named.branch ?? 'a detached HEAD'}, not master`)
    }
    if (sameCheckoutPath(named.path, stagingRoot)) {
      throw new Error('promote: the master worktree must be a separate worktree from the staging checkout')
    }
    return named
  }
  const candidates = worktrees.filter(worktree => worktree.branch === 'master' && !sameCheckoutPath(worktree.path, stagingRoot))
  const [only] = candidates
  if (only === undefined) {
    throw new Error('promote: no linked master worktree; create one with git worktree add <path> master, or pass --master <path>')
  }
  if (candidates.length > 1) {
    throw new Error(`promote: ${String(candidates.length)} master worktrees are registered; pass --master <path>`)
  }
  return only
}

/**
 * Reduce a git remote URL to its host and path for comparison.
 * @param url - URL reported by `git remote get-url origin`.
 * @returns Lower-case `host/owner/repo`, without a trailing `.git` or slash.
 */
export function normalizeRemoteUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/u, '').replace(/\.git$/u, '')
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed)) {
    // scp-like syntax carries the host after `@` and the path after `:`.
    const scp = /^[^@/\s]+@(?<host>[^:/\s]+):(?<path>.+)$/u.exec(trimmed)
    const host = scp?.groups?.host
    const path = scp?.groups?.path
    if (host !== undefined && path !== undefined) return `${host}/${path}`.toLowerCase()
    return trimmed.toLowerCase()
  }
  const parsed = new URL(trimmed)
  return `${parsed.host}${parsed.pathname}`.toLowerCase()
}

/**
 * Build one git command for a checkout.
 * @param root - Directory the command runs in.
 * @param args - Git arguments.
 * @returns The command to run.
 */
function gitCommand(root: string, args: readonly string[]): PromoteCommand {
  return { label: `git ${args.join(' ')}`, executable: 'git', args, cwd: root }
}

/**
 * Build one workspace script invocation.
 * @param root - Checkout holding the workspace.
 * @param directory - Workspace directory to run in, or undefined for the root package.
 * @param script - Package script name.
 * @param args - Arguments forwarded to the script.
 * @returns The command to run.
 */
function pnpmScript(root: string, directory: string | undefined, script: string, args: readonly string[] = []): PromoteCommand {
  const [executable, ...prefix] = pnpmCommand()
  const selected = directory === undefined ? [] : ['--dir', directory]
  return {
    label: `pnpm ${[...selected, 'run', script, ...args].join(' ')}`,
    executable,
    args: [...prefix, ...selected, 'run', script, ...args],
    cwd: root,
  }
}

/**
 * Run one git command and require a zero exit.
 * @param session - Approval state.
 * @param root - Directory the command runs in.
 * @param args - Git arguments.
 */
async function runGit(session: PromoteSession, root: string, args: readonly string[]): Promise<void> {
  await session.adapter.run(gitCommand(root, args))
}

/**
 * Read one git command's standard output and require a zero exit.
 * @param session - Approval state.
 * @param root - Directory the command runs in.
 * @param args - Git arguments.
 * @returns Trimmed standard output.
 */
function readGit(session: PromoteSession, root: string, args: readonly string[]): string {
  const command = gitCommand(root, args)
  const result = session.adapter.inspect(command)
  if (result.status !== 0) throw new Error(`promote: ${command.label} failed in ${root}`)
  return result.stdout
}

/**
 * Report whether one git command exits zero.
 * @param session - Approval state.
 * @param root - Directory the command runs in.
 * @param args - Git arguments.
 * @returns True on a zero exit.
 */
function gitSucceeds(session: PromoteSession, root: string, args: readonly string[]): boolean {
  return session.adapter.inspect(gitCommand(root, args)).status === 0
}

/**
 * Read one manifest version.
 * @param root - Checkout holding the manifest.
 * @param manifestPath - Workspace-relative manifest path.
 * @returns The declared version.
 */
async function manifestVersion(root: string, manifestPath: string): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(join(root, manifestPath), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest) || typeof manifest.version !== 'string') {
    throw new Error(`promote: ${manifestPath} must declare a string version`)
  }
  return manifest.version
}

/**
 * Require one worktree to have no uncommitted changes.
 * @param session - Approval state.
 * @param root - Worktree to inspect.
 * @param label - Name used in the failure message.
 */
function requireCleanWorktree(session: PromoteSession, root: string, label: string): void {
  const status = readGit(session, root, ['status', '--porcelain'])
  if (status !== '') {
    throw new Error(`promote: the ${label} worktree ${root} has uncommitted changes; commit or stash them before approving a release`)
  }
}

/**
 * Name the origin every participating worktree must use.
 * @returns The HTTPS origin of the Harnessy release repository.
 */
function officialOrigin(): string {
  const { owner, repo } = CUSTOM_HARNESS_PRODUCT.updateRepository
  return `https://github.com/${owner}/${repo}`
}

/**
 * Require one worktree's origin to be the Harnessy release repository.
 * @param session - Approval state.
 * @param root - Worktree to inspect.
 */
function requireOfficialOrigin(session: PromoteSession, root: string): void {
  const { owner, repo } = CUSTOM_HARNESS_PRODUCT.updateRepository
  const expected = officialOrigin()
  const result = session.adapter.inspect(gitCommand(root, ['remote', 'get-url', 'origin']))
  if (result.status !== 0) {
    throw new Error(`promote: ${root} has no origin remote; the Harnessy release repository is ${owner}/${repo}`)
  }
  if (normalizeRemoteUrl(result.stdout) !== normalizeRemoteUrl(expected)) {
    throw new Error(`promote: ${root} origin is ${result.stdout}; expected ${expected}`)
  }
}

/**
 * Require an authenticated GitHub CLI before any release step.
 * @param session - Approval state.
 */
function requireGitHubAuthentication(session: PromoteSession): void {
  const command: PromoteCommand = { label: 'gh auth status', executable: 'gh', args: ['auth', 'status'], cwd: session.stagingRoot }
  if (session.adapter.inspect(command).status !== 0) {
    throw new Error('promote: gh is not authenticated; run gh auth login before approving a release')
  }
}

/**
 * Commit the requested stable version when the manifests declare another one.
 * @param session - Approval state.
 * @param version - Version the release publishes.
 */
async function ensureFamilyVersion(session: PromoteSession, version: string): Promise<void> {
  const manifests = [ROOT_MANIFEST, DESKTOP_MANIFEST]
  const declared = await Promise.all(manifests.map(async path => ({ path, version: await manifestVersion(session.stagingRoot, path) })))
  if (declared.every(entry => entry.version === version)) {
    session.log(`promote: the release family already declares ${version}`)
    return
  }
  session.log(`promote: committing ${version} through ${VERSION_SCRIPT} (${declared
    .map(entry => `${entry.path} declares ${entry.version}`).join(', ')})`)
  await session.adapter.run(pnpmScript(session.stagingRoot, undefined, VERSION_SCRIPT, [version]))
  const updated = await Promise.all(manifests.map(async path => ({ path, version: await manifestVersion(session.stagingRoot, path) })))
  const stale = updated.filter(entry => entry.version !== version)
  if (stale.length > 0) {
    throw new Error(`promote: ${VERSION_SCRIPT} left ${stale.map(entry => `${entry.path} at ${entry.version}`).join(', ')}`)
  }
}

/**
 * Refuse a release tag that already names another commit before hardware signing.
 * @param session - Approval state.
 * @param tag - Release tag.
 * @param commit - Qualified commit the tag must name.
 * @returns True when the exact local tag already exists.
 */
function requireLocalTagCompatible(session: PromoteSession, tag: string, commit: string): boolean {
  const existing = readGit(session, session.stagingRoot, ['tag', '--list', tag])
  if (existing === '') return false
  const named = readGit(session, session.stagingRoot, ['rev-list', '-n', '1', tag])
  if (named !== commit) throw new Error(`promote: ${tag} already names ${named}, not the qualified commit ${commit}`)
  return true
}

/**
 * Create the release tag on the qualified commit, or accept the same tag.
 * @param session - Approval state.
 * @param tag - Release tag.
 * @param commit - Qualified commit the tag must name.
 */
async function ensureLocalTag(session: PromoteSession, tag: string, commit: string): Promise<void> {
  if (!requireLocalTagCompatible(session, tag, commit)) {
    await runGit(session, session.stagingRoot, ['tag', tag, commit])
    session.log(`promote: tagged ${tag} at ${commit}`)
    return
  }
  session.log(`promote: ${tag} already names the qualified commit`)
}

/**
 * Reuse a byte-verified signed package from an interrupted run, or create it once.
 * @param session - Approval state.
 */
async function ensureSignedArtifacts(session: PromoteSession): Promise<void> {
  const check = pnpmScript(session.stagingRoot, DESKTOP_DIRECTORY, CHECK_SCRIPT)
  if (session.adapter.inspect(check).status === 0) {
    session.log('promote: reusing the signed package already verified for this commit and tag')
    return
  }
  await session.adapter.run(pnpmScript(session.stagingRoot, DESKTOP_DIRECTORY, PACKAGE_SCRIPT))
  await session.adapter.run(check)
}

/**
 * Refuse promotion before a remote write unless local and origin master can both fast-forward.
 * @param session - Approval state.
 * @param masterRoot - Master worktree holding the fetched origin/master.
 * @param commit - Qualified commit.
 */
function requirePromotionAncestry(session: PromoteSession, masterRoot: string, commit: string): void {
  const masterHead = readGit(session, masterRoot, ['rev-parse', 'HEAD'])
  const originHead = readGit(session, masterRoot, ['rev-parse', 'origin/master'])
  for (const [name, head] of [['master', masterHead], ['origin/master', originHead]] as const) {
    if (head !== commit && !gitSucceeds(session, masterRoot, ['merge-base', '--is-ancestor', head, commit])) {
      throw new Error(`promote: ${name} ${head} is not an ancestor of ${commit}; refusing release promotion`)
    }
  }
}

/**
 * Move the local master worktree to the qualified commit without a merge commit.
 * @param session - Approval state.
 * @param masterRoot - Master worktree.
 * @param commit - Qualified commit.
 */
async function fastForwardMaster(session: PromoteSession, masterRoot: string, commit: string): Promise<void> {
  if (readGit(session, masterRoot, ['rev-parse', 'HEAD']) === commit) {
    session.log('promote: master already names the qualified commit')
    return
  }
  await runGit(session, masterRoot, ['merge', '--ff-only', commit])
  const updated = readGit(session, masterRoot, ['rev-parse', 'HEAD'])
  if (updated !== commit) throw new Error(`promote: master is at ${updated} after a fast-forward to ${commit}`)
  session.log(`promote: fast-forwarded master to ${commit}`)
}

/**
 * Read the commit a remote tag names, when the remote has that tag.
 * @param output - `git ls-remote --tags` output.
 * @param ref - Full tag reference to match.
 * @returns The commit the remote tag names, or undefined when the remote has no such tag.
 */
function remoteTagCommit(output: string, ref: string): string | undefined {
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [sha, name] = line.split('\t')
    if (name === ref) return sha
  }
  return undefined
}

/** Push the exact release tag unless origin already holds it. */
async function pushTag(session: PromoteSession, tag: string, commit: string): Promise<boolean> {
  const ref = `refs/tags/${tag}`
  const named = remoteTagCommit(readGit(session, session.stagingRoot, ['ls-remote', '--tags', 'origin', ref]), ref)
  if (named === commit) return false
  if (named !== undefined) throw new Error(`promote: origin ${ref} names ${named}, not ${commit}`)
  await runGit(session, session.stagingRoot, ['push', 'origin', `${ref}:${ref}`])
  return true
}

/** Lease-protect the final master push after the draft is verified. */
async function pushMaster(session: PromoteSession, masterRoot: string, commit: string): Promise<boolean> {
  const lease = readGit(session, masterRoot, ['rev-parse', 'origin/master'])
  if (lease === commit) return false
  if (!gitSucceeds(session, masterRoot, ['merge-base', '--is-ancestor', lease, commit])) {
    throw new Error(`promote: origin/master ${lease} is not an ancestor of ${commit}; refusing to rewrite master`)
  }
  await runGit(session, masterRoot, [
    'push', `--force-with-lease=refs/heads/master:${lease}`, 'origin', `${commit}:refs/heads/master`,
  ])
  return true
}

/**
 * Create the GitHub draft, or accept the verified draft a repeated run left.
 *
 * A draft that exists but does not hold the exact signed artifact set fails the
 * draft command instead of being replaced, because replacing a release is a
 * separate operator decision.
 * @param session - Approval state.
 * @returns True when this run created the draft.
 */
async function ensureDraft(session: PromoteSession): Promise<boolean> {
  const verify = pnpmScript(session.stagingRoot, DESKTOP_DIRECTORY, VERIFY_SCRIPT)
  if (session.adapter.inspect(verify).status === 0) {
    session.log('promote: the verified GitHub draft already exists')
    return false
  }
  session.log('promote: creating the GitHub draft and requiring the exact signed artifact set')
  await session.adapter.run(pnpmScript(session.stagingRoot, DESKTOP_DIRECTORY, DRAFT_SCRIPT))
  await session.adapter.run(verify)
  return true
}

/**
 * Read the Windows dotenv deployment without accepting ambient release settings.
 * @param stagingRoot - Checkout containing the Desktop package.
 * @returns The selected update deployment.
 */
function releaseEnvironment(stagingRoot: string): 'test' | 'production' {
  const settings = loadDesktopPackageEnvironment('win32', process.env, join(stagingRoot, DESKTOP_DIRECTORY))
  return resolveDesktopAutoUpdateEnvironment(settings)
}

/**
 * Approve one signed Windows x64 release from the staging worktree.
 *
 * The returned result reports what this run did, so a repeated run reports the
 * steps it skipped rather than repeating them.
 * @param options - Version, worktrees, command runner, and confirmation source.
 * @returns The commit that was packaged, tagged, pushed, and drafted.
 */
export async function promoteWindowsRelease(options: PromoteWindowsReleaseOptions): Promise<PromoteWindowsReleaseResult> {
  requireWindowsX64Host(options.platform ?? process.platform, options.arch ?? process.arch)
  const log = options.log ?? ((message: string): void => { process.stdout.write(`${message}\n`) })
  const session: PromoteSession = { stagingRoot: resolve(options.stagingRoot), adapter: options.adapter, log }
  const version = requireStableVersion(options.version)
  const tag = releaseTag(version)
  const deployment = (options.releaseEnvironment ?? releaseEnvironment)(session.stagingRoot)
  if (deployment !== 'production') {
    throw new Error('promote: apps/desktop/.env.windows must set DSH_DESKTOP_AUTO_UPDATE_ENV=production before approval')
  }

  const worktrees = parseWorktreeList(readGit(session, session.stagingRoot, ['worktree', 'list', '--porcelain']))
  const masterPath = resolve(selectMasterWorktree(worktrees, session.stagingRoot, options.masterPath).path)

  requireOfficialOrigin(session, session.stagingRoot)
  requireOfficialOrigin(session, masterPath)
  requireCleanWorktree(session, session.stagingRoot, 'staging')
  requireCleanWorktree(session, masterPath, 'master')
  requireGitHubAuthentication(session)
  await runGit(session, session.stagingRoot, ['fetch', 'origin', 'master'])

  const phrase = approvalPhrase(tag)
  log(`promote: staging worktree ${session.stagingRoot}`)
  log(`promote: master worktree  ${masterPath}`)
  log(`promote: origin          ${officialOrigin()}`)
  log(`promote: origin/master   ${readGit(session, masterPath, ['rev-parse', 'origin/master'])}`)
  log(`promote: ${tag} will be qualified, signed, and drafted; master moves only after the draft is verified`)
  if (!await options.confirm(phrase)) throw new Error(`promote: declined; type "${phrase}" to approve a release`)

  await ensureFamilyVersion(session, version)
  requireCleanWorktree(session, session.stagingRoot, 'staging')
  const commit = readGit(session, session.stagingRoot, ['rev-parse', 'HEAD'])
  requireLocalTagCompatible(session, tag, commit)
  requireCleanWorktree(session, masterPath, 'master')
  requirePromotionAncestry(session, masterPath, commit)
  await session.adapter.run(pnpmScript(session.stagingRoot, DESKTOP_DIRECTORY, PACKAGE_CHECK_SCRIPT))
  await session.adapter.run(pnpmScript(session.stagingRoot, undefined, QUALIFY_SCRIPT))
  await ensureLocalTag(session, tag, commit)
  await ensureSignedArtifacts(session)

  await runGit(session, session.stagingRoot, ['fetch', 'origin', 'master'])
  requireCleanWorktree(session, masterPath, 'master')
  requirePromotionAncestry(session, masterPath, commit)
  const tagPushed = await pushTag(session, tag, commit)
  const draftCreated = await ensureDraft(session)
  requireCleanWorktree(session, masterPath, 'master')
  await fastForwardMaster(session, masterPath, commit)
  const masterPushed = await pushMaster(session, masterPath, commit)

  log(`promote: ${tag} names ${commit}; master ${masterPushed ? 'pushed' : 'already current'}, tag ${
    tagPushed ? 'pushed' : 'already present'}, draft ${draftCreated ? 'created and verified' : 'already verified'}`)
  return { version, tag, commit, masterPath, masterPushed, tagPushed, draftCreated }
}

/**
 * Read the approval phrase from the operator's terminal.
 * @param phrase - Exact text the operator must type.
 * @returns True only when the typed text equals the phrase.
 */
async function askForApproval(phrase: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('promote: the approval requires an interactive terminal')
  const terminal = createInterface({ input: stdin, output: stdout })
  try {
    return await terminal.question(`promote: type "${phrase}" to approve, or anything else to stop: `) === phrase
  } finally {
    terminal.close()
  }
}

/**
 * Build the command runner that starts real programs.
 * @returns A runner that attaches the terminal to long commands and captures short ones.
 */
function createCommandAdapter(): PromoteCommandAdapter {
  return {
    run: command => new Promise<void>((resolveRun, rejectRun) => {
      const child = spawn(command.executable, [...command.args], { cwd: command.cwd, stdio: 'inherit', shell: false })
      child.once('error', rejectRun)
      child.once('close', (status, signal) => {
        if (status === 0) resolveRun()
        else rejectRun(new Error(`promote: ${command.label} exited with ${String(status ?? signal)}`))
      })
    }),
    inspect: (command) => {
      const result = spawnSync(command.executable, [...command.args], { cwd: command.cwd, encoding: 'utf8', shell: false })
      if (result.error !== undefined) throw result.error
      return { status: result.status ?? 1, stdout: result.stdout.trim() }
    },
  }
}

/**
 * Run the approval command from the staging worktree that holds this script.
 */
async function main(): Promise<void> {
  const invocation = parsePromoteInvocation(process.argv.slice(2))
  const result = await promoteWindowsRelease({
    version: invocation.version,
    stagingRoot: resolve(import.meta.dirname, '..', '..', '..'),
    adapter: createCommandAdapter(),
    confirm: askForApproval,
    ...invocation.masterPath === undefined ? {} : { masterPath: invocation.masterPath },
  })
  process.stdout.write(`HARNESSY_RELEASE_APPROVED ${result.tag} ${result.commit}\n`)
  process.stdout.write('promote: publishing the verified draft stays separate: pnpm run release:win:x64:publish\n')
}

if (isEntry(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.stderr.write('promote: stopped. Re-run the same command to continue; a master, tag, or draft already at the qualified commit is accepted as it is.\n')
    process.exitCode = 1
  })
}
