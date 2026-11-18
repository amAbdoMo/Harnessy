/** Owner release decisions with real PowerShell and isolated Git/GitHub process responses. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const runFile = promisify(execFile)
interface Observation {
  State: {
    Phase: string
    Version: string
    LatestVersion: string
    CanPublish: boolean
    CanRetry: boolean
    Message: string
    RunId: number
    Steps: { Status: string; Detail: string }[]
  }
  Paused: Observation['State'] | null
  Effects: { Bumps: number; Pushes: number; Dispatches: number; Retries: number; Views: number; Fetches: number }
}
function argumentsFor(root: string, name: string): string[] {
  return ['-NoProfile', '-File', fileURLToPath(new URL('./release-control.fixture.ps1', import.meta.url)), '-Engine',
    fileURLToPath(new URL('../scripts/release-control.ps1', import.meta.url)), '-Root', root, '-Scenario', name]
}
async function scenario(name: string): Promise<Observation> {
  const root = await mkdtemp(join(tmpdir(), 'harnessy-release-control-'))
  try {
    const { stdout } = await runFile('pwsh.exe', argumentsFor(root, name), { timeout: 25_000, windowsHide: true })
    return JSON.parse(stdout) as Observation
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}
it.skipIf(process.platform !== 'win32').each([
  { name: 'inspect', version: '0.1.21', canPublish: true },
  { name: 'reserved', version: '0.1.22', canPublish: true },
  { name: 'already-released', version: '0.1.21', canPublish: false },
])('suggests an unreleased version for $name without changing source', async ({ name, version, canPublish }) => {
  const { State, Effects } = await scenario(name)
  expect(State).toMatchObject({ Phase: 'ready', Version: version, CanPublish: canPublish })
  expect(Effects).toMatchObject({ Bumps: 0, Pushes: 0, Dispatches: 0 })
})
it.skipIf(process.platform !== 'win32').each(['publish', 'queued', 'uncertain-dispatch'])(
  'publishes and reconnects through %s without duplicate dispatch', async (name) => {
    const { State, Effects } = await scenario(name)
    expect(State).toMatchObject({ Phase: 'published', Version: '0.1.21', LatestVersion: '0.1.21', RunId: 42 })
    expect(State.Steps.every(step => step.Status === 'succeeded')).toBe(true)
    expect(Effects).toMatchObject({ Bumps: 1, Pushes: 1, Dispatches: 1 })
  })
it.skipIf(process.platform !== 'win32')('recovers a temporary certificate error while fetching staging', async () => {
  const { State, Effects } = await scenario('preflight-tls')
  expect(State).toMatchObject({ Phase: 'ready', Version: '0.1.21', CanPublish: true })
  expect(Effects).toMatchObject({ Fetches: 2, Bumps: 0, Pushes: 0, Dispatches: 0 })
})
it.skipIf(process.platform !== 'win32')('preserves version information and requires a fresh staging check after a connection outage', async () => {
  const { State, Effects, Paused } = await scenario('preflight-offline')
  expect(Paused).toMatchObject({ Phase: 'paused', Version: '0.1.21', LatestVersion: '0.1.20', CanPublish: false, RunId: 0 })
  expect(State).toMatchObject({ Phase: 'ready', Version: '0.1.21', CanPublish: true })
  expect(Effects).toMatchObject({ Fetches: 5, Pushes: 0, Dispatches: 0 })
})
it.skipIf(process.platform !== 'win32')('dispatches the verified staging commit without pushing it again', async () => {
  const { State, Effects } = await scenario('already-staged')
  expect(State).toMatchObject({ Phase: 'published', Version: '0.1.21', RunId: 42 })
  expect(Effects).toMatchObject({ Bumps: 0, Pushes: 0, Dispatches: 1 })
})
it.skipIf(process.platform !== 'win32').each(['dirty', 'changed-source', 'wrong-origin', 'newer-release'])('stops %s before changing or publishing source', async (name) => {
  const { State, Effects } = await scenario(name)
  expect(State).toMatchObject({ Phase: 'failed', CanPublish: false })
  expect(Effects).toMatchObject({ Bumps: 0, Pushes: 0, Dispatches: 0 })
})
it.skipIf(process.platform !== 'win32')('keeps the publication step incomplete until the public update feed matches', async () => {
  const { State, Effects } = await scenario('stale-feed')
  expect(State.Phase).toBe('failed')
  expect(State.Steps[5]?.Status).toBe('failed')
  expect(State.Message).toContain('public update feed')
  expect(Effects.Dispatches).toBe(1)
})
it.skipIf(process.platform !== 'win32')('retries failed GitHub steps without another version bump, push or build dispatch', async () => {
  const { State, Effects } = await scenario('retry')
  expect(State.Phase).toBe('published')
  expect(Effects).toMatchObject({ Bumps: 1, Pushes: 1, Dispatches: 1, Retries: 1 })
})
it.skipIf(process.platform !== 'win32')('continues following the same run after a certificate error reading status', async () => {
  const { State, Effects } = await scenario('poll-tls')
  expect(State).toMatchObject({ Phase: 'published', RunId: 42 })
  expect(Effects).toMatchObject({ Views: 2, Dispatches: 1, Retries: 0 })
})
it.skipIf(process.platform !== 'win32')('pauses after repeated read errors and reconnects on refresh', async () => {
  const { State, Effects, Paused } = await scenario('poll-offline')
  expect(Paused).toMatchObject({ Phase: 'paused', RunId: 42, CanPublish: false, CanRetry: false })
  expect(Paused?.Steps[3]?.Status).toBe('pending')
  expect(State).toMatchObject({ Phase: 'published', RunId: 42 })
  expect(Effects).toMatchObject({ Views: 4, Dispatches: 1, Retries: 0 })
})
it.skipIf(process.platform !== 'win32')('names the failing GitHub check and leaves skipped jobs waiting', async () => {
  const { State } = await scenario('checks-failed')
  expect(State).toMatchObject({ Phase: 'failed', CanRetry: true })
  expect(State.Message).toContain('Verify the Super Agent panel and worker replay')
  expect(State.Steps.slice(3).map(step => step.Status)).toEqual(['failed', 'pending', 'pending'])
})
it.skipIf(process.platform !== 'win32')('leaves an existing release worker in control when another window checks progress', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'harnessy-release-mutex-'))
  const holder = runFile('pwsh.exe', argumentsFor(root, 'hold'), { timeout: 20_000, windowsHide: true })
  void holder.catch((_failure: unknown) => { /* The owned process is joined in finally, including an early startup failure. */ })
  try {
    await expect.poll(() => existsSync(join(root, 'lock-ready')), { timeout: 5000 }).toBe(true)
    const { stdout } = await runFile('pwsh.exe', argumentsFor(root, 'locked'), { timeout: 5000, windowsHide: true })
    const observed = JSON.parse(stdout) as Observation
    expect(observed.State).toBeNull()
    expect(observed.Effects).toMatchObject({ Bumps: 0, Pushes: 0, Dispatches: 0 })
  } finally {
    await writeFile(join(root, 'release-lock'), 'release')
    try { await holder } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  }
})
it.skipIf(process.platform !== 'win32')('passes literal release arguments to child processes without shell expansion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harnessy release arguments '))
  try {
    const { stdout } = await runFile('pwsh.exe', argumentsFor(root, 'native-command'), { timeout: 5000, windowsHide: true })
    expect(JSON.parse(stdout)).toEqual(['space value', '$(literal)'])
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
