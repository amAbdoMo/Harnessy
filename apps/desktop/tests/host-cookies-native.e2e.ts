/** Real Electron loopback startup after accumulated authority-specific cookies. */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import ts from 'typescript'
import { execa } from 'execa'

const require = createRequire(import.meta.url)

it.skipIf(process.platform !== 'win32')('recovers an oversized startup cookie header while retaining active and website sessions', { timeout: 60_000, retry: 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'harnessy-host-cookies-'))
  const server = createServer({ maxHeaderSize: 16_384 }, (_request, response) => { response.end('ready') })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Owned loopback listener is unavailable')
    const source = await readFile(new URL('../src/host-cookies.ts', import.meta.url), 'utf8')
    await writeFile(join(root, 'host-cookies.mjs'), ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
    } }).outputText, { flag: 'wx', mode: 0o600 })
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key) && !/^(DSH_|CUSTOM_HARNESS_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/iu.test(key)))
    const execution = await execa(require('electron') as string, [
      fileURLToPath(new URL('./host-cookies-native.fixture.mjs', import.meta.url)), root, `http://127.0.0.1:${address.port}`,
    ], { env, timeout: 45_000, forceKillAfterDelay: 1000, windowsHide: true, reject: false })
    expect(execution.timedOut, execution.stderr).toBe(false)
    expect(execution.signal, execution.stderr).toBeUndefined()
    expect(execution.exitCode, execution.stderr).toBe(0)
    expect(execution.stdout).toContain('HOST_COOKIE_RECOVERY_OK')
  } finally {
    try {
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
        server.closeAllConnections()
      })
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
})
