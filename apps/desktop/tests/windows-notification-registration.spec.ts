import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { windowsToastRegistrationScript } from '../src/windows-notification-registration.ts'

const execute = promisify(execFile)

it.skipIf(process.platform !== 'win32')('repairs only the product-owned bare Electron activator and preserves unrelated registrations', async () => {
  // Disposable shortcuts and registry names never overlap the installed product or stock Electron.
  const root = await mkdtemp(join(tmpdir(), 'harnessy-toast-registration-'))
  const applicationId = `com.harnessy.toast.test.${randomUUID()}`
  const activator = `{${randomUUID()}}`
  const unrelated = `{${randomUUID()}}`
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const target = join(root, 'electron.exe')
  const executable = join(root, 'Harnessy.exe')
  const shortcut = join(root, 'Electron.lnk')
  const scriptPath = join(root, 'registration.ps1')
  const request = { applicationId, displayName: 'Harnessy test', icon: join(root, 'app.ico'), executable,
    legacy: { path: shortcut, target, appUserModelId: applicationId, toastActivatorClsid: activator } }
  const data = Buffer.from(JSON.stringify({ ...request, activator, unrelated, scriptPath }), 'utf8').toString('base64')
  const setupAndVerify = `$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
$classes = [Microsoft.Win32.Registry]::CurrentUser
$idPath = 'Software\\Classes\\AppUserModelId\\' + $p.applicationId
$serverPath = 'Software\\Classes\\CLSID\\' + $p.activator
$otherPath = 'Software\\Classes\\CLSID\\' + $p.unrelated
function Set-Server($path, $command) {
  $key = $classes.CreateSubKey($path + '\\LocalServer32')
  try { $key.SetValue('', [string]$command) } finally { $key.Dispose() }
}
function Read-Server($path) {
  $key = $classes.OpenSubKey($path + '\\LocalServer32')
  try { return [string]$key.GetValue('') } finally { $key.Dispose() }
}
function Shortcut($id, $launchArguments) {
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($p.legacy.path)
  $link.TargetPath = $p.legacy.target
  $link.Arguments = $launchArguments
  $link.Save()
  $props = (New-Object -ComObject Shell.Application).NameSpace([IO.Path]::GetDirectoryName($p.legacy.path)).ParseName('Electron.lnk')
  # SetValue through IPropertyStore is supplied by the fixture below.
  [ToastShortcutFixture]::SetId($p.legacy.path, $id)
}
try {
  Set-Server $serverPath ('"' + $p.legacy.target + '" --foreign-app')
  Set-Server $otherPath 'untouched.exe'
  Shortcut $p.applicationId ''
  $first = (& $p.scriptPath) | ConvertFrom-Json
  if ($first.legacyRepaired -or -not (Test-Path -LiteralPath $p.legacy.path)) { throw 'Changed an unverified activation command.' }
  Set-Server $serverPath $p.legacy.target
  Shortcut ($p.applicationId + '.foreign') ''
  $second = (& $p.scriptPath) | ConvertFrom-Json
  if ($second.legacyRepaired -or -not (Test-Path -LiteralPath $p.legacy.path)) { throw 'Changed another application shortcut.' }
  Shortcut $p.applicationId '--foreign-app'
  $third = (& $p.scriptPath) | ConvertFrom-Json
  if ($third.legacyRepaired -or -not (Test-Path -LiteralPath $p.legacy.path)) { throw 'Changed a configured Electron application.' }
  Shortcut $p.applicationId ''
  $fixed = (& $p.scriptPath) | ConvertFrom-Json
  if (-not $fixed.legacyRepaired -or (Test-Path -LiteralPath $p.legacy.path)) { throw 'Legacy shortcut was not removed after repair.' }
  if ((Read-Server $serverPath) -ne ('"' + $p.executable + '"')) { throw 'Bare Electron activation was not redirected.' }
  if ((Read-Server $otherPath) -ne 'untouched.exe') { throw 'Unrelated activation changed.' }
  $metadata = $classes.OpenSubKey($idPath)
  try {
    if ($metadata.GetValue('DisplayName') -ne $p.displayName -or $metadata.GetValue('IconUri') -ne $p.icon) { throw 'Incorrect branding.' }
  } finally { $metadata.Dispose() }
  # Recreate the verified shortcut with COM already redirected, as after an interrupted deletion.
  Shortcut $p.applicationId ''
  $resumed = (& $p.scriptPath) | ConvertFrom-Json
  if (-not $resumed.legacyRepaired -or (Test-Path -LiteralPath $p.legacy.path)) { throw 'Interrupted repair did not resume.' }
  $again = (& $p.scriptPath) | ConvertFrom-Json
  if ($again.legacyRepaired) { throw 'Repair was not idempotent.' }
  'native ownership checks passed'
} finally {
  $classes.DeleteSubKeyTree($idPath, $false)
  $classes.DeleteSubKeyTree($serverPath, $false)
  $classes.DeleteSubKeyTree($otherPath, $false)
}
`
  try {
    await writeFile(scriptPath, windowsToastRegistrationScript(request), 'utf8')
    // COM IPropertyStore is the real Windows shortcut metadata API, not a serialized fake.
    const fixture = String.raw`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ToastShortcutFixture {
  [StructLayout(LayoutKind.Sequential, Pack=4)] public struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size=24)] public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr value; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface PropertyStore {
    uint GetCount(); void GetAt(uint index, out PropertyKey key); void GetValue(ref PropertyKey key, out PropVariant value);
    void SetValue(ref PropertyKey key, ref PropVariant value); void Commit();
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr bind, uint flags, ref Guid iid, out PropertyStore store);
  public static void SetId(string path, string id) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); PropertyStore store;
    SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out store);
    var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    var value = new PropVariant { vt = 31, value = Marshal.StringToCoTaskMemUni(id) };
    try { store.SetValue(ref key, ref value); store.Commit(); }
    finally { Marshal.FreeCoTaskMem(value.value); Marshal.ReleaseComObject(store); }
  }
}
'@
`
    const script = fixture + setupAndVerify
    const result = await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 30000, maxBuffer: 65536 })
    expect(result.stdout).toContain('native ownership checks passed')
  } finally {
    // A force-killed child cannot run its own finally; the parent also owns registry cleanup.
    const cleanup = `$ErrorActionPreference = 'Stop'
[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('Software\\Classes\\AppUserModelId\\${applicationId}', $false)
[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('Software\\Classes\\CLSID\\${activator}', $false)
[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('Software\\Classes\\CLSID\\${unrelated}', $false)
`
    try {
      await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cleanup, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 10000, maxBuffer: 65536 })
    } finally { await rm(root, { recursive: true, force: true }) }
  }
}, 45000)
