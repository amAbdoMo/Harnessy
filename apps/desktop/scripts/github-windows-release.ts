/** Draft, verify, and explicitly publish one stable Harnessy Windows update release. */
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { load } from 'js-yaml'
import { gt, prerelease, valid } from 'semver'
import { CUSTOM_HARNESS_PRODUCT } from '../../../scripts/custom-harness-product.mjs'
import { desktopBuildRecordFilename } from './desktop-auto-update-environment.mjs'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'

interface ReleaseAsset { readonly name?: unknown; readonly size?: unknown; readonly digest?: unknown }
interface ReleaseView {
  readonly tagName?: unknown
  readonly isDraft?: unknown
  readonly isPrerelease?: unknown
  readonly assets?: unknown
}

const repository = `${CUSTOM_HARNESS_PRODUCT.updateRepository.owner}/${CUSTOM_HARNESS_PRODUCT.updateRepository.repo}`

function runCommand(executable: string, args: readonly string[], capture = false): string {
  const result = spawnSync(executable, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', shell: false })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`Harnessy release: ${executable} exited with ${String(result.status)}`)
  return result.stdout?.trim() ?? ''
}

function runGh(args: readonly string[], capture = false): string {
  return runCommand('gh', args, capture)
}

async function hashFile(path: string, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): Promise<string> {
  const hash = createHash(algorithm)
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(path)
    input.on('error', reject)
    input.on('data', (chunk) => { hash.update(chunk) })
    input.on('end', resolve)
  })
  return hash.digest(encoding)
}

async function releaseInputs(): Promise<{ version: string; tag: string; commit: string; assets: readonly string[] }> {
  const manifest: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest) || typeof manifest.version !== 'string'
    || valid(manifest.version) === null || prerelease(manifest.version) !== null) {
    throw new Error('Harnessy release: Desktop package must have a stable semantic version')
  }
  const version = manifest.version
  const rootManifest: unknown = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
  if (typeof rootManifest !== 'object' || rootManifest === null || !('version' in rootManifest)
    || rootManifest.version !== version) {
    throw new Error('Harnessy release: Desktop and root package versions must match')
  }
  const root = desktopTargetBuildPaths('win-x64').artifacts
  const record: unknown = JSON.parse(await readFile(join(root, desktopBuildRecordFilename('win-x64')), 'utf8'))
  if (typeof record !== 'object' || record === null || !('schemaVersion' in record) || record.schemaVersion !== 1
    || !('target' in record) || record.target !== 'win-x64' || !('version' in record) || record.version !== version
    || !('environment' in record) || record.environment !== 'production'
    || !('commit' in record) || typeof record.commit !== 'string' || !/^[a-f\d]{40}$/u.test(record.commit)
    || !('dirty' in record) || record.dirty !== false
    || !('signatureMode' in record) || record.signatureMode !== 'unsigned'
    || !('artifacts' in record) || !Array.isArray(record.artifacts) || record.artifacts.length !== 3) {
    throw new Error('Harnessy release: production package completion record is missing, dirty, or does not match')
  }
  const recordedArtifacts = record.artifacts
  const tag = `v${version}`
  if (runCommand('git', ['rev-parse', `${tag}^{commit}`], true) !== record.commit) {
    throw new Error(`Harnessy release: ${tag} does not identify the packaged commit`)
  }
  const base = `${CUSTOM_HARNESS_PRODUCT.installerName}-${version}-win-x64`
  const names = [`${base}.exe`, `${base}.exe.blockmap`, 'latest.yml']
  const assets = names.map(name => join(root, name))
  const assetStats = await Promise.all(assets.map(async (path) => {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0) throw new Error(`Harnessy release: missing artifact ${path}`)
    return info
  }))
  const localArtifacts = await Promise.all(assets.map(async (path, index) => ({
    name: names[index], size: assetStats[index]!.size, sha256: await hashFile(path, 'sha256', 'hex'),
  })))
  if (recordedArtifacts.some((entry: unknown) => typeof entry !== 'object' || entry === null
    || !('name' in entry) || typeof entry.name !== 'string'
    || !('size' in entry) || typeof entry.size !== 'number'
    || !('sha256' in entry) || typeof entry.sha256 !== 'string'
    || !localArtifacts.some(local => local.name === entry.name && local.size === entry.size && local.sha256 === entry.sha256))
    || localArtifacts.some(local => !recordedArtifacts.some((entry: unknown) => typeof entry === 'object' && entry !== null
      && 'name' in entry && local.name === entry.name && 'size' in entry && local.size === entry.size
      && 'sha256' in entry && local.sha256 === entry.sha256))) {
    throw new Error('Harnessy release: packaged artifact bytes do not match the completion record')
  }
  const metadata: unknown = load(await readFile(assets[2]!, 'utf8'))
  if (typeof metadata !== 'object' || metadata === null || !('version' in metadata) || metadata.version !== version
    || !('files' in metadata) || !Array.isArray(metadata.files) || metadata.files.length !== 1) {
    throw new Error('Harnessy release: latest.yml does not describe exactly one matching version')
  }
  const file = metadata.files[0]
  if (typeof file !== 'object' || file === null || !('url' in file) || file.url !== names[0]
    || !('sha512' in file) || typeof file.sha512 !== 'string' || file.sha512.length === 0
    || !('size' in file) || typeof file.size !== 'number' || file.size <= 0) {
    throw new Error('Harnessy release: latest.yml artifact identity is incomplete')
  }
  if (file.size !== assetStats[0]!.size || file.sha512 !== await hashFile(assets[0]!, 'sha512', 'base64')) {
    throw new Error('Harnessy release: latest.yml does not match the release installer bytes')
  }
  return { version, tag, commit: record.commit, assets }
}

