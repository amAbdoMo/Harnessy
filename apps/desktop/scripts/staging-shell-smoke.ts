/** Verify a frozen staging shell with disposable data and an ephemeral inspector port. */

import { spawn, execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import WebSocket from 'ws'

async function rendered(url: string): Promise<boolean> {
  const socket = new WebSocket(url)
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => { finish(new Error('staging smoke: renderer did not answer')) }, 5_000)
    const finish = (error?: Error, ready = false): void => {
      clearTimeout(timer)
      socket.terminate()
      if (error !== undefined) reject(error)
      else resolve(ready)
    }
    socket.once('error', (error) => { finish(error) })
    socket.once('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true,
        expression: "document.readyState === 'complete' && (document.body?.innerText.trim().length ?? 0) > 20" } }))
    })
    socket.once('message', (data) => {
      try {
        const response: unknown = JSON.parse(data.toString())
        const ready = typeof response === 'object' && response !== null && 'result' in response
          && typeof response.result === 'object' && response.result !== null && 'result' in response.result
          && typeof response.result.result === 'object' && response.result.result !== null
          && 'value' in response.result.result && response.result.result.value === true
        finish(undefined, ready)
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    })
  })
}

/**
 * Launch the real frozen application and require a rendered window before promotion.
 * No user home, profile, credentials or fixed inspector port is used; all child processes are joined.
 * @param directory - Self-contained candidate with app, Electron and runtime directories.
 * @returns Resolves after native startup, rendering and process-tree teardown.
 */
export async function smokeStagingShell(directory: string): Promise<void> {
  const isolated = await mkdtemp(join(tmpdir(), 'harnessy-staging-smoke-'))
  const userData = join(isolated, 'Cache', 'DesktopUserData')
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(?:DSH_|CUSTOM_HARNESS_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|NODE_PATH$)/u.test(name)
      && !/KEY|SECRET|TOKEN|PASSWORD/iu.test(name)
  )))
  const child = spawn(join(directory, 'electron', 'electron.exe'), [
    '--remote-debugging-port=0', `--user-data-dir=${userData}`, join(directory, 'app'),
  ], { windowsHide: true, env: {
    ...environment,
    CUSTOM_HARNESS_DATA_DIR: isolated,
    DSH_HOME: join(isolated, 'Harness'), DSH_AGENTS_HOME: join(isolated, 'Agents'),
    DSH_DESKTOP_PROFILE_DIR: join(isolated, 'profile'),
    DSH_DESKTOP_DSH_DIR: join(directory, 'app', 'dsh'),
    DSH_DESKTOP_PNPM_ENTRY: join(directory, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: join(directory, 'runtime', 'primary-runtime'),
    DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    NARB_NATIVE_CACHE_DIR: join(isolated, 'native-cache'),
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-16_384) }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  let spawnError: Error | undefined
  const closed = new Promise<void>((resolve) => {
    child.once('error', (error) => { spawnError = error })
    child.once('close', () => { resolve() })
  })
  try {
    const deadline = Date.now() + 60_000
    let stableSince: number | undefined
    while (Date.now() < deadline) {
      if (spawnError !== undefined) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`staging smoke: shell exited early\n${output}`)
      let ready = false
      try {
        const port = (await readFile(join(userData, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
        if (port !== undefined && /^\d+$/u.test(port)) {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })
          const pages: unknown = await response.json()
          if (Array.isArray(pages)) {
            for (const page of pages) {
              if (typeof page === 'object' && page !== null && 'type' in page && page.type === 'page'
                && 'url' in page && typeof page.url === 'string'
                && (page.url.startsWith('dsh-app://app/') || page.url.endsWith('/renderer/welcome.html'))
                && 'webSocketDebuggerUrl' in page && typeof page.webSocketDebuggerUrl === 'string') {
                ready = await rendered(page.webSocketDebuggerUrl)
                if (ready) break
              }
            }
          }
        }
      } catch (error) {
        // Inspector metadata and the first page are unavailable during early shell startup.
        if (Date.now() >= deadline) throw error
      }
      stableSince = ready ? stableSince ?? Date.now() : undefined
      if (stableSince !== undefined && Date.now() - stableSince >= 3_000) {
        console.log('staging smoke: frozen shell rendered successfully with isolated data')
        return
      }
      await delay(250)
    }
    throw new Error(`staging smoke: no stable application window within 60 seconds\n${output}`)
  } finally {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 })
      } catch (error) {
        // The process can exit between the liveness check and taskkill's lookup.
        if (child.exitCode === null && child.signalCode === null) throw error
      }
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('staging smoke: shell teardown exceeded 15 seconds')) }, 15_000)
      void closed.then(() => { clearTimeout(timer); resolve() })
    })
    await rm(isolated, { recursive: true, force: true })
  }
}
