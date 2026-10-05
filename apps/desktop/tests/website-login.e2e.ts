/**
 * Built Windows Desktop acceptance through real Main, Host, preload and native guests.
 * Only external login/MCP services are fixtures. Pairing uses Main's real shell confirmation;
 * guest attachment uses the shipped lease/partition handshake, not a fake bridge.
 * Requires an interactive Windows desktop and completed Host/Desktop builds.
 * The Agent scenario uses an owned Messages provider, genuine Session/tool execution and live consent.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { lstat, readFile, readdir, rmdir, unlink } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import { scanZstdFrames } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import { describe, expect, it } from 'vitest'
import type { ElectronApplication, Page } from '../../web/node_modules/playwright/index.js'
import type { WebviewTag } from 'electron'
import type { DshDesktopProductApi } from '../src/ipc.ts'
import type { DesktopBrowserReservation, DesktopWebsiteProfileId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { readClientBuildRecord } from '../../../scripts/client-build-environment.ts'
import { websiteModelFixture } from './website-model.fixture.ts'
import { assertCleanWebsiteExit } from './website-shutdown.fixture.ts'

// Reuse the Web acceptance lane's installed Playwright; no browser download is needed.
const { _electron } = createRequire(new URL('../../web/package.json', import.meta.url))('playwright') as typeof import('../../web/node_modules/playwright/index.js')
const desktopRequire = createRequire(new URL('../package.json', import.meta.url))
const electronExecutable = desktopRequire('electron') as string
const pnpmEntry = join(dirname(desktopRequire.resolve('pnpm')), 'bin/pnpm.mjs')
const desktop = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const project = join(desktop, '.desktop-build/development/project')
const primaryRuntime = join(desktop, '.desktop-build/targets/win-x64/runtime/primary-runtime')
const artifacts = [join(desktop, 'lib/main.js'), join(desktop, 'lib/preload-app.cjs'),
  join(repository, 'apps/desktop-host/lib/index.js'), join(project, 'desktop-runtime.json'),
  join(primaryRuntime, 'dependencies/node/bin/node.exe')]
const missing = artifacts.filter(path => !existsSync(path))
const runFile = promisify(execFile)
type ProductWindow = Window & { dshDesktop?: DshDesktopProductApi; __websiteNativeTitleRestore?: () => void }
type NativeProbe = {
  count: { title: number; dom: number; image: number }
  setTitle(title: string): Promise<void>
  restore(): void
}
type ProbedGlobal = typeof globalThis & { __websiteNativeFixture?: NativeProbe }

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture has no loopback address')
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => server.close((error) => {
    if (error) reject(error)
    else resolve()
  }))
  server.closeAllConnections()
  await closed
}

function loginFixture(cookieValue = 'signed-in') {
  const server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store')
    if (request.method === 'POST' && request.url === '/login') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        const form = new URLSearchParams(body)
        if (form.get('username') !== 'fixture-user' || form.get('password') !== 'fixture-password') {
          response.writeHead(401).end('Invalid fixture credentials')
          return
        }
        // Persistence follows the site's expiry policy; a session-only cookie ends on process exit.
        response.setHeader('set-cookie', `fixture_login=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`)
        response.writeHead(303, { location: '/' }).end()
      })
      return
    }
    const signedIn = request.headers.cookie?.split(';').some(cookie => cookie.trim() === `fixture_login=${cookieValue}`) === true
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<title>Website login fixture</title><p id="state">${signedIn ? 'authenticated' : 'anonymous'}</p>
      <form action="/login" method="post"><label>Username<input name="username"></label>
      <label>Password<input name="password" type="password"></label><button>Sign in</button></form>`)
  })
  return server
}

function mcpFixture() {
  const methods: string[] = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(request.method === 'DELETE' ? 204 : 405).end(); return }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      let input: unknown
      try { input = JSON.parse(body) } catch (error) {
        response.writeHead(400).end(String(error)); return
      }
      if (typeof input !== 'object' || input === null || !('method' in input) || typeof input.method !== 'string') {
        response.writeHead(400).end(); return
      }
      methods.push(input.method)
      if (!('id' in input)) { response.writeHead(202).end(); return }
      let result: object
      switch (input.method) {
        case 'initialize': {
          const params = 'params' in input ? input.params : undefined
          const protocolVersion = typeof params === 'object' && params !== null && 'protocolVersion' in params
            ? params.protocolVersion : '2025-03-26'
          result = { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'website-fixture', version: '1.0.0' } }
          break
        }
        case 'tools/list': result = { tools: [{ name: 'fixture_status', description: 'Report fixture availability.', inputSchema: { type: 'object', properties: {} } }] }; break
        case 'tools/call': result = { content: [{ type: 'text', text: 'fixture available' }] }; break
        case 'ping': result = {}; break
        default:
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, error: { code: -32601, message: 'Method not found' } }))
          return
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }))
    })
  })
  return { server, methods }
}

function childEnvironment(root: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/KEY|SECRET|TOKEN|PASSWORD/iu.test(name)
      && !/^(DSH_|CUSTOM_HARNESS_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/iu.test(name)) env[name] = value
  }
  const home = join(root, 'home')
  Object.assign(env, {
    CUSTOM_HARNESS_DATA_DIR: join(root, 'data'), CUSTOM_HARNESS_HOME: home,
    CUSTOM_HARNESS_AGENTS_DIR: join(root, 'agents'), CUSTOM_HARNESS_LOG_DIR: join(root, 'logs'),
    CUSTOM_HARNESS_CACHE_DIR: join(root, 'cache'), DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'),
    APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    HOME: join(root, 'user'), USERPROFILE: join(root, 'user'), TEMP: join(root, 'temp'), TMP: join(root, 'temp'),
    DSH_DESKTOP_PROFILE_DIR: join(root, 'profile'), DSH_DESKTOP_DSH_DIR: project,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: primaryRuntime, DSH_DESKTOP_PNPM_ENTRY: pnpmEntry, DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    DSH_TELEMETRY_MODE: 'DISABLED', LANG: 'en_US.UTF-8',
  })
  for (const key of ['CUSTOM_HARNESS_DATA_DIR', 'CUSTOM_HARNESS_HOME', 'CUSTOM_HARNESS_AGENTS_DIR',
    'CUSTOM_HARNESS_LOG_DIR', 'CUSTOM_HARNESS_CACHE_DIR', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'TEMP', 'DSH_DESKTOP_PROFILE_DIR']) {
    mkdirSync(env[key]!, { recursive: true })
  }
  return env
}

function systemRoot(env: Record<string, string>): string {
  const value = Object.entries(env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1]
  if (!value) throw new Error('Windows SystemRoot is required for native dialog automation')
  return value
}

function powershell(env: Record<string, string>): string {
  return join(systemRoot(env), 'System32/WindowsPowerShell/v1.0/powershell.exe')
}

// UIAutomation invokes only the exact button in the exact owned process/dialog.
// It never replaces showMessageBox or sends global keystrokes to the installed GUI.
function nativeDialog(
  pid: number, title: string, button: string, detail: readonly string[], env: Record<string, string>, optional = false,
) {
  const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`
  const command = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${pid})
$deadline = [DateTime]::UtcNow.AddSeconds(45)
$ownedDialogs = @()
[Console]::WriteLine('READY')
while ([DateTime]::UtcNow -lt $deadline) {
  if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) {
    ${optional ? 'exit 0' : "throw 'Owned Electron exited before native pairing confirmation'"}
  }
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  :ownedWindow foreach ($window in $windows) {
    if ($window.Current.ClassName -eq '#32770') { $ownedDialogs = @($window.Current.Name) }
    if ($window.Current.Name -ne ${literal(title)}) { continue }
    $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $text = ($elements | ForEach-Object { $_.Current.Name }) -join "\n"
    foreach ($required in @(${detail.map(literal).join(',')})) {
      if (-not $text.Contains($required)) { ${optional ? 'continue ownedWindow' : "throw ('Native dialog lacks expected pairing detail: ' + $required)"} }
    }
    foreach ($element in $elements) {
      if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $element.Current.Name -eq ${literal(button)}) {
        $invoke = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $invoke.Invoke()
        [Console]::WriteLine('CONFIRMED')
        exit 0
      }
    }
    throw 'Expected native confirmation button is unavailable'
  }
  Start-Sleep -Milliseconds 50
}
throw ('Native confirmation dialog timed out; owned task dialog names: ' + ($ownedDialogs -join ', '))
`
  const child = spawn(powershell(env), ['-NoProfile', '-NonInteractive', '-Command', command], { env, windowsHide: true })
  let output = ''
  let errors = ''
  let readyResolve: () => void = () => {}
  let readyReject: (error: Error) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.includes('READY')) readyResolve() })
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString() })
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', (error) => { readyReject(error); reject(error) })
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Native dialog helper exited ${code}: ${errors || output}`))
      readyReject(new Error(`Native dialog helper closed before readiness: ${errors || output}`))
    })
  })
  // The owner joins failures below; an early helper failure must not become an unhandled rejection.
  void done.catch(() => {})
  return { child, ready, done }
}

async function stopHelper(helper: ReturnType<typeof nativeDialog>): Promise<void> {
  if (helper.child.exitCode === null && helper.child.signalCode === null) helper.child.kill()
  await helper.done.catch((error: unknown) => { void error /* Cancelled helper is physically joined here. */ })
}

