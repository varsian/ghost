# Verify that the Live2D plugins are installed in a DSH profile.
#
# Read-only: it inspects the profile manifest, the @local junctions, each bundle's
# cordis.patch.yml and (when the app is running) the plugin host endpoint.
# Use it to answer "did the install actually land?" and "where are the switches?".
#
# Usage:
#   .\tools\verify-install.ps1                                  # desktop profile
#   .\tools\verify-install.ps1 -ProfileDir <profile dir>
#   .\tools\verify-install.ps1 -SkipHostCheck

param(
  [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop",
  [switch]$SkipHostCheck
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$failed = $false

function Check([string]$label, [bool]$ok, [string]$detail = '') {
  if ($ok) { Write-Host ("  [ok]   {0}{1}" -f $label, $(if ($detail) { "  ($detail)" } else { '' })) -ForegroundColor Green }
  else { Write-Host ("  [FAIL] {0}{1}" -f $label, $(if ($detail) { "  ($detail)" } else { '' })) -ForegroundColor Red; $script:failed = $true }
}

Write-Host "== Live2D plugin install verification =="
Write-Host "repo:    $repo"
Write-Host "profile: $ProfileDir"

$manifestPath = Join-Path $ProfileDir 'package.json'
Check 'profile package.json exists' (Test-Path $manifestPath) $manifestPath
if (-not (Test-Path $manifestPath)) { exit 1 }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

$bundles = @($manifest.dsh.profile.bundles)
$deps = @($manifest.dependencies.PSObject.Properties.Name)

foreach ($name in @('@local/dsh-live2d-bundle', '@local/dsh-live2d-tts-bridge')) {
  Check "bundles list contains $name" ($bundles -contains $name)
  Check "dependencies contains $name" ($deps -contains $name)
  $pkgJson = Join-Path $ProfileDir "node_modules\$($name -replace '/', '\')\package.json"
  Check "junction/package resolves: $name" (Test-Path $pkgJson) $pkgJson
  if (Test-Path $pkgJson) {
    $pkg = Get-Content $pkgJson -Raw | ConvertFrom-Json
    Check "  declares dsh.bundle.patch" ($null -ne $pkg.dsh.bundle.patch) ([string]$pkg.dsh.bundle.patch)
    $patch = Join-Path (Split-Path $pkgJson -Parent) $pkg.dsh.bundle.patch
    Check "  bundle patch file exists" (Test-Path $patch) $patch
    if (Test-Path $patch) {
      $rows = Select-String -Path $patch -Pattern '^\s*-\s+id:\s*(\S+)' | ForEach-Object { $_.Matches[0].Groups[1].Value }
      Check "  bundle rows: $($rows -join ', ')" ($rows.Count -gt 0)
    }
  }
}

$pluginPkg = Join-Path $ProfileDir 'node_modules\@local\dsh-live2d\package.json'
Check 'plugin package resolves: @local/dsh-live2d' (Test-Path $pluginPkg) $pluginPkg
if (Test-Path $pluginPkg) {
  $plugin = Get-Content $pluginPkg -Raw | ConvertFrom-Json
  Check '  plugin declares dsh.client (web half)' ($null -ne $plugin.dsh.client)
}

$bundlePatch = Join-Path $repo 'packages\bundle\cordis.patch.yml'
if (Test-Path $bundlePatch) {
  $modeLine = Select-String -Path $bundlePatch -Pattern '^\s*mode:\s*(\S+)' | Select-Object -First 1
  if ($modeLine) { Write-Host ("  [info] presentation mode: {0}" -f $modeLine.Matches[0].Groups[1].Value) }
}

$topRoot = Split-Path -Parent $repo
$bridgePatch = Join-Path $topRoot 'tts-bridge\bundle\cordis.patch.yml'
if (Test-Path $bridgePatch) {
  $daemon = Select-String -Path $bridgePatch -Pattern 'daemonScript:\s*(.+)$' | Select-Object -First 1
  if ($daemon) { Write-Host ("  [info] TTS daemonScript: {0}" -f $daemon.Matches[0].Groups[1].Value.Trim()) }
}

$windowLauncher = Join-Path $repo 'tools\live2d-window\launch.mjs'
$electronDist = Join-Path $repo 'tools\live2d-window\node_modules\electron\dist\electron.exe'
Check 'window launcher present' (Test-Path $windowLauncher)
Check 'Electron installed for the window (npm install)' (Test-Path $electronDist)

if (-not $SkipHostCheck) {
  try {
    $health = Invoke-WebRequest 'http://127.0.0.1:34567/health' -UseBasicParsing -TimeoutSec 4
    $live = $health.Content | ConvertFrom-Json
    Write-Host ("  [ok]   plugin host running: mode={0} visible={1} windowOpen={2} windowPid={3} model={4}" -f $live.mode, $live.visible, $live.windowOpen, $live.windowPid, $live.model) -ForegroundColor Green
  } catch {
    Write-Host '  [info] plugin host not reachable on 127.0.0.1:34567 (app not running, or another profile owns the port)' -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host 'Where are the switches in the app?' -ForegroundColor Cyan
Write-Host '  设置 -> 插件 -> 向下滚动到「已安装插件」'
Write-Host '  两张卡：「Live2D 桌宠」「Live2D × TTS 联动桥」，右侧各有一个开关。'
Write-Host '  列表若还是旧的：点该页右上角刷新，或退出设置再进入（无需重启应用）。'
Write-Host ''
if ($failed) { Write-Host 'RESULT: FAIL — installation incomplete.' -ForegroundColor Red; exit 1 }
Write-Host 'RESULT: OK — both Live2D bundles are installed in this profile.' -ForegroundColor Green
