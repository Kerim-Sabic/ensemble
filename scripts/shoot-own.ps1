# Dev-only: like shoot.ps1, but builds into a folder of its own (.shots\<Name>\out) and uses
# data of its own, so several people (or agents) can build and take screenshots at the same
# time without treading on each other. Always demo mode: no real account is touched.
#   scripts\shoot-own.ps1 -Name composer -Script scripts\visual\auto-composer.json -Fresh
# Screenshots are written next to the step script.
#   options: -NoBuild  -Fresh  -Show  -TimeoutSec 60  -Speed 1
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$Script,
  [switch]$NoBuild,
  [switch]$Fresh,
  [switch]$Show,
  [int]$TimeoutSec = 60,
  [string]$Speed = '1'
)
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$safe = ($Name -replace '[^A-Za-z0-9_-]', '')
if (-not $safe) { Write-Output 'Give -Name letters or digits.'; exit 1 }
$own = Join-Path $root ".shots\$safe"
$data = Join-Path $env:TEMP "ensemble-demo-$safe"
New-Item -ItemType Directory -Force $own | Out-Null
if (-not $NoBuild) {
  # An absolute path: a relative one would land the window's files under src\renderer.
  $b = & (Join-Path $root 'node_modules\.bin\electron-vite.cmd') build --outDir (Join-Path $own 'out') 2>&1
  if ($LASTEXITCODE -ne 0) { $b | ForEach-Object { "$_" } | Select-Object -Last 40; Write-Output "BUILD FAILED"; exit 1 }
}
# The app looks for its icon and helper two folders above its main file.
foreach ($d in 'build', 'resources') {
  $to = Join-Path $own $d
  if (-not (Test-Path $to)) { Copy-Item -Recurse (Join-Path $root $d) $to }
}
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$mini = @{ name = 'ensemble'; productName = 'Ensemble'; version = $pkg.version; type = 'module'; main = 'out/main/index.js' } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $own 'package.json'), $mini)
if ($Fresh -and (Test-Path $data)) { Remove-Item -Recurse -Force $data }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $root 'node_modules\electron\dist\electron.exe'
$psi.Arguments = "`"$own`""
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
foreach ($k in @($psi.EnvironmentVariables.Keys)) { if ($k -match '^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|CLAUDE_PID$|ELECTRON_RUN_AS_NODE$)') { $psi.EnvironmentVariables.Remove($k) } }
$psi.EnvironmentVariables['ENSEMBLE_SCRIPT'] = (Resolve-Path $Script).Path
$psi.EnvironmentVariables['ENSEMBLE_DATA'] = $data
$psi.EnvironmentVariables['ENSEMBLE_DEMO_SPEED'] = $Speed
$psi.EnvironmentVariables['ENSEMBLE_DEMO_IMAGE'] = Join-Path $root 'scripts\visual\sample-image.png'
$psi.EnvironmentVariables['ENSEMBLE_DEMO'] = '1'
$psi.EnvironmentVariables['ENSEMBLE_NO_MICA'] = '1'
if (-not $Show) { $psi.EnvironmentVariables['ENSEMBLE_HIDDEN'] = '1' }
$p = [System.Diagnostics.Process]::Start($psi)
$out = $p.StandardOutput.ReadToEndAsync()
$err = $p.StandardError.ReadToEndAsync()
if (-not $p.WaitForExit($TimeoutSec * 1000)) { try { $p.Kill() } catch {}; Write-Output "TIMED OUT after $TimeoutSec s (killed)" }
($out.Result -split "`n") | Where-Object { $_ -match '^\[(script|shot|script error|unhandled)' } | ForEach-Object { $_.TrimEnd() }
$e = ($err.Result -split "`n") | Where-Object { $_ -match 'Error|error|threw' -and $_ -notmatch 'GPU|cache|Autofill|DevTools|disk_cache|quota' } | Select-Object -First 12
if ($e) { Write-Output '--- stderr'; $e | ForEach-Object { $_.TrimEnd() } }
