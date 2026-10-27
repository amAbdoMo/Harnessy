import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import test from 'node:test'
import {
  captureWebSnapshotEvidence,
  checkFeatureSmokeReport,
  checkWebOwnerReport,
  freezeWebSnapshotInputs,
  isAllowedWebOutput,
  requireManualLinuxFork,
} from './harnessy-web-snapshots.mjs'

const owners = [
  'changed-files-turn',
  'fresh-round-trip',
  'minimal-preset',
  'present',
  'present-svg',
]
const files = [
  'changed-files-turn.e2e.ts',
  'replay-round-trip.e2e.ts',
  'minimal-preset.snapshot.ts',
  'present.e2e.ts',
  'present-svg.e2e.ts',
]
const smokeSpecs = [
  ['produced-file-mentions.e2e.ts', 'links the unique mention and leaves ambiguous and unknown code inert'],
  ['sidebar-terminal.e2e.ts', 'starts in the current directory while earlier terminals and sandbox roots stay independent'],
  ['worktree-opt-in.e2e.ts', 'persists the Git Worktrees switch and removes its capability while retaining checkouts'],
]
const workflowRoot = resolve(import.meta.dirname, '..')
const workflowPath = resolve(workflowRoot, '.github/workflows/ci-master.yml')
const webJobName = 'harnessy-web-snapshot-verification'
const webSuite = webJobName

function passingReport() {
  return {
    success: true,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    testResults: files.map(file => ({
      name: `/repo/apps/web/tests/${file}`,
      status: 'passed',
      assertionResults: [{ status: 'passed' }],
    })),
  }
}

function passingFeatureSmokeReport() {
  return {
    success: true,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    testResults: smokeSpecs.map(([file, title]) => ({
      name: `/repo/apps/web/tests/${file}`,
      status: 'passed',
      assertionResults: [
        { title, status: 'passed' },
        { title: 'an unrelated filtered assertion', status: 'pending' },
      ],
    })),
  }
}

async function createGitFixture(context, { trackedWriter = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-snapshot-guard-'))
  const evidence = await mkdtemp(join(tmpdir(), 'dsh-web-snapshot-evidence-'))
  context.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(evidence, { recursive: true, force: true })
  })
  for (const owner of owners) {
    const ownerDir = join(root, 'snapshots', 'web', owner)
    await mkdir(ownerDir, { recursive: true })
    await writeFile(join(ownerDir, 'snapshot.yml'), [
      'version: 1',
      `scenario: ${owner}`,
      'profile: web',
      'immutableInput: source-recording',
      '',
    ].join('\n'))
    await writeFile(join(ownerDir, 'session.v3.jsonl'), `{"type":"session","version":3,"owner":"${owner}"}\n`)
  }
  await mkdir(join(root, 'scripts'), { recursive: true })
  const sourcePath = 'scripts/example.mjs'
  await writeFile(join(root, sourcePath), 'export const value = 1\n')
  const sessionPath = 'snapshots/web/present-svg/session.v3.jsonl'
  const writerPath = 'snapshots/web/present-svg/writer.expected.jsonl'
  if (trackedWriter) await writeFile(join(root, writerPath), '{"type":"session","version":4}\n')
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Web snapshot test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'web-snapshot-test@example.invalid'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root })
  return { root, evidence, sessionPath, writerPath, sourcePath }
}

function passingOutcomes() {
  return Object.fromEntries([
    'guardTests', 'nativeBuild', 'landlock', 'hostBuild', 'clientBuild',
    'webBuild', 'browserInstall', 'freeze', 'refresh', 'replay', 'featureSmoke',
  ].map(name => [name, 'success']))
}

function selected(expression, event, ref, repository, suite, optIn = 'true') {
  if (typeof expression === 'boolean') return expression
  if (typeof expression !== 'string') return true
  return Boolean(runInNewContext(expression, {
    github: { event_name: event, ref, repository },
    inputs: { suite },
    vars: { CUSTOM_HARNESS_RUN_UPSTREAM_CI: optIn },
  }, { timeout: 1000 }))
}

function readWorkflow() {
  return load(readFileSync(workflowPath, 'utf8'))
}

test('Web output allowlist includes only the selected owners’ exact generated files', () => {
  for (const owner of owners) {
    assert.equal(isAllowedWebOutput(`snapshots/web/${owner}/writer.expected.jsonl`), true)
  }
  assert.equal(isAllowedWebOutput('snapshots/web/present-svg/session.v3.jsonl'), false)
  assert.equal(isAllowedWebOutput('snapshots/web/fresh-round-trip/ui.expected.md'), true)
  assert.equal(isAllowedWebOutput('snapshots/web/present-svg/workspace.expected/von-neumann.svg'), true)
  assert.equal(isAllowedWebOutput('snapshots/web/other-owner/ui.expected.md'), false)
  assert.equal(isAllowedWebOutput('snapshots/web/present-svg/other.expected.md'), false)
})

