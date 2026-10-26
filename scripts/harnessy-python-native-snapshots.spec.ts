import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'
import { assertNativeBuiltSmokeReport, assertSnapshotRunnerReport, captureSnapshotOutputs, prepareSnapshotInputs, requireManualStagingCi, restoreSnapshotInputs } from './harnessy-python-native-snapshots.mjs'

const root = resolve(import.meta.dirname, '..')
const fixtures: string[] = []
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Expected workflow mapping')
  return value as Record<string, unknown>
}
function fixture() { const path = mkdtempSync(join(tmpdir(), 'python-native-phase-')); fixtures.push(path); return path }
afterEach(() => { for (const path of fixtures.splice(0)) removeFixtureSafely(path) })
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function git(rootPath: string, ...args: string[]) { execFileSync('git', args, { cwd: rootPath, stdio: 'ignore' }) }
function runnerReport(mode: 'refresh' | 'replay') {
  const verb = mode === 'refresh' ? 'refreshs' : 'replays'
  return Buffer.from(JSON.stringify({
    success: true,
    numPassedTests: 2,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numPendingTests: 1,
    testResults: [{ assertionResults: [
      { fullName: `${verb} ptc-python-turn through dsh`, title: `${verb} ptc-python-turn through dsh`, status: 'passed' },
      { fullName: `${verb} ptc-python-read-only through dsh`, title: `${verb} ptc-python-read-only through dsh`, status: 'passed' },
      { fullName: 'unselected unrelated test', title: 'unselected unrelated test', status: 'skipped' },
    ] }],
  }))
}
function builtSmokeReport(status = 'success') {
  return Buffer.from(JSON.stringify({ status, checks: [
    'built public package exports resolve from the Python runtime package',
    'public built entrypoint and both packaged Python assets exist',
    'built package launches Python, returns a value, and permits workspace writes',
    'built package denies writes outside its workspace',
    'built package denies direct writes under read-only policy',
  ], errors: [] }))
}

function harnessFixture() {
  const base = fixture()
  const repo = join(base, 'fake-repo')
  mkdirSync(repo)
  git(repo, 'init', '-q')
  const turn = join(repo, 'snapshots/session/ptc-python-turn')
  mkdirSync(turn, { recursive: true })
  const originalManifest = Buffer.from('version: 1\nprofile: headless\ncomposition: ptc-python\nrecording: authored\nplatform: posix\nheader:\n  class: ptc-python\n  pin: true\n')
  writeFileSync(join(turn, 'snapshot.yml'), originalManifest)
  writeFileSync(join(turn, 'session.v2.jsonl'), '{"type":"session","version":2}\n')
  writeFileSync(join(turn, 'system-prompt.expected.md'), 'prior prompt\n')
  writeFileSync(join(turn, 'tool-schemas.expected.json'), '{}\n')
  const turnSession = Buffer.from('{"type":"session","version":4}\n{"type":"message"}\n')
  const readOnlySession = Buffer.from('{"type":"session","version":4}\n{"type":"message"}\n')
  const readOnlyManifest = Buffer.from('version: 1\nprofile: headless\ncomposition: ptc-python\nrecording: authored\nplatform: posix\npermission: read-only\nworkspace:\n  final: true\n  parent: outside-temp\nheader:\n  class: ptc-python\n')
  const sources = new Map([
    ['snapshots/session/ptc-python-turn/session.v4.jsonl', turnSession],
    ['snapshots/session/ptc-python-turn/snapshot.yml', originalManifest],
    ['snapshots/session/ptc-python-read-only/session.v4.jsonl', readOnlySession],
    ['snapshots/session/ptc-python-read-only/snapshot.yml', readOnlyManifest],
    ['snapshots/session/ptc-python-read-only/workspace.expected/.empty', Buffer.alloc(0)],
  ])
  for (const [path, bytes] of sources) {
    const target = join(repo, path)
    if (path === 'snapshots/session/ptc-python-turn/snapshot.yml') {
      mkdirSync(resolve(target, '..'), { recursive: true })
      writeFileSync(target, bytes)
    }
  }
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const sourceHashes = new Map([...sources].map(([path, bytes]) => [path, hash(bytes)]))
  return { repo, sourceCommit, sources, sourceHashes, originalManifest }
}

