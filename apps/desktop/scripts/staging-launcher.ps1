# Launch protected staging generations or prepare an update while the app is quit.
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Start', 'Stop', 'Build', 'Update')]
  [string]$Action,
  [switch]$SkipBuild,
  [string]$RemoteUrl,
  [string]$ListenPort,
  [switch]$PreparedRuntime,
  [string]$RepositoryRoot
)

$ErrorActionPreference = 'Stop'
if ($PreparedRuntime -and $Action -ne 'Build' -and $Action -ne 'Update') {
  throw '-PreparedRuntime is valid only for Build or Update.'
}
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) { $RepositoryRoot = Join-Path $PSScriptRoot '..\..\..' }
$repoRoot = [System.IO.Path]::GetFullPath($RepositoryRoot)
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'CustomHarness\Harness\dsh-runtimes\dsh-primary-runtime\dependencies'
$nodeDir = Join-Path $runtimeRoot 'node\bin'
$nodeExe = Join-Path $nodeDir 'node.exe'
$pnpmFile = Join-Path $runtimeRoot 'pnpm\bin\pnpm.mjs'
$stateDir = Join-Path $env:LOCALAPPDATA 'CustomHarnessStaging\StagingDesktopLauncher'
$pidFile = Join-Path $stateDir 'desktop.pid'
$registrationFile = Join-Path $stateDir 'repository.txt'
$storeRoot = Join-Path $repoRoot 'apps\desktop\.desktop-build\staging-runtime'
$scopeHash = [System.Security.Cryptography.SHA256]::Create()
try { $mutexScope = [BitConverter]::ToString($scopeHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($stateDir.ToLowerInvariant()))).Replace('-', '') }
finally { $scopeHash.Dispose() }

# PID publication and owner cleanup must not race when a user restarts the launcher.
function Invoke-StagingPidLock {
  param([scriptblock]$Operation)
  $mutex = New-Object System.Threading.Mutex($false, ('Local\HarnessyStagingDesktopLauncherPid' + $mutexScope))
  try {
    try { $null = $mutex.WaitOne() }
    catch [System.Threading.AbandonedMutexException] {
      Write-Verbose "Recovered the staging PID mutex from a terminated launcher: $($_.Exception.Message)"
    }
    try { & $Operation } finally { $mutex.ReleaseMutex() }
  } finally { $mutex.Dispose() }
}

function Get-StagingDesktopProcess {
  if (-not (Test-Path -LiteralPath $pidFile)) {
    return $null
  }

  $savedPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($savedPid -notmatch '^\d+$') {
    return $null
  }

  $candidateProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
  if ($null -eq $candidateProcess) {
    return $null
  }

  $expectedPnpm = [Regex]::Escape($pnpmFile)
  $oldLauncher = $candidateProcess.Name -eq 'node.exe' -and $candidateProcess.CommandLine -match $expectedPnpm -and $candidateProcess.CommandLine -match '(dev|start):desktop'
  $protectedElectron = [Regex]::Escape((Join-Path $storeRoot 'generations')) + '\\[a-f0-9-]+\\electron\\electron\.exe$'
  if ($oldLauncher -or $candidateProcess.ExecutablePath -match $protectedElectron) { return $candidateProcess }
  return $null
}