test('Web report guard accepts the exact five passing selected owners', () => {
  assert.doesNotThrow(() => checkWebOwnerReport(passingReport(), 'refresh'))
})

test('Web report guard rejects a missing or skipped selected owner', () => {
  const missing = passingReport()
  missing.testResults.pop()
  assert.throws(() => checkWebOwnerReport(missing, 'replay'), /exactly 5 selected owner files/)

  const skipped = passingReport()
  skipped.testResults[2].assertionResults[0].status = 'pending'
  assert.throws(() => checkWebOwnerReport(skipped, 'refresh'), /failed or skipped assertion/)
})

test('Web report guard rejects an unexpected suite or duplicate selected file', () => {
  const duplicate = passingReport()
  duplicate.testResults[4].name = duplicate.testResults[0].name
  assert.throws(() => checkWebOwnerReport(duplicate, 'replay'), /exactly one result/)

  const extra = passingReport()
  extra.testResults[4].name = '/repo/apps/web/tests/unselected.e2e.ts'
  assert.throws(() => checkWebOwnerReport(extra, 'replay'), /exactly one result/)
})

test('feature smoke report accepts exactly three named passes with unrelated cases filtered', () => {
  assert.doesNotThrow(() => checkFeatureSmokeReport(passingFeatureSmokeReport()))
})

test('feature smoke report rejects missing, skipped, or extra passed assertions', () => {
  const missing = passingFeatureSmokeReport()
  missing.testResults.pop()
  assert.throws(() => checkFeatureSmokeReport(missing), /exactly 3 selected test files/)

  const skipped = passingFeatureSmokeReport()
  skipped.testResults[1].assertionResults[0].status = 'pending'
  assert.throws(() => checkFeatureSmokeReport(skipped), /named assertion did not pass/)

  const pendingSuite = passingFeatureSmokeReport()
  pendingSuite.testResults[1].status = 'pending'
  assert.throws(() => checkFeatureSmokeReport(pendingSuite), /selected file did not pass/)

  const extra = passingFeatureSmokeReport()
  extra.testResults[0].assertionResults.push({ title: 'unexpected pass', status: 'passed' })
  assert.throws(() => checkFeatureSmokeReport(extra), /exactly 3 passed assertions/)
})

test('manual execution guard requires a Linux staging fork', () => {
  const validFork = {
    GITHUB_ACTIONS: 'true',
    DSH_WEB_SNAPSHOT_PHASE: '1',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/staging',
    GITHUB_REPOSITORY: 'owner/HarnessY',
    RUNNER_OS: 'Linux',
  }
  assert.doesNotThrow(() => requireManualLinuxFork(validFork))
  const invalidCases = [
    ['missing environment', {}],
    ['wrong event', { ...validFork, GITHUB_EVENT_NAME: 'push' }],
    ['wrong ref', { ...validFork, GITHUB_REF: 'refs/heads/master' }],
    ['wrong OS', { ...validFork, RUNNER_OS: 'macOS' }],
    ['official repository', { ...validFork, GITHUB_REPOSITORY: 'deepseek-ai/deepseek-harness' }],
    ['missing repository', { ...validFork, GITHUB_REPOSITORY: undefined }],
    ['empty repository', { ...validFork, GITHUB_REPOSITORY: ' ' }],
  ]
  for (const [name, environment] of invalidCases) {
    assert.throws(() => requireManualLinuxFork(environment), /manual fork staging Linux Web snapshot phase required/, name)
  }
})

test('workflow selects only the manual staging-fork Web suite and preserves automatic job selection', () => {
  const workflow = readWorkflow()
  const job = workflow.jobs[webJobName]
  assert.ok(job, 'Web browser diagnostics job must exist')
  const cases = [
    ['workflow_dispatch', 'refs/heads/staging', 'owner/HarnessY', webSuite, true],
    ['workflow_dispatch', 'refs/heads/master', 'owner/HarnessY', webSuite, false],
    ['push', 'refs/heads/staging', 'owner/HarnessY', webSuite, false],
    ['workflow_dispatch', 'refs/heads/staging', 'deepseek-ai/deepseek-harness', webSuite, false],
    ['workflow_dispatch', 'refs/heads/staging', 'owner/HarnessY', 'larger-runner-benchmark', false],
  ]
  for (const [event, ref, repository, suite, expected] of cases) {
    assert.equal(selected(job.if, event, ref, repository, suite), expected,
      `unexpected Web job selection for ${event} ${ref} ${repository} ${suite}`)
  }

  const suiteOptions = workflow.on.workflow_dispatch.inputs.suite.options
  assert.ok(suiteOptions.includes(webSuite), 'manual suite choice must be available')
  const jobs = Object.entries(workflow.jobs)
  for (const [name, otherJob] of jobs) {
    if (name === webJobName) continue
    assert.equal(selected(otherJob.if, 'workflow_dispatch', 'refs/heads/staging', 'owner/HarnessY', webSuite), false,
      `${name} must remain unselected for the new Web suite`)
  }
  const automaticPushJobs = jobs
    .filter(([, candidate]) => selected(candidate.if, 'push', 'refs/heads/master', 'owner/HarnessY', '', 'true'))
    .map(([name]) => name)
    .sort()
  assert.deepEqual(automaticPushJobs, [
    'python-runtime', 'serial-linux-selfhosted', 'serial-windows', 'windows',
  ])
})

