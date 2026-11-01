# GitHub-hosted release preparation and persisted progress for the owner's Desktop window.
Set-StrictMode -Version Latest

function New-ReleaseContext {
  param([string]$RepositoryRoot, [string]$StateDirectory)
  $root = [IO.Path]::GetFullPath($RepositoryRoot)
  if (-not $StateDirectory) { $StateDirectory = Join-Path $root 'apps/desktop/.desktop-build/release-control' }
  $null = [IO.Directory]::CreateDirectory($StateDirectory)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()))).Replace('-', '') }
  finally { $algorithm.Dispose() }
  return @{ Root = $root; Directory = $StateDirectory; StatePath = (Join-Path $StateDirectory 'state.json');
    LogPath = (Join-Path $StateDirectory 'release.log'); MutexName = "Local\HarnessyReleaseWorker-$hash";
    Repository = 'amAbdoMo/Harnessy'; Workflow = 'custom-harness-windows.yml' }
}

function Read-ReleaseState {
  param($Context)
  if (-not (Test-Path -LiteralPath $Context.StatePath)) { return $null }
  $sharing = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
  $stream = [IO.File]::Open($Context.StatePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, $sharing)
  $reader = [IO.StreamReader]::new($stream)
  try { $json = $reader.ReadToEnd() } finally { $reader.Dispose() }
  if ($PSVersionTable.PSVersion.Major -lt 7) { return $json | ConvertFrom-Json }
  return $json | ConvertFrom-Json -AsHashtable
}

function Save-ReleaseState {
  param($Context, $State)
  $State.UpdatedAt = [DateTime]::UtcNow.ToString('o')
  $temporary = Join-Path $Context.Directory ([guid]::NewGuid().ToString() + '.tmp')
  [IO.File]::WriteAllText($temporary, ($State | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temporary, $Context.StatePath, $true)
}

function New-ReleaseState {
  $labels = @('Check your changes', 'Prepare the version', 'Send to GitHub', 'Run app checks', 'Build the update', 'Publish to Harnessy')
  return @{ Phase = 'checking'; Version = ''; LatestVersion = ''; SourceCommit = ''; SourceBranch = '';
    Message = 'Checking your changes and GitHub connection...'; CanPublish = $false; CanRetry = $false;
    RunId = 0L; RunUrl = ''; StartedAt = ''; UpdatedAt = ''; NeedsRunLookup = $false; BaseRunIds = @();
    Steps = @($labels | ForEach-Object { @{ Label = $_; Status = 'pending'; Detail = '' } }) }
}

function Set-ReleaseStep {
  param($Context, $State, [int]$Index, [string]$Detail)
  $State.Phase = 'running'; $State.CanPublish = $false; $State.CanRetry = $false
  $State.Steps[$Index].Status = 'running'; $State.Steps[$Index].Detail = $Detail
  $State.Message = $Detail
  Save-ReleaseState $Context $State
}

function Invoke-ReleaseCommand {
  param($Context, [string]$Executable, [string[]]$Arguments, [string]$Label)
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Executable; $start.WorkingDirectory = $Context.Root
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $start.Environment['Path'] = (Join-Path $Context.Root 'node_modules/.bin') + ';' + $env:Path
  $start.Environment['npm_execpath'] = Join-Path $Context.Root 'node_modules/pnpm/bin/pnpm.mjs'
  $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
  try {
    [IO.File]::AppendAllText($Context.LogPath, "$([DateTime]::UtcNow.ToString('o')) $Label`n")
    if (-not $process.Start()) { throw "Could not start: $Label" }
    $output = $process.StandardOutput.ReadToEndAsync(); $errors = $process.StandardError.ReadToEndAsync()
    $deadline = if ([IO.Path]::GetFileNameWithoutExtension($Executable) -eq 'gh') { 90000 } else { 900000 }
    if (-not $process.WaitForExit($deadline)) {
      $process.Kill($true); $process.WaitForExit()
      throw "$Label took too long. Open details, then refresh."
    }
    $stdout = $output.GetAwaiter().GetResult(); $stderr = $errors.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
      [IO.File]::AppendAllText($Context.LogPath, "`n$([DateTime]::UtcNow.ToString('o')) $Label`n$stdout`n$stderr`n")
      throw "$Label failed. Open details for the command output."
    }
    return $stdout.Trim()
  } finally { $process.Dispose() }
}

