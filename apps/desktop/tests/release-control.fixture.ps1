# External Git/GitHub/clock responses only; all state persistence and release decisions are real.
param([string]$Engine, [string]$Root, [string]$Scenario)
$ErrorActionPreference = 'Stop'
. $Engine
$script:nativeInvoker = (Get-Command Invoke-ReleaseCommand).ScriptBlock
$null = [IO.Directory]::CreateDirectory((Join-Path $Root 'apps/desktop'))
foreach ($path in @('package.json', 'apps/desktop/package.json')) {
  [IO.File]::WriteAllText((Join-Path $Root $path), '{"version":"0.1.20"}')
}
$script:fake = @{ Head = ('a' * 40); Parent = ('a' * 40); Stage = ('a' * 40); PublishedHead = ('c' * 40);
  Published = '0.1.20'; Dirty = ''; Dispatched = $false; Dispatches = 0; Bumps = 0; Pushes = 0; Retries = 0; Views = 0 }
$script:fixtureScenario = $Scenario
function Start-Sleep { param($Seconds) }
function Read-ReleasePublicFeed {
  param($Context)
  if ($script:fixtureScenario -eq 'stale-feed') { return "version: 0.1.20`n" }
  return "version: $($script:fake.Published)`n"
}
function Invoke-ReleaseCommand {
  param($Context, [string]$Executable, [string[]]$Arguments, [string]$Label)
  $tool = [IO.Path]::GetFileNameWithoutExtension($Executable)
  if ($tool -eq 'git') {
    switch ($Arguments[0]) {
      'remote' {
        if ($script:fixtureScenario -eq 'wrong-origin') { return 'https://github.com/other/repository.git' }
        return 'https://github.com/amAbdoMo/Harnessy.git'
      }
      'status' { return $script:fake.Dirty }
      'fetch' { return '' }
      'branch' { return 'staging' }
      'merge-base' { return '' }
      'ls-remote' {
        if ($Arguments[2] -eq 'refs/heads/staging') { return "$($script:fake.Stage)`trefs/heads/staging" }
        $tags = "$($script:fake.PublishedHead)`trefs/tags/v0.1.20"
        if ($script:fixtureScenario -eq 'reserved') { $tags += "`n$($script:fake.PublishedHead)`trefs/tags/v0.1.21" }
        return $tags
      }
      'rev-parse' {
        switch ($Arguments[1]) {
          '--show-toplevel' { return $Context.Root }
          'HEAD' { return $script:fake.Head }
          'HEAD^' { return $script:fake.Parent }
          'refs/remotes/origin/staging' { return $script:fake.Stage }
          default { return $script:fake.PublishedHead }
        }
      }
      'push' {
        if ($Arguments -contains '--force') { throw 'Force push is forbidden' }
        $script:fake.Pushes++; $script:fake.Stage = $script:fake.Head; return ''
      }
    }
  }
  if ($tool -eq 'node') {
    if ($Arguments -contains '--dry-run') { return '' }
    $script:fake.Bumps++; $script:fake.Head = 'b' * 40
    foreach ($path in @('package.json', 'apps/desktop/package.json')) {
      [IO.File]::WriteAllText((Join-Path $Context.Root $path), '{"version":"0.1.21"}')
    }
    return ''
  }
  if ($tool -eq 'gh') {
    if ($Arguments[0] -eq 'release') { return (@{ tagName = "v$($script:fake.Published)"; isDraft = $false; isPrerelease = $false; url = 'https://github.com/amAbdoMo/Harnessy/releases' } | ConvertTo-Json) }
    if ($Arguments[0] -eq 'workflow') {
      $script:fake.Dispatched = $true; $script:fake.Dispatches++
      if ($script:fixtureScenario -eq 'uncertain-dispatch') { throw 'Start response was interrupted' }
      return ''
    }
    if ($Arguments[1] -eq 'rerun') { $script:fake.Retries++; return '' }
    if ($Arguments[1] -eq 'list') {
      if ($script:fake.Dispatched) {
        return (@(@{ databaseId = 42; headSha = $script:fake.Head; url = 'https://github.com/amAbdoMo/Harnessy/actions/runs/42'; status = 'in_progress'; conclusion = '' }) | ConvertTo-Json -AsArray)
      }
      return '[]'
    }
    if ($Arguments[1] -eq 'view') {
      $script:fake.Views++
      $failed = $script:fixtureScenario -eq 'retry' -and $script:fake.Retries -eq 0
      $inProgress = $script:fixtureScenario -eq 'queued' -and $script:fake.Views -eq 1
      $jobs = @()
      foreach ($name in @('desktop checks / Windows x64','qualified in-app update / Windows x64','publish in-app update / Windows x64')) {
        $status = if ($inProgress) { 'in_progress' } else { 'completed' }
        $conclusion = if ($failed -and $name -ne 'desktop checks / Windows x64') { 'failure' } else { 'success' }
        $jobs += @{ name = $name; status = $status; conclusion = $conclusion; steps = @(@{ name = 'Build your update'; status = 'in_progress' }) }
      }
      if (-not $failed -and -not $inProgress) { $script:fake.Published = '0.1.21' }
      $conclusion = if ($failed) { 'failure' } else { 'success' }
      $status = if ($inProgress) { 'in_progress' } else { 'completed' }
      return (@{ jobs = $jobs; status = $status; conclusion = $conclusion; headSha = $script:fake.Head; url = 'https://github.com/amAbdoMo/Harnessy/actions/runs/42' } | ConvertTo-Json -Depth 8)
    }
  }
  throw "Unexpected external command: $tool $($Arguments -join ' ')"
}
$context = New-ReleaseContext $Root
if ($Scenario -eq 'native-command') {
  & $script:nativeInvoker $context (Get-Command node.exe).Source @('-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'space value', '$(literal)') 'Read fixture arguments'
  return
}
if ($Scenario -eq 'hold') {
  $owned = [Threading.Mutex]::new($false, $context.MutexName)
  try {
    $null = $owned.WaitOne()
    [IO.File]::WriteAllText((Join-Path $Root 'lock-ready'), 'ready')
    while (-not (Test-Path -LiteralPath (Join-Path $Root 'release-lock'))) { [Threading.Thread]::Sleep(20) }
  } finally { $owned.ReleaseMutex(); $owned.Dispose() }
  'HOLDER_COMPLETE'
  return
}
if ($Scenario -eq 'dirty') { $script:fake.Dirty = ' M unfinished.ts' }
if ($Scenario -eq 'already-released') { $script:fake.Head = $script:fake.PublishedHead }
Invoke-ReleaseWorker $context 'Inspect'
if ($Scenario -eq 'changed-source') { $script:fake.Head = 'd' * 40 }
if ($Scenario -eq 'newer-release') { $script:fake.Published = '0.1.21' }
if ($Scenario -notin @('inspect', 'dirty', 'locked', 'reserved', 'already-released')) { Invoke-ReleaseWorker $context 'Publish' '0.1.21' }
if ($Scenario -eq 'uncertain-dispatch') { Invoke-ReleaseWorker $context 'Inspect' }
if ($Scenario -eq 'retry') { Invoke-ReleaseWorker $context 'Retry' }
@{ State = (Read-ReleaseState $context); Effects = $script:fake } | ConvertTo-Json -Depth 12 -Compress
