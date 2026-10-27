/** Freeze, verify, and capture the bounded Linux Web snapshot run. */
import { execFileSync } from 'node:child_process'
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { JSON_SCHEMA, load } from 'js-yaml'
import { digestTracked } from './harnessy-integration-snapshots.mjs'

const OWNER_FILES = [
  'apps/web/tests/changed-files-turn.e2e.ts',
  'apps/web/tests/replay-round-trip.e2e.ts',
  'apps/web/tests/minimal-preset.snapshot.ts',
  'apps/web/tests/present.e2e.ts',
  'apps/web/tests/present-svg.e2e.ts',
]
const OWNER_NAMES = ['changed-files-turn', 'fresh-round-trip', 'minimal-preset', 'present', 'present-svg']
const FEATURE_SMOKES = [
  {
    file: 'apps/web/tests/produced-file-mentions.e2e.ts',
    title: 'links the unique mention and leaves ambiguous and unknown code inert',
  },
  {
    file: 'apps/web/tests/sidebar-terminal.e2e.ts',
    title: 'starts in the current directory while earlier terminals and sandbox roots stay independent',
  },
  {
    file: 'apps/web/tests/worktree-opt-in.e2e.ts',
    title: 'persists the Git Worktrees switch and removes its capability while retaining checkouts',
  },
]
const SESSION_INPUT = /(?:^|\/)session(?:\.\d+)?(?:\.v[1-9]\d*)?\.jsonl$/u
const EVIDENCE_DIR = '.artifacts/row25-web-snapshot-verification'
const check = (condition, message) => { if (!condition) throw new Error(message) }
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const paths = (root, ...args) => git(root, ...args).split('\0').filter(Boolean).sort()

const ALLOWED_OUTPUTS = new Set([
  ...OWNER_NAMES.map(owner => `snapshots/web/${owner}/writer.expected.jsonl`),
  'snapshots/web/changed-files-turn/preparing-edit.expected.md',
  'snapshots/web/changed-files-turn/preparing-edit-content.expected.md',
  'snapshots/web/changed-files-turn/preparing-write.expected.md',
  'snapshots/web/changed-files-turn/preparing-write-content.expected.md',
  'snapshots/web/changed-files-turn/hover.expected.md',
  'snapshots/web/changed-files-turn/ui.expected.md',
  'snapshots/web/fresh-round-trip/accepted-reconnect.expected.md',
  'snapshots/web/fresh-round-trip/blank-reload.expected.md',
  'snapshots/web/fresh-round-trip/submission-echo.expected.md',
  'snapshots/web/fresh-round-trip/system-prompt.expected.md',
  'snapshots/web/fresh-round-trip/tool-schemas.expected.json',
  'snapshots/web/fresh-round-trip/ui.expected.md',
  'snapshots/web/fresh-round-trip/ui-expanded.expected.md',
  'snapshots/web/fresh-round-trip/web-context.expected.md',
  'snapshots/web/minimal-preset/system-prompt.expected.md',
  'snapshots/web/minimal-preset/tool-schemas.expected.json',
  'snapshots/web/minimal-preset/ui.expected.md',
  'snapshots/web/present/ui.expected.md',
  'snapshots/web/present-svg/ui.expected.md',
  'snapshots/web/changed-files-turn/workspace.expected/.gitignore',
  'snapshots/web/changed-files-turn/workspace.expected/app.local',
  'snapshots/web/changed-files-turn/workspace.expected/intro.md',
  'snapshots/web/changed-files-turn/workspace.expected/notes.txt',
  'snapshots/web/changed-files-turn/workspace.expected/src/util.ts',
  'snapshots/web/present/workspace.expected/report.txt',
  'snapshots/web/present/workspace.expected/说明.txt',
  'snapshots/web/present-svg/workspace.expected/von-neumann.svg',
])

/**
 * Whether one exact generated output belongs to the selected Web owners.
 * @param {string} path - Repository-relative generated path.
 * @returns {boolean} Whether the selected owners may refresh this exact path.
 */
export function isAllowedWebOutput(path) {
  return ALLOWED_OUTPUTS.has(path)
}

