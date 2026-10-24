import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { updateStagingRuntime } from '../scripts/staging-runtime-store.ts'

interface OwnedProcess {
  readonly child: ChildProcess
  readonly closed: Promise<void>
}

function execute(
  owned: Set<OwnedProcess>, file: string, args: readonly string[], env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  let child!: ChildProcess
  let close!: () => void
  const closed = new Promise<void>((resolveClose) => { close = resolveClose })
  const result = new Promise<{ stdout: string; stderr: string }>((resolveResult, rejectResult) => {
    child = execFile(file, args, { env, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error === null) resolveResult({ stdout, stderr })
      else {
        rejectResult(Object.assign(new Error(error.message, { cause: error }), {
          stdout, stderr, code: error.code, killed: error.killed, signal: error.signal,
        }))
      }
    })
  })
  child.once('close', close)
  owned.add({ child, closed })
  return result
}

async function stopOwnedProcesses(owned: Set<OwnedProcess>): Promise<void> {
  for (const { child } of owned) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) continue
    await new Promise<void>((resolveStop) => {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { resolveStop() })
    })
  }
  await Promise.allSettled([...owned].map(({ closed }) => closed))
}

describe.skipIf(process.platform !== 'win32')('Windows protected staging launcher', () => {
  it.each(['Start', 'Stop', 'Build', 'Update'])('rejects %s from another checkout without changing its registered location', async (action) => {
    const root = mkdtempSync(join(tmpdir(), 'staging registration '))
    const owned = new Set<OwnedProcess>()
    onTestFinished(async () => {
      await stopOwnedProcesses(owned)
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    const repository = join(root, 'duplicate')
    const launcher = join(repository, 'apps', 'desktop', 'scripts', 'staging-launcher.ps1')
    mkdirSync(dirname(launcher), { recursive: true })
    copyFileSync(resolve('apps/desktop/scripts/staging-launcher.ps1'), launcher)
    const localData = join(root, 'local-app-data')
    const registration = join(localData, 'CustomHarnessStaging', 'StagingDesktopLauncher', 'repository.txt')
    mkdirSync(dirname(registration), { recursive: true })
    const canonical = join(root, 'canonical')
    writeFileSync(registration, canonical)

    await expect(execute(owned, 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Action', action],
      { ...process.env, LOCALAPPDATA: localData })).rejects.toHaveProperty(
      'stderr', expect.stringContaining('staging is already registered'))
    expect(readFileSync(registration, 'utf8')).toBe(canonical)
  }, 30_000)

  it.each(['same repository', 'invalid registration'])('validates %s before native startup', async (scenario) => {
    const repository = mkdtempSync(join(tmpdir(), 'staging canonical '))
    const owned = new Set<OwnedProcess>()
    onTestFinished(async () => {
      await stopOwnedProcesses(owned)
      rmSync(repository, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    const launcher = join(repository, 'apps', 'desktop', 'scripts', 'staging-launcher.ps1')
    mkdirSync(dirname(launcher), { recursive: true })
    copyFileSync(resolve('apps/desktop/scripts/staging-launcher.ps1'), launcher)
    const localData = join(repository, 'local-app-data')
    const registration = join(localData, 'CustomHarnessStaging', 'StagingDesktopLauncher', 'repository.txt')
    mkdirSync(dirname(registration), { recursive: true })
    writeFileSync(registration, scenario === 'same repository' ? repository.toUpperCase() : '../duplicate')

    await expect(execute(owned, 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Action', 'Start'],
      { ...process.env, LOCALAPPDATA: localData })).rejects.toHaveProperty(
      'stderr', expect.stringContaining(scenario === 'same repository' ? 'No verified staging runtime exists' : 'repository registration is invalid'))
  }, 30_000)

  it('isolates a sealed runtime alongside installed Harnessy and reports its actual exit code without workspace build tools', async () => {
    const repository = realpathSync.native(mkdtempSync(join(tmpdir(), 'staging launcher with spaces ')))
    const owned = new Set<OwnedProcess>()
    const cleanup: { disposeInstalled?: () => Promise<void> } = {}
    onTestFinished(async () => {
      try { await cleanup.disposeInstalled?.() }
      finally {
        await stopOwnedProcesses(owned)
        rmSync(repository, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    })
    const launcher = join(repository, 'apps', 'desktop', 'scripts', 'staging-launcher.ps1')
    mkdirSync(dirname(launcher), { recursive: true })
    copyFileSync(resolve('apps/desktop/scripts/staging-launcher.ps1'), launcher)
    const store = join(repository, 'apps', 'desktop', '.desktop-build', 'staging-runtime')
    const observed = join(repository, 'observed.json')
    const generation = await updateStagingRuntime(store, async (directory) => {
      for (const name of ['electron/electron.exe', 'app/package.json', 'app/lib/main.js', 'app/lib/preload-app.cjs',
        'app/dsh/desktop-runtime.json', 'runtime/primary-runtime/runtime.json',
        'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs', 'app/scripts/node-bin/node.cmd']) {
        const path = join(directory, name)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, 'fixture\n')
      }
      // A real Node executable stands in for Electron so the launcher owns and joins an actual process.
      copyFileSync(process.execPath, join(directory, 'electron', 'electron.exe'))
      writeFileSync(join(directory, 'app', 'package.json'), JSON.stringify({ type: 'module', main: 'lib/main.js' }))
      writeFileSync(join(directory, 'app', 'lib', 'main.js'), `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(observed)}, JSON.stringify(Object.fromEntries([
  'DSH_DESKTOP_DSH_DIR', 'DSH_DESKTOP_PNPM_ENTRY', 'DSH_DESKTOP_PRIMARY_RUNTIME_DIR',
  'CUSTOM_HARNESS_DATA_DIR', 'CUSTOM_HARNESS_HOME', 'DSH_HOME',
  'CUSTOM_HARNESS_AGENTS_DIR', 'DSH_AGENTS_HOME', 'CUSTOM_HARNESS_LOG_DIR', 'CUSTOM_HARNESS_CACHE_DIR',
  'DSH_DESKTOP_PROFILE_DIR', 'DSH_DESKTOP_USER_DATA_DIR', 'DSH_DESKTOP_DEV_APP',
  'DSH_DESKTOP_REMOTE_URL', 'DSH_DESKTOP_LISTEN_PORT',
].map(name => [name, process.env[name] ?? null]))))
process.exit(7)
`)
    }, async () => {})
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:DSH_|CUSTOM_HARNESS_)/iu.test(name)))
    const localData = join(repository, 'local-app-data')
    const installedData = join(localData, 'CustomHarness')
    const inheritedEnvironment = {
      ...environment,
      LOCALAPPDATA: localData,
      CUSTOM_HARNESS_DATA_DIR: installedData,
      CUSTOM_HARNESS_HOME: join(installedData, 'custom-home'),
      DSH_HOME: join(installedData, 'Harness'),
      CUSTOM_HARNESS_AGENTS_DIR: join(installedData, 'custom-agents'),
      DSH_AGENTS_HOME: join(installedData, 'Agents'),
      CUSTOM_HARNESS_LOG_DIR: join(installedData, 'Logs'),
      CUSTOM_HARNESS_CACHE_DIR: join(installedData, 'Cache'),
      DSH_DESKTOP_PROFILE_DIR: join(installedData, 'installed-profile'),
      DSH_DESKTOP_USER_DATA_DIR: join(installedData, 'installed-user-data'),
      DSH_DESKTOP_DEV_APP: '1',
      DSH_DESKTOP_REMOTE_URL: 'https://installed.fixture.ts.net/',
      DSH_DESKTOP_LISTEN_PORT: '43210',
    }
    const installedExecutable = join(repository, 'Harnessy.exe')
    copyFileSync(process.execPath, installedExecutable)
    const installed = spawn(installedExecutable, ['-e', `
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
process.stdout.write('ready\\n')
`], { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] })
    const installedExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      installed.once('close', (code, signal) => { resolveExit({ code, signal }) })
    })
    owned.add({ child: installed, closed: installedExit.then(() => undefined) })
    cleanup.disposeInstalled = async () => {
      if (!installed.stdin.writableEnded) installed.stdin.end()
      await installedExit
    }
    await new Promise<void>((ready, reject) => {
      installed.once('error', reject)
      installed.once('exit', () => { reject(new Error('Owned Harnessy fixture exited before readiness')) })
      let output = ''
      const onData = (chunk: Buffer) => {
        output += chunk.toString()
        if (!output.includes('\n')) return
        installed.stdout.off('data', onData)
        if (output === 'ready\n') ready()
        else reject(new Error(`Unexpected Harnessy fixture readiness: ${output}`))
      }
      installed.stdout.on('data', onData)
    })
    mkdirSync(join(repository, 'apps', 'desktop', 'lib'), { recursive: true })
    writeFileSync(join(repository, 'apps', 'desktop', 'lib', 'main.js'), 'throw new Error("broken workspace build")\n')
    const data = join(localData, 'CustomHarnessStaging')
    const expectedEnvironment = {
      DSH_DESKTOP_DSH_DIR: join(store, 'generations', generation, 'app', 'dsh'),
      DSH_DESKTOP_PNPM_ENTRY: join(store, 'generations', generation, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
      DSH_DESKTOP_PRIMARY_RUNTIME_DIR: join(store, 'generations', generation, 'runtime', 'primary-runtime'),
      CUSTOM_HARNESS_DATA_DIR: data,
      CUSTOM_HARNESS_HOME: join(data, 'Harness'),
      DSH_HOME: join(data, 'Harness'),
      CUSTOM_HARNESS_AGENTS_DIR: join(data, 'Agents'),
      DSH_AGENTS_HOME: join(data, 'Agents'),
      CUSTOM_HARNESS_LOG_DIR: join(data, 'Logs'),
      CUSTOM_HARNESS_CACHE_DIR: join(data, 'Cache'),
      DSH_DESKTOP_PROFILE_DIR: join(data, 'Harness', 'profiles', 'desktop'),
      DSH_DESKTOP_USER_DATA_DIR: join(data, 'Cache', 'DesktopUserData'),
      DSH_DESKTOP_DEV_APP: '0',
    }
    for (const remote of [
      { args: [], url: null, port: null },
      { args: ['-RemoteUrl', 'https://staging.fixture.ts.net/', '-ListenPort', '43211'], url: 'https://staging.fixture.ts.net/', port: '43211' },
    ]) {
      let diagnostic = ''
      try {
        await execute(owned, 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Action', 'Start', ...remote.args],
          inheritedEnvironment)
      } catch (error) {
        if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error
        expect(error).toHaveProperty('killed', false)
        expect(error).toHaveProperty('signal', null)
        diagnostic = String(error.stderr)
      }
      expect(diagnostic).toContain('Harnessy staging exited with code 7.')
      expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({
        ...expectedEnvironment,
        DSH_DESKTOP_REMOTE_URL: remote.url,
        DSH_DESKTOP_LISTEN_PORT: remote.port,
      })
      expect(readFileSync(join(localData, 'CustomHarnessStaging', 'StagingDesktopLauncher', 'repository.txt'), 'utf8').trim()).toBe(repository)
      expect(installed.exitCode).toBeNull()
      expect(installed.signalCode).toBeNull()
    }
    installed.stdin.end()
    expect(await installedExit).toEqual({ code: 0, signal: null })
    const bootstrap = join(localData, 'CustomHarness', 'Harness', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies')
    mkdirSync(join(bootstrap, 'node', 'bin'), { recursive: true })
    mkdirSync(join(bootstrap, 'pnpm', 'bin'), { recursive: true })
    copyFileSync(process.execPath, join(bootstrap, 'node', 'bin', 'node.exe'))
    writeFileSync(join(bootstrap, 'pnpm', 'bin', 'pnpm.mjs'), 'process.exit(0)\n')
    await expect(execute(owned, 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Action', 'Update'],
      { ...environment, LOCALAPPDATA: localData })).rejects.toHaveProperty(
      'stderr', expect.stringContaining('did not select a new verified runtime'))
    writeFileSync(join(store, 'generations', generation, 'app', 'lib', 'main.js'), 'throw new Error("must not run")\n')
    await expect(execute(owned, 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Action', 'Start'],
      { ...environment, LOCALAPPDATA: localData })).rejects.toHaveProperty(
      'stderr', expect.stringContaining('protected staging file app/lib/main.js changed'))
  }, 90_000)
})
