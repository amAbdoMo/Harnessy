/** Exact selections and frozen source bytes gate the manual cohort diagnostic. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { describe, expect, it, onTestFinished } from 'vitest'
import { checkCohortFiles, checkCohortInventory, checkCohortReport, freezeCohort, runCohortRefreshes, type CohortRefreshOutcome, type CohortReport } from './harnessy-directory-cohort.mjs'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

const root = resolve(import.meta.dirname, '..')
const file = 'snapshots/session/headless.snapshot.ts'
const name = 'headless > replays text-turn through dsh --profile headless'
const selected = [{ file, name }]
const report = (status = 'passed'): CohortReport => ({
  success: true, numFailedTests: 0, numFailedTestSuites: 0,
  testResults: [{ name: `${root}/${file}`, assertionResults: [
    { fullName: name.replace(' > ', ' '), status },
    { fullName: 'unselected ancillary case', status: 'skipped' },
  ] }],
})

function git(repo: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
}

function fixture(): string {
  const repo = mkdtempSync(join(tmpdir(), 'directory-cohort-guard-'))
  onTestFinished(() => { removeFixtureSafely(repo) })
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  git(repo, 'config', 'user.name', 'Fixture')
  mkdirSync(join(repo, 'snapshots/session/text-turn/workspace.expected'), { recursive: true })
  mkdirSync(join(repo, 'scripts/executable-goldens'), { recursive: true })
  writeFileSync(join(repo, '.gitignore'), '.artifacts/\n')
  writeFileSync(join(repo, 'source.ts'), 'export const source = 1\n')
  writeFileSync(join(repo, 'snapshots/session/text-turn/session.v1.jsonl'), '{"type":"session","version":1}\n')
  writeFileSync(join(repo, 'scripts/executable-goldens/session.v4.jsonl'), '{"type":"session","version":4}\n')
  writeFileSync(join(repo, 'snapshots/session/text-turn/workspace.expected/result.txt'), 'independent oracle\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'fixture')
  return repo
}

describe('directory cohort qualification', () => {
  it('joins list hierarchy names to JSON assertion names and tolerates unselected skips', () => {
    const ids = checkCohortInventory(root, [{ file: `${root}/${file}`, name }], selected)
    expect(() => { checkCohortReport(root, report(), ids) }).not.toThrow()
  })

  it.each(['empty', 'missing', 'duplicate', 'extra'] as const)('rejects %s selected inventories', (variant) => {
    const entry = selected[0]!
    const list = variant === 'empty' || variant === 'missing' ? []
      : variant === 'duplicate' ? [entry, entry] : [entry, { file, name: 'extra case' }]
    expect(() => checkCohortInventory(root, list, variant === 'empty' ? [] : selected)).toThrow()
  })

  it.each(['skipped', 'pending', 'failed', 'missing', 'duplicate', 'extra'] as const)('rejects %s selected results', (variant) => {
    const ids = checkCohortInventory(root, selected, selected)
    const result = report(variant)
    const assertions = result.testResults[0]!.assertionResults
    const changed: CohortReport = variant === 'missing' ? { ...result, testResults: [] }
      : variant === 'duplicate' ? { ...report(), testResults: [...report().testResults, ...report().testResults] }
        : variant === 'extra' ? { ...result, testResults: [{ name: `${root}/${file}`, assertionResults: [...report().testResults[0]!.assertionResults, { fullName: 'extra executed case', status: 'passed' }] }] }
          : { ...result, testResults: [{ name: `${root}/${file}`, assertionResults: assertions }] }
    expect(() => { checkCohortReport(root, changed, ids) }).toThrow()
  })

  it('captures exact new writer outputs while freezing Session inputs outside snapshots too', async () => {
    const repo = fixture()
    const baseline = await freezeCohort(repo, join(repo, '.artifacts/evidence'))
    expect(Object.keys(baseline.sessionInputs)).toHaveLength(2)
    const writer = 'snapshots/session/text-turn/writer.expected.jsonl'
    writeFileSync(join(repo, writer), 'current writer\n')
    const observed = await checkCohortFiles(repo, baseline, [writer])
    expect(Object.keys(observed.outputs)).toEqual([writer])
    expect(observed.sessionInputs['scripts/executable-goldens/session.v4.jsonl']?.before)
      .toBe(observed.sessionInputs['scripts/executable-goldens/session.v4.jsonl']?.after)
  })

  it.each([
    'snapshots/session/text-turn/session.v1.jsonl',
    'scripts/executable-goldens/session.v4.jsonl',
    'snapshots/session/text-turn/workspace.expected/result.txt',
    'snapshots/session/text-turn/writer.99.expected.jsonl',
    'unexpected.expected.md',
    'source.ts',
  ])('rejects changes to protected or unowned path %s', async (path) => {
    const repo = fixture()
    const baseline = await freezeCohort(repo, join(repo, '.artifacts/evidence'))
    writeFileSync(join(repo, path), 'mutation\n')
    await expect(checkCohortFiles(repo, baseline, ['snapshots/session/text-turn/writer.expected.jsonl'])).rejects.toThrow()
  })

  it('refuses Session and workspace paths even when an allowlist mistakenly includes them', async () => {
    const repo = fixture()
    const baseline = await freezeCohort(repo, join(repo, '.artifacts/evidence'))
    for (const path of ['snapshots/session/text-turn/session.v1.jsonl', 'snapshots/session/text-turn/workspace.expected/result.txt']) {
      await expect(checkCohortFiles(repo, baseline, [path])).rejects.toThrow('forbidden writable input')
    }
  })

  it('rejects a changed source revision even when its tracked bytes remain unchanged', async () => {
    const repo = fixture()
    const baseline = await freezeCohort(repo, join(repo, '.artifacts/evidence'))
    git(repo, 'commit', '--allow-empty', '-qm', 'revision change')
    await expect(checkCohortFiles(repo, baseline, [])).rejects.toThrow('source HEAD changed')
  })

  it('collects independent refresh failures and retains the successful phase between them', async () => {
    const repo = fixture()
    const baseline = await freezeCohort(repo, join(repo, '.artifacts/evidence'))
    const writer = 'snapshots/session/text-turn/writer.expected.jsonl'
    const executed: string[] = []
    const outcomes: Array<{ id: string; state: CohortRefreshOutcome }> = []
    const verifyFiles = () => checkCohortFiles(repo, baseline, [writer])
    const errors = await runCohortRefreshes([{ id: 'headless' }, { id: 'sdk' }, { id: 'web' }], async (phase) => {
      executed.push(phase.id)
      if (phase.id === 'headless') {
        writeFileSync(join(repo, writer), 'partial allowed output\n')
        throw new Error('recording assertion failed')
      }
      if (phase.id === 'web') throw new Error('browser assertion failed')
      return { selected: ['sdk case'], ...await verifyFiles() }
    }, verifyFiles, async (id, state) => { outcomes.push({ id, state }) })
    expect(executed).toEqual(['headless', 'sdk', 'web'])
    expect(errors).toEqual(['headless: Error: recording assertion failed', 'web: Error: browser assertion failed'])
    expect(outcomes.map(({ id, state }) => `${id}:${state.outcome}`))
      .toEqual(['headless:running', 'headless:failure', 'sdk:running', 'sdk:success', 'web:running', 'web:failure'])
    expect(outcomes.find(({ state }) => state.outcome === 'success')?.state)
      .toMatchObject({ selected: ['sdk case'], outputs: { [writer]: { before: null } } })
  })

  it.each([
    'snapshots/session/text-turn/session.v1.jsonl',
    'source.ts',
    'unexpected.expected.md',
  ])('stops after a rejected refresh mutates protected or unowned %s', async (path) => {
    const repo = fixture()
    const baseline = await freezeCohort(repo, join(repo, '.artifacts/evidence'))
    const executed: string[] = []
    const outcomes: CohortRefreshOutcome[] = []
    await expect(runCohortRefreshes([{ id: 'headless' }, { id: 'sdk' }], async (phase) => {
      executed.push(phase.id)
      writeFileSync(join(repo, path), 'mutation before nonzero test exit\n')
      throw new Error('test process exited nonzero')
    }, () => checkCohortFiles(repo, baseline, []), async (_id, state) => { outcomes.push(state) }))
      .rejects.toThrow(path.includes('session.v1') ? 'protected Session input changed' : 'unexpected source or output change')
    expect(executed).toEqual(['headless'])
    expect(outcomes).toEqual([{ outcome: 'running' }])
  })

  it('keeps the workflow manual, Linux-only and bounded to one 90-minute job', () => {
    const workflow = load(readFileSync(join(root, '.github/workflows/ci-master.yml'), 'utf8')) as {
      jobs: Record<string, {
        if: string
        'runs-on': string
        'timeout-minutes': number
        permissions: object
        steps: Array<{ uses?: string; with?: Record<string, unknown>; run?: string }>
      }>
    }
    const job = workflow.jobs['harnessy-directory-cohort-verification']!
    for (const [event, ref, repository, suite, allowed] of [
      ['workflow_dispatch', 'refs/heads/staging', 'fork/Harnessy', 'harnessy-directory-cohort-verification', true],
      ['push', 'refs/heads/staging', 'fork/Harnessy', 'harnessy-directory-cohort-verification', false],
      ['workflow_dispatch', 'refs/heads/master', 'fork/Harnessy', 'harnessy-directory-cohort-verification', false],
      ['workflow_dispatch', 'refs/heads/staging', 'deepseek-ai/deepseek-harness', 'harnessy-directory-cohort-verification', false],
      ['workflow_dispatch', 'refs/heads/staging', 'fork/Harnessy', 'harnessy-native-verification', false],
    ] as const) {
      const context = { github: { event_name: event, ref, repository }, inputs: { suite } }
      expect(runInNewContext(job.if, context, { timeout: 1000 })).toBe(allowed)
    }
    expect(job['runs-on']).toBe('ubuntu-24.04')
    expect(job['timeout-minutes']).toBe(90)
    expect(job.permissions).toEqual({ contents: 'read' })
    expect(job.steps.filter(step => step.uses?.startsWith('actions/checkout@'))[0]?.with?.['persist-credentials']).toBe(false)
    const artifact = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))
    expect(artifact?.with?.['retention-days']).toBe(7)
    const commands = job.steps.map(step => step.run ?? '').join('\n')
    expect(commands).not.toMatch(/build:desktop|release|workflow run|test:coverage/u)
    expect(commands.match(/pnpm run build:web/gu)).toHaveLength(1)
  })
})