async function ownedTree(pid: number, env: Record<string, string>): Promise<number[]> {
  const { stdout } = await runFile(powershell(env), ['-NoProfile', '-NonInteractive', '-Command', `
$all = @(Get-CimInstance Win32_Process)
$owned = @(${pid})
do {
  $next = @($all | Where-Object { $_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned } | ForEach-Object { $_.ProcessId })
  $owned += $next
} while ($next.Count -gt 0)
$owned -join ','
`], { env, timeout: 15_000, windowsHide: true })
  return stdout.trim().split(',').map(Number)
}

async function processesGone(pids: readonly number[], env: Record<string, string>): Promise<void> {
  await runFile(powershell(env), ['-NoProfile', '-NonInteractive', '-Command', `
$deadline = [DateTime]::UtcNow.AddSeconds(15)
do {
  $remaining = @(Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue)
  if ($remaining.Count -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 50
} while ([DateTime]::UtcNow -lt $deadline)
throw ('Owned processes remain: ' + ($remaining.Id -join ','))
`], { env, timeout: 20_000, windowsHide: true })
}

async function exited(child: ChildProcess, milliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  let listener: () => void = () => {}
  const exit = new Promise<true>((resolve) => { listener = () => { resolve(true) }; child.once('exit', listener) })
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false) }, milliseconds) })
  try { return await Promise.race([exit, timeout]) } finally { clearTimeout(timer); child.off('exit', listener) }
}

