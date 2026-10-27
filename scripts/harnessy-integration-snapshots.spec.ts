import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { describe, expect, it, onTestFinished } from 'vitest'
import { captureIntegrationEvidence, checkOwnerReport, digestTracked, freezeSnapshotInputs, isAllowedOutput } from './harnessy-integration-snapshots.mjs'

const root = resolve(import.meta.dirname, '..')
const owners = ['ptc-turn', 'ptc-python-turn', 'ptc-python-read-only', 'working-directory', 'working-directory-consumers', 'working-directory-admission']
const outcomes = Object.fromEntries(['freeze', 'headlessRefresh', 'headlessReplay', 'sdkRefresh', 'sdkReplay', 'pythonMetadata', 'builtPackageSmoke'].map(key => [key, 'success']))
function report(names: string[], verb: string) {
  return { success: true, numFailedTests: 0, numFailedTestSuites: 0, numPassedTests: names.length,
    testResults: [{ assertionResults: names.map(name => ({ fullName: `${verb}s ${name} through dsh`, status: 'passed' })) }] }
}
function fixture(selectedOwners = owners) {
  const repo = mkdtempSync(join(tmpdir(), 'integration-snapshot-'))
  onTestFinished(() => { rmSync(repo, { recursive: true, force: true }) })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git('init', '-q')
  for (const owner of selectedOwners) {
    const dir = join(repo, 'snapshots/session', owner); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'snapshot.yml'), 'immutableInput: source-recording\n')
    writeFileSync(join(dir, 'session.v4.jsonl'), `input ${owner}\n`)
  }
  for (const owner of ['ptc-turn', 'persistent-tools']) {
    const sdk = join(repo, 'snapshots/sdk', owner); mkdirSync(sdk, { recursive: true })
    writeFileSync(join(sdk, 'snapshot.yml'), 'immutableInput: source-recording\n')
    writeFileSync(join(sdk, 'session.v4.jsonl'), `sdk input ${owner}\n`)
  }
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
  const evidence = join(repo, '.artifacts/evidence')
  return { repo, evidence }
}
function reports(evidence: string, selectedOwners = owners, sdkOwner = 'ptc-turn') {
  for (const [file, value] of [
    ['headless-refresh.json', report(selectedOwners, 'refresh')], ['headless-replay.json', report(selectedOwners, 'replay')],
    ['sdk-refresh.json', report([sdkOwner], 'refresh')], ['sdk-replay.json', report([sdkOwner], 'replay')],
    ['built-package-smoke.json', { status: 'success', errors: [], checks: [
      'built public package exports resolve from the Python runtime package', 'public built entrypoint and both packaged Python assets exist',
      'built package launches Python, returns a value, and permits workspace writes', 'built package denies writes outside its workspace',
      'built package denies direct writes under read-only policy',
    ] }],
  ] as const) writeFileSync(join(evidence, file), JSON.stringify(value))
}

