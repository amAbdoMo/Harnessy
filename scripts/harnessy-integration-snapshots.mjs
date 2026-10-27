/** Preserve snapshot inputs and collect bounded POSIX integration evidence. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, lstat, mkdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { JSON_SCHEMA, load } from 'js-yaml'
import { assertNativeBuiltSmokeReport } from './harnessy-python-native-snapshots.mjs'

const HEADLESS = ['ptc-turn', 'ptc-python-turn', 'ptc-python-read-only', 'working-directory', 'working-directory-consumers', 'working-directory-admission']
const DIRECTORY_FIXTURES = ['compaction-output-reserve', 'compaction-summary-headroom', 'worktree', 'ptc-turn']
const SESSION = /(?:^|\/)session(?:\.\d+)?(?:\.v[1-9]\d*)?\.jsonl$/u
const OUTPUT = /^(?:writer(?:\.[1-9]\d*)?\.expected\.jsonl|system-prompt(?:\.[1-9]\d*)?\.expected\.md|tool-schemas(?:\.[1-9]\d*)?\.expected\.json)$/u
const SDK_OUTPUT = new Set(['notifications.current.expected.jsonl', 'result.expected.json', 'writer.expected.jsonl'])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const check = (condition, message) => { if (!condition) throw new Error(message) }
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const paths = (root, ...args) => git(root, ...args).split('\0').filter(Boolean).sort()

function selectedOwners(selection) {
  check(selection === 'primary' || selection === 'directory-fixtures', 'unknown integration snapshot selection')
  return selection === 'primary' ? HEADLESS : DIRECTORY_FIXTURES
}
/** Hash one tracked file or link without following linked ancestors.
 * @param {string} root - Repository root.
 * @param {string} relativePath - Repository-relative path.
 * @returns {Promise<string>} File digest or tagged link-target digest.
 */
export async function digestTracked(root, relativePath) {
  const segments = relativePath.split('/')
  let current = resolve(root)
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment)
    const info = await lstat(current)
    const leaf = index === segments.length - 1
    if (!leaf) {
      check(info.isDirectory() && !info.isSymbolicLink(), `${relativePath}: parent must be a real directory`)
    } else if (info.isSymbolicLink()) {
      check(!SESSION.test(relativePath), `${relativePath}: Session input must be a regular file`)
      return `symlink:${sha(await readlink(current))}`
    } else {
      check(info.isFile(), `${relativePath}: expected a regular file or tracked link`)
      return sha(await readFile(current))
    }
  }
  throw new Error(`${relativePath}: empty path`)
}

async function digestOutput(root, path) {
  const info = await lstat(resolve(root, path))
  check(info.isFile() && !info.isSymbolicLink(), `${path}: expected a regular output file`)
  return digestTracked(root, path)
}

/** @param {string} path - Repository-relative path. @returns {boolean} Whether this exact output belongs to the selected owners. */
export function isAllowedOutput(path, selection = 'primary') {
  const owners = selectedOwners(selection)
  const parts = path.split('/')
  if (parts.length !== 4 || parts[0] !== 'snapshots') return false
  if (parts[1] === 'session' && owners.includes(parts[2])) return OUTPUT.test(parts[3])
  if (selection === 'directory-fixtures') return false
  if (parts[1] === 'session' && parts[2] === 'text-turn') return /^(?:system-prompt|tool-schemas)(?:\.[1-9]\d*)?\.expected\.(?:md|json)$/u.test(parts[3])
  return parts[1] === 'sdk' && parts[2] === 'ptc-turn' && SDK_OUTPUT.has(parts[3])
}