async function stopDesktop(app: ElectronApplication, env: Record<string, string>): Promise<void> {
  const child = app.process()
  if (child.pid === undefined) throw new Error('Owned Electron has no process ID')
  const pids = await ownedTree(child.pid, env)
  const quit = nativeDialog(child.pid, 'Harnessy', 'Quit', ['Quit Harnessy?'], env, true)
  let failure: unknown
  try {
    await quit.ready
    // Do not use ElectronApplication.close(): production before-quit may require native consent.
    await app.evaluate(({ app: nativeApp }) => { setTimeout(() => { nativeApp.quit() }, 0) })
    const graceful = exited(child, 50_000)
    if (!await Promise.race([graceful, quit.done.then(async () => graceful)])) {
      throw new Error('Owned Electron did not complete graceful quit')
    }
    await quit.done
    assertCleanWebsiteExit(child)
    await processesGone(pids, env)
  } catch (error) {
    failure = error
  } finally {
    await stopHelper(quit)
  }
  if (failure !== undefined) {
    if (child.exitCode === null && child.signalCode === null) {
      await runFile(join(systemRoot(env), 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { env, windowsHide: true })
      if (!await exited(child, 15_000)) throw new Error('Forced owned Electron shutdown did not settle', { cause: failure })
    }
    // Kill only observed owned descendants if Main exited before they did.
    for (const pid of pids.filter(pid => pid !== child.pid)) {
      await runFile(powershell(env), ['-NoProfile', '-NonInteractive', '-Command',
        `$owned = Get-Process -Id ${pid} -ErrorAction Ignore; if ($null -ne $owned) { $owned | Stop-Process -Force -ErrorAction Stop } else { exit 0 }`], { env, timeout: 15_000, windowsHide: true })
    }
    await processesGone(pids, env)
    throw new Error('Acceptance required forced process cleanup', { cause: failure })
  }
}

// Never recurse through runtime projections or Windows directory junctions.
async function removeOwned(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) { await unlink(path); return }
  for (const name of await readdir(path)) await removeOwned(join(path, name))
  await rmdir(path)
}