function parseView(text: string): ReleaseView {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null) throw new Error('Harnessy release: invalid GitHub release response')
  return value
}

async function verifyRelease(tag: string, assetPaths: readonly string[], status: 'draft' | 'published' = 'draft'): Promise<void> {
  const view = parseView(runGh(['release', 'view', tag, '--repo', repository, '--json', 'tagName,isDraft,isPrerelease,assets'], true))
  const expected = await Promise.all(assetPaths.map(async path => ({
    name: path.split(/[\\/]/u).at(-1),
    size: (await stat(path)).size,
    digest: `sha256:${await hashFile(path, 'sha256', 'hex')}`,
  })))
  const assets = Array.isArray(view.assets) ? view.assets as ReleaseAsset[] : []
  if (view.tagName !== tag || view.isDraft !== (status === 'draft') || view.isPrerelease !== false
    || expected.length !== assets.length || expected.some(local => local.name === undefined
      || !assets.some(remote => remote.name === local.name && remote.size === local.size && remote.digest === local.digest))) {
    throw new Error('Harnessy release: GitHub release is not the complete byte-identical stable artifact set')
  }
}

function prepareHostedTag(): void {
  const version = process.env.RELEASE_VERSION
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== 'refs/heads/staging'
    || version === undefined || valid(version) !== version || prerelease(version) !== null
    || !/^[a-f\d]{40}$/u.test(process.env.GITHUB_SHA ?? '')) {
    throw new Error('Harnessy release: hosted publication requires an approved stable staging dispatch')
  }
  if (runCommand('git', ['rev-parse', 'HEAD'], true) !== process.env.GITHUB_SHA) {
    throw new Error('Harnessy release: the checkout differs from the dispatched commit')
  }
  if (runCommand('git', ['tag', '--list', `v${version}`], true) === '') {
    runCommand('git', ['tag', `v${version}`, process.env.GITHUB_SHA])
  }
}

async function verifyPublicFeed(tag: string, feedPath: string): Promise<void> {
  const expected = await readFile(feedPath, 'utf8')
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const latest = parseView(runGh(['release', 'view', '--repo', repository, '--json', 'tagName,isDraft,isPrerelease'], true))
      const response = await fetch(`https://github.com/${repository}/releases/latest/download/latest.yml`, {
        signal: AbortSignal.timeout(30_000), cache: 'no-store',
      })
      const publicFeed = await response.text()
      if (latest.tagName === tag && latest.isDraft === false && latest.isPrerelease === false
        && response.ok && publicFeed === expected) return
    } catch (error) {
      // Retry transient API/redirect failures while GitHub propagates the latest release.
      if (attempt === 4) throw error
    }
    if (attempt < 4) await setTimeout(3000)
  }
  throw new Error('Harnessy release: the public latest release/feed does not match the qualified update')
}

async function verifyHostedConfiguration(): Promise<void> {
  const config: unknown = load(await readFile(join(desktopTargetBuildPaths('win-x64').artifacts, 'packaged-app-update.yml'), 'utf8'))
  if (typeof config !== 'object' || config === null
    || !('provider' in config) || config.provider !== 'github'
    || !('owner' in config) || config.owner !== CUSTOM_HARNESS_PRODUCT.updateRepository.owner
    || !('repo' in config) || config.repo !== CUSTOM_HARNESS_PRODUCT.updateRepository.repo
    || !('channel' in config) || config.channel !== 'latest'
    || !('releaseType' in config) || config.releaseType !== 'release'
    || !('updaterCacheDirName' in config) || config.updaterCacheDirName !== '@deepseek-aidsh-desktop-updater') {
    throw new Error('Harnessy release: packaged updater configuration differs from the installed channel')
  }
}

