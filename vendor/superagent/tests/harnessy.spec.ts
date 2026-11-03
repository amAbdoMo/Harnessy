/** Harnessy-specific worker isolation, native Windows invocation and personal-account requests. */
import { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { Config, machineOf } from '../src/deployment.ts'
import { Setup } from '../src/app/setup.ts'
import { SettingsSchema } from '../src/policy.ts'
import { agentVariables, credentialHelper, workerBin, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { workerShellSpec } from '../src/worker-shell.ts'
import { commentTrigger } from '../src/sources/github-trigger.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'

const exec = promisify(execFile)
const directories: string[] = []
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'harnessy-superagent-')); directories.push(path); return path }
afterEach(() => { vi.unstubAllEnvs(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

it('keeps the default database inside the active Harness home', async () => {
  const home = directory()
  vi.stubEnv('DSH_HOME', home)
  vi.resetModules()
  const { Config: homeConfig } = await import('../src/deployment.ts')
  expect(homeConfig({}).stateDir).toBe(join(home, 'SuperAgent'))
})

it.each([
  { enabled: true, body: '/superagent Fix the header', human: true, addressed: true },
  { enabled: false, body: '/superagent Fix the header', human: false, addressed: false },
  { enabled: true, body: 'An ordinary comment', human: false, addressed: false },
  { enabled: true, body: '/superagent Fix the header\n<!-- dsh-superagent:automatic -->', human: false, addressed: false },
])('admits personal-account commands only with opt-in and without automatic-reply markers: $body', ({ enabled, body, human, addressed }) => {
  const trigger = commentTrigger({ id: 1, user: { login: 'amAbdoMo', type: 'User' }, body }, { number: 1, isPr: false }, 'conversation', 'amAbdoMo', enabled)
  expect(trigger.human).toBe(human)
  expect(trigger.addressed === 'mention').toBe(addressed)
})

it('configures worker commands without changing the Host process environment', async () => {
  const stateDir = directory()
  const parent = { ...process.env }
  const ctx = new Context()
  ctx.reflect.provide('subprocess', { spawn(spec: { argv: string[] }) {
    const key = spec.argv.slice(1).join(' ')
    const text = key === 'api user' ? JSON.stringify({ login: 'amAbdoMo', id: 7 })
      : key.startsWith('api repos/') ? JSON.stringify({ name: 'amAbdoMo/Harnessy', push: true })
      : key === 'config -z --show-origin --get-all credential.https://github.com.helper'
        ? `file:${workerGitConfig(stateDir)}\0${credentialHelper(process.execPath)}\0` : undefined
    if (text === undefined) throw new Error(`Unexpected external command: ${key}`)
    return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {
      stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    } }
  } })
  const setup = new Setup({ context: ctx, machine: testMachine({ stateDir }), lifetime: new AbortController().signal, restart() {} })
  const settings = SettingsSchema.parse({ sources: { github: { config: { repository: 'amAbdoMo/Harnessy', cli: process.execPath } } } })
  expect(await setup.run(settings)).toBe(true)
  expect(setup.workerEnvironment.PATH?.split(delimiter)[0]).toBe(workerBin(stateDir))
  expect(setup.workerEnvironment.GIT_CONFIG_GLOBAL).toBe(workerGitConfig(stateDir))
  expect(process.env).toEqual(parent)
})

it.skipIf(process.platform !== 'win32')('runs native worker shims with literal arguments and clears inherited Git locations', async () => {
  const stateDir = directory()
  const parent = { ...process.env }
  const script = join(stateDir, 'arguments with spaces.mjs')
  writeFileSync(script, 'console.log(JSON.stringify({args:process.argv.slice(2), git:process.env.GIT_DIR ?? null}))\n')
  const deployment = testDeployment({ stateDir, github: { cli: process.execPath, login: 'amAbdoMo', noreply: 'test@example.invalid' }, feishu: undefined })
  await writeEnvironment(deployment, ['blocked-cli'])
  const literal = 'spaces; $(not-a-command) & percent%'
  const quote = (text: string) => `'${text.replaceAll("'", "''")}'`
  const spec = workerShellSpec({ command: `gh ${quote(script)} ${quote(literal)}`, workdir: stateDir, timeoutMs: 10000,
    onExpiry: 'kill', stdoutMaxBytes: 4096, sandboxPolicy: undefined }, { PATH: [workerBin(stateDir), process.env.PATH].join(delimiter), GIT_DIR: undefined }, 'win32')
  const { stdout } = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', spec.command], {
    cwd: stateDir, env: { ...process.env, GIT_DIR: 'wrong-repository', ...spec.env }, timeout: 15000,
  })
  expect(JSON.parse(stdout)).toEqual({ args: [literal], git: null })
  const git = await exec('git', ['config', '--file', workerGitConfig(stateDir), '--get', 'credential.https://github.com.helper'], { timeout: 10000 })
  expect(git.stdout.trim()).toBe(credentialHelper(process.execPath))
  const workerEnv = { ...process.env }
  for (const [key, value] of Object.entries(agentVariables(stateDir))) {
    if (value === undefined) delete workerEnv[key]
    else workerEnv[key] = value
  }
  const origin = await exec('git', ['config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], {
    cwd: stateDir, env: workerEnv, timeout: 10000,
  })
  expect(origin.stdout).toBe(`file:${workerGitConfig(stateDir)}\0${credentialHelper(process.execPath)}\0`)
  expect(readFileSync(join(workerBin(stateDir), 'blocked-cli.ps1'), 'utf8')).toContain('exit 1')
  expect(machineOf(Config({ stateDir })).stateDir).toBe(stateDir)
  expect(process.env).toEqual(parent)
})
