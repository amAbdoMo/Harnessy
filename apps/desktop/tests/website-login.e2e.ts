/**
 * Built Windows Desktop acceptance through real Main, Host, preload and native guests.
 * Only owned website/MCP/model endpoints are fixtures. Pairing uses Main's real shell confirmation;
 * guest attachment uses the shipped lease/partition handshake, not a fake bridge.
 * Requires an interactive Windows desktop and completed Host/Desktop builds.
 * The Agent scenario uses an owned Messages provider, genuine Session/tool execution and live consent.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { lstat, readFile, readdir, rmdir, unlink } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { Duplex } from 'node:stream'
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

/** Ephemeral PFX bytes only; CertificateRequest never opens or changes an OS certificate store. */
async function localDeviceCertificate(env: Record<string, string>) {
  const { stdout } = await runFile(process.env.DSH_TEST_PWSH_PATH ?? 'pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `
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
  if (typeof value !== 'object' || value === null || !('pfx' in value) || typeof value.pfx !== 'string'
    || !('der' in value) || typeof value.der !== 'string') throw new Error('In-memory TLS fixture generation returned invalid certificate bytes')
  const certificate = new X509Certificate(Buffer.from(value.der, 'base64'))
  if (certificate.checkIP('127.0.0.1') !== '127.0.0.1' || Date.parse(certificate.validFrom) >= Date.now()
    || Date.parse(certificate.validTo) <= Date.now()) throw new Error('Owned TLS certificate is not currently valid for loopback')
  // Electron exposes the SHA-256 digest as sha256/base64, rather than Node's colon-separated hex.
  const fingerprint = `sha256/${Buffer.from(certificate.fingerprint256.replaceAll(':', ''), 'hex').toString('base64')}`
  return { pfx: Buffer.from(value.pfx, 'base64'), fingerprint }
}

/** Bounded loopback fixture, including raw TLS sockets that HTTP closeAllConnections does not cover. */
function localDeviceFixture(certificate: Awaited<ReturnType<typeof localDeviceCertificate>>) {
  const requests: string[] = []
  const sockets = new Set<Duplex>()
  let otherOrigin = ''
  const server = createHttpsServer({ pfx: certificate.pfx, passphrase: 'fixture', handshakeTimeout: 5_000 }, (request, response) => {
    response.setHeader('cache-control', 'no-store')
    if (requests.length >= 128) { response.writeHead(429).end(); return }
    requests.push(`${request.method} ${request.url}`)
    if (request.url === '/relative.js' || request.url === '/denied.js') {
      response.setHeader('content-type', 'text/javascript')
      response.end('document.title = "Local device relative script loaded"')
    } else if (request.url === '/other-port') {
      response.setHeader('content-type', 'text/html')
      response.end(`<title>Waiting for other port</title><script>
        const script = document.createElement('script');
        script.src = ${JSON.stringify(`${otherOrigin}/denied.js`)};
        script.onload = () => { document.title = 'UNSAFE other port loaded' };
        script.onerror = () => { document.title = 'Other local TLS port blocked' };
        document.head.append(script);
      </script>`)
    } else {
      response.setHeader('content-type', 'text/html')
      response.end(`<title>Waiting for relative script</title><script src="/relative.js"></script>
        <form action="${otherOrigin}/tls-transition" method="post"><button>Leave with POST</button></form>`)
    }
  })
  server.maxConnections = 16
  server.maxRequestsPerSocket = 16
  server.requestTimeout = 5_000
  server.headersTimeout = 5_000
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
  const disconnect = async (): Promise<void> => {
    await Promise.all([...sockets].map(socket => new Promise<void>((resolve) => {
      socket.once('close', () => { resolve() })
      socket.destroy()
    })))
  }
  return {
    server, requests,
    configure(other: string): void { otherOrigin = other },
    async replace(next: Awaited<ReturnType<typeof localDeviceCertificate>>): Promise<void> {
      server.setSecureContext({ pfx: next.pfx, passphrase: 'fixture' })
      server.setTicketKeys(randomBytes(48))
      await disconnect()
    },
    async close(): Promise<void> {
      const draining = disconnect()
      await Promise.all([draining, server.listening ? closeServer(server) : Promise.resolve()])
      if (sockets.size !== 0) throw new Error('Owned TLS sockets did not settle after listener close')
    },
  }
}

async function listenHttps(server: HttpsServer): Promise<string> {
  return (await listen(server)).replace('http:', 'https:')
}

async function activeBrowserGuest(page: Page): Promise<number> {
  return page.locator('[data-sidebar-browser-frame="webview"]:visible').evaluate((element) => {
    const guest = element as WebviewTag
    return guest.getWebContentsId()
  })
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
    APPDATA: join(root, 'user', 'AppData', 'Roaming'), LOCALAPPDATA: join(root, 'user', 'AppData', 'Local'),
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

// Native automation invokes only the exact button in the exact owned process/dialog.
// It never replaces showMessageBox or sends global keystrokes to the installed GUI.
function nativeDialog(
  pid: number, title: string, button: string, detail: readonly string[], env: Record<string, string>, optional = false,
  options: { readonly seconds?: number; readonly fingerprint?: string; readonly nativeHandle?: string } = {},
) {
  const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`
  const command = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OwnedNativeWindows {
  public delegate bool Callback(IntPtr handle, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr handle, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  public static void ClickTaskButton(IntPtr dialog, IntPtr control, uint pid, int id) {
    if (Owner(dialog) != pid || Owner(control) != pid || GetAncestor(control, 2) != dialog)
      throw new InvalidOperationException("NATIVE_CONTROL_OWNER_MISMATCH: dialog.pid=" + Owner(dialog) + " control.pid=" + Owner(control) + " expected.pid=" + pid + " control.root=" + GetAncestor(control, 2) + " expected.dialog=" + dialog);
    if (!IsWindowVisible(dialog) || !IsWindowVisible(control)) throw new InvalidOperationException("Native confirmation is not visible");
    IntPtr result;
    // TDM_CLICK_BUTTON dispatches the registered button through the native TaskDialog procedure.
    if (SendMessageTimeout(dialog, 0x400 + 102, new IntPtr(id), IntPtr.Zero, 3, 2000, out result) == IntPtr.Zero)
      throw new InvalidOperationException("Native TaskDialog click did not complete");
  }
  public static uint Owner(IntPtr handle) { uint pid; GetWindowThreadProcessId(handle, out pid); return pid; }
  public static IntPtr[] ForProcess(uint pid) {
    var handles = new List<IntPtr>();
    EnumWindows((handle, data) => { if (Owner(handle) == pid) handles.Add(handle); return true; }, IntPtr.Zero);
    return handles.ToArray();
  }
}
'@
${options.nativeHandle === undefined ? '' : `
$mainHandle = [IntPtr]::new([long]${options.nativeHandle})
$mainOwner = [OwnedNativeWindows]::Owner($mainHandle)
if ($mainOwner -ne ${pid}) { throw ('NATIVE_OWNER_MISMATCH: expected ${pid}, actual ' + $mainOwner) }
$mainElement = [System.Windows.Automation.AutomationElement]::FromHandle($mainHandle)
if ($mainElement.Current.ProcessId -ne ${pid}) { throw 'NATIVE_UIA_OWNER_MISMATCH' }
[Console]::WriteLine(('OWNED_MAIN: handle=' + $mainHandle + ' owner=' + $mainOwner + ' visible=' + [OwnedNativeWindows]::IsWindowVisible($mainHandle) + ' UIA.pid=' + $mainElement.Current.ProcessId + ' UIA.name=' + $mainElement.Current.Name + ' UIA.class=' + $mainElement.Current.ClassName))
`}
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${pid})
$deadline = [DateTime]::UtcNow.AddSeconds(${options.seconds ?? 45})
$ownedDialogs = @()
[Console]::WriteLine('READY')
while ([DateTime]::UtcNow -lt $deadline) {
  if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) {
    ${optional ? 'exit 0' : "throw 'Owned Electron exited before native pairing confirmation'"}
  }
  $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  $windows = @($roots)
  foreach ($root in $roots) {
    $windows += @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
  }
  $ownedDialogs = @($windows | ForEach-Object { $_.Current.Name + '[' + $_.Current.ClassName + ']' })
  :ownedWindow foreach ($window in $windows) {
    if ($window.Current.ClassName -ne '#32770') { continue }
    if ($window.Current.Name -ne ${literal(title)}) { continue }
    ${options.nativeHandle === undefined ? '' : `
    $dialogHandle = [IntPtr]::new($window.Current.NativeWindowHandle)
    if ([OwnedNativeWindows]::Owner($dialogHandle) -ne ${pid} -or $window.Current.ProcessId -ne ${pid} -or [OwnedNativeWindows]::GetWindow($dialogHandle, 4) -ne $mainHandle) {
      throw 'NATIVE_DIALOG_OWNER_MISMATCH: task dialog is not owned by the exact Main window'
    }
    [Console]::WriteLine(('OWNED_DIALOG: handle=' + $dialogHandle + ' ownerWindow=' + $mainHandle + ' visible=' + [OwnedNativeWindows]::IsWindowVisible($dialogHandle)))
    `}
    $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $text = ($elements | ForEach-Object { $_.Current.Name }) -join "\n"
    foreach ($required in @(${detail.map(literal).join(',')})) {
      if (-not $text.Contains($required)) { ${optional ? 'continue ownedWindow' : "throw ('Native dialog lacks expected pairing detail: ' + $required)"} }
    }
    ${options.fingerprint === undefined ? '' : `if (-not $text.Contains(${literal(options.fingerprint)})) { throw ('Native TLS dialog lacks the owned certificate fingerprint; expected: ${options.fingerprint}; owned text: ' + $text) }`}
    foreach ($element in $elements) {
      $commandButton = $element.Current.ControlType.Id -eq [System.Windows.Automation.ControlType]::Button.Id -or ($element.Current.ControlType.Id -eq [System.Windows.Automation.ControlType]::Pane.Id -and $element.Current.AutomationId -match '^CommandButton_[0-9]+$')
      if ($commandButton -and $element.Current.Name -eq ${literal(button)}) {
        if ($element.Current.ProcessId -ne ${pid} -or -not $element.Current.IsEnabled) { throw 'Native confirmation control is not enabled in the exact owned process' }
        [Console]::WriteLine(('OWNED_CONTROL: name=' + $element.Current.Name + ' type=' + $element.Current.ControlType.ProgrammaticName + ' id=' + $element.Current.AutomationId + ' patterns=' + (($element.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ',')))
        $controlHandle = [IntPtr]::new($element.Current.NativeWindowHandle)
        [Console]::WriteLine(('OWNED_CONTROL_NATIVE: handle=' + $controlHandle + ' class=' + $element.Current.ClassName + ' framework=' + $element.Current.FrameworkId))
        if ($controlHandle -ne [IntPtr]::Zero) {
          if ([OwnedNativeWindows]::Owner($controlHandle) -ne ${pid}) { throw 'NATIVE_CONTROL_OWNER_MISMATCH' }
          $direct = [System.Windows.Automation.AutomationElement]::FromHandle($controlHandle)
          if ($direct.Current.ProcessId -ne ${pid} -or $direct.Current.Name -ne ${literal(button)} -or $direct.Current.AutomationId -ne $element.Current.AutomationId) { throw 'NATIVE_CONTROL_IDENTITY_MISMATCH' }
          [Console]::WriteLine(('OWNED_CONTROL_DIRECT: name=' + $direct.Current.Name + ' type=' + $direct.Current.ControlType.ProgrammaticName + ' patterns=' + (($direct.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ',')))
        }
        $clickedDialog = [IntPtr]::new($window.Current.NativeWindowHandle)
        $invoke = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
          $invoke.Invoke()
        } ${options.nativeHandle === undefined ? '' : `elseif ($element.Current.ClassName -eq 'CCPushButton' -and $element.Current.FrameworkId -eq 'DirectUI' -and $element.Current.AutomationId -match '^CommandButton_([0-9]+)$') {
          # DirectUI registers TaskDialog IDs in CommandButton_<id>; its child HWND has Win32 control ID zero.
          [OwnedNativeWindows]::ClickTaskButton($dialogHandle, $controlHandle, ${pid}, [int]$Matches[1])
        }`} else { throw 'Exact native confirmation control has no supported invocation capability' }
        $closedDeadline = [DateTime]::UtcNow.AddSeconds(5)
        while ([OwnedNativeWindows]::IsWindow($clickedDialog) -and [DateTime]::UtcNow -lt $closedDeadline) { Start-Sleep -Milliseconds 20 }
        if ([OwnedNativeWindows]::IsWindow($clickedDialog)) { throw 'Native confirmation action did not close the exact dialog' }
        [Console]::WriteLine('CONFIRMED')
        exit 0
      }
    }
    $controls = @($elements | ForEach-Object { 'name=' + $_.Current.Name + ' type=' + $_.Current.ControlType.ProgrammaticName + ' buttonEqual=' + ($_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) + ' id=' + $_.Current.AutomationId })
    throw ('Expected native confirmation button is unavailable; owned controls: ' + ($controls -join ', '))
  }
  Start-Sleep -Milliseconds 50
}
$nativeWindows = @([OwnedNativeWindows]::ForProcess(${pid}) | ForEach-Object {
  $element = [System.Windows.Automation.AutomationElement]::FromHandle($_)
  'handle=' + $_ + ' visible=' + [OwnedNativeWindows]::IsWindowVisible($_) + ' UIA.pid=' + $element.Current.ProcessId + ' UIA.name=' + $element.Current.Name + ' UIA.class=' + $element.Current.ClassName
})
throw ('NATIVE_DIALOG_EXPIRED: owned task dialog names: ' + ($ownedDialogs -join ', ') + '; native windows: ' + ($nativeWindows -join ', '))
`
  const child = spawn(powershell(env), ['-NoProfile', '-NonInteractive', '-Command', command], { env, windowsHide: true })
  let output = ''
  let errors = ''
  let readyResolve: () => void = () => {}
  let readyReject: (error: Error) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (/^READY\r?$/mu.test(output)) readyResolve() })
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString() })
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', (error) => { readyReject(error); reject(error) })
    child.once('close', (code) => {
      if (code === 0 && (optional || /^CONFIRMED\r?$/mu.test(output))) resolve()
      else reject(new Error(`Native dialog helper exited ${code}: ${errors}; ${output}`))
      readyReject(new Error(`Native dialog helper closed before readiness: ${errors || output}`))
    })
  })
  // The owner joins failures below; an early helper failure must not become an unhandled rejection.
  void done.catch(() => {})
  return { child, ready, done, diagnostics: (): string => output }
}