function Invoke-ReleaseGit {
  param($Context, [string[]]$Arguments, [string]$Label = 'Read your changes')
  return Invoke-ReleaseCommand $Context (Get-Command git.exe -ErrorAction Stop).Source $Arguments $Label
}

function Invoke-ReleaseGh {
  param($Context, [string[]]$Arguments, [string]$Label = 'Connect to GitHub')
  return Invoke-ReleaseCommand $Context (Get-Command gh.exe -ErrorAction Stop).Source $Arguments $Label
}

function Get-ReleaseVersion {
  param([string]$Text)
  if ($Text -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'A stable version such as 0.1.21 is required.' }
  return [Version]::Parse($Text)
}

function Get-ReleaseSnapshot {
  param($Context)
  $origin = Invoke-ReleaseGit $Context @('remote', 'get-url', 'origin')
  if ($origin -notin @('https://github.com/amAbdoMo/Harnessy.git', 'https://github.com/amAbdoMo/Harnessy')) {
    throw 'Open this window from the Harnessy staging checkout.'
  }
  $actualRoot = Invoke-ReleaseGit $Context @('rev-parse', '--show-toplevel')
  if ([IO.Path]::GetFullPath($actualRoot) -ne $Context.Root) { throw 'The selected folder is not the staging repository root.' }
  $dirty = Invoke-ReleaseGit $Context @('status', '--porcelain')
  if ($dirty) { throw 'Finish and commit your changes in staging, then click Refresh.' }
  $latest = Invoke-ReleaseGh $Context @('release', 'view', '--repo', $Context.Repository, '--json', 'tagName') | ConvertFrom-Json -AsHashtable
  $published = $latest.tagName -creplace '^v', ''
  $publishedVersion = Get-ReleaseVersion $published
  $manifest = Get-Content -LiteralPath (Join-Path $Context.Root 'package.json') -Raw | ConvertFrom-Json -AsHashtable
  $desktop = Get-Content -LiteralPath (Join-Path $Context.Root 'apps/desktop/package.json') -Raw | ConvertFrom-Json -AsHashtable
  $current = Get-ReleaseVersion $manifest.version
  if ($desktop.version -cne $manifest.version) { throw 'The app and repository versions differ. Finish the version change first.' }
  $next = if ($current -gt $publishedVersion) { $current } else { [Version]::new($publishedVersion.Major, $publishedVersion.Minor, $publishedVersion.Build + 1) }
  $tags = Invoke-ReleaseGit $Context @('ls-remote', 'origin', 'refs/tags/v*')
  while ($tags -match ('(?m)\srefs/tags/v' + [regex]::Escape($next.ToString(3)) + '(\^\{\})?$')) {
    $next = [Version]::new($next.Major, $next.Minor, $next.Build + 1)
  }
  $pnpm = Join-Path $Context.Root 'node_modules/pnpm/bin/pnpm.mjs'
  Invoke-ReleaseCommand $Context (Get-Command node.exe -ErrorAction Stop).Source @($pnpm, 'run', 'release:dsh', $next.ToString(3), '--dry-run') 'Check the release versions' | Out-Null
  Invoke-ReleaseGit $Context @('fetch', 'origin', 'refs/heads/master:refs/remotes/origin/master',
    'refs/heads/staging:refs/remotes/origin/staging', "refs/tags/v${published}:refs/tags/v${published}") 'Read the latest staging source' | Out-Null
  $head = Invoke-ReleaseGit $Context @('rev-parse', 'HEAD')
  $stage = Invoke-ReleaseGit $Context @('rev-parse', 'refs/remotes/origin/staging')
  Invoke-ReleaseGit $Context @('merge-base', '--is-ancestor', $stage, $head) 'Check staging history' | Out-Null
  Invoke-ReleaseGit $Context @('merge-base', '--is-ancestor', 'refs/remotes/origin/master', $head) 'Check release history' | Out-Null
  $releasedHead = Invoke-ReleaseGit $Context @('rev-parse', "v${published}^{commit}")
  return @{ Version = $next.ToString(3); CurrentVersion = $manifest.version; LatestVersion = $published;
    SourceCommit = $head; SourceBranch = (Invoke-ReleaseGit $Context @('branch', '--show-current'));
    StageCommit = $stage; CanPublish = ($releasedHead -ne $head) }
}

