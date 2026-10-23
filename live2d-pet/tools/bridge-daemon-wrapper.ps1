<#
.SYNOPSIS
  Route the installed profile's `tool-tts` daemon through the Live2D mirror shim
  WITHOUT restarting the DSH desktop app.

.DESCRIPTION
  The supported wiring is the independent bundle `@local/dsh-live2d-tts-bridge`
  (it overrides the tool-tts row's `daemonScript` to `live2d_tts_shim.py`). The
  desktop app only composes newly installed bundle layers on the next launch; if
  you want lip sync in the *current* session without restarting, this script
  installs a tiny launcher wrapper at

      <profile>/node_modules/@deepseek-ai/dsh-tool-tts/python/tts_daemon.py

  which keeps the original daemon as `tts_daemon.native.py` and executes the
  Live2D shim (which runpy's the original daemon in-process, byte-for-byte relay).
  The shim's sidecar `realDaemon` is pointed at the native copy.

  After the app is restarted the bridge bundle takes over; the wrapper then just
  stays unused. Use -Remove to restore the stock daemon at any time.

.PARAMETER ProfileDir
  The DSH profile that owns the installed `@deepseek-ai/dsh-tool-tts` package.

.PARAMETER Remove
  Restore `tts_daemon.native.py` over `tts_daemon.py` (stock TTS behaviour) and
  point the shim sidecar back at `tts_daemon.py`.

.EXAMPLE
  .\tools\bridge-daemon-wrapper.ps1 -ProfileDir '<DSH_PROFILE>'
  .\tools\bridge-daemon-wrapper.ps1 -ProfileDir '<DSH_PROFILE>' -Remove
#>
param(
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$pythonDir = Join-Path $ProfileDir 'node_modules\@deepseek-ai\dsh-tool-tts\python'
$daemon = Join-Path $pythonDir 'tts_daemon.py'
$native = Join-Path $pythonDir 'tts_daemon.native.py'
$sidecar = Join-Path $repo 'packages\plugin\python\live2d_tts_shim.json'
$shim = Join-Path $repo 'packages\plugin\python\live2d_tts_shim.py'

if (-not (Test-Path -LiteralPath $daemon)) {
  throw "tool-tts daemon not found: $daemon (is the voice bundle installed in this profile?)"
}

if ($Remove) {
  if (Test-Path -LiteralPath $native) {
    Copy-Item -LiteralPath $native -Destination $daemon -Force
    Remove-Item -LiteralPath $native -Force
    Write-Host "restored stock tts_daemon.py from tts_daemon.native.py" -ForegroundColor Green
  } else {
    Write-Host "no wrapper installed (tts_daemon.native.py missing); nothing to remove" -ForegroundColor Yellow
  }
  if (Test-Path -LiteralPath $sidecar) {
    $cfg = Get-Content -LiteralPath $sidecar -Raw | ConvertFrom-Json
    $cfg.realDaemon = (Join-Path $pythonDir 'tts_daemon.py') -replace '\\', '/'
    $cfg | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $sidecar -Encoding utf8NoBOM
    Write-Host "shim sidecar realDaemon -> tts_daemon.py"
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $native)) { Copy-Item -LiteralPath $daemon -Destination $native -Force }
$wrapper = @"
# TEMPORARY Live2D TTS-bridge bootstrap for this installed profile.
# The supported wiring is the @local/dsh-live2d-tts-bridge bundle (tool-tts row
# override -> daemonScript); the running desktop app has not yet composed that
# newly installed bundle layer, so this launcher routes the same command line
# through the mirror shim until the app restarts.
# Remove with: tools/bridge-daemon-wrapper.ps1 -ProfileDir <profile> -Remove
import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REAL = os.path.join(HERE, "tts_daemon.native.py")
SHIM = r"$shim"
os.environ["LIVE2D_TTS_REAL_DAEMON"] = REAL
sys.argv[0] = REAL
runpy.run_path(SHIM, run_name="__main__")
"@
Set-Content -LiteralPath $daemon -Value $wrapper -Encoding utf8NoBOM
Write-Host "installed shim launcher wrapper at $daemon" -ForegroundColor Green

if (Test-Path -LiteralPath $sidecar) {
  $cfg = Get-Content -LiteralPath $sidecar -Raw | ConvertFrom-Json
  $cfg.realDaemon = $native -replace '\\', '/'
  $cfg | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $sidecar -Encoding utf8NoBOM
  Write-Host "shim sidecar realDaemon -> tts_daemon.native.py"
} else {
  Write-Host 'warning: shim sidecar not found; the wrapper still sets LIVE2D_TTS_REAL_DAEMON itself' -ForegroundColor Yellow
}
Write-Host 'Kill any running tts daemon so the next tts call starts through the wrapper.' -ForegroundColor Yellow