async function nativeMainWindow(app: ElectronApplication): Promise<{ pid: number; nativeHandle: string }> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('dsh-app://app/'))
    if (!window) throw new Error('Owned app BrowserWindow is unavailable')
    const handle = window.getNativeWindowHandle()
    const nativeHandle = (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString()
    return { pid: process.pid, nativeHandle }
  })
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
  const main = await nativeMainWindow(app)
  expect(pids, 'Native quit target must belong to the launched test process tree').toContain(main.pid)
  const quit = nativeDialog(main.pid, 'Harnessy', 'Quit', ['Quit Harnessy?'], env, true, { nativeHandle: main.nativeHandle })
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

describe('native dialog source helper', () => {
  it.skipIf(process.platform !== 'win32')('rejects a native handle not owned by the exact target PID', { retry: 0, timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dialog-owner-'))
    const helper = nativeDialog(process.pid, 'Owned nonexistent TLS dialog', 'Cancel', [], childEnvironment(root), false, { nativeHandle: '0' })
    try {
      await expect(helper.ready).rejects.toThrow('NATIVE_OWNER_MISMATCH')
      await expect(helper.done).rejects.toThrow('NATIVE_OWNER_MISMATCH')
      expect(helper.diagnostics()).not.toMatch(/^CONFIRMED\r?$/mu)
      expect(helper.child.exitCode).not.toBeNull()
    } finally { await stopHelper(helper); await removeOwned(root) }
  })

  it.skipIf(process.platform !== 'win32')('reports expiry instead of treating an unconfirmed native dialog as consent', { retry: 0, timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dialog-expiry-'))
    let helper: ReturnType<typeof nativeDialog> | undefined
    try {
      helper = nativeDialog(process.pid, 'Owned nonexistent TLS dialog', 'Cancel', [], childEnvironment(root), false, { seconds: 0.1 })
      await helper.ready
      await expect(helper.done).rejects.toThrow('NATIVE_DIALOG_EXPIRED')
      expect(helper.diagnostics()).not.toMatch(/^CONFIRMED\r?$/mu)
      expect(helper.child.exitCode).not.toBeNull()
    } finally {
      if (helper) await stopHelper(helper)
      await removeOwned(root)
    }
  })
})

