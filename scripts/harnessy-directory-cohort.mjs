/** Bounded manual Linux directory cohort: frozen inputs, serial refresh, then strict replay. */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { digestTracked } from './harnessy-integration-snapshots.mjs'

const SESSION = /(?:^|\/)session(?:\.\d+)?(?:\.v[1-9]\d*)?\.jsonl$/u
const EVIDENCE = '.artifacts/directory-cohort-ci'
const check = (condition, message) => { if (!condition) throw new Error(message) }
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const paths = (root, ...args) => git(root, ...args).split('\0').filter(Boolean).sort()
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const save = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`) }
const normalized = name => name.split(' > ').join(' ')
const relativeFile = (root, file) => file.replaceAll('\\', '/').replace(`${root.replaceAll('\\', '/')}/`, '')
const id = (root, file, name) => `${relativeFile(root, file)}::${normalized(name)}`
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** Require the discovered Vitest cases to equal the closed selection before running.
 * @param {string} root - Repository root.
 * @param {Array<{file:string,name:string}>} inventory - Vitest list JSON file.
 * @param {Array<{file:string,name:string}>} expected - Closed selected cases.
 * @returns {string[]} Unique selected case identifiers.
 */
export function checkCohortInventory(root, inventory, expected) {
  check(Array.isArray(inventory) && expected.length > 0, 'empty or invalid selected inventory')
  const wanted = expected.map(item => id(root, item.file, item.name)).sort()
  const actual = inventory.map(item => id(root, item.file, item.name)).sort()
  check(new Set(wanted).size === wanted.length && new Set(actual).size === actual.length, 'duplicate selected cases')
  check(JSON.stringify(actual) === JSON.stringify(wanted), `selected inventory differs: expected ${wanted.length}, listed ${actual.length}`)
  return actual
}

/** Require every listed case to pass exactly once; unselected skipped cases are allowed.
 * @param {string} root - Repository root.
 * @param {object} report - Vitest JSON result.
 * @param {string[]} selected - Identifiers returned by the strict list check.
 */
export function checkCohortReport(root, report, selected) {
  check(report?.success === true && report.numFailedTests === 0 && report.numFailedTestSuites === 0, 'Vitest report failed')
  const found = []
  for (const suite of report.testResults ?? []) for (const assertion of suite.assertionResults ?? []) {
    const key = id(root, suite.name, assertion.fullName)
    if (selected.includes(key)) {
      check(assertion.status === 'passed', `selected case did not pass: ${key} (${assertion.status})`)
      found.push(key)
    } else check(assertion.status === 'pending' || assertion.status === 'skipped', `unexpected executed case: ${key}`)
  }
  check(found.length === selected.length && new Set(found).size === selected.length
    && selected.every(key => found.includes(key)), 'missing or duplicate selected result')
}

/** Freeze every tracked file, including Session generations outside snapshots.
 * @param {string} root - Clean repository root.
 * @param {string} evidence - Fresh evidence directory.
 * @returns {Promise<object>} Exact source and input digests.
 */
export async function freezeCohort(root, evidence) {
  check(git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all') === '', 'source checkout must be clean')
  const tracked = paths(root, 'ls-files', '-z')
  check(tracked.length > 0, 'no tracked source')
  const hashes = {}
  for (const path of tracked) hashes[path] = await digestTracked(root, path)
  const baseline = { sourceHead: git(root, 'rev-parse', 'HEAD').trim(), hashes,
    sessionInputs: Object.fromEntries(Object.entries(hashes).filter(([path]) => SESSION.test(path))) }
  check(Object.keys(baseline.sessionInputs).length > 0, 'no Session inputs')
  await mkdir(evidence, { recursive: true })
  await writeFile(resolve(evidence, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' })
  return baseline
}

/** Verify frozen inputs and source after each command; admit only exact physical outputs.
 * @param {string} root - Repository root.
 * @param {object} baseline - Frozen source digests.
 * @param {string[]} writable - Exact paths owned by selected refresh cases.
 * @returns {Promise<object>} Output and protected Session digests.
 */
export async function checkCohortFiles(root, baseline, writable) {
  check(git(root, 'rev-parse', 'HEAD').trim() === baseline.sourceHead, 'source HEAD changed')
  const allowed = new Set(writable)
  for (const path of allowed) check(!SESSION.test(path) && !path.split('/').some(part => part === 'workspace' || part === 'workspace.expected'), `forbidden writable input: ${path}`)
  const current = paths(root, 'ls-files', '-z')
  check(JSON.stringify(current) === JSON.stringify(Object.keys(baseline.hashes).sort()), 'tracked source inventory changed')
  const outputs = {}
  const sessionInputs = {}
  const untracked = paths(root, 'ls-files', '--others', '--exclude-standard', '-z')
  for (const path of [...current, ...untracked]) {
    const after = await digestTracked(root, path)
    const before = baseline.hashes[path]
    if (SESSION.test(path)) {
      sessionInputs[path] = { before, after }
      check(after === before, `${path}: protected Session input changed`)
    }
    if (after !== before) {
      check(allowed.has(path), `${path}: unexpected source or output change`)
      const info = await lstat(resolve(root, path))
      check(info.isFile() && !info.isSymbolicLink() && !after.startsWith('symlink:'), `${path}: output must be a physical regular file`)
      outputs[path] = { before: before ?? null, sha256: after }
    }
  }
  return { outputs, sessionInputs }
}

function requireManualLinuxFork(env) {
  check(env.GITHUB_ACTIONS === 'true' && env.DSH_DIRECTORY_COHORT_PHASE === '1'
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/staging'
    && env.RUNNER_OS === 'Linux' && env.GITHUB_REPOSITORY
    && env.GITHUB_REPOSITORY !== 'deepseek-ai/deepseek-harness', 'manual Linux staging fork cohort required')
}

function runVitest(root, args, mode) {
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', ...args], {
    cwd: root, env: { ...process.env, DSH_SNAPSHOT: mode, DEEPSEEK_API_KEY: '' }, stdio: 'inherit',
  })
  check(result.error === undefined && result.signal === null && result.status === 0,
    `Vitest command failed: status=${result.status}, signal=${result.signal}, error=${result.error ?? ''}`)
}

async function executePhase(root, evidence, phase, baseline, writable) {
  const listPath = resolve(evidence, `${phase.id}.list.json`)
  const reportPath = resolve(evidence, `${phase.id}.report.json`)
  // Vitest list uses hierarchy separators; run's name filter uses spaces.
  const pattern = `^(?:${phase.cases.map(item => escapeRegex(normalized(item.name))).join('|')})$`
  const args = ['--config', phase.config, ...phase.files, '-t', pattern, '--pool=forks', '--maxWorkers=1', '--no-file-parallelism']
  runVitest(root, ['list', ...args, `--json=${listPath}`], phase.mode)
  const selected = checkCohortInventory(root, await json(listPath), phase.cases)
  await checkCohortFiles(root, baseline, writable)
  runVitest(root, ['run', ...args, '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`], phase.mode)
  checkCohortReport(root, await json(reportPath), selected)
  const files = await checkCohortFiles(root, baseline, writable)
  await save(resolve(evidence, `${phase.id}.verdict.json`), { qualified: true, selected, ...files })
  return { selected, ...files }
}

