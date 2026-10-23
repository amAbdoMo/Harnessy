/** Validate only the launcher's selection reader; no launch, Update or native process runs. */

import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, onTestFinished } from 'vitest'
import { updateStagingRuntime } from '../scripts/staging-runtime-store.ts'

const pnpmPath = 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'

describe.skipIf(process.platform !== 'win32')('staging shared pnpm verification', () => {
  it.each(['sealed', 'missing', 'tampered', 'wrong layout', 'legacy sealed', 'legacy tampered'])('validates %s without consulting installed or workspace pnpm', async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'staging-pnpm-verification '))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const id = await updateStagingRuntime(root, async (directory) => {
      for (const name of ['electron/electron.exe', 'app/package.json', 'app/lib/main.js', 'app/lib/preload-app.cjs',
        'app/dsh/desktop-runtime.json', 'runtime/primary-runtime/runtime.json', pnpmPath, 'app/scripts/node-bin/node.cmd']) {
        const path = join(directory, name)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, 'synthetic payload\n')
      }
    }, async () => {})
    const directory = join(root, 'generations', id)
    const recordPath = join(directory, 'verified.json')
    if (scenario === 'missing') rmSync(join(directory, pnpmPath))
    if (scenario === 'tampered') writeFileSync(join(directory, pnpmPath), 'changed\n')
    if (scenario === 'wrong layout' || scenario.startsWith('legacy')) {
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { schemaVersion: number; checks: { path: string }[] }
      if (scenario.startsWith('legacy')) record.schemaVersion = 1
      record.checks = record.checks.map(check => check.path === pnpmPath ? { ...check, path: 'runtime/pnpm/bin/pnpm.mjs' } : check)
      writeFileSync(recordPath, JSON.stringify(record))
    }
    // A readable old payload must never satisfy the shared entry requirement.
    const legacy = join(directory, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(legacy, scenario === 'legacy tampered' ? 'changed legacy payload\n' : 'synthetic payload\n')
    const source = readFileSync(resolve('apps/desktop/scripts/staging-launcher.ps1'), 'utf8')
    const start = source.indexOf('function Get-VerifiedStagingRuntime {')
    const end = source.indexOf('\nfunction Get-StagingWebProcess', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const script = join(root, 'verify.ps1')
    writeFileSync(script, `param([string]$storeRoot)\n$ErrorActionPreference = 'Stop'\n${source.slice(start, end)}\nGet-VerifiedStagingRuntime | ConvertTo-Json -Compress\n`)
    const verification = promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, root],
      { windowsHide: true, timeout: 10_000 })
    if (scenario === 'sealed' || scenario === 'legacy sealed') {
      expect(JSON.parse((await verification).stdout)).toEqual({
        Directory: directory,
        PnpmEntry: join(directory, scenario === 'legacy sealed' ? 'runtime/pnpm/bin/pnpm.mjs' : pnpmPath),
      })
    } else await expect(verification).rejects.toHaveProperty('stderr', expect.stringContaining(
      scenario === 'wrong layout' ? 'no valid verification record'
        : scenario === 'legacy tampered' ? 'protected staging file runtime/pnpm/bin/pnpm.mjs changed'
          : scenario === 'tampered' ? 'protected staging file runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs changed'
            : 'pnpm.mjs',
    ))
    const selection: unknown = JSON.parse(readFileSync(join(root, 'active.json'), 'utf8'))
    expect(selection).toMatchObject({ current: id })
  })
})