describe.skipIf(missing.length > 0)(`built Native Website login${missing.length ? ` (missing artifacts: ${missing.join(', ')})` : ''}`, () => {
  it('native local TLS consent isolates tabs and reacquisition while preserving normal workspace cookies', { retry: 0, timeout: 420_000 }, async () => {
    if (process.platform !== 'win32') throw new Error('Native TLS acceptance requires an interactive Windows desktop')
    expect(readClientBuildRecord(repository).environment.DSH_CLIENT_BUILD_PROFILE,
      'Native TLS acceptance requires root build:custom-harness artifacts').toBe('custom-harness')
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-local-tls-'))
    const env = childEnvironment(root)
    env.DEEPSEEK_API_KEY = 'fixture-key-not-an-external-credential'
    const model = websiteModelFixture()
    const normal = loginFixture()
    const fixtures: ReturnType<typeof localDeviceFixture>[] = []
    const helpers = new Set<ReturnType<typeof nativeDialog>>()
    let app: ElectronApplication | undefined
    let failure: unknown
    const cleanupErrors: unknown[] = []
    try {
      const certificate = await localDeviceCertificate(env)
      const replacement = await localDeviceCertificate(env)
      expect(replacement.fingerprint).not.toBe(certificate.fingerprint)
      const device = localDeviceFixture(certificate)
      fixtures.push(device)
      const otherPort = localDeviceFixture(certificate)
      fixtures.push(otherPort)
      const origin = await listenHttps(device.server)
      const otherOrigin = await listenHttps(otherPort.server)
      const normalOrigin = await listen(normal)
      device.configure(otherOrigin)
      otherPort.configure(origin)
      const modelOrigin = await listen(model.server)
      await new DesktopProjectManager(resolveDesktopPaths(env.DSH_HOME, env.DSH_DESKTOP_PROFILE_DIR), { dsh: project }).applyRelease()
      writeFileSync(join(env.DSH_DESKTOP_PROFILE_DIR!, 'cordis.patch.yml'),
        '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n'
        + `- id: llm-deepseek\n  disabled: false\n  config:\n    baseURL: ${modelOrigin}\n    thinking: disabled\n`
        + '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n    reasoningEffort: off\n'
        + '- id: directory-picker\n  disabled: true\n'
        + '- insert:\n    - id: directory-picker-browse\n      name: "@deepseek-ai/dsh-host-directory-picker-browse"\n'
        + '    - id: ui-directory-picker-browse\n      name: "@deepseek-ai/dsh-client-ui-directory-picker-browse"\n')
      app = await _electron.launch({ executablePath: electronExecutable,
        args: [desktop, '--lang=en-US', '--enable-logging=stderr'], env, cwd: desktop, timeout: 120_000 })
      const activeApp = app
      await activeApp.evaluate(({ app }) => {
        const events: string[] = []
        ;(globalThis as typeof globalThis & { __localTLSFixture?: string[] }).__localTLSFixture = events
        const record = (entry: string): void => { if (events.length < 100) events.push(entry) }
        app.on('web-contents-created', (_event, contents) => {
          if (contents.getType() !== 'webview') return
          contents.on('did-start-navigation', (event) => { record(`${contents.id}:start:${event.url}`) })
          contents.on('dom-ready', () => { record(`${contents.id}:ready`) })
          contents.on('certificate-error', (_event, url, error, certificate, _callback, main) => {
            record(`${contents.id}:certificate:${url}:${error}:${main}:${certificate.fingerprint}`)
          })
          contents.on('did-stop-loading', () => { record(`${contents.id}:stop`) })
          contents.on('did-fail-load', (_event, code, _description, url) => { record(`${contents.id}:fail:${url}:${code}`) })
          contents.on('did-fail-provisional-load', (_event, code, _description, url, main) => {
            record(`${contents.id}:provisional-fail:${url}:${code}:${main}`)
          })
          contents.on('will-frame-navigate', (event) => { record(`${contents.id}:will-frame:${event.url}:${event.isMainFrame}`) })
        })
      })
      const page = await applicationPage(app)
      await page.evaluate(() => { (window as Window & { __DSH_LOCALE__?: { onChange(locale: string): void } }).__DSH_LOCALE__!.onChange('en') })
      const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
      await composer.fill('Create the owned native TLS acceptance session; reply without tools.')
      await composer.press('Enter')
      await page.locator('[data-chat-turn]').getByText('Website acceptance', { exact: true }).last().waitFor({ timeout: 60_000 })
      expect(model.errors).toEqual([])
      await page.locator('[data-sidebar-right-expand]').click()
      await page.locator('[data-sidebar-right-guide-entry="browser"]').click()
      const right = page.locator('[data-rightbar-col]')
      const address = right.getByRole('textbox', { name: 'Enter an HTTP(S) address' })
      const navigate = async (url: string): Promise<void> => { await address.fill(url); await address.press('Enter') }
      const nativeTitle = (id: number): Promise<string> => activeApp.evaluate(({ webContents }, id) => {
        const guest = webContents.fromId(id)
        return guest && !guest.isDestroyed() ? guest.getTitle() : ''
      }, id)
      const current = async (previous?: number): Promise<number> => {
        await expect.poll(async () => {
          const id = await activeBrowserGuest(page)
          return id > 0 && id !== previous
        }, { timeout: 20_000 }).toBe(true)
        return activeBrowserGuest(page)
      }
      const sameSession = (first: number, second: number): Promise<boolean> => activeApp.evaluate(({ webContents }, ids) =>
        webContents.fromId(ids.first)!.session === webContents.fromId(ids.second)!.session, { first, second })
      const partition = (): Promise<string | null> => page.locator('[data-sidebar-browser-frame="webview"]:visible').getAttribute('partition')
      const denied = async (): Promise<void> => {
        await expect.poll(() => right.getByRole('status').allTextContents(), { timeout: 20_000 })
          .toEqual(expect.arrayContaining([expect.stringContaining('ERR_CERT_AUTHORITY_INVALID')]))
      }
      let fingerprintControlChecked = false
      const decide = async (button: 'Cancel' | 'Open device in this tab (unsafe)', fingerprint: string,
        trigger: () => Promise<void>): Promise<void> => {
        const pid = activeApp.process().pid
        if (pid === undefined) throw new Error('Owned Main has no PID for TLS dialog automation')
        const ownedWindow = await nativeMainWindow(activeApp)
        expect(await ownedTree(pid, env), 'Native Main must belong to the launched test process tree').toContain(ownedWindow.pid)
        console.info('TLS native ownership', { launchPid: pid, ...ownedWindow })
        let navigationTriggered = false
        if (!fingerprintControlChecked) {
          const wrong = nativeDialog(ownedWindow.pid, 'Unverified local device', 'Cancel',
            [origin, 'Cancel', 'Open device in this tab (unsafe)'], env, false,
            { fingerprint: 'sha256/not-the-owned-certificate', nativeHandle: ownedWindow.nativeHandle })
          helpers.add(wrong)
          try {
            await wrong.ready
            const outcomes = await Promise.allSettled([wrong.done, trigger()])
            const rejected = outcomes[0]
            expect(rejected.status).toBe('rejected')
            if (rejected.status !== 'rejected') throw new Error('Native helper accepted a mismatched certificate fingerprint')
            const reason: unknown = rejected.reason
            expect(reason).toBeInstanceOf(Error)
            if (!(reason instanceof Error)) throw new Error('Native helper did not report a diagnostic Error')
            expect(reason.message).toContain('Native TLS dialog lacks the owned certificate fingerprint')
            expect(outcomes[1]).toMatchObject({ status: 'fulfilled' })
            expect(wrong.diagnostics()).not.toMatch(/^CONFIRMED\r?$/mu)
            expect(device.requests).toEqual([])
            fingerprintControlChecked = true
            navigationTriggered = true
            console.info('TLS wrong fingerprint rejected without confirmation')
          } finally { await stopHelper(wrong); helpers.delete(wrong) }
        }
        const helper = nativeDialog(ownedWindow.pid, 'Unverified local device', button,
          [origin, 'Cancel', 'Open device in this tab (unsafe)'], env, false, { fingerprint, nativeHandle: ownedWindow.nativeHandle })
        helpers.add(helper)
        try {
          await helper.ready
          const outcomes = await Promise.allSettled([helper.done, navigationTriggered ? Promise.resolve() : trigger()])
          const failures = outcomes.filter(outcome => outcome.status === 'rejected').map((outcome): unknown => outcome.reason)
          if (failures.length !== 0) {
            const details = failures.map(error => error instanceof Error ? error.message : String(error)).join('; ')
            const guestState = await activeApp.evaluate(({ webContents }) => webContents.getAllWebContents()
              .filter(contents => contents.getType() === 'webview').map(contents => ({ id: contents.id,
                url: contents.getURL(), loading: contents.isLoading() })))
            const status = await right.getByRole('status').allTextContents()
            const trace = await activeApp.evaluate(() =>
              (globalThis as typeof globalThis & { __localTLSFixture?: string[] }).__localTLSFixture)
            const observations = JSON.stringify({ guestState, status, partition: await partition(), trace })
            throw new AggregateError(failures, `Native TLS decision or UI navigation failed: ${details}; ${observations}`)
          }
          console.info(`TLS native ${button}: ${helper.diagnostics().trim()}`)
        } finally { await stopHelper(helper); helpers.delete(helper) }
      }
      const destroyed = async (id: number): Promise<void> => {
        await expect.poll(() => activeApp.evaluate(({ webContents }, id) => {
          const guest = webContents.fromId(id)
          return guest === undefined || guest.isDestroyed()
        }, id), { timeout: 15_000 }).toBe(true)
      }
      const openSecond = async (): Promise<void> => {
        await right.getByRole('button', { name: 'New tab', exact: true }).click()
        await right.locator('[data-sidebar-right-guide-entry="browser"]').click()
      }
      const closeSecond = async (id: number, primaryTab: string): Promise<void> => {
        await right.getByRole('tab', { selected: true }).locator('[data-dockkit-tab-close]').click()
        await destroyed(id)
        await right.locator(`[data-dockkit-tab="${primaryTab}"]`).click()
      }

      await navigate(normalOrigin)
      const normalGuest = await current()
      const normalPartition = await partition()
      expect(normalPartition).not.toBeNull()
      const primaryTab = await right.getByRole('tab', { selected: true }).getAttribute('data-dockkit-tab')
      if (!primaryTab) throw new Error('Product Browser tab identity is missing')
      await expect.poll(() => state(activeApp, normalGuest), { timeout: 15_000 }).toBe('anonymous')
      await signIn(activeApp, normalGuest)
      await openSecond()
      await navigate(normalOrigin)
      const sharedGuest = await current()
      expect(await partition()).toBe(normalPartition)
      expect(await sameSession(normalGuest, sharedGuest)).toBe(true)
      await expect.poll(() => state(activeApp, sharedGuest), { timeout: 15_000 }).toBe('authenticated')
      await closeSecond(sharedGuest, primaryTab)

      // The assembled frame must replace its normal guest before private TLS navigation.
      await decide('Cancel', certificate.fingerprint, () => navigate(`${origin}/`))
      await denied()
      const privateGuest = await current()
      const privatePartition = await partition()
      expect(privateGuest).not.toBe(normalGuest)
      expect(privatePartition).not.toBe(normalPartition)
      await destroyed(normalGuest)
      expect(device.requests).toEqual([])
      expect(await activeApp.evaluate(async ({ webContents }, id) =>
        webContents.fromId(id)!.session.cookies.get({ name: 'fixture_login' }), privateGuest)).toEqual([])

      await decide('Open device in this tab (unsafe)', certificate.fingerprint, () => navigate(`${origin}/`))
      expect(await current()).toBe(privateGuest)
      await expect.poll(() => nativeTitle(privateGuest), { timeout: 15_000 }).toBe('Local device relative script loaded')
      expect(device.requests).toEqual(expect.arrayContaining(['GET /', 'GET /relative.js']))
      await navigate(`${origin}/other-port`)
      await expect.poll(() => nativeTitle(privateGuest), { timeout: 15_000 }).toBe('Other local TLS port blocked')
      expect(otherPort.requests).toEqual([])

      // A page-originated POST cannot be reissued as a GET in another origin's Session.
      await navigate(`${origin}/post-normal`)
      await expect.poll(() => nativeTitle(privateGuest), { timeout: 15_000 }).toBe('Local device relative script loaded')
      const postFailure = await activeApp.evaluate(async ({ webContents }, { id, url }) => {
        const guest = webContents.fromId(id)
        if (!guest) throw new Error('Private TLS guest is unavailable')
        return new Promise<{
          error: string
          method: string
          resourceType: string
          webContentsId: number | undefined
          url: string
        }>((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup()
            const trace = (globalThis as typeof globalThis & { __localTLSFixture?: string[] }).__localTLSFixture
            reject(new Error(`Owned POST rejection did not settle; ${JSON.stringify({ url: guest.getURL(), loading: guest.isLoading(), trace })}`))
          }, 15_000)
          const cleanup = (): void => {
            clearTimeout(timer)
            guest.session.webRequest.onErrorOccurred(null)
          }
          // Observe the isolated Session's native network result without replacing its onBeforeRequest policy.
          guest.session.webRequest.onErrorOccurred({ urls: [url] }, (details) => {
            cleanup()
            resolve({ error: details.error, method: details.method, resourceType: details.resourceType,
              webContentsId: details.webContentsId, url: details.url })
          })
          void guest.executeJavaScript('setTimeout(() => document.querySelector("form").requestSubmit(), 0); void 0')
            .catch((error: unknown) => { cleanup(); reject(new Error('Native POST fixture failed', { cause: error })) })
        })
      }, { id: privateGuest, url: `${otherOrigin}/tls-transition` })
      expect(postFailure).toEqual({ error: 'net::ERR_BLOCKED_BY_CLIENT', method: 'POST', resourceType: 'mainFrame',
        webContentsId: privateGuest, url: `${otherOrigin}/tls-transition` })
      console.info('TLS native POST rejection', postFailure)
      expect(await current()).toBe(privateGuest)
      expect(otherPort.requests).toEqual([])

      await openSecond()
      await decide('Cancel', certificate.fingerprint, () => navigate(`${origin}/second-tab`))
      await denied()
      const secondPrivate = await current()
      expect(await partition()).not.toBe(privatePartition)
      expect(await sameSession(privateGuest, secondPrivate)).toBe(false)
      expect(device.requests).not.toContain('GET /second-tab')
      await closeSecond(secondPrivate, primaryTab)

      await activeApp.evaluate(async ({ webContents }, id) => { await webContents.fromId(id)!.session.closeAllConnections() }, privateGuest)
      await device.replace(replacement)
      await decide('Cancel', replacement.fingerprint, () => navigate(`${origin}/replacement`))
      await denied()
      expect(device.requests).not.toContain('GET /replacement')
      expect(await current()).toBe(privateGuest)
      await decide('Open device in this tab (unsafe)', replacement.fingerprint, () => navigate(`${origin}/replacement`))
      await expect.poll(() => nativeTitle(privateGuest), { timeout: 15_000 }).toBe('Local device relative script loaded')
      expect(device.requests).toContain('GET /replacement')

      await navigate(normalOrigin)
      const returnedNormal = await current(privateGuest)
      expect(returnedNormal).not.toBe(privateGuest)
      await destroyed(privateGuest)
      expect(await partition()).toBe(normalPartition)
      expect(await activeApp.evaluate(({ webContents, session }, { id, partition }) =>
        webContents.fromId(id)!.session === session.fromPartition(partition),
      { id: returnedNormal, partition: normalPartition! })).toBe(true)
      await expect.poll(() => state(activeApp, returnedNormal), { timeout: 15_000 }).toBe('authenticated')

      await decide('Cancel', replacement.fingerprint, () => navigate(`${origin}/fresh-acquire`))
      await denied()
      const freshPrivate = await current()
      expect(freshPrivate).not.toBe(privateGuest)
      expect(await partition()).not.toBe(privatePartition)
      await destroyed(returnedNormal)
      expect(device.requests).not.toContain('GET /fresh-acquire')
      await navigate(normalOrigin)
      const finalNormal = await current(freshPrivate)
      await destroyed(freshPrivate)
      expect(await partition()).toBe(normalPartition)
      await expect.poll(() => state(activeApp, finalNormal), { timeout: 15_000 }).toBe('authenticated')
      expect(model.errors).toEqual([])
      await stopDesktop(activeApp, env)
      app = undefined
    } catch (error) { failure = error }
    finally {
      for (const helper of helpers) await stopHelper(helper)
      model.dispose()
      let settled = app === undefined
      if (app) { try { await stopDesktop(app, env); settled = true } catch (error) { cleanupErrors.push(error) } }
      for (const fixture of fixtures) { try { await fixture.close() } catch (error) { cleanupErrors.push(error) } }
      for (const server of [normal, model.server]) {
        if (server.listening) { try { await closeServer(server) } catch (error) { cleanupErrors.push(error) } }
      }
      if (settled && failure === undefined && cleanupErrors.length === 0) {
        try { await removeOwned(root) } catch (error) { cleanupErrors.push(error) }
      } else cleanupErrors.push(new Error(`Native TLS acceptance ${settled ? 'failed' : 'did not shut down'}; retained root: ${root}`))
      if (failure !== undefined || cleanupErrors.length !== 0) {
        throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupErrors], 'Native TLS acceptance or cleanup failed')
      }
    }
  })

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