async function cohortRun(root, evidence, registry) {
  const baseline = await json(resolve(evidence, 'baseline.json'))
  check(Object.keys(baseline.sessionInputs).length === 631, 'expected all 631 repository Session inputs')
  const state = { qualified: false, sourceHead: baseline.sourceHead, phases: {}, errors: [] }
  await save(resolve(evidence, 'run.json'), state)
  try {
    const refresh = registry.corePhases.filter(phase => phase.mode === 'refresh')
    const replay = registry.corePhases.filter(phase => phase.mode === 'replay')
    refresh.push(registry.webPhases.find(phase => phase.mode === 'refresh'))
    replay.push(registry.webPhases.find(phase => phase.mode === 'replay'))
    for (const phase of [...refresh, ...replay]) state.phases[phase.id] = { outcome: 'pending' }
    for (const phase of registry.receiptPhases) state.phases[phase.id] = { outcome: 'skipped', reason: 'prior receipt unchanged' }
    for (const phase of refresh) {
      state.phases[phase.id] = { outcome: 'running' }
      await save(resolve(evidence, 'run.json'), state)
      state.phases[phase.id] = { outcome: 'success', ...await executePhase(root, evidence, phase, baseline, registry.writableOutputs) }
      await save(resolve(evidence, 'run.json'), state)
    }
    const refreshed = await checkCohortFiles(root, baseline, registry.writableOutputs)
    // Receipts survive only while their owned shared output bytes are unchanged.
    const changedOwners = new Set(Object.keys(refreshed.outputs).map(path => dirname(path).replaceAll('\\', '/')))
    let expanded = true
    while (expanded) {
      expanded = false
      for (const [consumer, source] of registry.dependencies) {
        if (changedOwners.has(source) && !changedOwners.has(consumer)) { changedOwners.add(consumer); expanded = true }
      }
    }
    const invalidated = registry.priorReceipts.filter(dir => changedOwners.has(dir))
    state.invalidatedReceipts = invalidated
    for (const dir of invalidated) replay.push(registry.receiptPhases.find(phase => phase.owners.includes(dir)))
    for (const phase of replay) {
      check(phase !== undefined, 'changed receipt has no closed replay selection')
      state.phases[phase.id] = { outcome: 'running' }
      await save(resolve(evidence, 'run.json'), state)
      const result = await executePhase(root, evidence, phase, baseline, registry.writableOutputs)
      const after = await checkCohortFiles(root, baseline, registry.writableOutputs)
      check(JSON.stringify(after.outputs) === JSON.stringify(refreshed.outputs), `${phase.id}: replay mutated output bytes`)
      state.phases[phase.id] = { outcome: 'success', ...result }
      await save(resolve(evidence, 'run.json'), state)
    }
    state.qualified = true
  } catch (error) {
    state.errors.push(String(error))
    for (const phase of Object.values(state.phases)) if (phase.outcome === 'running') phase.outcome = 'failure'
    throw error
  } finally { await save(resolve(evidence, 'run.json'), state) }
}