async function applicationPage(app: ElectronApplication): Promise<Page> {
  await app.firstWindow({ timeout: 120_000 })
  await expect.poll(() => app.windows().map(page => page.url()), { timeout: 120_000 })
    .toEqual(expect.arrayContaining([expect.stringMatching(/^dsh-app:\/\/app\//u)]))
  const page = app.windows().find(page => page.url().startsWith('dsh-app://app/'))!
  await page.waitForFunction(() => 'dshDesktop' in window && 'browser' in (window as ProductWindow).dshDesktop!)
  return page
}

async function attach(page: Page, reservation: DesktopBrowserReservation, url: string): Promise<number> {
  return page.evaluate(async ({ reservation, url }) => {
    const guest = document.createElement('webview')
    guest.setAttribute('data-website-login-fixture', reservation.lease)
    guest.setAttribute('name', reservation.lease)
    guest.setAttribute('partition', reservation.partition)
    guest.setAttribute('allowpopups', '')
    guest.setAttribute('src', `about:blank#${reservation.lease}`)
    guest.style.cssText = 'position:fixed;inset:100px 20px 20px;z-index:10000;display:flex'
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Native guest lease attachment timed out')) }, 15_000)
      const cleanup = (): void => { clearTimeout(timer); guest.removeEventListener('dom-ready', ready); guest.removeEventListener('destroyed', destroyed) }
      const ready = (): void => { cleanup(); resolve() }
      const destroyed = (): void => { cleanup(); reject(new Error('Main rejected the native guest lease/partition')) }
      guest.addEventListener('dom-ready', ready)
      guest.addEventListener('destroyed', destroyed)
      document.body.append(guest)
    })
    await guest.loadURL(url)
    return guest.getWebContentsId()
  }, { reservation, url })
}

async function state(app: ElectronApplication, id: number): Promise<string | null> {
  return app.evaluate(async ({ webContents }, id) => {
    const guest = webContents.fromId(id)
    if (!guest || guest.isDestroyed()) throw new Error('Expected website guest was destroyed')
    return guest.executeJavaScript("document.querySelector('#state')?.textContent ?? null") as Promise<string | null>
  }, id)
}

async function signIn(app: ElectronApplication, id: number, cookieValue = 'signed-in'): Promise<void> {
  await app.evaluate(async ({ webContents }, id) => {
    const guest = webContents.fromId(id)
    if (!guest || guest.isDestroyed()) throw new Error('Login guest is unavailable')
    await guest.executeJavaScript(`
      document.querySelector('[name=username]').value = 'fixture-user';
      document.querySelector('[name=password]').value = 'fixture-password';
      setTimeout(() => document.querySelector('form').requestSubmit(), 0);
    `)
  }, id)
  await expect.poll(() => state(app, id), { timeout: 15_000 }).toBe('authenticated')
  const cookies = await app.evaluate(async ({ webContents }, id) => {
    const guest = webContents.fromId(id)
    if (!guest) throw new Error('Login guest is unavailable')
    return guest.session.cookies.get({ name: 'fixture_login' })
  }, id)
  expect(cookies).toEqual([expect.objectContaining({ value: cookieValue, httpOnly: true })])
}

async function gone(app: ElectronApplication, id: number): Promise<void> {
  expect(await app.evaluate(({ webContents }, id) => {
    const guest = webContents.fromId(id)
    return guest === undefined || guest.isDestroyed()
  }, id)).toBe(true)
}

async function removeTag(page: Page, lease: DesktopBrowserReservation['lease']): Promise<void> {
  await page.evaluate((lease) => { document.querySelector(`[data-website-login-fixture="${lease}"]`)?.remove() }, lease)
}

async function configureMcp(page: Page, url: string): Promise<void> {
  await page.getByRole('button', { name: /No accounts saved/u }).click({ timeout: 120_000 })
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'MCP Servers', exact: true }).click()
  await page.getByRole('button', { name: /Add MCP server/u }).click()
  await page.getByLabel('Display name', { exact: true }).fill('Website acceptance MCP')
  await page.getByLabel('Tool namespace', { exact: true }).fill('website_fixture')
  await page.getByLabel('Server URL', { exact: true }).fill(url)
  await page.getByRole('button', { name: 'Save server', exact: true }).click()
  const card = page.getByRole('listitem').filter({ has: page.getByText('Website acceptance MCP', { exact: true }) })
  await expect.poll(() => card.innerText(), { timeout: 30_000 }).toContain('Connected')
}

async function pairProfile(app: ElectronApplication, page: Page, origin: string, mcpUrl: string, accountLabel: string) {
  const creating = page.evaluate(input => (window as ProductWindow).dshDesktop!.browser.profiles.create(input), {
    name: 'Website acceptance', accountLabel, url: `${origin}/`, mcpServerName: 'website_fixture',
  })
  void creating.catch((error: unknown) => { void error /* Awaited after confirmation; shutdown cancels a pending prompt. */ })
  const confirmationUrl = 'dsh-app://shell/update-dialog.html'
  await expect.poll(() => app.windows().map(window => window.url()), { timeout: 30_000 }).toContain(confirmationUrl)
  const confirmation = app.windows().find(window => window.url() === confirmationUrl)!
  await expect.poll(() => confirmation.title()).toBe('Pair website account')
  const confirmationText = await confirmation.getByRole('dialog').innerText()
  for (const detail of ['website_fixture', mcpUrl, origin, accountLabel]) expect(confirmationText).toContain(detail)
  await confirmation.getByRole('button', { name: 'Confirm pairing', exact: true }).click()
  const profile = await creating
  expect(profile.control).toBe('human')
  return profile
}

async function sessionLogs(root: string): Promise<string[]> {
  const decompress = promisify(zstdDecompress)
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) result.push(...await sessionLogs(path))
    else if (entry.isFile() && /^session\.v\d+\.jsonl(?:\.zstd)?$/u.test(entry.name)) {
      const bytes = await readFile(path)
      if (entry.name.endsWith('.zstd')) {
        const scanned = scanZstdFrames(bytes)
        if (scanned.tornStart !== undefined) throw new Error('Owned Session has an incomplete durable frame')
        const frames = await Promise.all(scanned.frames.map(({ start, end }) => decompress(bytes.subarray(start, end))))
        result.push(Buffer.concat(frames).toString('utf8'))
      } else result.push(bytes.toString('utf8'))
    }
  }
  return result
}