describe('manual Python native snapshot phase', () => {
  it('rejects local and non-staging invocations before any preparation', () => {
    expect(() => { requireManualStagingCi({}) }).toThrow(/only from the explicitly marked GitHub Actions phase/u)
    expect(() => {
      requireManualStagingCi({
        GITHUB_ACTIONS: 'true', DSH_PYTHON_NATIVE_SNAPSHOT_PHASE: '1', GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/staging', GITHUB_REPOSITORY: 'owner/HarnessY', RUNNER_OS: 'Linux',
      })
    }).toThrow(/manual staging workflow/u)
  })

  it('checks the built smoke program against CPython async-wrapper return semantics', () => {
    const python = process.env.DSH_TEST_PYTHON ?? (process.platform === 'win32'
      ? join(root, '.artifacts/codex-fast-python-env/Scripts/python.exe') : 'python3')
    if (process.platform === 'win32' && !existsSync(python)) throw new Error(`CPython fixture interpreter is missing: ${python}`)
    const bootstrap = readFileSync(join(root, 'packages/experimental/ptc-runtime-python/py/bootstrap.py'), 'utf8')
    expect(bootstrap).toContain('body=module.body or [ast.Pass()]')
    const check = [
      'import ast, asyncio',
      'program = "print(\\\'built-python-ok\\\')\\nreturn 42"',
      'module = ast.parse(program, filename="<model>")',
      'wrapper = ast.AsyncFunctionDef(name="__dsh_main__", args=ast.arguments(posonlyargs=[], args=[], vararg=None, kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[]), body=module.body or [ast.Pass()], decorator_list=[], returns=None)',
      'ast.copy_location(wrapper, module.body[0])',
      'wrapped = ast.Module(body=[wrapper], type_ignores=[])',
      'ast.fix_missing_locations(wrapped)',
      'scope = {}',
      'exec(compile(wrapped, "<model>", "exec", dont_inherit=True), scope)',
      'assert asyncio.run(scope["__dsh_main__"]()) == 42',
    ].join('\n')
    expect(execFileSync(python, ['-c', check], { encoding: 'utf8' })).toContain('built-python-ok')
  })

  it('stages pinned bytes, captures refresh outputs, and restores every existing generation and sidecar', async () => {
    const { repo, sourceCommit, sources, sourceHashes, originalManifest } = harnessFixture()
    const phaseRoot = join(repo, '.artifacts/python-native-snapshot-phase-ci/linux')
    const options = { repoRoot: repo, phaseRoot, platform: 'linux' as const, sourceCommit, expectedCommit: sourceCommit, sourceHashes, turnManifestHash: hash(originalManifest), readBlob: async (_commit: string, path: string) => sources.get(path)! }
    await prepareSnapshotInputs(options)
    expect(readFileSync(join(repo, 'snapshots/session/ptc-python-turn/session.v4.jsonl'))).toEqual(sources.get('snapshots/session/ptc-python-turn/session.v4.jsonl'))
    writeFileSync(join(repo, 'snapshots/session/ptc-python-turn/writer.expected.jsonl'), 'writer\n')
    writeFileSync(join(repo, 'snapshots/session/ptc-python-read-only/writer.expected.jsonl'), 'writer\n')
    mkdirSync(join(phaseRoot, 'evidence'), { recursive: true })
    writeFileSync(join(phaseRoot, 'evidence/snapshot-refresh.json'), runnerReport('refresh'))
    writeFileSync(join(phaseRoot, 'evidence/snapshot-replay.json'), runnerReport('replay'))
    writeFileSync(join(phaseRoot, 'evidence/built-package-smoke.json'), builtSmokeReport())
    const capture = await captureSnapshotOutputs({ ...options, readBlob: async (_commit: string, path: string) => sources.get(path)!, outcomes: { refresh: 'success', replay: 'failure', builtPackageSmoke: 'success' } })
    expect(capture.qualified).toBe(false)
    await restoreSnapshotInputs(options)
    expect(readFileSync(join(repo, 'snapshots/session/ptc-python-turn/session.v2.jsonl'), 'utf8')).toBe('{"type":"session","version":2}\n')
    expect(readFileSync(join(repo, 'snapshots/session/ptc-python-turn/system-prompt.expected.md'), 'utf8')).toBe('prior prompt\n')
    expect(readFileSync(join(repo, 'snapshots/session/ptc-python-turn/snapshot.yml'))).toEqual(originalManifest)
    expect(() => readFileSync(join(repo, 'snapshots/session/ptc-python-read-only'))).toThrow()
  })

  it('does not overwrite an unexpected mutation during restore', async () => {
    const { repo, sourceCommit, sources, sourceHashes, originalManifest } = harnessFixture()
    const options = { repoRoot: repo, phaseRoot: join(repo, '.artifacts/python-native-snapshot-phase-ci/linux'), platform: 'linux' as const, sourceCommit, expectedCommit: sourceCommit, sourceHashes, turnManifestHash: hash(originalManifest), readBlob: async (_commit: string, path: string) => sources.get(path)! }
    await prepareSnapshotInputs(options)
    writeFileSync(join(repo, 'snapshots/session/ptc-python-turn/session.v4.jsonl'), 'unexpected')
    writeFileSync(join(repo, 'snapshots/session/ptc-python-turn/session.v2.jsonl'), 'changed frozen generation')
    await expect(restoreSnapshotInputs(options)).rejects.toThrow(/changed after capture/u)
    expect(readFileSync(join(repo, 'snapshots/session/ptc-python-turn/session.v4.jsonl'), 'utf8')).toBe('unexpected')
    expect(readFileSync(join(repo, 'snapshots/session/ptc-python-turn/session.v2.jsonl'), 'utf8')).toBe('changed frozen generation')
  })

  it('restores staged files after interruption before the capture step', async () => {
    const { repo, sourceCommit, sources, sourceHashes, originalManifest } = harnessFixture()
    const options = { repoRoot: repo, phaseRoot: join(repo, '.artifacts/python-native-snapshot-phase-ci/linux'), platform: 'linux' as const, sourceCommit, expectedCommit: sourceCommit, sourceHashes, turnManifestHash: hash(originalManifest), readBlob: async (_commit: string, path: string) => sources.get(path)! }
    await prepareSnapshotInputs(options)
    await restoreSnapshotInputs(options)
    expect(readFileSync(join(repo, 'snapshots/session/ptc-python-turn/snapshot.yml'))).toEqual(originalManifest)
    expect(() => readFileSync(join(repo, 'snapshots/session/ptc-python-read-only'))).toThrow()
  })

  it('ignores a legal unrelated workspace directory junction while freezing tracked generations', async () => {
    const { repo, sourceCommit, sources, sourceHashes, originalManifest } = harnessFixture()
    const target = join(fixture(), 'workspace-target')
    mkdirSync(target)
    const unrelatedWorkspace = join(repo, 'snapshots/session/unrelated/workspace')
    mkdirSync(resolve(unrelatedWorkspace, '..'), { recursive: true })
    symlinkSync(target, unrelatedWorkspace, 'junction')
    const options = { repoRoot: repo, phaseRoot: join(repo, '.artifacts/python-native-snapshot-phase-ci/linux'), platform: 'linux' as const, sourceCommit, expectedCommit: sourceCommit, sourceHashes, turnManifestHash: hash(originalManifest), readBlob: async (_commit: string, path: string) => sources.get(path)! }
    await prepareSnapshotInputs(options)
    await restoreSnapshotInputs(options)
    expect(readFileSync(join(repo, 'snapshots/session/ptc-python-turn/session.v2.jsonl'), 'utf8')).toBe('{"type":"session","version":2}\n')
  })

  it('does not qualify layout-only package evidence as a native smoke success', async () => {
    const { repo, sourceCommit, sources, sourceHashes, originalManifest } = harnessFixture()
    const options = { repoRoot: repo, phaseRoot: join(repo, '.artifacts/python-native-snapshot-phase-ci/linux'), platform: 'linux' as const, sourceCommit, expectedCommit: sourceCommit, sourceHashes, turnManifestHash: hash(originalManifest), readBlob: async (_commit: string, path: string) => sources.get(path)! }
    await prepareSnapshotInputs(options)
    mkdirSync(join(options.phaseRoot, 'evidence'), { recursive: true })
    writeFileSync(join(options.phaseRoot, 'evidence/snapshot-refresh.json'), runnerReport('refresh'))
    writeFileSync(join(options.phaseRoot, 'evidence/snapshot-replay.json'), runnerReport('replay'))
    writeFileSync(join(options.phaseRoot, 'evidence/built-package-smoke.json'), builtSmokeReport('layout-only-success'))
    expect(() => assertNativeBuiltSmokeReport(builtSmokeReport('layout-only-success'))).toThrow(/status must be success/u)
    await expect(captureSnapshotOutputs({ ...options, readBlob: async (_commit: string, path: string) => sources.get(path)!, outcomes: { refresh: 'success', replay: 'success', builtPackageSmoke: 'success' } })).rejects.toThrow(/status must be success/u)
  })

  it('rejects a changed immutable input and refuses to delete it during restoration', async () => {
    const { repo, sourceCommit, sources, sourceHashes, originalManifest } = harnessFixture()
    const options = { repoRoot: repo, phaseRoot: join(repo, '.artifacts/python-native-snapshot-phase-ci/linux'), platform: 'linux' as const, sourceCommit, expectedCommit: sourceCommit, sourceHashes, turnManifestHash: hash(originalManifest), readBlob: async (_commit: string, path: string) => sources.get(path)! }
    await prepareSnapshotInputs(options)
    const input = join(repo, 'snapshots/session/ptc-python-turn/session.v4.jsonl')
    writeFileSync(input, 'changed-input')
    mkdirSync(join(options.phaseRoot, 'evidence'), { recursive: true })
    writeFileSync(join(options.phaseRoot, 'evidence/snapshot-refresh.json'), runnerReport('refresh'))
    writeFileSync(join(options.phaseRoot, 'evidence/snapshot-replay.json'), runnerReport('replay'))
    writeFileSync(join(options.phaseRoot, 'evidence/built-package-smoke.json'), builtSmokeReport())
    await expect(captureSnapshotOutputs({ ...options, readBlob: async (_commit: string, path: string) => sources.get(path)!, outcomes: { refresh: 'success', replay: 'success', builtPackageSmoke: 'success' } })).rejects.toThrow(/immutable input bytes changed/u)
    await expect(restoreSnapshotInputs(options)).rejects.toThrow(/changed after capture/u)
    expect(readFileSync(input, 'utf8')).toBe('changed-input')
  })

  it('refuses linked committed generations and rejects empty-green or skipped-owner reports', async () => {
    const { repo, sourceCommit, sources, sourceHashes, originalManifest } = harnessFixture()
    const owner = join(repo, 'snapshots/session/ptc-python-turn')
    const target = join(fixture(), 'linked-dir')
    mkdirSync(target)
    rmSync(join(owner, 'session.v2.jsonl'))
    symlinkSync(target, join(owner, 'session.v2.jsonl'), 'junction')
    const options = { repoRoot: repo, phaseRoot: join(repo, '.artifacts/python-native-snapshot-phase-ci/linux'), platform: 'linux' as const, sourceCommit, expectedCommit: sourceCommit, sourceHashes, turnManifestHash: hash(originalManifest), readBlob: async (_commit: string, path: string) => sources.get(path)! }
    await expect(prepareSnapshotInputs(options)).rejects.toThrow(/tracked Session generation.*link/u)
    expect(() => {
      assertSnapshotRunnerReport(Buffer.from(JSON.stringify({
        success: true, numPassedTests: 0, numFailedTests: 0, numFailedTestSuites: 0, testResults: [],
      })), 'replay')
    }).toThrow(/two passed tests/u)
    expect(() => {
      assertSnapshotRunnerReport(Buffer.from(JSON.stringify({
        success: true, numPassedTests: 2, numFailedTests: 0, numFailedTestSuites: 0,
        testResults: [{ assertionResults: [
          { title: 'replays ptc-python-turn', status: 'passed' },
          { title: 'replays ptc-python-read-only', status: 'skipped' },
        ] }],
      })), 'replay')
    }).toThrow(/exactly one passed ptc-python-read-only/u)
    expect(() => { assertSnapshotRunnerReport(runnerReport('replay'), 'replay') }).not.toThrow()
  })

  it('selects only the explicit manual staging fork job and separates refresh from replay', () => {
    const workflow = record(load(readFileSync(join(root, '.github/workflows/ci-master.yml'), 'utf8')))
    const job = record(record(workflow.jobs)['harnessy-python-snapshot-verification'])
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'")
    expect(job.if).toContain("github.ref == 'refs/heads/staging'")
    expect(record(job.strategy)['max-parallel']).toBe(1)
    expect(job['timeout-minutes']).toBe(45)
    expect(job.permissions).toEqual({ contents: 'read' })
    const steps = job.steps as Record<string, unknown>[]
    const names = steps.map(step => step.name)
    expect(names.indexOf('Refresh the Python snapshot owners')).toBeLessThan(names.indexOf('Replay the Python snapshot owners read-only'))
    expect(record(steps.find(step => step.name === 'Refresh the Python snapshot owners')?.env).DSH_SNAPSHOT).toBe('refresh')
    expect(steps.find(step => step.name === 'Replay the Python snapshot owners read-only')?.env).toBeUndefined()
    expect(JSON.stringify(job)).not.toMatch(/ptc-runtime-python\/tests|swift build|cua-macos/u)
  })
})
