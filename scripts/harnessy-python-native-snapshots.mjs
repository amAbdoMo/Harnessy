/** Prepare, capture, and restore the two upstream Python snapshots in manual CI only. */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { JSON_SCHEMA, load } from 'js-yaml'

const upstreamLedger = JSON.parse(await readFile(new URL('./harnessy-upstream-review.json', import.meta.url), 'utf8'))
const fixtureEntry = upstreamLedger.entries.find(entry => entry.tree === '9203404c8509edbefd40f21f72c3cb86466278e0')
if (fixtureEntry === undefined) throw new Error('Python fixture checkpoint is absent from the upstream review ledger')
export const UPSTREAM_FIXTURE_COMMIT = fixtureEntry.sha

const SOURCE_BLOBS = new Map([
  ['snapshots/session/ptc-python-turn/session.v4.jsonl', 'b833f570f375410f176e369a7ff275598f7100604346e1adb8bdac970be7113d'],
  ['snapshots/session/ptc-python-turn/snapshot.yml', '8afa6c45e5269d52e5e7b24eaf441606e339fb7240427966d3e1d2f1b70774c7'],
  ['snapshots/session/ptc-python-read-only/session.v4.jsonl', '893af1862017c6a2674d183a887791486f3ce6d183d5193647df10bf8ba9ce0c'],
  ['snapshots/session/ptc-python-read-only/snapshot.yml', '8c74bba26bb4776980ef56c6fac3968051b6986a4d5224e16665af041500a29b'],
  ['snapshots/session/ptc-python-read-only/workspace.expected/.empty', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
])
const TURN_COMPOSITION_FILES = ['cordis.yml', 'cordis.snapshot.yml']
const TURN_MANIFEST_PATH = 'snapshots/session/ptc-python-turn/snapshot.yml'
const TURN_MANIFEST_SHA256 = '8afa6c45e5269d52e5e7b24eaf441606e339fb7240427966d3e1d2f1b70774c7'
const GENERATION_NAME = /^session(?:\.\d+)?(?:\.v[1-9]\d*)?\.jsonl$/u
const WRITER_NAME = /^writer(?:\.[1-9]\d*)?\.expected\.jsonl$/u
const PROMPT_NAME = /^system-prompt(?:\.[1-9]\d*)?\.expected\.md$/u
const SCHEMA_NAME = /^tool-schemas(?:\.[1-9]\d*)?\.expected\.json$/u
const ALLOWED_OUTCOMES = new Set(['success', 'failure', 'skipped', 'cancelled'])
const encoder = new TextEncoder()

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function pathInside(root, candidate) {
  const absoluteRoot = resolve(root)
  const absoluteCandidate = resolve(candidate)
  const part = relative(absoluteRoot, absoluteCandidate)
  assert(part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)),
    `path escapes its owned directory: ${candidate}`)
  return absoluteCandidate
}

function posixPath(path) {
  return path.split(sep).join('/')
}

