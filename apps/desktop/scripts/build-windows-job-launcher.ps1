$ErrorActionPreference = "Stop"

$desktopRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $desktopRoot "native\windows-job-launcher.cs"
$output = Join-Path $desktopRoot "assets\windows-job-launcher.exe"
$frameworkRoot = Join-Path $env:WINDIR "Microsoft.NET\Framework64"
$compiler = Get-ChildItem $frameworkRoot -Directory |
  Where-Object { $_.Name -match '^v\d+\.\d+(?:\.\d+)?$' } |
  Sort-Object { [version]$_.Name.Substring(1) } -Descending |
  ForEach-Object { Join-Path $_.FullName "csc.exe" } |
  Where-Object { Test-Path $_ } |
  Select-Object -First 1

if (-not $compiler) {
  throw "Could not find the .NET Framework C# compiler."
}

& $compiler /nologo /optimize+ /target:winexe /platform:anycpu /out:$output $source
if ($LASTEXITCODE -ne 0) {
  throw "Failed to compile the Windows Job Object launcher."
}

Write-Host "Built $output"