function Get-ReleaseRuns {
  param($Context)
  $json = Invoke-ReleaseGh $Context @('run', 'list', '--repo', $Context.Repository, '--workflow', $Context.Workflow,
    '--branch', 'staging', '--event', 'workflow_dispatch', '--limit', '30', '--json', 'databaseId,headSha,url,status,conclusion')
  return @($json | ConvertFrom-Json -AsHashtable)
}

function Find-ReleaseRun {
  param($Context, $State)
  for ($attempt = 0; $attempt -lt 12; $attempt++) {
    $matchingRuns = @(Get-ReleaseRuns $Context | Where-Object { $_.headSha -ceq $State.SourceCommit -and $_.databaseId -notin $State.BaseRunIds })
    if ($matchingRuns.Count -gt 1) { throw 'More than one matching build started. Open GitHub to select the right run.' }
    if ($matchingRuns.Count -eq 1) {
      $State.RunId = [long]$matchingRuns[0].databaseId; $State.RunUrl = $matchingRuns[0].url; $State.NeedsRunLookup = $false
      $State.Steps[2].Status = 'succeeded'; $State.Steps[2].Detail = 'Your update is running on GitHub.'
      Save-ReleaseState $Context $State
      return
    }
    Start-Sleep -Seconds 5
  }
  throw 'The build start could not be confirmed. Click Refresh to look again, or open GitHub. Do not start another release yet.'
}

function Read-ReleasePublicFeed {
  param($Context)
  $response = Invoke-WebRequest -Uri "https://github.com/$($Context.Repository)/releases/latest/download/latest.yml" -TimeoutSec 30
  if ($response.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($response.Content) }
  return [string]$response.Content
}

function Complete-Release {
  param($Context, $State)
  $latest = Invoke-ReleaseGh $Context @('release', 'view', '--repo', $Context.Repository, '--json', 'tagName,isDraft,isPrerelease,url') | ConvertFrom-Json -AsHashtable
  if ($latest.tagName -cne "v$($State.Version)" -or $latest.isDraft -ne $false -or $latest.isPrerelease -ne $false) {
    throw 'The published update is not the expected latest version. Open GitHub to check it.'
  }
  $feed = Read-ReleasePublicFeed $Context
  if ($feed -cnotmatch ('(?m)^version:\s*' + [regex]::Escape($State.Version) + '\s*$')) {
    throw 'The public update feed has not reached this version yet. Click Refresh to check again.'
  }
  $State.Phase = 'published'; $State.CanRetry = $false; $State.CanPublish = $false
  $State.LatestVersion = $State.Version
  $State.Message = "v$($State.Version) is published. Open Harnessy and choose Check for Updates."
  Save-ReleaseState $Context $State
}

