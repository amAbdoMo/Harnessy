/** One-off native diagnostics require explicit staging selection and executed enforcement. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { describe, expect, it, onTestFinished } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const nativeJob = 'harnessy-native-verification'
const requiredEnforcementCases = [
  'denies direct Python writes under the standing read-only policy',
  'permits workspace writes while denying direct and symlink writes outside it',
  'boots under confinement with stdin EOF, fd-3 bindings, resource limits and a scrubbed environment',
  'retains the read-only policy in Python child processes',
  'reports CPU termination according to the selected launcher signal transport',
]

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Expected workflow mapping')
  return value as Record<string, unknown>
}

function workflow(): Record<string, unknown> {
  return record(load(readFileSync(join(root, '.github/workflows/ci-master.yml'), 'utf8')))
}

function job(): Record<string, unknown> {
  return record(record(workflow().jobs)[nativeJob])
}

function steps(): Record<string, unknown>[] {
  const value = job().steps
  if (!Array.isArray(value)) throw new TypeError('Native diagnostics steps are missing')
  return value.map(record)
}

function step(name: string): Record<string, unknown> {
  const value = steps().find(candidate => candidate.name === name)
  if (value === undefined) throw new Error(`Native diagnostics step missing: ${name}`)
  return value
}

function selected(value: unknown, event: string, ref: string, repository: string, suite: string, optIn?: string): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') throw new TypeError('Job selection must be explicit')
  return Boolean(runInNewContext(value, {
    github: { event_name: event, ref, repository }, inputs: { suite }, vars: { CUSTOM_HARNESS_RUN_UPSTREAM_CI: optIn },
  }, { timeout: 1000 }))
}

function reportFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'harnessy-native-report-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const artifacts = join(directory, '.artifacts/native-verification')
  mkdirSync(artifacts, { recursive: true })
  const script = step('Require actual policy enforcement cases').run
  if (typeof script !== 'string') throw new TypeError('Native report checker is missing')
  const match = script.match(/^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n?$/u)
  if (match?.[1] === undefined) throw new TypeError('Native report checker must be an executable Node heredoc')
  const checker = match[1]
  const report = {
    success: true, numFailedTests: 0,
    testResults: [{
      name: '/runner/work/repo/packages/experimental/ptc-runtime-python/tests/sandbox.spec.ts',
      assertionResults: requiredEnforcementCases.map(title => ({ title, status: 'passed' })),
    }],
  }
  const check = (value: typeof report) => {
    writeFileSync(join(artifacts, 'python-runtime.json'), JSON.stringify(value))
    return () => execFileSync(process.execPath, ['--input-type=module', '--eval', checker], {
      cwd: directory, encoding: 'utf8', stdio: 'pipe', timeout: 10_000,
    })
  }
  return { report, check }
}

describe('Manual Harnessy native diagnostics', () => {
  it.each([
    ['workflow_dispatch', 'refs/heads/staging', 'owner/HarnessY', nativeJob, true],
    ['workflow_dispatch', 'refs/heads/master', 'owner/HarnessY', nativeJob, false],
    ['push', 'refs/heads/staging', 'owner/HarnessY', nativeJob, false],
    ['pull_request', 'refs/heads/staging', 'owner/HarnessY', nativeJob, false],
    ['workflow_dispatch', 'refs/heads/staging', 'deepseek-ai/deepseek-harness', nativeJob, false],
    ['workflow_dispatch', 'refs/heads/staging', 'owner/HarnessY', 'larger-runner-benchmark', false],
    ['workflow_dispatch', 'refs/heads/staging', 'owner/HarnessY', 'consolidated-runner-benchmark', false],
  ] as const)('selects event %s, ref %s, repository %s, suite %s: %s', (event, ref, repository, suite, expected) => {
    for (const optIn of [undefined, 'false', 'true']) expect(selected(job().if, event, ref, repository, suite, optIn)).toBe(expected)
  })

  it('keeps inherited private jobs unselected for native diagnostics even with upstream opt-in', () => {
    const jobs = record(workflow().jobs)
    for (const optIn of [undefined, 'false', 'true']) {
      for (const [name, value] of Object.entries(jobs)) {
        if (name === nativeJob) continue
        expect(selected(record(value).if, 'workflow_dispatch', 'refs/heads/staging', 'owner/HarnessY', nativeJob, optIn), name).toBe(false)
      }
    }
    const options = record(record(record(record(workflow().on).workflow_dispatch).inputs).suite).options
    expect(options).toEqual(['larger-runner-benchmark', 'consolidated-runner-benchmark', nativeJob, 'harnessy-integration-snapshot-verification'])
  })

  it('bounds standard hosted runs and retains read-only access without product credentials', () => {
    const native = job()
    expect(native).toMatchObject({
      'runs-on': '${{ matrix.runner }}', 'timeout-minutes': 45, permissions: { contents: 'read' },
      defaults: { run: { shell: 'bash' } },
      strategy: { 'fail-fast': false, 'max-parallel': 1, matrix: { include: [
        { platform: 'linux', runner: 'ubuntu-24.04' }, { platform: 'macos', runner: 'macos-latest' },
      ] } },
    })
    expect(native).not.toHaveProperty('secrets')
    expect(native).not.toHaveProperty('continue-on-error')
    const checkout = steps().find(candidate => candidate.uses === 'actions/checkout@v6')
    expect(checkout).toMatchObject({ with: { 'persist-credentials': false } })
    expect(step('Install immutable dependencies').run).toBe('pnpm install --frozen-lockfile')
    const commands = steps().map(candidate => candidate.run).filter((value): value is string => typeof value === 'string').join('\n')
    expect(commands).not.toMatch(/prepare-ci-bubblewrap|sysctl|apparmor_restrict|--privileged|DSH_SNAPSHOT=refresh/u)
    expect(steps().every(candidate => candidate['continue-on-error'] !== true)).toBe(true)
  })

  it('requires real confinement results after native construction and preserves failure evidence', () => {
    const values = steps()
    const index = (name: string) => values.findIndex(candidate => candidate.name === name)
    expect(index('Build host native system payload')).toBeGreaterThan(index('Install immutable dependencies'))
    expect(index('Exercise real Python runtime and confinement owners')).toBeGreaterThan(index('Build host native system payload'))
    expect(index('Require actual policy enforcement cases')).toBeGreaterThan(index('Exercise real Python runtime and confinement owners'))
    expect(step('Require Linux Landlock enforcement')).toMatchObject({
      if: "runner.os == 'Linux'", env: { NALR_REQUIRE_LANDLOCK: '1' }, run: 'node test/launcher.test.js',
    })
    expect(step('Exercise real Python runtime and confinement owners').run).toContain('packages/experimental/ptc-runtime-python/tests')
    expect(step('Compile optional Mac Computer Use helper')).toMatchObject({
      if: "${{ !cancelled() && runner.os == 'macOS' }}", run: 'swift build --package-path packages/experimental/cua-macos/native --configuration release',
    })
    expect(step('Run offline Swift native unit owners')).toMatchObject({
      if: "${{ !cancelled() && runner.os == 'macOS' }}", run: 'python3 packages/experimental/cua-macos/native/tests/test_swift.py',
    })
    expect(step('Retain native verification reports')).toMatchObject({
      if: 'always()', uses: 'actions/upload-artifact@v4', with: { path: '.artifacts/native-verification/', 'retention-days': 7 },
    })
  })

  it('accepts a native report with every required enforcement case executed', () => {
    const { report, check } = reportFixture()
    expect(check(report)()).toContain('Required real sandbox cases passed')
  })

  it.each(['pending', 'skipped', 'todo', 'failed'])('rejects a native report whose enforcement case is %s', (status) => {
    const { report, check } = reportFixture()
    report.testResults[0]!.assertionResults[0]!.status = status
    expect(check(report)).toThrow()
  })

  it.each(['missing case', 'duplicate case', 'missing suite', 'duplicate suite', 'overall error', 'sibling failure'])('rejects native evidence with %s', (failure) => {
    const { report, check } = reportFixture()
    const suite = report.testResults[0]!
    switch (failure) {
      case 'missing case': suite.assertionResults.pop(); break
      case 'duplicate case': suite.assertionResults.push(suite.assertionResults[0]!); break
      case 'missing suite': report.testResults = []; break
      case 'duplicate suite': report.testResults.push(suite); break
      case 'overall error': report.success = false; break
      case 'sibling failure': report.numFailedTests = 1; break
    }
    expect(check(report)).toThrow()
  })
})