test('workflow keeps the five-owner refresh/replay and adds only the three filtered replay smokes', () => {
  const steps = readWorkflow().jobs[webJobName].steps
  const namedStep = name => steps.find(step => step.name === name)
  const owners = [
    'apps/web/tests/changed-files-turn.e2e.ts',
    'apps/web/tests/replay-round-trip.e2e.ts',
    'apps/web/tests/minimal-preset.snapshot.ts',
    'apps/web/tests/present.e2e.ts',
    'apps/web/tests/present-svg.e2e.ts',
  ]
  const refresh = namedStep('Refresh selected Web owners')
  const replay = namedStep('Replay selected Web owners')
  const smoke = namedStep('Replay bounded directory feature smokes')
  assert.equal(refresh.env.DSH_SNAPSHOT, 'refresh')
  assert.equal(replay.env.DSH_SNAPSHOT, 'replay')
  for (const file of owners) {
    assert.ok(refresh.run.includes(file), `refresh must retain ${file}`)
    assert.ok(replay.run.includes(file), `replay must retain ${file}`)
  }
  assert.equal(smoke.env.DSH_SNAPSHOT, 'replay')
  for (const [file] of smokeSpecs) assert.ok(smoke.run.includes(`apps/web/tests/${file}`), `smoke must include ${file}`)
  assert.match(smoke.run, /-t 'inline-code mentions\|starts in the current directory while earlier terminals\|persists the Git Worktrees switch'/u)
  assert.match(smoke.run, /feature-smoke\.json/u)
})

test('evidence capture rejects changes to a Session input and tracked source', async (context) => {
  const { root, evidence, sessionPath, writerPath, sourcePath } = await createGitFixture(context, { trackedWriter: true })
  await freezeWebSnapshotInputs(root, evidence)
  await writeFile(join(root, sessionPath), '{"type":"session","version":4}\n')
  const freshWriterOutput = '{"type":"session","version":4,"source":"writer"}\n'
  await writeFile(join(root, writerPath), freshWriterOutput)
  await writeFile(join(root, sourcePath), 'export const value = 2\n')
  await writeFile(join(evidence, 'refresh.json'), JSON.stringify(passingReport()))
  await writeFile(join(evidence, 'replay.json'), JSON.stringify(passingReport()))
  await writeFile(join(evidence, 'feature-smoke.json'), JSON.stringify(passingFeatureSmokeReport()))

  await assert.rejects(
    captureWebSnapshotEvidence(root, evidence, passingOutcomes()),
    error => error instanceof Error
      && error.message.includes('protected Session input changed')
      && error.message.includes('tracked source changed'),
  )
  const phase = JSON.parse(await readFile(join(evidence, 'phase.json'), 'utf8'))
  assert.equal(phase.qualified, false)
  assert.equal(phase.inputHashes[sessionPath].before === phase.inputHashes[sessionPath].after, false)
  assert.equal(phase.outputs[writerPath].sha256.length, 64)
  assert.equal(await readFile(join(evidence, 'outputs', writerPath), 'utf8'), freshWriterOutput)
})

test('clean freeze and capture qualifies with five owners and an untracked writer output', async (context) => {
  const { root, evidence, writerPath } = await createGitFixture(context)
  const baseline = await freezeWebSnapshotInputs(root, evidence)
  assert.equal(Object.keys(baseline.sessionInputs).length, owners.length)
  await writeFile(join(root, writerPath), '{"type":"session","version":4,"source":"writer"}\n')
  await writeFile(join(evidence, 'refresh.json'), JSON.stringify(passingReport()))
  await writeFile(join(evidence, 'replay.json'), JSON.stringify(passingReport()))
  await writeFile(join(evidence, 'feature-smoke.json'), JSON.stringify(passingFeatureSmokeReport()))

  const phase = await captureWebSnapshotEvidence(root, evidence, passingOutcomes())
  assert.equal(phase.qualified, true)
  assert.equal(Object.keys(phase.ownerReports.refresh).length, owners.length)
  assert.equal(Object.keys(phase.ownerReports.replay).length, owners.length)
  assert.equal(phase.outputs[writerPath].before, null)
  assert.equal(phase.outputs[writerPath].sha256.length, 64)
  assert.equal(await readFile(join(evidence, 'outputs', writerPath), 'utf8'), '{"type":"session","version":4,"source":"writer"}\n')
})