function Assert-StagingRepository {
  if (-not (Test-Path -LiteralPath $registrationFile)) { return }
  $registeredRoot = (Get-Content -LiteralPath $registrationFile -Raw).Trim()
  if (-not [IO.Path]::IsPathRooted($registeredRoot)) {
    throw 'The staging repository registration is invalid. Restore its canonical repository path before launching.'
  }
  if (-not [string]::Equals([IO.Path]::GetFullPath($registeredRoot).TrimEnd('\'), $repoRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Harnessy staging is already registered at $registeredRoot. Use that folder's launcher instead of this extra copy."
  }
}

function Register-StagingRepository {
  Assert-StagingRepository
  if (-not (Test-Path -LiteralPath $registrationFile)) {
    [IO.File]::WriteAllText($registrationFile, $repoRoot + [Environment]::NewLine)
  }
}

function Get-VerifiedStagingRuntime {
  $selectionFile = Join-Path $storeRoot 'active.json'
  if (-not (Test-Path -LiteralPath $selectionFile)) {
    throw 'No verified staging runtime exists. Quit staging, then run Update-Harnessy-Staging-App.cmd once.'
  }
  $selection = Get-Content -LiteralPath $selectionFile -Raw | ConvertFrom-Json
  $generationPattern = '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  if ($selection.schemaVersion -ne 1 -or $selection.current -notmatch $generationPattern) {
    throw 'The staging runtime selection is invalid. Restore the verified selection before launching.'
  }
  $directory = Join-Path (Join-Path $storeRoot 'generations') $selection.current
  $verified = Get-Content -LiteralPath (Join-Path $directory 'verified.json') -Raw | ConvertFrom-Json
  $pnpmRelative = switch ($verified.schemaVersion) {
    1 { 'runtime/pnpm/bin/pnpm.mjs' }
    2 { 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs' }
    default { throw 'The selected staging runtime has an unsupported verification record. Run Update-Harnessy-Staging-App.cmd.' }
  }
  $pnpmCheck = @($verified.checks | Where-Object { $_.path -ceq $pnpmRelative })
  if ($verified.id -ne $selection.current -or @($verified.checks).Count -lt 8 -or $pnpmCheck.Count -ne 1) {
    throw 'The selected staging runtime has no valid verification record. Run Update-Harnessy-Staging-App.cmd.'
  }
  foreach ($check in $verified.checks) {
    if ($check.path -notmatch '^[a-zA-Z0-9._/-]+$' -or $check.path -match '(^|/)\.\.?(/|$)' -or $check.path.StartsWith('/')) {
      throw 'The staging runtime verification record contains an invalid path.'
    }
    $file = Join-Path $directory $check.path
    $stream = [System.IO.File]::OpenRead($file)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
    if ($hash -ne $check.sha256) {
      throw "The protected staging file $($check.path) changed. Run Update-Harnessy-Staging-App.cmd; no older runtime will be opened automatically."
    }
  }
  return [PSCustomObject]@{ Directory = $directory; PnpmEntry = (Join-Path $directory $pnpmRelative) }
}

function Get-StagingWebProcess {
  $webPidFile = Join-Path $env:LOCALAPPDATA 'CustomHarness\StagingLauncher\server.pid'
  if (-not (Test-Path -LiteralPath $webPidFile)) { return $null }
  $webPid = Get-Content -LiteralPath $webPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($webPid -notmatch '^\d+$') { return $null }
  $webProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $webPid" -ErrorAction SilentlyContinue
  $expectedPnpm = [Regex]::Escape($pnpmFile)
  if ($null -ne $webProcess -and $webProcess.Name -eq 'node.exe' -and $webProcess.CommandLine -match $expectedPnpm -and $webProcess.CommandLine -match 'custom-harness') {
    return $webProcess
  }
  return $null
}

Assert-StagingRepository

if ($Action -eq 'Stop') {
  $stagingProcess = Get-StagingDesktopProcess
  if ($null -eq $stagingProcess) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'Harnessy staging desktop app is not running from this launcher.'
    exit 0
  }

  & taskkill.exe /PID $stagingProcess.ProcessId /T /F | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Could not stop Harnessy staging desktop process $($stagingProcess.ProcessId)."
  }

  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'Harnessy staging desktop app stopped.'
  exit 0
}