/**
 * Require every selected browser owner to have passed every assertion once.
 * @param {object} report - Parsed Vitest JSON report.
 * @param {string} phase - Refresh or replay phase name for diagnostics.
 * @throws If any selected file is missing, duplicated, skipped, or failed.
 */
export function checkWebOwnerReport(report, phase) {
  check(report?.success === true && report.numFailedTests === 0 && report.numFailedTestSuites === 0,
    `${phase}: Vitest report failed`)
  check(Array.isArray(report.testResults) && report.testResults.length === OWNER_FILES.length,
    `${phase}: expected exactly ${OWNER_FILES.length} selected owner files`)
  for (const ownerFile of OWNER_FILES) {
    const normalized = ownerFile.replaceAll('\\', '/')
    const matches = report.testResults.filter(result => result.name?.replaceAll('\\', '/').endsWith(normalized))
    check(matches.length === 1, `${phase}: expected exactly one result for ${ownerFile}`)
    const [suite] = matches
    check(suite.status === 'passed', `${phase}: selected owner did not pass: ${ownerFile}`)
    check(Array.isArray(suite.assertionResults) && suite.assertionResults.length > 0,
      `${phase}: selected owner ran no assertions: ${ownerFile}`)
    check(suite.assertionResults.every(result => result.status === 'passed'),
      `${phase}: selected owner has a failed or skipped assertion: ${ownerFile}`)
  }
}

/**
 * Require exactly the three selected directory-feature smoke assertions to pass.
 * @param {object} report - Parsed Vitest JSON report for the filtered smoke run.
 * @throws If a target assertion is missing, duplicated, skipped, failed, or an extra assertion runs.
 */
export function checkFeatureSmokeReport(report) {
  check(report?.success === true && report.numFailedTests === 0 && report.numFailedTestSuites === 0,
    'feature smoke: Vitest report failed')
  check(Array.isArray(report.testResults) && report.testResults.length === FEATURE_SMOKES.length,
    `feature smoke: expected exactly ${FEATURE_SMOKES.length} selected test files`)
  const passed = []
  for (const smoke of FEATURE_SMOKES) {
    const normalized = smoke.file.replaceAll('\\', '/')
    const suites = report.testResults.filter(result => result.name?.replaceAll('\\', '/').endsWith(normalized))
    check(suites.length === 1, `feature smoke: expected one result for ${smoke.file}`)
    check(suites[0].status === 'passed', `feature smoke: selected file did not pass: ${smoke.file}`)
    const assertions = suites[0].assertionResults
    check(Array.isArray(assertions), `feature smoke: missing assertions for ${smoke.file}`)
    const matching = assertions.filter(assertion => assertion.title === smoke.title)
    check(matching.length === 1, `feature smoke: expected exactly one named assertion in ${smoke.file}`)
    check(matching[0].status === 'passed', `feature smoke: named assertion did not pass in ${smoke.file}`)
    passed.push(...assertions.filter(assertion => assertion.status === 'passed'))
  }
  check(passed.length === FEATURE_SMOKES.length,
    `feature smoke: expected exactly ${FEATURE_SMOKES.length} passed assertions`)
}

async function verifyOwnerManifests(root) {
  for (const owner of OWNER_NAMES) {
    const path = resolve(root, 'snapshots/web', owner, 'snapshot.yml')
    const manifest = load(await readFile(path, 'utf8'), { schema: JSON_SCHEMA })
    check(manifest?.profile === 'web' && manifest.immutableInput === 'source-recording'
      && manifest.session === undefined && manifest.sessionFormat === undefined,
    `${owner}: selected Web input must be an owning immutable current-format source`)
  }
}

/**
 * Hash every tracked source path and freeze all Session inputs before refresh.
 * @param {string} root - Repository root.
 * @param {string} evidence - Directory receiving the input baseline.
 * @returns {Promise<object>} Source revision and tracked input digests.
 * @throws If the checkout is dirty, an owner manifest is not immutable, or a Session input is missing.
 */