describe('bounded integration snapshot lane', () => {
  const directoryOwners = ['compaction-output-reserve', 'compaction-summary-headroom', 'worktree', 'ptc-turn']

  it('bounds directory fixtures and the persistent SDK owner independently of primary checks', async () => {
    const { repo, evidence } = fixture(directoryOwners)
    await freezeSnapshotInputs(repo, evidence, 'directory-fixtures')
    reports(evidence, directoryOwners, 'persistent-tools')
    writeFileSync(join(repo, 'snapshots/session/worktree/writer.expected.jsonl'), 'current writer\n')
    writeFileSync(join(repo, 'snapshots/sdk/persistent-tools/writer.expected.jsonl'), 'SDK current writer\n')
    writeFileSync(join(repo, 'snapshots/sdk/persistent-tools/tool-schemas.expected.json'), '{}\n')
    const result = await captureIntegrationEvidence(repo, evidence, {
      freeze: 'success', headlessRefresh: 'success', headlessReplay: 'success',
      sdkRefresh: 'success', sdkReplay: 'success', pythonMetadata: 'skipped', builtPackageSmoke: 'skipped',
    }, 'directory-fixtures')
    expect(result.qualified).toBe(true)
    expect(result.selection).toBe('directory-fixtures')
    expect(Object.keys(result.ownerReports)).toEqual(['headless-refresh.json', 'headless-replay.json', 'sdk-refresh.json', 'sdk-replay.json'])
    expect(isAllowedOutput('snapshots/sdk/ptc-turn/writer.expected.jsonl', 'directory-fixtures')).toBe(false)
    expect(isAllowedOutput('snapshots/session/working-directory/writer.expected.jsonl', 'directory-fixtures')).toBe(false)
    expect(isAllowedOutput('snapshots/sdk/persistent-tools/session.v4.jsonl', 'directory-fixtures')).toBe(false)
    expect(isAllowedOutput('snapshots/sdk/persistent-tools/tool-schemas.expected.json', 'directory-fixtures')).toBe(true)
    for (const file of ['writer.1.expected.jsonl', 'system-prompt.1.expected.md', 'tool-schemas.1.expected.json']) {
      expect(isAllowedOutput(`snapshots/sdk/persistent-tools/${file}`, 'directory-fixtures')).toBe(false)
    }
  })

  it.each(['input', 'unselected output', 'numbered SDK output', 'missing owner', 'skipped owner', 'missing SDK owner', 'skipped SDK owner', 'skipped SDK step'] as const)('rejects directory fixture evidence with %s', async (failure) => {
    const { repo, evidence } = fixture(directoryOwners)
    await freezeSnapshotInputs(repo, evidence, 'directory-fixtures')
    reports(evidence, directoryOwners, 'persistent-tools')
    if (failure === 'input') writeFileSync(join(repo, 'snapshots/session/worktree/session.v4.jsonl'), 'changed')
    if (failure === 'unselected output') writeFileSync(join(repo, 'snapshots/sdk/ptc-turn/writer.expected.jsonl'), 'unselected')
    if (failure === 'numbered SDK output') writeFileSync(join(repo, 'snapshots/sdk/persistent-tools/writer.1.expected.jsonl'), 'unselected')
    if (failure === 'missing owner') writeFileSync(join(evidence, 'headless-replay.json'), JSON.stringify(report(directoryOwners.slice(1), 'replay')))
    if (failure === 'missing SDK owner') writeFileSync(join(evidence, 'sdk-replay.json'), JSON.stringify(report(['ptc-turn'], 'replay')))
    if (failure === 'skipped SDK owner') {
      const skipped = report(['persistent-tools'], 'replay')
      skipped.testResults[0]!.assertionResults[0]!.status = 'skipped'
      writeFileSync(join(evidence, 'sdk-replay.json'), JSON.stringify(skipped))
    }
    if (failure === 'skipped owner') {
      const skipped = report(directoryOwners, 'replay')
      skipped.testResults[0]!.assertionResults[0]!.status = 'skipped'
      writeFileSync(join(evidence, 'headless-replay.json'), JSON.stringify(skipped))
    }
    await expect(captureIntegrationEvidence(repo, evidence, {
      ...outcomes, ...failure === 'skipped SDK step' ? { sdkReplay: 'skipped' } : {},
    }, 'directory-fixtures')).rejects.toThrow()
    expect(JSON.parse(readFileSync(join(evidence, 'phase.json'), 'utf8'))).toMatchObject({ qualified: false })
  })

  it('rejects an unknown or changed selection instead of broadening output admission', async () => {
    expect(() => isAllowedOutput('snapshots/session/worktree/writer.expected.jsonl', 'unchecked')).toThrow('unknown integration')
    const { repo, evidence } = fixture(directoryOwners)
    await freezeSnapshotInputs(repo, evidence, 'directory-fixtures')
    await expect(captureIntegrationEvidence(repo, evidence, outcomes)).rejects.toThrow('selection changed after freeze')
  })

  it('selects Linux, four headless recordings and one SDK recording for the fixture diagnostic', () => {
    const workflow = load(readFileSync(join(root, '.github/workflows/ci-master.yml'), 'utf8')) as {
      jobs: Record<string, {
        strategy: { matrix: { include: string } }
        env: Record<string, string>
        steps: { name?: string; if?: string; run?: string }[]
      }>
    }
    const job = workflow.jobs['harnessy-integration-snapshot-verification']!
    const evaluate = (expression: string, suite: string): unknown => runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/gu, ''), { inputs: { suite }, fromJSON: JSON.parse }, { timeout: 1000 })
    const suite = 'harnessy-headless-fixture-verification'
    expect(evaluate(job.strategy.matrix.include, suite)).toEqual([{ platform: 'linux', runner: 'ubuntu-24.04' }])
    expect(evaluate(job.strategy.matrix.include, 'harnessy-integration-snapshot-verification')).toEqual([
      { platform: 'linux', runner: 'ubuntu-24.04' }, { platform: 'macos', runner: 'macos-latest' },
    ])
    expect(evaluate(job.env.HARNESSY_SNAPSHOT_SET!, suite)).toBe('directory-fixtures')
    const pattern = '(compaction-output-reserve|compaction-summary-headroom|worktree|ptc-turn) through dsh'
    for (const name of ['Refresh selected headless owners', 'Replay selected headless owners']) {
      expect(job.steps.find(step => step.name === name)?.run).toContain(pattern)
    }
    for (const name of ['Refresh selected SDK owner', 'Replay selected SDK owner']) {
      const step = job.steps.find(step => step.name === name)!
      expect(step.if).toBeUndefined()
      expect(step.run).toContain("'persistent-tools' || 'ptc-turn'")
    }
    for (const name of ['Check Python SDK PTC metadata', 'Smoke the built public Python runtime package']) {
      expect(evaluate(job.steps.find(step => step.name === name)!.if!, suite)).toBe(false)
    }
  })

  it('admits only named output files and no Session inputs', () => {
    expect(isAllowedOutput('snapshots/session/working-directory/writer.expected.jsonl')).toBe(true)
    expect(isAllowedOutput('snapshots/session/text-turn/system-prompt.expected.md')).toBe(true)
    expect(isAllowedOutput('snapshots/sdk/ptc-turn/notifications.current.expected.jsonl')).toBe(true)
    for (const path of ['snapshots/session/working-directory/session.v4.jsonl', 'snapshots/sdk/ptc-turn/session.v4.jsonl', 'snapshots/session/other/writer.expected.jsonl', 'snapshots/session/working-directory/other.yml']) expect(isAllowedOutput(path)).toBe(false)
  })
  it('requires one passed result for every selected owner and no extra passed test', () => {
    const valid = report(owners, 'refresh')
    expect(() => { checkOwnerReport(valid, owners, 'refresh') }).not.toThrow()
    const missing = report(owners.slice(1), 'refresh')
    expect(() => { checkOwnerReport(missing, owners, 'refresh') }).toThrow()
    valid.testResults[0]!.assertionResults[0]!.status = 'skipped'
    expect(() => { checkOwnerReport(valid, owners, 'refresh') }).toThrow()
  })
  it('freezes every Session input and captures only authorized outputs', async () => {
    const { repo, evidence } = fixture(); await freezeSnapshotInputs(repo, evidence); reports(evidence)
    const output = join(repo, 'snapshots/session/working-directory/writer.expected.jsonl')
    writeFileSync(output, 'writer\n')
    const result = await captureIntegrationEvidence(repo, evidence, outcomes)
    expect(result.qualified).toBe(true)
    expect(readFileSync(join(evidence, 'outputs/snapshots/session/working-directory/writer.expected.jsonl'), 'utf8')).toBe('writer\n')
  })
  it('freezes a tracked workspace link by its target without following it', async () => {
    const { repo, evidence } = fixture()
    const target = mkdtempSync(join(tmpdir(), 'integration-link-target-'))
    onTestFinished(() => { rmSync(target, { recursive: true, force: true }) })
    const link = join(repo, 'snapshots/session/working-directory/workspace')
    symlinkSync(target, link, 'junction')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    const path = 'snapshots/session/working-directory/workspace'
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: readlinkSync(link), encoding: 'utf8' }).trim()
    git('update-index', '--add', '--cacheinfo', `120000,${blob},${path}`)
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'workspace link')
    if (process.platform === 'win32') git('update-index', '--assume-unchanged', path)
    const state = await freezeSnapshotInputs(repo, evidence)
    expect(state.baseline['snapshots/session/working-directory/workspace']).toMatch(/^symlink:/u)
    reports(evidence)
    expect((await captureIntegrationEvidence(repo, evidence, outcomes)).qualified).toBe(true)
  })
  it.each(['input', 'ancestor'])('rejects a linked Session %s', async (kind) => {
    const { repo, evidence } = fixture()
    const owner = join(repo, 'snapshots/session/working-directory')
    const target = mkdtempSync(join(tmpdir(), 'integration-linked-session-'))
    onTestFinished(() => { rmSync(target, { recursive: true, force: true }) })
    if (kind === 'input') {
      rmSync(join(owner, 'session.v4.jsonl'))
      symlinkSync(target, join(owner, 'session.v4.jsonl'), 'junction')
    } else {
      const moved = join(target, 'owner')
      renameSync(owner, moved)
      symlinkSync(moved, owner, 'junction')
    }
    await expect(digestTracked(repo, 'snapshots/session/working-directory/session.v4.jsonl')).rejects.toThrow(kind === 'input' ? /Session input must be a regular file/u : /parent must be a real directory/u)
    await expect(freezeSnapshotInputs(repo, evidence)).rejects.toThrow()
  })

  it('rejects a tracked output link before refresh can write through it', async () => {
    const { repo, evidence } = fixture()
    const target = mkdtempSync(join(tmpdir(), 'integration-output-target-'))
    onTestFinished(() => { rmSync(target, { recursive: true, force: true }) })
    const path = 'snapshots/session/working-directory/writer.expected.jsonl'
    const link = join(repo, path)
    symlinkSync(target, link, 'junction')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: readlinkSync(link), encoding: 'utf8' }).trim()
    git('update-index', '--add', '--cacheinfo', `120000,${blob},${path}`)
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'output link')
    if (process.platform === 'win32') git('update-index', '--assume-unchanged', path)
    await expect(freezeSnapshotInputs(repo, evidence)).rejects.toThrow(/expected a regular output file/u)
  })

  it.each(['mutated input', 'new generation', 'unexpected source', 'skipped owner'])('rejects %s with evidence', async (failure) => {
    const { repo, evidence } = fixture(); await freezeSnapshotInputs(repo, evidence); reports(evidence)
    if (failure === 'mutated input') writeFileSync(join(repo, 'snapshots/session/working-directory/session.v4.jsonl'), 'changed')
    if (failure === 'new generation') writeFileSync(join(repo, 'snapshots/session/working-directory/session.v5.jsonl'), 'new')
    if (failure === 'unexpected source') writeFileSync(join(repo, 'snapshots/session/working-directory/snapshot.yml'), 'changed')
    if (failure === 'skipped owner') { const bad = report(owners, 'replay'); bad.testResults[0]!.assertionResults[0]!.status = 'skipped'; writeFileSync(join(evidence, 'headless-replay.json'), JSON.stringify(bad)) }
    await expect(captureIntegrationEvidence(repo, evidence, outcomes)).rejects.toThrow()
    expect(JSON.parse(readFileSync(join(evidence, 'phase.json'), 'utf8'))).toMatchObject({ qualified: false })
  })
  it('refuses to refresh an owner that does not preserve its source recording', async () => {
    const { repo, evidence } = fixture()
    writeFileSync(join(repo, 'snapshots/session/working-directory-admission/snapshot.yml'), 'version: 1\n')
    await expect(freezeSnapshotInputs(repo, evidence)).rejects.toThrow(/refresh must preserve its Session input/u)
  })
  it('keeps the workflow manual, serial, bounded, and uploads failure evidence', () => {
    const workflow = load(readFileSync(join(root, '.github/workflows/ci-master.yml'), 'utf8')) as { jobs: Record<string, { if: string; 'timeout-minutes': number; strategy: { 'max-parallel': number }; permissions: { contents: string }; steps: { name?: string; if?: string; env?: Record<string, string> }[] }> }
    const job = workflow.jobs['harnessy-integration-snapshot-verification']!
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'")
    expect(job.if).toContain("github.ref == 'refs/heads/staging'")
    expect(job.if).toContain("github.repository != 'deepseek-ai/deepseek-harness'")
    expect(job['timeout-minutes']).toBe(45); expect(job.strategy['max-parallel']).toBe(1)
    expect(job.permissions).toEqual({ contents: 'read' })
    const steps = job.steps
    expect(steps.find(step => step.name === 'Require Linux Landlock enforcement')?.env?.NALR_REQUIRE_LANDLOCK).toBe('1')
    expect(steps.find(step => step.name === 'Capture and verify integration evidence')?.if).toBe('always()')
    expect(steps.find(step => step.name === 'Retain integration snapshot evidence')?.if).toBe('always()')
    expect(steps.find(step => step.name === 'Refresh selected headless owners')?.env?.DSH_SNAPSHOT).toBe('refresh')
    expect(steps.find(step => step.name === 'Replay selected headless owners')?.env?.DSH_SNAPSHOT).toBe('replay')
  })
})