# Private Tailscale Serve is configured manually by the user; this launcher changes no networking.
$hasRemoteArgument = $PSBoundParameters.ContainsKey('RemoteUrl')
$hasPortArgument = $PSBoundParameters.ContainsKey('ListenPort')
if ($hasRemoteArgument -ne $hasPortArgument) {
  throw 'Supply both -RemoteUrl and -ListenPort, or neither.'
}
# Installed-app listeners are not staging settings; opt in with an explicit pair.
$selectedRemoteUrl = $null
$selectedListenPort = $null
Remove-Item Env:DSH_DESKTOP_REMOTE_URL -ErrorAction SilentlyContinue
Remove-Item Env:DSH_DESKTOP_LISTEN_PORT -ErrorAction SilentlyContinue
if ($hasRemoteArgument) {
  $selectedRemoteUrl = $RemoteUrl
  $selectedListenPort = $ListenPort
}
if ($null -ne $selectedRemoteUrl -or $null -ne $selectedListenPort) {
  if ($null -eq $selectedRemoteUrl -or $null -eq $selectedListenPort) {
    throw 'Phone connection requires both DSH_DESKTOP_REMOTE_URL and DSH_DESKTOP_LISTEN_PORT.'
  }
  if ($selectedRemoteUrl -match '\s' -or $selectedRemoteUrl -notmatch '^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net(?::443)?/?$') {
    throw 'RemoteUrl must be a credential-free HTTPS machine.tailnet.ts.net root on port 443.'
  }
  $parsedListenPort = 0
  if ($selectedListenPort.Length -eq 0 -or $selectedListenPort -match '\D' -or -not [int]::TryParse($selectedListenPort, [ref]$parsedListenPort) -or $parsedListenPort -lt 1 -or $parsedListenPort -gt 65535) {
    throw 'ListenPort must be an integer from 1 through 65535.'
  }
  $remoteRootUri = [uri]$selectedRemoteUrl
  $env:DSH_DESKTOP_REMOTE_URL = $remoteRootUri.GetLeftPart([System.UriPartial]::Authority) + '/'
  $env:DSH_DESKTOP_LISTEN_PORT = [string]$parsedListenPort
}

