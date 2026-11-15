# Dev-only: build, launch the app with a step script, and wait for its screenshots.
# Without -Real it runs in demo mode: scripted teammates, no real account is touched.
# Screenshots are written next to the step script.
#   scripts\shoot.ps1 -Script scripts\visual\tour-light.json -Fresh
# The window is drawn off-screen and never shown, so a run does not get in the way; -Show puts it on screen.
#   options: -Real  -Mica  -NoBuild  -Fresh  -Show  -Data <dir>  -TimeoutSec 60
param(
  [Parameter(Mandatory = $true)][string]$Script,
  [switch]$Real,
  [switch]$Mica,
  [switch]$NoBuild,
  [switch]$Fresh,
  [switch]$Show,
  [string]$Exe = '',
  [string]$Data = "$env:TEMP\ensemble-demo",
  [int]$TimeoutSec = 60,
  [string]$Speed = '1'
)
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $NoBuild) {
  $b = & (Join-Path $root 'node_modules\.bin\electron-vite.cmd') build 2>&1
  if ($LASTEXITCODE -ne 0) { $b | ForEach-Object { "$_" } | Select-Object -Last 40; Write-Output "BUILD FAILED"; exit 1 }
}
if ($Fresh -and (Test-Path $Data)) { Remove-Item -Recurse -Force $Data }
$psi = New-Object System.Diagnostics.ProcessStartInfo
# -Exe runs a built copy of the app (dist\win-unpacked\Ensemble.exe) instead of the source.
if ($Exe) { $psi.FileName = (Resolve-Path $Exe).Path; $psi.Arguments = '' } else { $psi.FileName = Join-Path $root 'node_modules\electron\dist\electron.exe'; $psi.Arguments = '.' }
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
foreach ($k in @($psi.EnvironmentVariables.Keys)) { if ($k -match '^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|CLAUDE_PID$|ELECTRON_RUN_AS_NODE$)') { $psi.EnvironmentVariables.Remove($k) } }
$psi.EnvironmentVariables['ENSEMBLE_SCRIPT'] = (Resolve-Path $Script).Path
$psi.EnvironmentVariables['ENSEMBLE_DATA'] = $Data
$psi.EnvironmentVariables['ENSEMBLE_DEMO_SPEED'] = $Speed
$psi.EnvironmentVariables['ENSEMBLE_DEMO_IMAGE'] = Join-Path $root 'scripts\visual\sample-image.png'
if (-not $Real) { $psi.EnvironmentVariables['ENSEMBLE_DEMO'] = '1' }
if (-not $Mica) { $psi.EnvironmentVariables['ENSEMBLE_NO_MICA'] = '1' }
if (-not $Show) { $psi.EnvironmentVariables['ENSEMBLE_HIDDEN'] = '1' }
$p = [System.Diagnostics.Process]::Start($psi)
$out = $p.StandardOutput.ReadToEndAsync()
$err = $p.StandardError.ReadToEndAsync()
if (-not $p.WaitForExit($TimeoutSec * 1000)) { try { $p.Kill() } catch {}; Write-Output "TIMED OUT after $TimeoutSec s (killed)" }
($out.Result -split "`n") | Where-Object { $_ -match '^\[(script|shot|script error|unhandled)' } | ForEach-Object { $_.TrimEnd() }
$e = ($err.Result -split "`n") | Where-Object { $_ -match 'Error|error|threw' -and $_ -notmatch 'GPU|cache|Autofill|DevTools|disk_cache|quota' } | Select-Object -First 12
if ($e) { Write-Output '--- stderr'; $e | ForEach-Object { $_.TrimEnd() } }
