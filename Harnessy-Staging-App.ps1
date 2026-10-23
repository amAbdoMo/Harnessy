param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Start', 'Stop', 'Build', 'Update')]
  [string]$Action,
  [switch]$SkipBuild,
  [string]$RemoteUrl,
  [string]$ListenPort
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'apps\desktop\scripts\staging-launcher.ps1') @PSBoundParameters -RepositoryRoot $PSScriptRoot
exit $LASTEXITCODE