function Watch-ReleaseRun {
  param($Context, $State)
  $names = @('desktop checks / Windows x64', 'qualified in-app update / Windows x64', 'publish in-app update / Windows x64')
  while ($true) {
    $run = Invoke-ReleaseGh $Context @('run', 'view', [string]$State.RunId, '--repo', $Context.Repository,
      '--json', 'jobs,status,conclusion,headSha,url') | ConvertFrom-Json -AsHashtable
    if ($run.headSha -cne $State.SourceCommit) { throw 'The build belongs to different source. Open GitHub to review it.' }
    $State.Phase = 'running'; $State.CanPublish = $false; $State.CanRetry = $false
    for ($index = 0; $index -lt $names.Count; $index++) {
      $job = @($run.jobs | Where-Object { $_.name -ceq $names[$index] })
      if ($job.Count -eq 0) { continue }
      $step = $State.Steps[$index + 3]
      if ($job[0].status -eq 'completed') {
        $step.Status = if ($job[0].conclusion -eq 'success') { 'succeeded' } else { 'failed' }
        $step.Detail = if ($step.Status -eq 'succeeded') { 'Complete' } else { 'Stopped: ' + $job[0].conclusion }
      } elseif ($job[0].status -eq 'in_progress') {
        $step.Status = 'running'
        $active = @($job[0].steps | Where-Object { $_.status -eq 'in_progress' })
        $step.Detail = if ($active.Count) { $active[0].name } else { 'Working on GitHub...' }
        $State.Message = $step.Label
      } else { $step.Status = 'pending'; $step.Detail = 'Waiting for GitHub...' }
    }
    Save-ReleaseState $Context $State
    if ($run.status -eq 'completed') {
      if ($run.conclusion -ne 'success' -or @($State.Steps[3..5] | Where-Object { $_.Status -ne 'succeeded' }).Count) {
        $State.CanRetry = $true
        throw 'A GitHub step stopped. Open the build for details, then use Retry failed steps.'
      }
      Complete-Release $Context $State
      return
    }
    Start-Sleep -Seconds 15
  }
}

function Start-ReleasePublication {
  param($Context, $State, [string]$Version)
  if ($State.Phase -ne 'ready' -or -not $State.CanPublish -or $State.Version -cne $Version) {
    throw 'Click Refresh before publishing this version.'
  }
  Set-ReleaseStep $Context $State 0 'Rechecking the changes you are publishing...'
  $snapshot = Get-ReleaseSnapshot $Context
  if ($State.SourceCommit -cne $snapshot.SourceCommit) {
    throw 'Your changes or version changed. Click Refresh before publishing.'
  }
  if ((Get-ReleaseVersion $Version) -le (Get-ReleaseVersion $snapshot.LatestVersion)) { throw 'This version is already published. Click Refresh.' }
  if ($snapshot.Version -cne $Version) { throw 'That version is already reserved. Click Refresh for the next version.' }
  $State.StartedAt = [DateTime]::UtcNow.ToString('o')
  $State.Steps[0].Status = 'succeeded'; $State.Steps[0].Detail = 'Your changes are committed and GitHub is connected.'
  Set-ReleaseStep $Context $State 1 "Preparing v$Version..."
  $base = $snapshot.SourceCommit
  if ($snapshot.CurrentVersion -cne $Version) {
    $pnpm = Join-Path $Context.Root 'node_modules/pnpm/bin/pnpm.mjs'
    Invoke-ReleaseCommand $Context (Get-Command node.exe -ErrorAction Stop).Source @($pnpm, 'run', 'release:dsh', $Version) 'Prepare the version' | Out-Null
    if ((Invoke-ReleaseGit $Context @('rev-parse', 'HEAD^')) -cne $base) { throw 'Other source changed during preparation. Review it before publishing.' }
  }
  if (Invoke-ReleaseGit $Context @('status', '--porcelain')) { throw 'Version preparation left unfinished files. Review and commit them before publishing.' }
  $State.SourceCommit = Invoke-ReleaseGit $Context @('rev-parse', 'HEAD')
  $State.Steps[1].Status = 'succeeded'; $State.Steps[1].Detail = "v$Version is ready."
  Set-ReleaseStep $Context $State 2 'Sending your changes to GitHub...'
  Invoke-ReleaseGit $Context @('push', 'origin', 'HEAD:staging') 'Send your changes to GitHub' | Out-Null
  $remote = Invoke-ReleaseGit $Context @('ls-remote', 'origin', 'refs/heads/staging')
  if (($remote -split '\s+')[0] -cne $State.SourceCommit) { throw 'Staging moved during preparation. Refresh before publishing.' }
  $State.BaseRunIds = @(Get-ReleaseRuns $Context | ForEach-Object { $_.databaseId })
  $State.NeedsRunLookup = $true
  Save-ReleaseState $Context $State
  Invoke-ReleaseGh $Context @('workflow', 'run', $Context.Workflow, '--repo', $Context.Repository, '--ref', 'staging',
    '-f', "release_version=$Version") 'Start the GitHub release' | Out-Null
  Find-ReleaseRun $Context $State
  Watch-ReleaseRun $Context $State
}

