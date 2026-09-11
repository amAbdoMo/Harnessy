import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanDistributable, sha256File } from '../src/package-verification.js'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(desktopRoot, '../..')
const stageRoot = resolve(desktopRoot, '.package-stage')
const distRoot = resolve(desktopRoot, 'dist')
const inputs = JSON.parse(await readFile(resolve(desktopRoot, 'packaging-inputs.json'), 'utf8'))
const desktopPackage = JSON.parse(await readFile(resolve(desktopRoot, 'package.json'), 'utf8'))
const distributionNotices = [
  'resources/LICENSE.txt',
  'resources/THIRD_PARTY_NOTICES.md',
  'resources/third-party-licenses/deepseek-harness-desktop-LICENSE',
  'LICENSE.electron.txt',
  'LICENSES.chromium.html',
]

function command(commandName, arguments_, options = {}) {
  const output = execFileSync(commandName, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  })
  return typeof output === 'string' ? output.trim() : ''
}

function optionalGit(arguments_) {
  const execution = spawnSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return execution.status === 0 ? execution.stdout.trim() : null
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new Error(`Phase 9 packaging requires ${name}`)
  return resolve(value)
}

function assertCleanCheckout() {
  const status = command('git', ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status !== '') throw new Error('Phase 9 packages only a clean checkout; commit or otherwise resolve the recorded working tree first.')
}

function assertVersion(executable, arguments_, expected, environment = process.env) {
  const actual = command(executable, arguments_, { env: environment }).replace(/^v/u, '')
  if (actual !== expected) throw new Error(`${executable} reported ${actual}; expected ${expected}`)
}

function validateRuntimeInputs(nodeRuntime, electronDist) {
  const nodeExecutable = resolve(nodeRuntime, 'node.exe')
  const nodeLicense = resolve(nodeRuntime, 'LICENSE')
  if (!existsSync(nodeExecutable) || !existsSync(nodeLicense)) {
    throw new Error('CUSTOM_HARNESS_NODE_RUNTIME must contain node.exe and the matching LICENSE file')
  }
  assertVersion(nodeExecutable, ['--version'], inputs.nodeVersion)

  const electronExecutable = resolve(electronDist, 'electron.exe')
  for (const requiredPath of [electronExecutable, resolve(electronDist, 'LICENSE'), resolve(electronDist, 'LICENSES.chromium.html')]) {
    if (!existsSync(requiredPath)) throw new Error(`audited Electron distribution is missing ${requiredPath}`)
  }
  assertVersion(electronExecutable, ['--version'], inputs.electronVersion, {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  })
}

function prepareStage(nodeRuntime) {
  rmSync(stageRoot, { recursive: true, force: true })
  mkdirSync(resolve(stageRoot, 'runtime'), { recursive: true })
  command('pnpm', [
    '--filter', '@deepseek-ai/dsh', 'deploy', '--prod', '--legacy', resolve(stageRoot, 'dsh'),
  ], { stdio: 'inherit' })
  copyFileSync(resolve(nodeRuntime, 'node.exe'), resolve(stageRoot, 'runtime', 'node.exe'))
  copyFileSync(resolve(nodeRuntime, 'LICENSE'), resolve(stageRoot, 'runtime', 'LICENSE'))
}

function buildEnvironment(electronDist, publisherName) {
  return {
    ...process.env,
    CUSTOM_HARNESS_ELECTRON_DIST: electronDist,
    CUSTOM_HARNESS_PUBLISHER_NAME: publisherName,
  }
}

function authenticode(artifactPath) {
  const script = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${artifactPath.replaceAll("'", "''")}'`,
    '[pscustomobject]@{ status = [string]$signature.Status; subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress',
  ].join('; ')
  return JSON.parse(command('powershell.exe', ['-NoProfile', '-Command', script]))
}

function installerPath() {
  const expected = `Harnessy-Setup-${desktopPackage.version}-windows-x64.exe`
  const installer = resolve(distRoot, expected)
  if (!existsSync(installer)) throw new Error(`electron-builder did not produce ${expected}`)
  return installer
}

function assertDistributionNotices(unpacked) {
  for (const relativePath of distributionNotices) {
    if (!existsSync(resolve(unpacked, relativePath))) {
      throw new Error(`distributable is missing required notice ${relativePath}`)
    }
  }
}