/** Save every tracked snapshot file digest, including all canonical Session generations. */
export async function freezeSnapshotInputs(root, evidence, selection = 'primary') {
  const owners = selectedOwners(selection)
  const allowed = path => isAllowedOutput(path, selection)
  for (const owner of owners) {
    const manifest = load(await readFile(resolve(root, 'snapshots/session', owner, 'snapshot.yml'), 'utf8'), { schema: JSON_SCHEMA })
    check(manifest?.immutableInput === 'source-recording', `${owner}: refresh must preserve its Session input`)
  }
  if (selection === 'primary') {
    const sdk = load(await readFile(resolve(root, 'snapshots/sdk/ptc-turn/snapshot.yml'), 'utf8'), { schema: JSON_SCHEMA })
    check(sdk?.immutableInput === 'source-recording', 'sdk/ptc-turn: refresh must preserve its Session input')
  }
  check(paths(root, 'diff', '--name-only', '-z', 'HEAD', '--', '.').length === 0, 'source checkout must be clean before validation')
  const all = paths(root, 'ls-files', '-z', '--', 'snapshots/')
  check(all.some(path => SESSION.test(path)), 'no tracked Session inputs')
  const baseline = {}
  for (const path of all) baseline[path] = await (allowed(path) ? digestOutput(root, path) : digestTracked(root, path))
  const untracked = paths(root, 'ls-files', '--others', '--exclude-standard', '-z', '--', '.')
  check(untracked.length === 0, `untracked snapshot files before validation: ${untracked.join(', ')}`)
  await mkdir(evidence, { recursive: true })
  const state = { sourceHead: git(root, 'rev-parse', 'HEAD').trim(), selection, baseline }
  await writeFile(resolve(evidence, 'baseline.json'), JSON.stringify(state, null, 2) + '\n', { flag: 'wx' })
  return state
}

/** Reject skipped or missing selected owners in a Vitest JSON report. */
export function checkOwnerReport(report, owners, verb) {
  check(report.success === true && report.numFailedTests === 0 && report.numFailedTestSuites === 0 && report.numPassedTests === owners.length,
    `${verb}: expected exactly ${owners.length} passed tests`)
  const assertions = report.testResults.flatMap(result => result.assertionResults ?? [])
  for (const owner of owners) {
    const matches = assertions.filter(item => (item.fullName ?? item.title ?? '').includes(`${verb}s ${owner} through dsh`))
    check(matches.length === 1 && matches[0].status === 'passed', `${verb}: expected one passed ${owner}`)
  }
}