function fetchHostedMaster(commit: string): string {
  const origin = runCommand('git', ['remote', 'get-url', 'origin'], true).replace(/\.git$/u, '')
  if (origin !== `https://github.com/${repository}`) throw new Error('Harnessy release: unexpected origin repository')
  runCommand('git', ['fetch', 'origin', 'refs/heads/master:refs/remotes/origin/master', 'refs/heads/staging:refs/remotes/origin/staging'])
  const master = runCommand('git', ['rev-parse', 'refs/remotes/origin/master'], true)
  if (runCommand('git', ['rev-parse', 'refs/remotes/origin/staging'], true) !== commit) {
    throw new Error('Harnessy release: staging moved after this release was dispatched')
  }
  runCommand('git', ['merge-base', '--is-ancestor', master, commit])
  return master
}

function verifyNewReleaseVersion(version: string, tag: string): void {
  const latest = parseView(runGh(['release', 'view', '--repo', repository, '--json', 'tagName'], true))
  if (typeof latest.tagName !== 'string' || valid(latest.tagName) === null
    || (latest.tagName !== tag && !gt(version, latest.tagName))) {
    throw new Error('Harnessy release: the release version must be newer than the published update')
  }
}

function pushHostedTag(tag: string, commit: string): void {
  const remoteTag = runCommand('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], true)
  if (remoteTag !== '') {
    const lines = remoteTag.split('\n')
    const taggedCommit = (lines.find(line => line.trim().endsWith('^{}')) ?? lines[0])?.split(/\s+/u)[0]
    if (taggedCommit !== commit) throw new Error('Harnessy release: the remote tag identifies different source')
  } else {
    runCommand('git', ['push', 'origin', `refs/tags/${tag}:refs/tags/${tag}`])
  }
}

async function prepareHostedDraft(version: string, tag: string, assets: readonly string[]): Promise<'draft' | 'published'> {
  const releases: unknown = JSON.parse(runGh(['release', 'list', '--repo', repository, '--limit', '100', '--json', 'tagName'], true))
  if (!Array.isArray(releases)) throw new Error('Harnessy release: invalid GitHub release list')
  if (!releases.some((entry: unknown) => typeof entry === 'object' && entry !== null && 'tagName' in entry && entry.tagName === tag)) {
    runGh(['release', 'create', tag, ...assets, '--repo', repository, '--draft', '--verify-tag', '--title', `Harnessy v${version}`, '--generate-notes'])
  }
  const release = parseView(runGh(['release', 'view', tag, '--repo', repository, '--json', 'isDraft'], true))
  if (typeof release.isDraft !== 'boolean') throw new Error('Harnessy release: invalid draft status')
  const status = release.isDraft ? 'draft' : 'published'
  await verifyRelease(tag, assets, status)
  return status
}

function promoteHostedMaster(master: string, commit: string): void {
  if (master !== commit) {
    runCommand('git', ['push', `--force-with-lease=refs/heads/master:${master}`, 'origin', `${commit}:refs/heads/master`])
  }
  const remoteMaster = runCommand('git', ['ls-remote', 'origin', 'refs/heads/master'], true).split(/\s+/u)[0]
  if (remoteMaster !== commit) throw new Error('Harnessy release: master moved before publication')
}

async function publishHostedRelease(inputs: Awaited<ReturnType<typeof releaseInputs>>): Promise<void> {
  const { version, tag, commit, assets } = inputs
  if (version !== process.env.RELEASE_VERSION || commit !== process.env.GITHUB_SHA) {
    throw new Error('Harnessy release: package identity differs from the approved dispatch')
  }
  await verifyHostedConfiguration()
  const master = fetchHostedMaster(commit)
  verifyNewReleaseVersion(version, tag)
  pushHostedTag(tag, commit)
  const status = await prepareHostedDraft(version, tag, assets)
  promoteHostedMaster(master, commit)
  if (status === 'draft') runGh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest'])
  await verifyRelease(tag, assets, 'published')
  await verifyPublicFeed(tag, assets[2]!)
}

const command = process.argv[2]
if (command !== 'check' && command !== 'draft' && command !== 'verify' && command !== 'publish' && command !== 'hosted') {
  throw new Error('Usage: github-windows-release.ts <check|draft|verify|publish|hosted>')
}
if (command === 'hosted') prepareHostedTag()
const inputs = await releaseInputs()
const { version, tag, assets } = inputs
if (command === 'hosted') {
  await publishHostedRelease(inputs)
} else if (command !== 'check') {
  const repo = repository
  if (command === 'draft') {
    runGh(['release', 'create', tag, ...assets, '--repo', repo, '--draft', '--verify-tag', '--title', `Harnessy v${version}`, '--generate-notes'])
  }
  await verifyRelease(tag, assets)
  if (command === 'publish') {
    runGh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'])
  }
}
console.info(`HARNESSY_GITHUB_RELEASE ${command} ${tag}`)
