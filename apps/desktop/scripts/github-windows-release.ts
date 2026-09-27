/** Draft, verify, and explicitly publish one stable Harnessy Windows update release. */
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { prerelease, valid } from 'semver'
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

async function releaseInputs(): Promise<{ version: string; tag: string; assets: readonly string[] }> {
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
  return { version, tag, assets }
}

function parseView(text: string): ReleaseView {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null) throw new Error('Harnessy release: invalid GitHub release response')
  return value
}

async function verifyDraft(tag: string, assetPaths: readonly string[]): Promise<void> {
  const repo = `${CUSTOM_HARNESS_PRODUCT.updateRepository.owner}/${CUSTOM_HARNESS_PRODUCT.updateRepository.repo}`
  const view = parseView(runGh(['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft,isPrerelease,assets'], true))
  const expected = await Promise.all(assetPaths.map(async path => ({
    name: path.split(/[\\/]/u).at(-1),
    size: (await stat(path)).size,
    digest: `sha256:${await hashFile(path, 'sha256', 'hex')}`,
  })))
  const assets = Array.isArray(view.assets) ? view.assets as ReleaseAsset[] : []
  if (view.tagName !== tag || view.isDraft !== true || view.isPrerelease !== false
    || expected.length !== assets.length || expected.some(local => local.name === undefined
      || !assets.some(remote => remote.name === local.name && remote.size === local.size && remote.digest === local.digest))) {
    throw new Error('Harnessy release: GitHub draft is not the complete byte-identical stable artifact set')
  }
}

const command = process.argv[2]
if (command !== 'check' && command !== 'draft' && command !== 'verify' && command !== 'publish') {
  throw new Error('Usage: github-windows-release.ts <check|draft|verify|publish>')
}
const { version, tag, assets } = await releaseInputs()
if (command !== 'check') {
  const repo = `${CUSTOM_HARNESS_PRODUCT.updateRepository.owner}/${CUSTOM_HARNESS_PRODUCT.updateRepository.repo}`
  if (command === 'draft') {
    runGh(['release', 'create', tag, ...assets, '--repo', repo, '--draft', '--verify-tag', '--title', `Harnessy v${version}`, '--generate-notes'])
  }
  await verifyDraft(tag, assets)
  if (command === 'publish') {
    runGh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'])
  }
}
console.info(`HARNESSY_GITHUB_RELEASE ${command} ${tag}`)
