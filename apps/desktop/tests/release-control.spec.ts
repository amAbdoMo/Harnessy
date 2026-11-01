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
    Steps: { Status: string }[]
  }
  Effects: { Bumps: number; Pushes: number; Dispatches: number; Retries: number; Views: number }
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