if ($null -ne (Get-StagingWebProcess)) {
  throw 'Quit the browser staging app before rebuilding its artifacts or starting the Desktop staging app.'
}
# The installed Host runs Electron in Node mode; the staging GUI must not inherit that mode.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
# Serialize updates with runtime selection and PID publication, without locking for the app's lifetime.
$operationMutex = New-Object System.Threading.Mutex($false, ('Local\HarnessyStagingDesktopOperation' + $mutexScope))
try {
  try { $acquired = $operationMutex.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { throw 'Another staging launch or update is in progress. Wait for it to finish.' }
  try {
    $stagingProcess = Get-StagingDesktopProcess
    if ($Action -eq 'Build' -or $Action -eq 'Update') {
      $sourceElectron = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object {
        $_.CommandLine -match [Regex]::Escape((Join-Path $repoRoot 'apps\desktop'))
      }
      if ($null -ne $stagingProcess -or $null -ne $sourceElectron) {
        throw 'Quit staging completely, including its tray process, before updating its runtime.'
      }
      if (-not (Test-Path -LiteralPath $nodeExe) -or -not (Test-Path -LiteralPath $pnpmFile)) {
        throw 'Harnessy bundled Node.js or pnpm was not found. Start the installed Harnessy app once, quit it, and try again.'
      }
      $env:Path = "$nodeDir;$env:Path"
      $updateLog = Join-Path $stateDir ('update-' + [Guid]::NewGuid().ToString('N') + '.log')
      Start-Transcript -LiteralPath $updateLog | Out-Null
      Push-Location -LiteralPath $repoRoot
      try {
        $selectionFile = Join-Path $storeRoot 'active.json'
        $selectionBefore = $null
        if (Test-Path -LiteralPath $selectionFile) { $selectionBefore = Get-Content -LiteralPath $selectionFile -Raw }
        $preparationArguments = @()
        if ($PreparedRuntime) { $preparationArguments += '--prepared-runtime' }
        & $nodeExe $pnpmFile --dir apps/desktop run update:staging @preparationArguments
        $updateExit = $LASTEXITCODE
        if ($updateExit -ne 0) { throw "Staging update failed with exit code $updateExit. The selected runtime is unchanged. Full output: $updateLog" }
        if (-not (Test-Path -LiteralPath $selectionFile) -or (Get-Content -LiteralPath $selectionFile -Raw) -eq $selectionBefore) {
          throw "Staging update did not select a new verified runtime. Full output: $updateLog"
        }
        $null = Get-VerifiedStagingRuntime
        Register-StagingRepository
      } finally {
        Pop-Location
        Stop-Transcript | Out-Null
      }
      exit 0
    }
    if ($null -ne $stagingProcess) {
      Write-Host 'Harnessy staging desktop app is already running.'
      exit 0
    }
    $verifiedRuntime = Get-VerifiedStagingRuntime
    Register-StagingRepository
    $selectedRuntime = $verifiedRuntime.Directory
    # Never inherit installed-app state, including aliases with higher resolution priority.
    $dataRoot = Join-Path $env:LOCALAPPDATA 'CustomHarnessStaging'
    $env:CUSTOM_HARNESS_DATA_DIR = $dataRoot
    $env:DSH_HOME = Join-Path $dataRoot 'Harness'
    $env:CUSTOM_HARNESS_HOME = $env:DSH_HOME
    $env:DSH_AGENTS_HOME = Join-Path $dataRoot 'Agents'
    $env:CUSTOM_HARNESS_AGENTS_DIR = $env:DSH_AGENTS_HOME
    $env:CUSTOM_HARNESS_LOG_DIR = Join-Path $dataRoot 'Logs'
    $env:CUSTOM_HARNESS_CACHE_DIR = Join-Path $dataRoot 'Cache'
    $env:DSH_DESKTOP_USER_DATA_DIR = Join-Path $env:CUSTOM_HARNESS_CACHE_DIR 'DesktopUserData'
    $env:DSH_DESKTOP_PROFILE_DIR = Join-Path $env:DSH_HOME 'profiles\desktop'
    $env:DSH_DESKTOP_DEV_APP = '0'
    $env:DSH_DESKTOP_DSH_DIR = Join-Path $selectedRuntime 'app\dsh'
    $env:DSH_DESKTOP_PNPM_ENTRY = $verifiedRuntime.PnpmEntry
    $env:DSH_DESKTOP_PRIMARY_RUNTIME_DIR = Join-Path $selectedRuntime 'runtime\primary-runtime'
    $env:DSH_DESKTOP_OPEN_DEVTOOLS = '0'
    $launchId = [Guid]::NewGuid().ToString('N')
    $stdout = Join-Path $stateDir ("launch-$launchId.log")
    $stderr = Join-Path $stateDir ("launch-$launchId.err.log")
    $appRoot = Join-Path $selectedRuntime 'app'
    $desktopProcess = Start-Process -FilePath (Join-Path $selectedRuntime 'electron\electron.exe') `
      -ArgumentList @('"' + $appRoot + '"') -WorkingDirectory $appRoot -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    # Cache the handle before exit so Windows PowerShell retains the real exit code.
    $null = $desktopProcess.Handle
    Invoke-StagingPidLock { Set-Content -LiteralPath $pidFile -Value $desktopProcess.Id }
  } finally { $operationMutex.ReleaseMutex() }
} finally { $operationMutex.Dispose() }

Write-Host ''
Write-Host "Harnessy staging opened protected runtime: $selectedRuntime"
Write-Host "Staging data (separate from the installed app): $dataRoot"
Write-Host "Application logs: $stdout and $stderr"
Write-Host 'Keep this window open. Stop the app with Stop-Harnessy-Staging-App.cmd.'
try {
  $desktopProcess.WaitForExit()
  if ($desktopProcess.ExitCode -ne 0) {
    throw "Harnessy staging exited with code $($desktopProcess.ExitCode). Review $stderr. No runtime downgrade was attempted."
  }
} finally {
  Invoke-StagingPidLock {
    $savedPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($savedPid -eq [string]$desktopProcess.Id) {
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
  }
}