async function capture(root, evidence, registry) {
  const phase = { qualified: false, sourceHead: null, outcomes: {}, errors: [], scope: {
    owners: registry.owners, windows: registry.windows, priorReceipts: registry.priorReceipts,
    exclusions: ['Windows/pwsh', 'standalone Python SDK executable goldens', 'real model/API providers', 'release/update publication'],
  } }
  try {
    const baseline = await json(resolve(evidence, 'baseline.json'))
    phase.sourceHead = baseline.sourceHead
    const files = await checkCohortFiles(root, baseline, registry.writableOutputs)
    Object.assign(phase, files)
    for (const path of Object.keys(files.outputs)) {
      const target = resolve(evidence, 'outputs', path)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(resolve(root, path), target)
    }
    const run = await json(resolve(evidence, 'run.json'))
    check(run.qualified === true && run.errors.length === 0, 'cohort run did not qualify')
    phase.invalidatedReceipts = run.invalidatedReceipts
    for (const name of ['guardTests', 'nativeBuild', 'landlock', 'hostBuild', 'clientBuild', 'webBuild', 'browserInstall', 'freeze', 'cohort']) {
      const outcome = process.env[`${name.replace(/[A-Z]/gu, match => `_${match}`).toUpperCase()}_OUTCOME`]
      phase.outcomes[name] = outcome ?? 'missing'
      check(outcome === 'success', `${name}: ${outcome ?? 'missing'}`)
    }
    phase.qualified = true
  } catch (error) { phase.errors.push(String(error)) }
  await save(resolve(evidence, 'phase.json'), phase)
  console.log(JSON.stringify({ qualified: phase.qualified, scope: phase.scope.exclusions, errors: phase.errors }))
  check(phase.qualified, phase.errors.join('\n'))
}

if (import.meta.main) {
  requireManualLinuxFork(process.env)
  const root = resolve(import.meta.dirname, '..')
  const evidence = resolve(root, EVIDENCE)
  const registry = await json(resolve(root, 'scripts/harnessy-directory-cohort.json'))
  if (process.argv[2] === 'freeze') await freezeCohort(root, evidence)
  else if (process.argv[2] === 'run') await cohortRun(root, evidence, registry)
  else if (process.argv[2] === 'capture') await capture(root, evidence, registry)
  else throw new Error('usage: harnessy-directory-cohort.mjs freeze|run|capture')
}
