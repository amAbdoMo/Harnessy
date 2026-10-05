/** Per-user toast branding and narrowly owned legacy Electron activation repair. */

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

/** Native fields read from a conflicting product-owned Electron shortcut. */
export interface LegacyWindowsToastShortcut {
  readonly path: string
  readonly target: string
  readonly appUserModelId: string
  readonly toastActivatorClsid?: string
}

/** Main-owned Windows identity; no renderer can supply these values. */
export interface WindowsToastRegistration {
  readonly applicationId: string
  readonly displayName: string
  readonly icon: string
  readonly executable: string
  readonly legacy?: LegacyWindowsToastShortcut
}

/**
 * Encode fixed registry operations with JSON data rather than interpolated PowerShell expressions.
 * @param request - main-owned identity and previously inspected legacy shortcut.
 * @returns a PowerShell script that changes only the product identity and a verified bare Electron activator.
 */
export function windowsToastRegistrationScript(request: WindowsToastRegistration): string {
  const data = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
  return `$ErrorActionPreference = 'Stop'
$classesPrefix = 'Software\\Classes'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
if ($request.applicationId -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid notification application id.' }
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($classesPrefix + '\\AppUserModelId\\' + $request.applicationId)
try {
  $key.SetValue('DisplayName', [string]$request.displayName)
  $key.SetValue('IconUri', [string]$request.icon)
} finally { $key.Dispose() }
$repaired = $false
if ($null -ne $request.legacy -and (Test-Path -LiteralPath $request.legacy.path -PathType Leaf)) {
  $folder = (New-Object -ComObject Shell.Application).NameSpace([IO.Path]::GetDirectoryName($request.legacy.path))
  $item = $folder.ParseName([IO.Path]::GetFileName($request.legacy.path))
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($request.legacy.path)
  if ($item.ExtendedProperty('System.AppUserModel.ID') -eq $request.applicationId -and
      $request.legacy.appUserModelId -eq $request.applicationId -and
      [IO.Path]::GetFileName($link.TargetPath) -ieq 'electron.exe' -and
      $link.TargetPath -ieq $request.legacy.target -and [string]::IsNullOrWhiteSpace($link.Arguments)) {
    $clsid = [string]$request.legacy.toastActivatorClsid
    if ($clsid -match '^\\{[a-fA-F0-9-]{36}\\}$') {
      $server = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($classesPrefix + '\\CLSID\\' + $clsid + '\\LocalServer32', $true)
      if ($null -ne $server) {
        try {
          $command = [string]$server.GetValue('')
          $installedCommand = '"' + $request.executable + '"'
          if ($command.Trim() -ieq $link.TargetPath -or $command.Trim() -ieq ('"' + $link.TargetPath + '"')) {
            $server.SetValue('', $installedCommand)
            $repaired = $true
          } elseif ($command.Trim() -ieq $installedCommand) {
            # A prior interrupted repair may have redirected COM before removing the shortcut.
            $repaired = $true
          }
        } finally { $server.Dispose() }
      }
    }
    # An unknown or changed activation command is not ours to redirect or detach.
    if ($repaired) { Remove-Item -LiteralPath $request.legacy.path }
  }
}
@{ legacyRepaired=$repaired } | ConvertTo-Json -Compress
`
}

/**
 * Publish native branding before any toast is shown and repair a verified legacy activator.
 * @param request - main-owned product metadata.
 * @returns whether a product-owned legacy Electron registration was repaired.
 */
export async function registerWindowsToastIdentity(request: WindowsToastRegistration): Promise<boolean> {
  const root = process.env.SystemRoot ?? process.env.WINDIR
  if (root === undefined) throw new Error('SystemRoot is required to register Harnessy notifications')
  const script = windowsToastRegistrationScript(request)
  const { stdout } = await promisify(execFile)(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { windowsHide: true, timeout: 10000, maxBuffer: 65536 })
  const response: unknown = JSON.parse(stdout.trim())
  if (typeof response !== 'object' || response === null || !('legacyRepaired' in response)
    || typeof response.legacyRepaired !== 'boolean') throw new Error('Invalid Windows notification registration response')
  return response.legacyRepaired
}
