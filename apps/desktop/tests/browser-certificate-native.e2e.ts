/** Source-policy regression against owned Electron 44 windows; no Harness startup or artifact build. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { it } from 'vitest'

const runFile = promisify(execFile)
const tests = fileURLToPath(new URL('./', import.meta.url))
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(import.meta.url)
const electron = join(repository, 'node_modules/.pnpm/electron@44.0.0/node_modules/electron/dist/electron.exe')

async function certificate(env: NodeJS.ProcessEnv) {
  // CertificateRequest exports bytes without opening an OS certificate store.
  const { stdout } = await runFile('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$certificate = $null
try {
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=127.0.0.1', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
  $request.CertificateExtensions.Add($san.Build())
  $now = [DateTimeOffset]::UtcNow
  $certificate = $request.CreateSelfSigned($now.AddDays(-1), $now.AddDays(1))
  @{ pfx = [Convert]::ToBase64String($certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, 'fixture')); der = [Convert]::ToBase64String($certificate.RawData) } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $certificate) { $certificate.Dispose() }
  $rsa.Dispose()
}
`], { env, timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true })
  const value: unknown = JSON.parse(stdout)
  assert.ok(value !== null && typeof value === 'object'
    && 'pfx' in value && typeof value.pfx === 'string'
    && 'der' in value && typeof value.der === 'string', 'Fixture certificate bytes must be explicit strings')
  const leaf = new X509Certificate(Buffer.from(value.der, 'base64'))
  assert.equal(leaf.checkIP('127.0.0.1'), '127.0.0.1')
  assert.ok(leaf.validFromDate.getTime() < Date.now())
  assert.ok(leaf.validToDate.getTime() > Date.now())
  return { pfx: value.pfx, der: value.der }
}

async function removeOwned(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) { await unlink(path); return }
  for (const name of await readdir(path)) await removeOwned(join(path, name))
  await rmdir(path)
}

// Windows Electron and its existing binary are required; this fixture never installs a runtime.
it.skipIf(process.platform !== 'win32' || !existsSync(electron))('native sha256/base64 leaf supports consent, cancellation, certificate rotation and new-session isolation', { retry: 0 }, async () => {
  const typescript = require('typescript') as typeof import('typescript')
  const esbuild = require('esbuild') as { build(options: {
    absWorkingDir: string
    entryPoints: string[]
    bundle: boolean
    platform: 'node'
    format: 'esm'
    external: string[]
    write: false
  }): Promise<{ outputFiles: Array<{ text: string }> }> }
  const root = await mkdtemp(join(tests, '.certificate-native-owned-'))
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!/KEY|SECRET|TOKEN|PASSWORD/iu.test(key)
      && !/^(DSH_|CUSTOM_HARNESS_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/iu.test(key)) env[key] = value
  }
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    env[key] = join(root, key)
    await mkdir(env[key], { recursive: true })
  }
  try {
    const certificates = await Promise.all([certificate(env), certificate(env)])
    // Transpile only the live policy into this disposable test root; no active Desktop artifact is rebuilt.
    const source = await readFile(join(repository, 'apps/desktop/src/browser-certificates.ts'), 'utf8')
    const policy = typescript.transpileModule(source, { compilerOptions: {
      module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2022,
    } }).outputText
    await writeFile(join(root, 'source-policy.mjs'), policy, { flag: 'wx', mode: 0o600 })
    const guests = await esbuild.build({ absWorkingDir: repository,
      entryPoints: ['apps/desktop/src/browser-guests.ts'], bundle: true, platform: 'node', format: 'esm',
      external: ['electron'], write: false })
    await writeFile(join(root, 'source-guests.mjs'), guests.outputFiles[0]!.text, { flag: 'wx', mode: 0o600 })
    await writeFile(join(root, 'fixture-input.json'), JSON.stringify({ certificates }), { flag: 'wx', mode: 0o600 })
    const child = spawn(electron, [join(tests, 'owned-certificate-native.fixture.mjs'), root], {
      cwd: repository, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.ok(child.pid, 'Only the independently spawned Electron PID may be targeted')
    const pid = child.pid
    let output = ''
    let errors = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk })
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    let forced = false
    let cleanup: Promise<unknown> = Promise.resolve()
    const deadline = setTimeout(() => {
      forced = true
      cleanup = runFile(join(env.SystemRoot ?? env.SYSTEMROOT!, 'System32/taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'], { env, timeout: 10_000, windowsHide: true })
      void cleanup.catch(() => { /* Reported after the child settles. */ })
    }, 75_000)
    let code: number | null
    try { code = await closed } finally { clearTimeout(deadline); await cleanup }
    assert.equal(forced, false, `Owned Electron exceeded graceful deadline: ${errors}; ${output}`)
    assert.equal(code, 0, `Owned Electron exited ${code}: ${errors}; ${output}`)
    const line = output.split(/\r?\n/u).find(line => line.startsWith('NATIVE_CERTIFICATE_RESULT '))
    assert.ok(line, `Missing asserted native result: ${errors}; ${output}`)
    const result: unknown = JSON.parse(line.slice('NATIVE_CERTIFICATE_RESULT '.length))
    assert.ok(result !== null && typeof result === 'object'
      && 'pid' in result && 'quiescent' in result && 'electron' in result, 'Native result must report ownership and cleanup')
    assert.equal(result.pid, pid)
    assert.equal(result.quiescent, true)
    assert.equal(result.electron, '44.0.0')
    console.info(line)
  } finally {
    // root is the exact mkdtemp result beneath tests, never the active application's profile.
    await removeOwned(root)
  }
})