async function regularFile(path, label = path) {
  const info = await lstat(path)
  assert(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file, not a link`)
  return readFile(path)
}

async function fileExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function directoryExists(path) {
  try {
    const info = await lstat(path)
    assert(info.isDirectory() && !info.isSymbolicLink(), `${path} must be a real directory`)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function assertRealDirectoryChain(root, relativePath) {
  let current = resolve(root)
  for (const segment of relativePath.split('/')) {
    current = resolve(current, segment)
    const info = await lstat(current)
    assert(info.isDirectory() && !info.isSymbolicLink(), `${relativePath}: owner directory ancestor must be a real directory`)
  }
}

async function inventoryFiles(root) {
  const files = []
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolute = pathInside(root, resolve(directory, entry.name))
      const info = await lstat(absolute)
      assert(!info.isSymbolicLink(), `${posixPath(relativePath)} is a link`)
      if (info.isDirectory()) await visit(absolute, relativePath)
      else {
        assert(info.isFile(), `${posixPath(relativePath)} is not a regular file`)
        files.push(posixPath(relativePath))
      }
    }
  }
  await visit(root)
  return files.sort()
}

function parseManifest(bytes, label) {
  let manifest
  try {
    manifest = load(bytes.toString('utf8'), { schema: JSON_SCHEMA })
  } catch (error) {
    throw new Error(`${label}: invalid YAML: ${String(error)}`)
  }
  assert(manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest), `${label}: manifest must be a mapping`)
  return manifest
}

function withImmutableInput(bytes, label) {
  const manifest = parseManifest(bytes, label)
  assert(manifest.immutableInput === undefined || manifest.immutableInput === 'source-recording',
    `${label}: immutableInput has an incompatible value`)
  assert(manifest.session === undefined && manifest.sessionFormat === undefined,
    `${label}: immutable input cannot borrow a Session or claim historical migration coverage`)
  if (manifest.immutableInput === 'source-recording') return { bytes, manifest }
  const prefix = bytes.length === 0 || bytes[bytes.length - 1] === 10 ? '' : '\n'
  const changed = Buffer.concat([bytes, encoder.encode(`${prefix}immutableInput: source-recording\n`)] )
  return { bytes: changed, manifest: parseManifest(changed, label) }
}

function validateOwnerManifests(turn, readOnly) {
  for (const [name, manifest] of [['turn', turn], ['read-only', readOnly]]) {
    assert(manifest.version === 1 && manifest.profile === 'headless'
      && manifest.composition === 'ptc-python' && manifest.recording === 'authored'
      && manifest.platform === 'posix' && manifest.immutableInput === 'source-recording',
    `${name}: unexpected headless owner metadata`)
    assert(manifest.header?.class === 'ptc-python', `${name}: unexpected Python header class`)
  }
  assert(turn.header.pin === true, 'turn must remain the pinned owner of the Python header sidecars')
  assert(readOnly.header.pin === undefined, 'read-only scenario cannot also pin the Python header sidecars')
  assert(readOnly.permission === 'read-only' && readOnly.workspace?.final === true
    && readOnly.workspace.parent === 'outside-temp', 'read-only scenario must own its outside-temp final workspace')
}

async function gitBlob(repoRoot, commit, path) {
  return execFileSync('git', ['show', `${commit}:${path}`], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 })
}

export async function frozenGenerations(repoRoot) {
  const result = {}
  const root = resolve(repoRoot)
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'snapshots/session'], { cwd: root })
    .toString('utf8').split('\0').filter(Boolean)
  for (const relativePath of tracked) {
    const name = relativePath.split('/').at(-1)
    if (name === undefined || !GENERATION_NAME.test(name)) continue
    const path = pathInside(root, resolve(root, ...relativePath.split('/')))
    let current = path
    while (current !== root) {
      const info = await lstat(current)
      assert(!info.isSymbolicLink(), `${relativePath}: tracked Session generation or its parent is a link`)
      if (current === path) assert(info.isFile(), `${relativePath}: tracked Session generation is not a regular file`)
      else assert(info.isDirectory(), `${relativePath}: tracked Session generation parent is not a directory`)
      current = dirname(current)
    }
    result[relativePath] = sha256(await regularFile(path))
  }
  assert(Object.keys(result).length > 0, 'repository has no tracked Session generations')
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)))
}

async function trackedHeaderSidecars(turnDir) {
  const files = []
  for (const entry of await readdir(turnDir, { withFileTypes: true })) {
    if (!(PROMPT_NAME.test(entry.name) || SCHEMA_NAME.test(entry.name))) continue
    files.push({ name: entry.name, bytes: await regularFile(resolve(turnDir, entry.name)) })
  }
  return files.sort((left, right) => left.name.localeCompare(right.name))
}

async function writeJson(path, value) {
  const temporary = `${path}.next`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  await rename(temporary, path)
}

async function loadState(phaseRoot) {
  const path = resolve(phaseRoot, 'state.json')
  if (!(await fileExists(path))) return undefined
  return JSON.parse((await regularFile(path)).toString('utf8'))
}

export function assertSnapshotRunnerReport(bytes, label) {
  const report = JSON.parse(bytes.toString('utf8'))
  assert(report.success === true && report.numFailedTests === 0 && report.numFailedTestSuites === 0
    && report.numPassedTests === 2,
  `${label}: Vitest must report success, two passed tests, and no failed tests or suites`)
  const assertions = report.testResults.flatMap(result => result.assertionResults ?? [])
  const titles = assertions.map(assertion => `${assertion.fullName ?? ''} ${assertion.title ?? ''}`.trim())
  for (const owner of ['ptc-python-turn', 'ptc-python-read-only']) {
    const matches = assertions.filter(assertion => `${assertion.fullName ?? ''} ${assertion.title ?? ''}`.includes(owner))
    assert(matches.length === 1 && matches[0].status === 'passed',
      `${label}: expected exactly one passed ${owner} replay; saw ${titles.join(' | ')}`)
  }
}

const NATIVE_SMOKE_CHECKS = [
  'built public package exports resolve from the Python runtime package',
  'public built entrypoint and both packaged Python assets exist',
  'built package launches Python, returns a value, and permits workspace writes',
  'built package denies writes outside its workspace',
  'built package denies direct writes under read-only policy',
]

export function assertNativeBuiltSmokeReport(bytes) {
  const report = JSON.parse(bytes.toString('utf8'))
  assert(report.status === 'success', `native built-package report status must be success, received ${report.status}`)
  for (const check of NATIVE_SMOKE_CHECKS) {
    assert(report.checks.includes(check), `native built-package report is missing: ${check}`)
  }
  assert(Array.isArray(report.errors) && report.errors.length === 0, 'native built-package report contains errors')
  return { status: report.status, checks: report.checks, errors: report.errors }
}

/**
 * Stage exact public recordings into one disposable scenario pair and retain a rollback journal.
 * Test callers may supply a local Git reader and temporary roots; the CLI always uses the pinned public source.
 * @param options - Private CI roots, platform, pinned commit, and optional test-only Git/hash inputs.
 * @returns The saved phase state.
 */
export async function prepareSnapshotInputs(options) {
  const {
    repoRoot,
    phaseRoot,
    platform,
    sourceCommit = UPSTREAM_FIXTURE_COMMIT,
    readBlob = (commit, path) => gitBlob(repoRoot, commit, path),
    sourceHashes = SOURCE_BLOBS,
    turnManifestHash = TURN_MANIFEST_SHA256,
  } = options
  assert(platform === 'linux' || platform === 'macos', `unsupported platform: ${platform}`)
  const root = resolve(repoRoot)
  const phase = pathInside(resolve(root, '.artifacts'), phaseRoot)
  assert(sourceCommit === options.expectedCommit || sourceCommit === UPSTREAM_FIXTURE_COMMIT,
    'source commit must be the pinned public upstream commit')
  const turnDir = pathInside(root, resolve(root, 'snapshots/session/ptc-python-turn'))
  const readOnlyDir = pathInside(root, resolve(root, 'snapshots/session/ptc-python-read-only'))
  const statePath = pathInside(phase, resolve(phase, 'state.json'))
  assert(!(await fileExists(statePath)), 'a Python snapshot phase is already prepared')
  await assertRealDirectoryChain(root, 'snapshots/session/ptc-python-turn')
  assert(await directoryExists(turnDir), 'Python turn scenario is missing')
  assert(!(await directoryExists(readOnlyDir)), 'read-only scenario already exists; refusing to overwrite it')

  const currentManifest = await regularFile(resolve(turnDir, 'snapshot.yml'))
  assert(sha256(currentManifest) === turnManifestHash, 'Python turn snapshot manifest differs from the reviewed baseline')
  const frozenBefore = await frozenGenerations(root)
  const sourceBuffers = new Map()
  for (const [path, expectedHash] of sourceHashes) {
    const bytes = Buffer.from(await readBlob(sourceCommit, path))
    assert(sha256(bytes) === expectedHash, `${path}: upstream blob hash does not match the reviewed public source`)
    sourceBuffers.set(path, bytes)
  }
  assert(sourceBuffers.size === SOURCE_BLOBS.size || sourceHashes !== SOURCE_BLOBS,
    'the pinned upstream source list is incomplete')

  const v4TurnPath = resolve(turnDir, 'session.v4.jsonl')
  const writerPaths = (await readdir(turnDir)).filter(name => WRITER_NAME.test(name))
  assert(!(await fileExists(v4TurnPath)), 'turn V4 already exists; refusing to overwrite it')
  assert(writerPaths.length === 0, 'turn writer expectations already exist; refusing to overwrite them')

  const upstreamTurnManifest = sourceBuffers.get('snapshots/session/ptc-python-turn/snapshot.yml')
  assert(upstreamTurnManifest.equals(currentManifest), 'upstream turn manifest differs from the current owner baseline')
  const turnManifest = withImmutableInput(upstreamTurnManifest, 'upstream turn manifest')
  const readOnlyManifest = withImmutableInput(
    sourceBuffers.get('snapshots/session/ptc-python-read-only/snapshot.yml'),
    'upstream read-only manifest',
  )
  validateOwnerManifests(turnManifest.manifest, readOnlyManifest.manifest)
  const turnInput = sourceBuffers.get('snapshots/session/ptc-python-turn/session.v4.jsonl')
  const readOnlyInput = sourceBuffers.get('snapshots/session/ptc-python-read-only/session.v4.jsonl')
  for (const [label, bytes] of [['turn', turnInput], ['read-only', readOnlyInput]]) {
    const header = JSON.parse(bytes.toString('utf8').split(/\r?\n/u, 1)[0])
    assert(header.type === 'session' && header.version === 4, `${label}: upstream source is not a V4 Session`)
  }
  assert(sourceBuffers.get('snapshots/session/ptc-python-read-only/workspace.expected/.empty').length === 0,
    'read-only empty workspace marker must remain zero bytes')

  const sidecars = await trackedHeaderSidecars(turnDir)
  const compositionFiles = Object.fromEntries(await Promise.all(TURN_COMPOSITION_FILES.map(async name =>
    [name, sha256(await regularFile(resolve(turnDir, name)))])))
  const state = {
    schemaVersion: 1,
    platform,
    sourceCommit,
    sourceBlobs: Object.fromEntries([...sourceBuffers].map(([path, bytes]) => [path, {
      sha256: sha256(bytes), bytesBase64: bytes.toString('base64'),
    }])),
    frozenBefore,
    original: {
      turnManifestBase64: currentManifest.toString('base64'),
      turnManifestSha256: sha256(currentManifest),
      compositionFiles,
      sidecars: sidecars.map(({ name, bytes }) => ({ name, bytesBase64: bytes.toString('base64'), sha256: sha256(bytes) })),
    },
    injected: {
      turnManifestSha256: sha256(turnManifest.bytes),
      readOnlyManifestSha256: sha256(readOnlyManifest.bytes),
      turnSessionSha256: sha256(turnInput),
      readOnlySessionSha256: sha256(readOnlyInput),
      createdTurnFiles: ['session.v4.jsonl'],
      createdReadOnlyFiles: [
        'session.v4.jsonl', 'snapshot.yml', 'workspace.expected/.empty',
      ],
    },
  }
  await mkdir(phase, { recursive: true })
  await writeJson(statePath, state)

  const readOnlyCreated = []
  try {
    await writeFile(resolve(turnDir, 'snapshot.yml'), turnManifest.bytes)
    await writeFile(v4TurnPath, turnInput, { flag: 'wx' })
    await mkdir(readOnlyDir)
    readOnlyCreated.push('snapshot.yml')
    await writeFile(resolve(readOnlyDir, 'snapshot.yml'), readOnlyManifest.bytes, { flag: 'wx' })
    readOnlyCreated.push('session.v4.jsonl')
    await writeFile(resolve(readOnlyDir, 'session.v4.jsonl'), readOnlyInput, { flag: 'wx' })
    await mkdir(resolve(readOnlyDir, 'workspace.expected'))
    readOnlyCreated.push('workspace.expected/.empty')
    await writeFile(resolve(readOnlyDir, 'workspace.expected/.empty'), sourceBuffers.get('snapshots/session/ptc-python-read-only/workspace.expected/.empty'), { flag: 'wx' })
  } catch (error) {
    await writeJson(statePath, { ...state, prepareError: String(error), readOnlyCreated })
    throw error
  }
  return state
}

function allowedScenarioFile(name, scenario) {
  if (name === 'snapshot.yml' || GENERATION_NAME.test(name) || WRITER_NAME.test(name)
    || PROMPT_NAME.test(name) || SCHEMA_NAME.test(name)) return true
  return (scenario === 'ptc-python-turn' && TURN_COMPOSITION_FILES.includes(name))
    || (scenario === 'ptc-python-read-only' && name === 'workspace.expected/.empty')
}

async function captureOwnerFiles(repoRoot, scenario, destination) {
  await assertRealDirectoryChain(repoRoot, `snapshots/session/${scenario}`)
  const ownerRoot = resolve(repoRoot, 'snapshots/session', scenario)
  const fileNames = await inventoryFiles(ownerRoot)
  const records = []
  const errors = []
  for (const name of fileNames) {
    if (!allowedScenarioFile(name, scenario)) {
      errors.push(`${scenario}/${name}: unexpected file in phase-owned snapshot inventory`)
      continue
    }
    const bytes = await regularFile(pathInside(ownerRoot, resolve(ownerRoot, ...name.split('/'))))
    const target = pathInside(destination, resolve(destination, scenario, ...name.split('/')))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes, { flag: 'wx' })
    records.push({ scenario, path: name, sha256: sha256(bytes), bytes: bytes.length })
  }
  return { records, errors, fileNames }
}

/** Capture source inputs and refresh outputs before cleanup, including failed/skipped phase outcomes. */
export async function captureSnapshotOutputs(options) {
  const { repoRoot, phaseRoot, platform, outcomes = {}, readBlob = (commit, path) => gitBlob(repoRoot, commit, path) } = options
  const root = resolve(repoRoot)
  const phase = pathInside(resolve(root, '.artifacts'), phaseRoot)
  const evidence = pathInside(phase, resolve(phase, 'evidence'))
  const statePath = resolve(phase, 'state.json')
  await mkdir(evidence, { recursive: true })
  const state = await loadState(phase)
  const normalizedOutcomes = Object.fromEntries(['refresh', 'replay', 'builtPackageSmoke'].map((key) => {
    const value = outcomes[key] ?? 'skipped'
    assert(ALLOWED_OUTCOMES.has(value), `invalid ${key} outcome: ${value}`)
    return [key, value]
  }))
  if (state === undefined) {
    const report = { schemaVersion: 1, status: 'not-prepared', platform, outcomes: normalizedOutcomes, qualified: false }
    await writeJson(resolve(evidence, 'phase.json'), report)
    return report
  }
  assert(state.platform === platform, 'phase platform does not match the capture runner')

  const errors = []
  for (const [label, file] of [['refresh', 'snapshot-refresh.json'], ['replay', 'snapshot-replay.json']]) {
    if (normalizedOutcomes[label] !== 'success') continue
    try { assertSnapshotRunnerReport(await regularFile(resolve(evidence, file)), label) }
    catch (error) { errors.push(`${label} report: ${String(error)}`) }
  }
  let builtSmokeEvidence
  const builtSmokePath = resolve(evidence, 'built-package-smoke.json')
  if (await fileExists(builtSmokePath)) {
    try {
      const bytes = await regularFile(builtSmokePath)
      const parsed = JSON.parse(bytes.toString('utf8'))
      builtSmokeEvidence = { status: parsed.status, checks: parsed.checks, errors: parsed.errors }
      if (normalizedOutcomes.builtPackageSmoke === 'success') builtSmokeEvidence = assertNativeBuiltSmokeReport(bytes)
    } catch (error) {
      errors.push(`built-package smoke report: ${String(error)}`)
    }
  } else if (normalizedOutcomes.builtPackageSmoke === 'success') {
    errors.push('built-package smoke report is missing despite a successful step outcome')
  }
  const sourceHashesBefore = Object.fromEntries(Object.entries(state.sourceBlobs).map(([path, value]) => [path, value.sha256]))
  const sourceHashesAfter = {}
  for (const [path, expected] of Object.entries(state.sourceBlobs)) {
    const original = Buffer.from(expected.bytesBase64, 'base64')
    const current = Buffer.from(await readBlob(state.sourceCommit, path))
    sourceHashesAfter[path] = sha256(current)
    if (sha256(current) !== expected.sha256 || !current.equals(original)) errors.push(`${path}: fetched source bytes changed`)
    const target = pathInside(evidence, resolve(evidence, 'upstream', ...path.split('/')))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, original, { flag: 'wx' })
    if (path.endsWith('/session.v4.jsonl')) {
      const scenario = path.includes('ptc-python-turn/') ? 'ptc-python-turn' : 'ptc-python-read-only'
      const staged = await regularFile(resolve(root, 'snapshots/session', scenario, 'session.v4.jsonl'))
      if (!staged.equals(original)) errors.push(`${scenario}/session.v4.jsonl: immutable input bytes changed`)
    }
  }

  const owners = {}
  for (const scenario of ['ptc-python-turn', 'ptc-python-read-only']) {
    const captured = await captureOwnerFiles(root, scenario, resolve(evidence, 'outputs'))
    owners[scenario] = { files: captured.records, inventory: captured.fileNames }
    errors.push(...captured.errors)
  }
  const compositionAfter = {}
  for (const name of TURN_COMPOSITION_FILES) {
    const captured = owners['ptc-python-turn'].files.find(file => file.path === name)
    compositionAfter[name] = captured?.sha256
    const original = state.original.compositionFiles?.[name]
    if (typeof original !== 'string' || captured?.sha256 !== original) errors.push(`${name}: original turn composition changed or disappeared`)
  }
  const frozenAfter = await frozenGenerations(root)
  if (JSON.stringify(frozenAfter) !== JSON.stringify(state.frozenBefore)) errors.push('a pre-existing Python turn Session generation changed')

  const observed = {
    turn: owners['ptc-python-turn'].files.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
    readOnly: owners['ptc-python-read-only'].files.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
  }
  state.observed = observed
  state.captureComplete = true
  await writeJson(statePath, state)

  const report = {
    schemaVersion: 1,
    status: errors.length === 0 ? 'captured' : 'capture-errors',
    platform,
    sourceCommit: state.sourceCommit,
    outcomes: normalizedOutcomes,
    builtPackageSmoke: builtSmokeEvidence,
    qualified: errors.length === 0 && Object.values(normalizedOutcomes).every(value => value === 'success')
      && builtSmokeEvidence?.status === 'success'
      && NATIVE_SMOKE_CHECKS.every(check => builtSmokeEvidence.checks.includes(check)),
    sourceBlobs: Object.fromEntries(Object.entries(sourceHashesBefore).map(([path, before]) => [path, {
      before, after: sourceHashesAfter[path], stagedInputAfter: path.endsWith('/session.v4.jsonl')
        ? owners[path.includes('ptc-python-turn/') ? 'ptc-python-turn' : 'ptc-python-read-only'].files
          .find(file => file.path === 'session.v4.jsonl')?.sha256 : undefined,
    }])),
    compositionFiles: { before: state.original.compositionFiles, afterSnapshotRuns: compositionAfter },
    frozenGenerations: { before: state.frozenBefore, afterSnapshotRuns: frozenAfter },
    owners,
    errors,
  }
  await writeJson(resolve(evidence, 'phase.json'), report)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return report
}

async function unlinkObservedFile(path, expectedHash, errors) {
  if (!(await fileExists(path))) return
  try {
    const bytes = await regularFile(path)
    if (sha256(bytes) !== expectedHash) {
      errors.push(`${path}: changed after capture; left in place`)
      return
    }
    await unlink(path)
  } catch (error) {
    errors.push(`${path}: ${String(error)}`)
  }
}

/** Restore only the exact temporary files recorded by prepare/capture; never recursively delete a scenario tree. */
export async function restoreSnapshotInputs(options) {
  const { repoRoot, phaseRoot, platform } = options
  const root = resolve(repoRoot)
  const phase = pathInside(resolve(root, '.artifacts'), phaseRoot)
  const evidence = pathInside(phase, resolve(phase, 'evidence'))
  const statePath = resolve(phase, 'state.json')
  const state = await loadState(phase)
  const errors = []
  if (state === undefined) {
    const report = { schemaVersion: 1, status: 'not-prepared', platform, restored: true }
    await mkdir(evidence, { recursive: true })
    await writeJson(resolve(evidence, 'cleanup.json'), report)
    return report
  }
  assert(state.platform === platform, 'phase platform does not match the restore runner')
  const turnDir = resolve(root, 'snapshots/session/ptc-python-turn')
  const readOnlyDir = resolve(root, 'snapshots/session/ptc-python-read-only')
  await assertRealDirectoryChain(root, 'snapshots/session/ptc-python-turn')
  const observedTurn = new Map((state.observed?.turn ?? []).map(item => [item.path, item.sha256]))
  const observedReadOnly = new Map((state.observed?.readOnly ?? []).map(item => [item.path, item.sha256]))

  const manifestPath = resolve(turnDir, 'snapshot.yml')
  if (await fileExists(manifestPath)) {
    const current = await regularFile(manifestPath)
    const currentHash = sha256(current)
    if (currentHash === state.injected.turnManifestSha256 || currentHash === state.original.turnManifestSha256) {
      if (currentHash !== state.original.turnManifestSha256) {
        await writeFile(manifestPath, Buffer.from(state.original.turnManifestBase64, 'base64'))
      }
    } else errors.push('turn snapshot.yml changed outside the phase inventory; left in place')
  } else errors.push('turn snapshot.yml disappeared during the phase; not recreated')

  for (const sidecar of state.original.sidecars) {
    const path = resolve(turnDir, sidecar.name)
    const observedHash = observedTurn.get(sidecar.name)
    if (!(await fileExists(path))) {
      errors.push(`${sidecar.name}: original header sidecar disappeared`)
      continue
    }
    const current = await regularFile(path)
    const digest = sha256(current)
    if (digest !== sidecar.sha256 && digest !== observedHash) {
      errors.push(`${sidecar.name}: changed outside the phase inventory; left in place`)
      continue
    }
    if (digest !== sidecar.sha256) await writeFile(path, Buffer.from(sidecar.bytesBase64, 'base64'))
  }

  const sidecarNames = new Set(state.original.sidecars.map(file => file.name))
  const turnFiles = await readdir(turnDir)
  for (const name of turnFiles) {
    if (name === 'snapshot.yml') continue
    const isGenerated = WRITER_NAME.test(name)
      || ((PROMPT_NAME.test(name) || SCHEMA_NAME.test(name)) && !sidecarNames.has(name))
      || name === 'session.v4.jsonl'
    if (!isGenerated) continue
    const expectedHash = name === 'session.v4.jsonl'
      ? state.injected.turnSessionSha256 : observedTurn.get(name)
    if (expectedHash === undefined) {
      errors.push(`${name}: generated file is absent from the captured inventory; left in place`)
      continue
    }
    await unlinkObservedFile(resolve(turnDir, name), expectedHash, errors)
  }

  if (await directoryExists(readOnlyDir)) {
    let names = []
    try { names = await inventoryFiles(readOnlyDir) }
    catch (error) { errors.push(`read-only owner inventory: ${String(error)}`) }
    for (const name of names) {
      const sourcePath = `snapshots/session/ptc-python-read-only/${name}`
      const expectedHash = observedReadOnly.get(name)
        ?? (name === 'session.v4.jsonl' ? state.injected.readOnlySessionSha256
          : name === 'snapshot.yml' ? state.injected.readOnlyManifestSha256
            : state.sourceBlobs[sourcePath]?.sha256)
      if (expectedHash === undefined) {
        errors.push(`read-only ${name}: file is absent from the captured inventory; left in place`)
        continue
      }
      await unlinkObservedFile(pathInside(readOnlyDir, resolve(readOnlyDir, ...name.split('/'))), expectedHash, errors)
    }
    for (const directory of [resolve(readOnlyDir, 'workspace.expected'), readOnlyDir]) {
      if (await directoryExists(directory)) {
        try { await rmdir(directory) }
        catch (error) { errors.push(`${directory}: could not remove empty phase-owned directory: ${String(error)}`) }
      }
    }
  }

  const compositionAfter = {}
  for (const name of TURN_COMPOSITION_FILES) {
    try {
      compositionAfter[name] = sha256(await regularFile(resolve(turnDir, name)))
      if (compositionAfter[name] !== state.original.compositionFiles?.[name]) errors.push(`${name}: original turn composition changed; left in place`)
    } catch (error) { errors.push(`${name}: original turn composition unavailable: ${String(error)}`) }
  }
  let frozenAfter
  try {
    frozenAfter = await frozenGenerations(root)
    if (JSON.stringify(frozenAfter) !== JSON.stringify(state.frozenBefore)) errors.push('a pre-existing Python turn Session generation changed')
  } catch (error) { errors.push(`frozen Session generations: ${String(error)}`) }
  const manifestAfter = await fileExists(manifestPath) ? sha256(await regularFile(manifestPath)) : undefined
  if (manifestAfter !== state.original.turnManifestSha256) errors.push('turn snapshot.yml was not restored byte-for-byte')
  if (await directoryExists(readOnlyDir)) errors.push('temporary read-only scenario directory remains')

  const report = {
    schemaVersion: 1,
    status: errors.length === 0 ? 'restored' : 'restore-errors',
    platform,
    restored: errors.length === 0,
    turnManifestSha256Before: state.original.turnManifestSha256,
    turnManifestSha256After: manifestAfter,
    compositionFiles: { before: state.original.compositionFiles, afterCleanup: compositionAfter },
    frozenGenerations: { before: state.frozenBefore, afterCleanup: frozenAfter },
    readOnlyScenarioRemoved: !(await directoryExists(readOnlyDir)),
    errors,
  }
  await mkdir(evidence, { recursive: true })
  await writeJson(resolve(evidence, 'cleanup.json'), report)
  if (errors.length === 0) {
    await unlink(statePath)
    try { await rmdir(phase) } catch (error) {
      if (error?.code !== 'ENOTEMPTY') throw error
    }
  } else throw new Error(errors.join('\n'))
  return report
}

/**
 * Verify cleanup evidence against the remaining owner files.
 * @param options - Checkout, phase location, platform, and optional fixture baseline.
 * @returns The verified cleanup receipt.
 */
export async function verifyCleanup(options) {
  const { repoRoot, phaseRoot, platform, turnManifestHash = TURN_MANIFEST_SHA256 } = options
  const root = resolve(repoRoot)
  const phase = pathInside(resolve(root, '.artifacts'), phaseRoot)
  const evidence = resolve(phase, 'evidence')
  const receipt = JSON.parse((await regularFile(resolve(evidence, 'cleanup.json'))).toString('utf8'))
  assert(receipt.platform === platform && receipt.status === 'restored' && receipt.restored === true,
    'cleanup receipt does not report a complete restore')
  assert(receipt.readOnlyScenarioRemoved === true, 'read-only scenario was not removed')
  assert(receipt.turnManifestSha256Before === turnManifestHash
    && receipt.turnManifestSha256After === turnManifestHash, 'turn snapshot manifest baseline changed')
  const turnDir = resolve(root, 'snapshots/session/ptc-python-turn')
  const readOnlyDir = resolve(root, 'snapshots/session/ptc-python-read-only')
  assert(!(await directoryExists(readOnlyDir)), 'temporary read-only scenario directory was recreated after cleanup')
  assert(!(await fileExists(resolve(turnDir, 'session.v4.jsonl'))), 'temporary turn V4 input was recreated after cleanup')
  assert(sha256(await regularFile(resolve(turnDir, 'snapshot.yml'))) === turnManifestHash,
    'turn snapshot manifest differs from the reviewed baseline after cleanup')
  for (const name of TURN_COMPOSITION_FILES) {
    const before = receipt.compositionFiles?.before?.[name]
    assert(typeof before === 'string' && before === receipt.compositionFiles?.afterCleanup?.[name]
      && sha256(await regularFile(resolve(turnDir, name))) === before,
    `${name}: original turn composition differs from the cleanup receipt`)
  }
  const current = await frozenGenerations(root)
  assert(JSON.stringify(current) === JSON.stringify(receipt.frozenGenerations.before)
    && JSON.stringify(current) === JSON.stringify(receipt.frozenGenerations.afterCleanup),
  'committed turn generations differ from the phase cleanup receipt')
  return receipt
}

export function requireManualStagingCi(env) {
  assert(env.GITHUB_ACTIONS === 'true' && env.DSH_PYTHON_NATIVE_SNAPSHOT_PHASE === '1',
    'Python snapshot mutation is allowed only from the explicitly marked GitHub Actions phase')
  assert(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/staging'
    && env.GITHUB_REPOSITORY !== 'deepseek-ai/deepseek-harness',
  'Python snapshot mutation requires the manual staging workflow on the Harnessy fork')
  assert(env.RUNNER_OS === 'Linux' || env.RUNNER_OS === 'macOS', 'Python snapshot phase requires a standard Linux or macOS runner')
}

async function runCli(args, env = process.env) {
  requireManualStagingCi(env)
  const repoRoot = resolve(import.meta.dirname, '..')
  const platform = env.RUNNER_OS === 'Linux' ? 'linux' : 'macos'
  const phaseRoot = resolve(repoRoot, '.artifacts/python-native-snapshot-phase-ci', platform)
  const options = { repoRoot, phaseRoot, platform }
  switch (args[0]) {
    case 'prepare':
      assert(env.UPSTREAM_FIXTURE_COMMIT === UPSTREAM_FIXTURE_COMMIT, 'workflow upstream commit input differs from the pinned commit')
      execFileSync('git', ['rev-parse', `${UPSTREAM_FIXTURE_COMMIT}^{commit}`], { cwd: repoRoot, encoding: 'utf8' })
      await prepareSnapshotInputs(options)
      break
    case 'capture':
      await captureSnapshotOutputs({
        ...options,
        outcomes: {
          refresh: env.PYTHON_SNAPSHOT_REFRESH_OUTCOME,
          replay: env.PYTHON_SNAPSHOT_REPLAY_OUTCOME,
          builtPackageSmoke: env.PYTHON_BUILT_SMOKE_OUTCOME,
        },
      })
      break
    case 'restore':
      await restoreSnapshotInputs(options)
      break
    case 'verify':
      await verifyCleanup(options)
      break
    default:
      throw new Error('usage: node scripts/harnessy-python-native-snapshots.mjs prepare|capture|restore|verify')
  }
}

if (import.meta.main) await runCli(process.argv.slice(2))