function Invoke-ReleaseWorker {
  param($Context, [ValidateSet('Inspect', 'Publish', 'Retry')][string]$Action, [string]$Version = '')
  $mutex = [Threading.Mutex]::new($false, $Context.MutexName)
  $acquired = $false
  try {
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { return }
    $state = Read-ReleaseState $Context
    if ($null -eq $state) { $state = New-ReleaseState }
    try {
      if ($Action -eq 'Publish') { Start-ReleasePublication $Context $state $Version; return }
      if ($state.NeedsRunLookup) { Find-ReleaseRun $Context $state; Watch-ReleaseRun $Context $state; return }
      if ($Action -eq 'Retry') {
        if (-not $state.CanRetry -or -not $state.RunId) { throw 'There is no failed build to retry. Click Refresh.' }
        if ((Invoke-ReleaseGit $Context @('rev-parse', 'HEAD')) -cne $state.SourceCommit) { throw 'Newer changes are ready. Refresh to prepare a new release.' }
        $remoteStage = Invoke-ReleaseGit $Context @('ls-remote', 'origin', 'refs/heads/staging')
        if (($remoteStage -split '\s+')[0] -cne $state.SourceCommit) { $state.CanRetry = $false; throw 'GitHub has newer changes. Refresh and review staging before starting another release.' }
        Invoke-ReleaseGh $Context @('run', 'rerun', [string]$state.RunId, '--repo', $Context.Repository, '--failed') 'Retry the failed GitHub steps' | Out-Null
        foreach ($step in $state.Steps[3..5]) { $step.Status = 'pending'; $step.Detail = '' }
        $state.CanRetry = $false
        Set-ReleaseStep $Context $state 3 'Retrying the failed steps on GitHub...'
        Start-Sleep -Seconds 5
        Watch-ReleaseRun $Context $state
        return
      }
      if ($state.RunId -and $state.Phase -in @('running', 'failed')) {
        $run = Invoke-ReleaseGh $Context @('run', 'view', [string]$state.RunId, '--repo', $Context.Repository,
          '--json', 'jobs,status,conclusion,headSha,url') | ConvertFrom-Json -AsHashtable
        $remoteStage = Invoke-ReleaseGit $Context @('ls-remote', 'origin', 'refs/heads/staging')
        if ($run.status -ne 'completed' -or ((Invoke-ReleaseGit $Context @('rev-parse', 'HEAD')) -ceq $state.SourceCommit -and ($remoteStage -split '\s+')[0] -ceq $state.SourceCommit)) {
          Watch-ReleaseRun $Context $state; return
        }
      }
      $state = New-ReleaseState
      $state.Steps[0].Status = 'running'; $state.Steps[0].Detail = 'Checking your committed changes and GitHub connection...'
      Save-ReleaseState $Context $state
      $snapshot = Get-ReleaseSnapshot $Context
      foreach ($key in @('Version', 'LatestVersion', 'SourceCommit', 'SourceBranch', 'CanPublish')) { $state[$key] = $snapshot[$key] }
      $state.Phase = 'ready'; $state.Steps[0].Status = 'succeeded'; $state.Steps[0].Detail = 'Your changes are committed and GitHub is connected.'
      $state.Message = if ($state.CanPublish) { 'Ready when you are. GitHub handles the build and publication.' } else { 'Your committed changes are already released.' }
      Save-ReleaseState $Context $state
    } catch {
      $state.Phase = 'failed'; $state.CanPublish = $false; $state.Message = $_.Exception.Message
      $active = @($state.Steps | Where-Object { $_.Status -eq 'running' })
      if ($active.Count) { $active[0].Status = 'failed'; $active[0].Detail = $state.Message }
      elseif ($state.RunId) { $state.Steps[5].Status = 'failed'; $state.Steps[5].Detail = $state.Message }
      else { $state.Steps[0].Status = 'failed'; $state.Steps[0].Detail = $state.Message }
      [IO.File]::AppendAllText($Context.LogPath, "`n$([DateTime]::UtcNow.ToString('o')) $($state.Message)`n")
      Save-ReleaseState $Context $state
    }
  } finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}