export async function freezeWebSnapshotInputs(root, evidence) {
  await verifyOwnerManifests(root)
  check(git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all') === '',
    'source checkout must be clean before validation')
  const tracked = paths(root, 'ls-files', '-z', '--', '.')
  check(tracked.length > 0, 'source checkout has no tracked files')
  const sessions = tracked.filter(path => SESSION_INPUT.test(path))
  check(sessions.length > 0, 'no tracked Session input generations')
  const trackedHashes = {}
  for (const path of tracked) trackedHashes[path] = await digestTracked(root, path)
  await mkdir(evidence, { recursive: true })
  const state = {
    sourceHead: git(root, 'rev-parse', 'HEAD').trim(),
    trackedHashes,
    sessionInputs: Object.fromEntries(sessions.map(path => [path, trackedHashes[path]])),
  }
  await writeFile(resolve(evidence, 'baseline.json'), `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' })
  return state
}

async function captureOutput(root, evidence, path, before) {
  const source = resolve(root, path)
  const info = await lstat(source)
  check(info.isFile() && !info.isSymbolicLink(), `${path}: expected a regular output file`)
  const after = await digestTracked(root, path)
  const target = resolve(evidence, 'outputs', path)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  return { before: before ?? null, sha256: after }
}

async function copyFailureScreenshots(root, evidence) {
  const names = [
    'web-e2e-round-trip.png',
    'web-e2e-round-trip-settled.png',
    'web-e2e-round-trip-aria.png',
    'web-e2e-round-trip-system-prompt.png',
    'web-e2e-round-trip-think.png',
    'web-minimal-persistent-bash-card.png',
    'web-e2e-produced-file-mentions.png',
    'web-e2e-worktree-opt-in.png',
    'sidebar-terminal-directory.png',
  ]
  const destination = resolve(evidence, 'failure-screenshots')
  await mkdir(destination, { recursive: true })
  for (const name of names) {
    try { await copyFile(resolve(root, '.artifacts', name), resolve(destination, name)) }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

/**
 * Verify protected inputs and capture only selected outputs and diagnostics.
 * @param {string} root - Repository root.
 * @param {string} evidence - Directory containing reports and the input baseline.
 * @param {Record<string, string | undefined>} outcomes - Workflow step outcomes.
 * @returns {Promise<object>} Qualification result and captured evidence metadata.
 * @throws If a Session input changed, a source write escaped the allowlist, or a selected test did not pass.
 */
export async function captureWebSnapshotEvidence(root, evidence, outcomes) {
  const errors = []
  let state
  try { state = JSON.parse(await readFile(resolve(evidence, 'baseline.json'), 'utf8')) }
  catch (error) { errors.push(`missing input baseline: ${String(error)}`) }
  const inputHashes = {}
  const outputs = {}
  if (state !== undefined) {
    const changedOutputs = new Set()
    const current = paths(root, 'ls-files', '-z', '--', '.')
    const currentSet = new Set(current)
    for (const [path, before] of Object.entries(state.trackedHashes)) {
      try {
        check(currentSet.has(path), `${path}: tracked source was removed`)
        const after = await digestTracked(root, path)
        if (SESSION_INPUT.test(path)) inputHashes[path] = { before, after }
        if (SESSION_INPUT.test(path)) check(after === before, `${path}: protected Session input changed`)
        else if (after !== before) {
          if (isAllowedWebOutput(path)) changedOutputs.add(path)
          else errors.push(`${path}: tracked source changed`)
        }
      } catch (error) { errors.push(`${path}: ${String(error)}`) }
    }
    for (const path of current) if (!(path in state.trackedHashes)) errors.push(`${path}: tracked source added after baseline`)
    const changed = paths(root, 'diff', '--name-only', '-z', 'HEAD', '--', '.')
    for (const path of changed) if (!isAllowedWebOutput(path)) errors.push(`${path}: unexpected source change`)
    const untracked = paths(root, 'ls-files', '--others', '--exclude-standard', '-z', '--', '.')
    for (const path of untracked) {
      if (SESSION_INPUT.test(path) || !isAllowedWebOutput(path)) errors.push(`${path}: unexpected untracked file`)
      else changedOutputs.add(path)
    }
    const outputPaths = [...changedOutputs].sort()
    for (const path of outputPaths) {
      try { outputs[path] = await captureOutput(root, evidence, path, state.trackedHashes[path]) }
      catch (error) { errors.push(`${path}: output capture failed: ${String(error)}`) }
    }
    if (git(root, 'rev-parse', 'HEAD').trim() !== state.sourceHead) errors.push('source HEAD changed')
  }
  const ownerReports = {}
  for (const phase of ['refresh', 'replay']) {
    try {
      const reportPath = resolve(evidence, `${phase}.json`)
      const report = JSON.parse(await readFile(reportPath, 'utf8'))
      checkWebOwnerReport(report, phase)
      ownerReports[phase] = Object.fromEntries(OWNER_NAMES.map(owner => [owner, 'passed']))
    } catch (error) { errors.push(`${phase} report: ${String(error)}`) }
  }
  try {
    const report = JSON.parse(await readFile(resolve(evidence, 'feature-smoke.json'), 'utf8'))
    checkFeatureSmokeReport(report)
    ownerReports.featureSmoke = Object.fromEntries(FEATURE_SMOKES.map(smoke => [smoke.file, smoke.title]))
  } catch (error) { errors.push(`feature smoke report: ${String(error)}`) }
  const requiredOutcomes = [
    'guardTests', 'nativeBuild', 'landlock', 'hostBuild', 'clientBuild',
    'webBuild', 'browserInstall', 'freeze', 'refresh', 'replay', 'featureSmoke',
  ]
  for (const name of requiredOutcomes) {
    if (outcomes[name] !== 'success') errors.push(`${name}: ${outcomes[name] ?? 'missing'}`)
  }
  await copyFailureScreenshots(root, evidence).catch(error => errors.push(`failure screenshot capture: ${String(error)}`))
  const phase = {
    sourceHead: state?.sourceHead ?? null,
    qualified: errors.length === 0,
    outcomes,
    inputHashes,
    ownerReports,
    outputs,
    errors,
  }
  await mkdir(evidence, { recursive: true })
  await writeFile(resolve(evidence, 'phase.json'), `${JSON.stringify(phase, null, 2)}\n`)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return phase
}

/**
 * Restrict collector commands to explicit manual runs from a Linux staging fork.
 * @param {NodeJS.ProcessEnv} env - Environment values for this process.
 * @throws If the invocation is local, automatic, official-repository, or non-Linux.
 */
export function requireManualLinuxFork(env) {
  const repository = env.GITHUB_REPOSITORY
  check(env.GITHUB_ACTIONS === 'true' && env.DSH_WEB_SNAPSHOT_PHASE === '1'
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/staging'
    && typeof repository === 'string' && repository.trim().length > 0
    && repository !== 'deepseek-ai/deepseek-harness' && env.RUNNER_OS === 'Linux',
  'manual fork staging Linux Web snapshot phase required')
}

if (import.meta.main) {
  requireManualLinuxFork(process.env)
  const root = resolve(import.meta.dirname, '..')
  const evidence = resolve(root, EVIDENCE_DIR)
  if (process.argv[2] === 'freeze') await freezeWebSnapshotInputs(root, evidence)
  else if (process.argv[2] === 'capture') {
    await captureWebSnapshotEvidence(root, evidence, {
      guardTests: process.env.GUARD_TESTS_OUTCOME,
      nativeBuild: process.env.NATIVE_BUILD_OUTCOME,
      landlock: process.env.LANDLOCK_OUTCOME,
      hostBuild: process.env.HOST_BUILD_OUTCOME,
      clientBuild: process.env.CLIENT_BUILD_OUTCOME,
      webBuild: process.env.WEB_BUILD_OUTCOME,
      browserInstall: process.env.BROWSER_INSTALL_OUTCOME,
      freeze: process.env.FREEZE_OUTCOME,
      refresh: process.env.REFRESH_OUTCOME,
      replay: process.env.REPLAY_OUTCOME,
      featureSmoke: process.env.FEATURE_SMOKE_OUTCOME,
    })
  } else throw new Error('usage: harnessy-web-snapshots.mjs freeze|capture')
}
