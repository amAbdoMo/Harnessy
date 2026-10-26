import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { CLIENT_BUILD_RECORD_PATH, readClientBuildRecord } from './client-build-environment.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

const root = resolve(import.meta.dirname, '..')

function buildFixture(flags: string[], failStage?: string) {
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-build-cli-'))
  onTestFinished(() => { removeFixtureSafely(fixture) })
  mkdirSync(join(fixture, 'scripts'))
  for (const file of ['build.ts', 'client-build-environment.ts', 'custom-harness-product.ts', 'custom-harness-product.mjs', 'pnpm-invocation.ts']) {
    copyFileSync(join(root, 'scripts', file), join(fixture, 'scripts', file))
  }
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module', version: '1.2.3' }))
  mkdirSync(join(fixture, '.dsh-build'))
  writeFileSync(join(fixture, CLIENT_BUILD_RECORD_PATH), 'stale build record\n')
  const entrypoint = join(fixture, 'pnpm.cjs')
  writeFileSync(entrypoint, [
    "const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs')",
    "const { join } = require('node:path')",
    'const args = process.argv.slice(2)',
    `appendFileSync('commands.jsonl', JSON.stringify({ args, title: process.env.DSH_CLIENT_TITLE, profile: process.env.DSH_CLIENT_BUILD_PROFILE, staleRecord: existsSync(${JSON.stringify(CLIENT_BUILD_RECORD_PATH)}) }) + '\\n')`,
    'if (args.join(" ") === process.env.DSH_BUILD_FIXTURE_FAIL) process.exit(7)',
    "if (args.join(' ') === 'run build:web') { mkdirSync('apps/web/dist', { recursive: true }); writeFileSync(join('apps/web/dist', 'index.html'), '<main>fixture</main>') }",
    '',
  ].join('\n'))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.toUpperCase().startsWith('DSH_CLIENT_') && !['DSH_BUILD_CLIENT_PROFILE', 'NPM_EXECPATH'].includes(key.toUpperCase())))
  const result = spawnSync(process.execPath, [join(fixture, 'scripts/build.ts'), '--profile', 'custom-harness', ...flags], {
    cwd: fixture,
    encoding: 'utf8',
    env: { ...environment, npm_execpath: entrypoint, DSH_CLIENT_COMMIT_HASH: 'abcdef0', DSH_BUILD_FIXTURE_FAIL: failStage },
  })
  const commands = readFileSync(join(fixture, 'commands.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { args: string[]; title: string; profile: string; staleRecord: boolean })
  return { fixture, result, commands }
}

describe('repository build CLI', () => {
  it.each([false, true])('preserves native/library/Web order and the custom profile with artifactsOnly=%s', (artifactsOnly) => {
    const { fixture, result, commands } = buildFixture(artifactsOnly ? ['--artifacts-only'] : [])

    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(commands).toEqual([
      ['run', 'build:native-system'],
      artifactsOnly ? ['exec', 'tsx', 'scripts/compile-referenced-projects.ts', 'libraries'] : ['run', 'build:lib'],
      ['run', 'build:web'],
    ].map(args => ({ args, title: 'Harnessy', profile: 'custom-harness', staleRecord: false })))
    expect(readClientBuildRecord(fixture).environment).toMatchObject({
      DSH_CLIENT_TITLE: 'Harnessy', DSH_CLIENT_BUILD_PROFILE: 'custom-harness', DSH_CLIENT_VERSION: '1.2.3',
    })
  })

  it.each([
    { flags: [], stage: 'run build:native-system', count: 1 },
    { flags: [], stage: 'run build:lib', count: 2 },
    { flags: ['--artifacts-only'], stage: 'exec tsx scripts/compile-referenced-projects.ts libraries', count: 2 },
    { flags: ['--artifacts-only'], stage: 'run build:web', count: 3 },
  ])('leaves no build record or later commands after $stage fails', ({ flags, stage, count }) => {
    const { fixture, result, commands } = buildFixture(flags, stage)

    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('exited with 7')
    expect(commands).toHaveLength(count)
    expect(existsSync(join(fixture, CLIENT_BUILD_RECORD_PATH))).toBe(false)
  })

  // The sentinel makes parseArgs fail fast if the check ever stops running first.
  it('rejects a Node process without TypeScript type stripping before any build step', () => {
    const result = spawnSync(
      process.execPath,
      ['--no-experimental-strip-types', '--import', 'tsx/esm', resolve(root, 'scripts/build.ts'), '--spec-sentinel'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('build: Node.js TypeScript type stripping is unavailable')
  })

  it('rejects a value for the artifacts-only flag before any build step', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', resolve(root, 'scripts/build.ts'), '--artifacts-only=yes'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('does not take an argument')
  })
})