/** Capture selected outputs and fail on changed inputs, unknown files, or incomplete reports. */
export async function captureIntegrationEvidence(root, evidence, outcomes, selection = 'primary') {
  const owners = selectedOwners(selection)
  const allowed = path => isAllowedOutput(path, selection)
  const errors = []
  let state
  try { state = JSON.parse(await readFile(resolve(evidence, 'baseline.json'), 'utf8')) }
  catch (error) { throw new Error(`missing input baseline: ${String(error)}`) }
  check(state.selection === selection, 'integration snapshot selection changed after freeze')
  const currentTracked = paths(root, 'ls-files', '-z', '--', 'snapshots/')
  const untracked = paths(root, 'ls-files', '--others', '--exclude-standard', '-z', '--', '.')
    .filter(path => !path.startsWith('.artifacts/'))
  const currentSet = new Set(currentTracked)
  const inputHashes = {}
  const outputs = {}
  for (const [path, before] of Object.entries(state.baseline)) {
    try {
      const after = await digestTracked(root, path)
      if (SESSION.test(path)) inputHashes[path] = { before, after }
      if (!currentSet.has(path) || (before !== after && !allowed(path))) errors.push(`${path}: protected snapshot changed`)
    } catch (error) { errors.push(`${path}: unavailable: ${String(error)}`) }
  }
  for (const path of currentTracked) if (!(path in state.baseline)) errors.push(`${path}: tracked snapshot added after baseline`)
  for (const path of untracked) if (!allowed(path) || SESSION.test(path)) errors.push(`${path}: unexpected untracked snapshot`)
  const changedOutside = paths(root, 'diff', '--name-only', '-z', 'HEAD', '--', '.')
  for (const path of changedOutside) if (!allowed(path)) errors.push(`${path}: unexpected source change`)
  for (const path of [...new Set([...currentTracked, ...untracked])].filter(allowed)) {
    try {
      const file = resolve(root, path); const hash = await digestOutput(root, path)
      const target = resolve(evidence, 'outputs', path)
      await mkdir(dirname(target), { recursive: true }); await copyFile(file, target)
      outputs[path] = { sha256: hash, before: state.baseline[path] }
    } catch (error) { errors.push(`${path}: output capture failed: ${String(error)}`) }
  }
  const ownerReports = {}
  const reports = [['headless-refresh.json', owners, 'refresh'], ['headless-replay.json', owners, 'replay']]
  if (selection === 'primary') reports.push(['sdk-refresh.json', ['ptc-turn'], 'refresh'], ['sdk-replay.json', ['ptc-turn'], 'replay'])
  for (const [file, owners, verb] of reports) {
    try {
      checkOwnerReport(JSON.parse(await readFile(resolve(evidence, file), 'utf8')), owners, verb)
      ownerReports[file] = Object.fromEntries(owners.map(owner => [owner, 'passed']))
    } catch (error) { errors.push(`${file}: ${String(error)}`) }
  }
  if (selection === 'primary') {
    try { assertNativeBuiltSmokeReport(await readFile(resolve(evidence, 'built-package-smoke.json'))) }
    catch (error) { errors.push(`built package: ${String(error)}`) }
  }
  const requiredOutcomes = ['freeze', 'headlessRefresh', 'headlessReplay']
  if (selection === 'primary') requiredOutcomes.push('sdkRefresh', 'sdkReplay', 'pythonMetadata', 'builtPackageSmoke')
  for (const key of requiredOutcomes) {
    if (outcomes[key] !== 'success') errors.push(`${key}: ${outcomes[key] ?? 'missing'}`)
  }
  if (git(root, 'rev-parse', 'HEAD').trim() !== state.sourceHead) errors.push('source HEAD changed')
  const report = { sourceHead: state.sourceHead, selection, qualified: errors.length === 0, outcomes, inputHashes, ownerReports, outputs, errors }
  await writeFile(resolve(evidence, 'phase.json'), JSON.stringify(report, null, 2) + '\n')
  if (errors.length) throw new Error(errors.join('\n'))
  return report
}

if (import.meta.main) {
  const env = process.env
  check(env.GITHUB_ACTIONS === 'true' && env.DSH_INTEGRATION_SNAPSHOT_PHASE === '1' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_REF === 'refs/heads/staging' && env.GITHUB_REPOSITORY !== 'deepseek-ai/deepseek-harness'
    && ['Linux', 'macOS'].includes(env.RUNNER_OS), 'manual fork staging integration phase required')
  const root = resolve(import.meta.dirname, '..')
  const selection = env.HARNESSY_SNAPSHOT_SET ?? 'primary'
  selectedOwners(selection)
  check(selection !== 'directory-fixtures' || env.RUNNER_OS === 'Linux', 'directory fixture phase requires Linux')
  const evidence = resolve(root, '.artifacts/integration-snapshot-phase-ci', env.RUNNER_OS === 'Linux' ? 'linux' : 'macos', 'evidence')
  if (process.argv[2] === 'freeze') await freezeSnapshotInputs(root, evidence, selection)
  else if (process.argv[2] === 'capture') await captureIntegrationEvidence(root, evidence, {
    freeze: env.FREEZE_OUTCOME, headlessRefresh: env.HEADLESS_REFRESH_OUTCOME, headlessReplay: env.HEADLESS_REPLAY_OUTCOME,
    sdkRefresh: env.SDK_REFRESH_OUTCOME, sdkReplay: env.SDK_REPLAY_OUTCOME, pythonMetadata: env.PYTHON_METADATA_OUTCOME, builtPackageSmoke: env.BUILT_SMOKE_OUTCOME,
  }, selection)
  else throw new Error('usage: integration snapshots freeze|capture')
}