describe.skipIf(missing.length > 0)(`built Native Website login${missing.length ? ` (missing artifacts: ${missing.join(', ')})` : ''}`, () => {
  it('isolates account login, preserves it on reacquire, and durably clears sign-out and forgotten profiles', async () => {
    if (process.platform !== 'win32') throw new Error('Native dialog automation requires an interactive Windows desktop')
    expect(readClientBuildRecord(repository).environment.DSH_CLIENT_BUILD_PROFILE,
      'Native Website acceptance requires build:custom-harness artifacts').toBe('custom-harness')
    const root = mkdtempSync(join(tmpdir(), 'dsh-website-login-'))
    const env = childEnvironment(root)
    const login = loginFixture()
    const mcp = mcpFixture()
    let app: ElectronApplication | undefined
    const cleanupErrors: unknown[] = []
    try {
      const loginOrigin = await listen(login)
      const mcpUrl = `${await listen(mcp.server)}/mcp`
      await new DesktopProjectManager(resolveDesktopPaths(env.DSH_HOME, env.DSH_DESKTOP_PROFILE_DIR), { dsh: project }).applyRelease()
      writeFileSync(join(env.DSH_DESKTOP_PROFILE_DIR!, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
      const launch = async (): Promise<Page> => {
        app = await _electron.launch({
          executablePath: electronExecutable,
          args: [desktop, '--lang=en-US', '--enable-logging=stderr'], env, cwd: desktop, timeout: 120_000,
        })
        return applicationPage(app)
      }
      const restart = async (): Promise<Page> => {
        await stopDesktop(app!, env)
        app = undefined
        const page = await launch()
        // Preload readiness precedes Host boot; use the persisted connection's visible readiness.
        await page.getByRole('button', { name: /No accounts saved/u }).click({ timeout: 120_000 })
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
        await page.getByRole('button', { name: 'MCP Servers', exact: true }).click()
        const card = page.getByRole('listitem').filter({ has: page.getByText('Website acceptance MCP', { exact: true }) })
        await expect.poll(() => card.innerText(), { timeout: 30_000 }).toContain('Connected')
        await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
        return page
      }
      let page = await launch()
      await configureMcp(page, mcpUrl)
      expect(mcp.methods).toContain('initialize')
      expect(mcp.methods).toContain('tools/list')
      // Public locale notification controls Main's real dialog language, without replacing its handler.
      await page.evaluate(() => { (window as Window & { __DSH_LOCALE__?: { onChange(locale: string): void } }).__DSH_LOCALE__!.onChange('en') })
      const profile = await pairProfile(app!, page, loginOrigin, mcpUrl, 'Fixture account')
      const second = await pairProfile(app!, page, loginOrigin, mcpUrl, 'Second fixture account')
      const acquire = (id: DesktopWebsiteProfileId): Promise<DesktopBrowserReservation> =>
        page.evaluate(id => (window as ProductWindow).dshDesktop!.browser.profiles.acquire(id), id)
      const profiles = () => page.evaluate(() => (window as ProductWindow).dshDesktop!.browser.profiles.list())
      let reservation = await acquire(profile.id)
      expect(reservation.partition).toBe(`persist:dsh-website-${profile.id}`)
      let guest = await attach(page, reservation, loginOrigin)
      await signIn(app!, guest)
      let secondReservation = await acquire(second.id)
      expect(secondReservation.partition).not.toBe(reservation.partition)
      let secondGuest = await attach(page, secondReservation, loginOrigin)
      expect(await state(app!, secondGuest)).toBe('anonymous')
      await signIn(app!, secondGuest)
      const anonymous = await page.evaluate(() => (window as ProductWindow).dshDesktop!.browser.acquire('website-login-anonymous'))
      const anonymousGuest = await attach(page, anonymous, loginOrigin)
      expect(await state(app!, anonymousGuest)).toBe('anonymous')
      await page.evaluate(lease => (window as ProductWindow).dshDesktop!.browser.release(lease), anonymous.lease)
      await gone(app!, anonymousGuest)
      await removeTag(page, anonymous.lease)
      await page.evaluate(lease => (window as ProductWindow).dshDesktop!.browser.release(lease), reservation.lease)
      await gone(app!, guest)
      await removeTag(page, reservation.lease)
      reservation = await acquire(profile.id)
      guest = await attach(page, reservation, loginOrigin)
      expect(await state(app!, guest)).toBe('authenticated')
      page = await restart()
      reservation = await acquire(profile.id)
      guest = await attach(page, reservation, loginOrigin)
      expect(await state(app!, guest)).toBe('authenticated')
      secondReservation = await acquire(second.id)
      secondGuest = await attach(page, secondReservation, loginOrigin)
      expect(await state(app!, secondGuest)).toBe('authenticated')
      await page.evaluate(id => (window as ProductWindow).dshDesktop!.browser.profiles.signOut(id), profile.id)
      expect(await state(app!, secondGuest)).toBe('authenticated')
      await gone(app!, guest)
      await removeTag(page, reservation.lease)
      expect(await profiles()).toEqual([
        expect.objectContaining({ id: profile.id, control: 'human' }), expect.objectContaining({ id: second.id, control: 'human' }),
      ])
      reservation = await acquire(profile.id)
      guest = await attach(page, reservation, loginOrigin)
      expect(await state(app!, guest)).toBe('anonymous')
      page = await restart()
      expect(await profiles()).toEqual([
        expect.objectContaining({ id: profile.id, control: 'human' }), expect.objectContaining({ id: second.id, control: 'human' }),
      ])
      reservation = await acquire(profile.id)
      guest = await attach(page, reservation, loginOrigin)
      expect(await state(app!, guest)).toBe('anonymous')
      await signIn(app!, guest)
      await page.evaluate(id => (window as ProductWindow).dshDesktop!.browser.profiles.forget(id), profile.id)
      await gone(app!, guest)
      await removeTag(page, reservation.lease)
      expect(await profiles()).toEqual([expect.objectContaining({ id: second.id, control: 'human' })])
      await expect(acquire(profile.id)).rejects.toThrow()
      page = await restart()
      expect(await profiles()).toEqual([expect.objectContaining({ id: second.id, control: 'human' })])
      secondReservation = await acquire(second.id)
      secondGuest = await attach(page, secondReservation, loginOrigin)
      expect(await state(app!, secondGuest)).toBe('authenticated')
      await page.evaluate(id => (window as ProductWindow).dshDesktop!.browser.profiles.forget(id), second.id)
      await gone(app!, secondGuest)
      await removeTag(page, secondReservation.lease)
      expect(await profiles()).toEqual([])
      // Observe the abandoned partition after restart; do not fabricate a lease or inject cookies.
      expect(await app!.evaluate(async ({ session }, partition) => session.fromPartition(partition).cookies.get({ name: 'fixture_login' }), reservation.partition)).toEqual([])
      await stopDesktop(app!, env)
      app = undefined
    } catch (error) {
      cleanupErrors.push(error)
      if (app) {
        try {
          const windows = await Promise.all(app.windows().filter(page => page.url().startsWith('dsh-app://app/') || page.url() === 'dsh-app://shell/update-dialog.html')
            .map(async page => ({ url: page.url(), text: (await page.locator('body').innerText({ timeout: 2_000 })).slice(0, 8_000) })))
          cleanupErrors.push(new Error(`Native application output: ${JSON.stringify(windows)}`))
        } catch (diagnosticError) { cleanupErrors.push(diagnosticError) }
      }
    } finally {
      let desktopSettled = app === undefined
      if (app) {
        try {
          await stopDesktop(app, env)
          desktopSettled = true
        } catch (error) { cleanupErrors.push(error) }
      }
      for (const server of [login, mcp.server]) {
        if (server.listening) {
          try { await closeServer(server) } catch (error) { cleanupErrors.push(error) }
        }
      }
      // Unsettled or forced shutdown retains the root rather than deleting live process state.
      if (desktopSettled) {
        try { await removeOwned(root) } catch (error) { cleanupErrors.push(error) }
      } else {
        cleanupErrors.push(new Error(`Desktop shutdown was not accepted; retained test root: ${root}`))
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Website acceptance or cleanup failed')
    }
  }, 300_000)

  it('uses a genuine Agent, fresh approval and the same native guest through Human takeover', async () => {
    if (process.platform !== 'win32') throw new Error('Native acceptance requires an interactive Windows desktop')
    expect(readClientBuildRecord(repository).environment.DSH_CLIENT_BUILD_PROFILE).toBe('custom-harness')
    const root = mkdtempSync(join(tmpdir(), 'dsh-website-agent-'))
    const env = childEnvironment(root)
    env.DEEPSEEK_API_KEY = 'fixture-key-not-an-external-credential'
    const model = websiteModelFixture()
    const mcp = mcpFixture()
    const privateCookie = 'HUMAN_PRIVATE_COOKIE_VALUE'
    const humanOnly = ['HUMAN_PRIVATE_TITLE', 'HUMAN_PRIVATE_BODY', 'HUMAN_PRIVATE_PATH', 'HUMAN_PRIVATE_QUERY', 'HUMAN_PRIVATE_INPUT', 'fixture-password', privateCookie]
    const approvedTitle = 'APPROVED_WEBSITE_TITLE'
    const website = loginFixture(privateCookie)
    let app: ElectronApplication | undefined
    let restored: (() => Promise<void>) | undefined
    let view: Page | undefined
    let failure: unknown
    const cleanupErrors: unknown[] = []
    try {
      const origin = await listen(website)
      const mcpUrl = `${await listen(mcp.server)}/mcp`
      const modelUrl = await listen(model.server)
      await new DesktopProjectManager(resolveDesktopPaths(env.DSH_HOME, env.DSH_DESKTOP_PROFILE_DIR), { dsh: project }).applyRelease()
      writeFileSync(join(env.DSH_DESKTOP_PROFILE_DIR!, 'cordis.patch.yml'),
        '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n'
        + `- id: llm-deepseek\n  disabled: false\n  config:\n    baseURL: ${modelUrl}\n    thinking: disabled\n`
        + '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n    reasoningEffort: off\n'
        + '- id: tools\n  config:\n    mode: native\n')
      app = await _electron.launch({ executablePath: electronExecutable,
        args: [desktop, '--lang=en-US', '--enable-logging=stderr'], env, cwd: desktop, timeout: 120_000 })
      const activeApp = app
      const page = await applicationPage(app)
      view = page
      await configureMcp(page, mcpUrl)
      await page.evaluate(() => { (window as Window & { __DSH_LOCALE__?: { onChange(locale: string): void } }).__DSH_LOCALE__!.onChange('en') })
      const profile = await pairProfile(app, page, origin, mcpUrl, 'Agent fixture account')
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
      const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
      await composer.fill(`${model.marker}: request the saved Agent fixture account, wait for Human Resume, and read only the approved page title and origin.`)
      await composer.press('Enter')
      await expect.poll(() => { expect(model.errors).toEqual([]); return model.held.has('prepared') }, { timeout: 60_000 }).toBe(true)
      expect(model.receipt?.profileId).toBe(profile.id)
      const requestId = model.receipt!.requestId
      await page.locator('[data-sidebar-right-expand]').click()
      await page.locator('[data-sidebar-right-guide-entry="browser"]').click()
      const right = page.locator('[data-rightbar-col]')
      await right.getByRole('button', { name: 'Saved website profiles', exact: true }).click()
      await page.getByRole('menuitem').filter({ hasText: profile.name }).click()
      await right.getByText('Human control', { exact: true }).waitFor()
      const guestTag = '[data-sidebar-browser-frame="webview"]'
      await page.locator(guestTag).waitFor()
      const guestId = (): Promise<number> => page.evaluate((selector) => {
        const guest = document.querySelector<WebviewTag>(selector)
        if (!guest) throw new Error('Product-created Website guest is unavailable')
        return guest.getWebContentsId()
      }, guestTag)
      await expect.poll(guestId, { timeout: 20_000 }).toBeGreaterThan(0)
      const nativeId = await guestId()
      expect(await page.locator(guestTag).getAttribute('partition')).toBe(`persist:dsh-website-${profile.id}`)
      // A native ID exists before the product's initial website navigation has loaded.
      await expect.poll(() => state(activeApp, nativeId), { timeout: 15_000 }).toBe('anonymous')
      // Human login and private-page setup run outside Agent execution.
      await signIn(app, nativeId, privateCookie)
      await app.evaluate(async ({ webContents }, { id, url, privateData }) => {
        const guest = webContents.fromId(id)
        if (!guest) throw new Error('Product-created Website guest was destroyed')
        await guest.loadURL(url)
        await guest.executeJavaScript(`
          document.title = ${JSON.stringify(privateData.title)};
          document.body.append(Object.assign(document.createElement('p'), { textContent: ${JSON.stringify(privateData.body)} }));
          document.querySelector('[name=password]').value = ${JSON.stringify(privateData.input)}; void 0;
        `)
      }, { id: nativeId, url: `${origin}/${humanOnly[2]}?secret=${humanOnly[3]}`,
        privateData: { title: humanOnly[0]!, body: humanOnly[1]!, input: humanOnly[4]! } })
      // The Human-facing address bar may read its own title; it must not count as an Agent observation.
      await page.evaluate(() => {
        const guest = document.querySelector<WebviewTag>('[data-sidebar-browser-frame="webview"]')
        if (!guest) throw new Error('Product-created Website frame is missing')
        const descriptor = Object.getOwnPropertyDescriptor(guest, 'getTitle')
        ;(window as ProductWindow).__websiteNativeTitleRestore = () => {
          if (descriptor) Object.defineProperty(guest, 'getTitle', descriptor)
          else Reflect.deleteProperty(guest, 'getTitle')
          delete (window as ProductWindow).__websiteNativeTitleRestore
        }
        guest.getTitle = () => 'Human website page'
      })
      await app.evaluate(({ webContents }, id) => {
        const guest = webContents.fromId(id)
        if (!guest) throw new Error('Product-created Website guest was destroyed')
        const count = { title: 0, dom: 0, image: 0 }
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Exact methods are restored; calls bind their guest.
        const original = { title: guest.getTitle, javascript: guest.executeJavaScript, image: guest.capturePage }
        const title = original.title.bind(guest)
        const javascript = original.javascript.bind(guest)
        const image = original.image.bind(guest)
        guest.getTitle = () => { count.title++; return title() }
        guest.executeJavaScript = (code, gesture) => { count.dom++; return javascript(code, gesture) }
        guest.capturePage = (rect, options) => { count.image++; return image(rect, options) }
        Reflect.set(globalThis, '__websiteNativeFixture', {
          count,
          setTitle: async (approved: string): Promise<void> => {
            await javascript(`document.title = ${JSON.stringify(approved)}; void 0`)
          },
          restore: () => {
            guest.getTitle = original.title; guest.executeJavaScript = original.javascript; guest.capturePage = original.image
            Reflect.deleteProperty(globalThis, '__websiteNativeFixture')
          },
        })
      }, nativeId)
      restored = async () => {
        await page.evaluate(() => { (window as ProductWindow).__websiteNativeTitleRestore?.() })
        await activeApp.evaluate(() => { (globalThis as ProbedGlobal).__websiteNativeFixture?.restore() })
      }
      const counts = () => activeApp.evaluate(() => (globalThis as ProbedGlobal).__websiteNativeFixture!.count)
      const noHumanLeak = (): void => {
        const text = JSON.stringify(model.requests)
        expect(humanOnly.some(secret => text.includes(secret)), 'Human-only page data reached the provider').toBe(false)
      }
      noHumanLeak()
      expect(await counts()).toEqual({ title: 0, dom: 0, image: 0 })
      await right.getByRole('button', { name: 'Choose a request', exact: true }).click()
      await page.getByRole('menuitem', { name: `Request ${requestId}`, exact: true }).click()
      // The Human chooses which title may be observed; this write is outside Agent measurement.
      await app.evaluate(async (_electron, title) => {
        await (globalThis as ProbedGlobal).__websiteNativeFixture!.setTitle(title)
      }, approvedTitle)
      await right.getByRole('button', { name: 'Resume', exact: true }).click()
      await right.getByText('Agent control', { exact: true }).waitFor()
      expect(await guestId()).toBe(nativeId)
      model.release('prepared')
      const consent = page.locator('[data-approval-key]')
      await consent.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ timeout: 30_000 })
      const firstApproval = await consent.getAttribute('data-approval-key')
      expect(await counts()).toEqual({ title: 0, dom: 0, image: 0 })
      await consent.getByRole('button', { name: 'Allow once', exact: true }).click()
      await expect.poll(() => model.held.has('observed') || model.errors.length > 0, { timeout: 30_000 }).toBe(true)
      noHumanLeak()
      expect(model.errors, JSON.stringify(model.observationResult)).toEqual([])
      expect(model.observed).toEqual({ origin, title: approvedTitle, titleTruncated: false })
      expect(await counts()).toEqual({ title: 1, dom: 0, image: 0 })
      noHumanLeak()
      model.release('observed')
      await consent.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ timeout: 30_000 })
      expect(await consent.getAttribute('data-approval-key')).not.toBe(firstApproval)
      await right.getByRole('button', { name: 'Take control', exact: true }).click()
      await right.getByText('Human control', { exact: true }).waitFor()
      await expect.poll(() => { expect(model.errors).toEqual([]); return model.held.has('taken-over') }, { timeout: 30_000 }).toBe(true)
      expect(model.denied).toBe(true)
      expect(await consent.count()).toBe(0)
      expect(await counts()).toEqual({ title: 1, dom: 0, image: 0 })
      expect(await guestId()).toBe(nativeId)
      noHumanLeak()
      await right.getByRole('button', { name: 'Resume', exact: true }).click()
      await right.getByText('Agent control', { exact: true }).waitFor()
      model.release('taken-over')
      await consent.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ timeout: 30_000 })
      expect(await consent.getAttribute('data-approval-key')).not.toBe(firstApproval)
      await consent.getByRole('button', { name: 'Allow once', exact: true }).click()
      await page.getByText('WEBSITE_AGENT_COMPLETE', { exact: true }).waitFor({ timeout: 30_000 })
      expect(await guestId()).toBe(nativeId)
      expect(await counts()).toEqual({ title: 2, dom: 0, image: 0 })
      noHumanLeak()
      await restored()
      restored = undefined
      await stopDesktop(app, env)
      app = undefined
      const logs = await sessionLogs(join(env.DSH_HOME!, 'sessions'))
      const log = logs.find(text => text.includes(model.marker))
      expect(log !== undefined, 'Genuine Agent Session was not durably recorded').toBe(true)
      expect(humanOnly.some(secret => logs.some(text => text.includes(secret))), 'Human-only data entered a durable Session').toBe(false)
      expect(log).toContain('approval/decided')
      expect(log).toContain('allowed-once')
      expect(log).toContain('native_info_denied')
      expect(log).toContain(approvedTitle)
      expect(log).toContain('WEBSITE_AGENT_COMPLETE')
    } catch (error) {
      failure = error
      throw error
    } finally {
      if (app && view && failure !== undefined) {
        try {
          await view.keyboard.press('Escape')
          const stop = view.getByRole('button', { name: 'Stop', exact: true })
          if (await stop.count()) await stop.click({ timeout: 5_000 })
        } catch (error) { cleanupErrors.push(error) }
      }
      model.dispose()
      if (restored) { try { await restored() } catch (error) { cleanupErrors.push(error) } }
      let settled = app === undefined
      if (app) {
        try { await stopDesktop(app, env); settled = true } catch (error) { cleanupErrors.push(error) }
      }
      for (const server of [model.server, website, mcp.server]) {
        if (server.listening) { try { await closeServer(server) } catch (error) { cleanupErrors.push(error) } }
      }
      if (settled && failure === undefined) { try { await removeOwned(root) } catch (error) { cleanupErrors.push(error) } }
      else cleanupErrors.push(new Error(`Native Agent ${settled ? 'scenario failed' : 'shutdown was not accepted'}; retained test root: ${root}`))
      if (cleanupErrors.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupErrors], 'Native Agent acceptance cleanup failed')
    }
  }, 300_000)
})