function upstreamProvenance() {
  const upstreamReference = upstreamTrackingReference()
  const upstreamBase = upstreamReference === null
    ? null
    : optionalGit(['merge-base', 'HEAD', upstreamReference])
  const upstreamStatus = upstreamReference === null
    ? 'NO_LOCAL_TRACKING_REFERENCE'
    : upstreamBase === null ? 'NO_COMMON_ANCESTOR' : 'RECORDED'
  return {
    url: optionalGit(['remote', 'get-url', 'upstream']),
    reference: upstreamReference,
    baseCommit: upstreamBase,
    status: upstreamStatus,
  }
}

async function sourceProvenance() {
  return {
    commit: command('git', ['rev-parse', 'HEAD']),
    tree: command('git', ['rev-parse', 'HEAD^{tree}']),
    branch: command('git', ['branch', '--show-current']),
    exactTag: optionalGit(['describe', '--tags', '--exact-match', 'HEAD']),
    clean: true,
    originUrl: optionalGit(['remote', 'get-url', 'origin']),
    upstream: upstreamProvenance(),
    lockfileSha256: await sha256File(resolve(repositoryRoot, 'pnpm-lock.yaml')),
  }
}

function buildProvenance() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pnpm: command('pnpm', ['--version']),
    inputs,
    automaticUpdates: 'DEFERRED',
  }
}

async function artifactProvenance(installer) {
  const signature = authenticode(installer)
  const artifactStat = await stat(installer)
  return {
    filename: installer.slice(distRoot.length + 1),
    bytes: artifactStat.size,
    sha256: await sha256File(installer),
    signing: signature.status === 'Valid'
      ? { status: 'SIGNED', subject: signature.subject }
      : { status: 'UNSIGNED', authenticodeStatus: signature.status },
  }
}

async function writeReleaseManifest(installer, publisherName) {
  const unpacked = resolve(distRoot, 'win-unpacked')
  assertDistributionNotices(unpacked)
  const violations = await scanDistributable(unpacked, [repositoryRoot, process.env.USERPROFILE])
  if (violations.length > 0) throw new Error(`distributable scan failed:\n${violations.join('\n')}`)
  const manifest = {
    formatVersion: 2,
    product: 'Harnessy',
    version: desktopPackage.version,
    appId: 'com.amabdmo.customharness',
    publisher: publisherName,
    source: await sourceProvenance(),
    build: buildProvenance(),
    artifact: await artifactProvenance(installer),
    notices: distributionNotices,
    validation: {
      distributableScan: 'PASS',
      cleanInstall: 'NOT RUN',
      upgrade: 'NOT RUN',
      uninstall: 'NOT RUN',
    },
  }
  const manifestPath = `${installer}.manifest.json`
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifestPath
}

function upstreamTrackingReference() {
  const symbolicReference = optionalGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/upstream/HEAD'])
  if (symbolicReference !== null) return symbolicReference
  const references = optionalGit(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/upstream'])
  if (references === null || references === '') return null
  const referenceSet = new Set(references.split(/\r?\n/u))
  if (referenceSet.has('upstream/main')) return 'upstream/main'
  if (referenceSet.has('upstream/master')) return 'upstream/master'
  return null
}

if (process.platform !== inputs.platform || process.arch !== inputs.arch) {
  throw new Error(`Phase 9 packaging requires ${inputs.platform}-${inputs.arch}`)
}
assertCleanCheckout()
assertVersion('pnpm', ['--version'], inputs.pnpmVersion)
const nodeRuntime = requiredEnvironment('CUSTOM_HARNESS_NODE_RUNTIME')
const electronDist = requiredEnvironment('CUSTOM_HARNESS_ELECTRON_DIST')
const publisherName = process.env.CUSTOM_HARNESS_PUBLISHER_NAME?.trim()
if (publisherName === undefined || publisherName === '') {
  throw new Error('Phase 9 packaging requires the product owner to set CUSTOM_HARNESS_PUBLISHER_NAME')
}
validateRuntimeInputs(nodeRuntime, electronDist)
command('pnpm', ['run', 'build:custom-harness'], { stdio: 'inherit' })
command('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  resolve(desktopRoot, 'scripts', 'build-windows-job-launcher.ps1'),
], { stdio: 'inherit' })
prepareStage(nodeRuntime)
rmSync(distRoot, { recursive: true, force: true })
command('pnpm', [
  'dlx', `electron-builder@${inputs.electronBuilderVersion}`,
  '--config', resolve(desktopRoot, 'electron-builder.yml'),
  '--win', 'nsis', '--x64', '--publish', 'never',
], { cwd: desktopRoot, env: buildEnvironment(electronDist, publisherName), stdio: 'inherit' })
const installer = installerPath()
const manifest = await writeReleaseManifest(installer, publisherName)
console.log(`Phase 9 installer: ${installer}`)
console.log(`Phase 9 manifest: ${manifest}`)
