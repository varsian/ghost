#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
    Start, restart, or inspect the development DSH Web instance (default port 3097).

.DESCRIPTION
    Owns the dev instance lifecycle for the Live2D plugin work: boots
    `dsh --profile web --port <port> --no-open` with DSH_HOME pointing at the
    repository's .live2d-home, redirects its output to a log file, waits for the
    process-token URL line and prints it (the Web GUI needs that token in the
    query string).

    Without -Restart a running instance is left alone: the script prints its PID
    and the last token URL recorded in <DshHome>/dev-url.txt (the token only lives
    in the process that printed it, so re-read the log after a manual restart).

.PARAMETER Port
    TCP port for the dev Web server. Default 3097.

.PARAMETER DshHome
    DSH_HOME for the dev instance. Default <repo parent>/.live2d-home.

.PARAMETER Profile
    Profile name. Default web.

.PARAMETER Restart
    Stop the current dev instance (only when it is provably the dev instance) and
    start a fresh one.

.PARAMETER Stop
    Stop the dev instance and exit (nothing is started). Fails when the port is not
    held by a provably-dev dsh process.

.PARAMETER TimeoutSec
    Seconds to wait for the token URL line. Default 90.

.EXAMPLE
    ./tools/dev-start.ps1
.EXAMPLE
    ./tools/dev-start.ps1 -Restart
#>
[CmdletBinding()]
param(
    [int]$Port = 3097,
    [string]$DshHome = '',
    [string]$Profile = 'web',
    [switch]$Restart,
    [switch]$Stop,
    [int]$TimeoutSec = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $DshHome) { $DshHome = Join-Path (Split-Path -Parent $RepoRoot) '.live2d-home' }
$DshHome = [System.IO.Path]::GetFullPath($DshHome)
$ProfileDir = Join-Path $DshHome "profiles/$Profile"
$LogDir = Join-Path $DshHome 'logs'
$UrlFile = Join-Path $DshHome 'dev-url.txt'

function Fail([string]$Text) { Write-Host "error: $Text" -ForegroundColor Red; exit 1 }

if (-not (Test-Path -LiteralPath (Join-Path $ProfileDir 'package.json'))) {
    Fail "dev profile not found: $ProfileDir"
}
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

# Resolve the dsh launcher: DSH_BIN, the global npm install, or PATH.
$bin = $env:DSH_BIN
if (-not $bin) {
    $candidates = @(
        (Join-Path $env:APPDATA 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js'),
        (Join-Path $env:ProgramFiles 'nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js')
    )
    $bin = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $bin -or -not (Test-Path -LiteralPath $bin)) {
    Fail 'cannot find the dsh launcher (set DSH_BIN to .../@deepseek-ai/dsh/lib/bin.js)'
}
$node = (Get-Command node -ErrorAction Stop).Source

function Get-ListeningProcess([int]$p) {
    Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty OwningProcess
}

function Assert-DevInstance([int]$processId) {
    $info = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if ($null -eq $info) { Fail "port $Port is held by process $processId that is already gone; retry" }
    $cmd = [string]$info.CommandLine
    $looksRight = $cmd -like '*bin.js*' -and $cmd -like "*--profile $Profile*" -and $cmd -like "*--port $Port*"
    if (-not $looksRight) {
        Fail "refusing to stop process $processId on port ${Port}: command line does not look like the dev dsh instance:`n  $cmd"
    }
}

function Read-TokenUrl([string]$logPath) {
    if (-not (Test-Path -LiteralPath $logPath)) { return $null }
    $match = Select-String -LiteralPath $logPath -Pattern 'dsh web:\s+(http://\S+)' -AllMatches -ErrorAction SilentlyContinue |
        Select-Object -Last 1
    if ($null -eq $match) { return $null }
    return $match.Matches[0].Groups[1].Value.TrimEnd(')', ',')
}

$owner = Get-ListeningProcess $Port
if ($Stop) {
    if (-not $owner) {
        Write-Host "dev instance: not running (port $Port is free)" -ForegroundColor Yellow
        exit 0
    }
    Assert-DevInstance $owner
    Stop-Process -Id $owner -Force
    for ($i = 0; $i -lt 50 -and (Get-ListeningProcess $Port); $i++) { Start-Sleep -Milliseconds 200 }
    if (Get-ListeningProcess $Port) { Fail "port $Port is still occupied after stopping the dev instance" }
    Write-Host "dev instance: stopped (port $Port is free)" -ForegroundColor Green
    exit 0
}
if ($owner) {
    if (-not $Restart) {
        Assert-DevInstance $owner
        Write-Host "dev instance already running on port $Port (pid $owner)" -ForegroundColor Yellow
        $known = if (Test-Path -LiteralPath $UrlFile) { (Get-Content -LiteralPath $UrlFile -Raw).Trim() } else { $null }
        if ($known) { Write-Host "token URL: $known" }
        else { Write-Host "token URL: unknown (read the process log, or run with -Restart)" }
        Write-Host "log dir:   $LogDir"
        exit 0
    }
    Write-Host "stopping dev instance on port $Port (pid $owner)"
    Assert-DevInstance $owner
    Stop-Process -Id $owner -Force
    for ($i = 0; $i -lt 50 -and (Get-ListeningProcess $Port); $i++) { Start-Sleep -Milliseconds 200 }
    if (Get-ListeningProcess $Port) { Fail "port $Port is still occupied after stopping the dev instance" }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $LogDir "dev-web-$stamp.log"
$errPath = Join-Path $LogDir "dev-web-$stamp.err.log"
$startArgs = @(
    $bin,
    '--profile', $Profile,
    '--port', "$Port",
    '--no-open'
)

Write-Host "starting dev instance: node $bin --profile $Profile --port $Port --no-open"
Write-Host "  DSH_HOME=$DshHome"
Write-Host "  log:      $logPath"

$proc = Start-Process -FilePath $node -ArgumentList $startArgs `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $logPath -RedirectStandardError $errPath `
    -Environment @{ DSH_HOME = $DshHome } `
    -PassThru -WindowStyle Hidden
if ($null -eq $proc) { Fail 'failed to start the dev instance' }

$url = $null
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    $url = Read-TokenUrl $logPath
    if ($url) { break }
    if ($proc.HasExited) { break }
}
if (-not $url) {
    $tail = ''
    if (Test-Path -LiteralPath $logPath) { $tail = (Get-Content -LiteralPath $logPath -Tail 40) -join "`n" }
    $errTail = ''
    if (Test-Path -LiteralPath $errPath) { $errTail = (Get-Content -LiteralPath $errPath -Tail 40) -join "`n" }
    Fail "dev instance did not print a token URL within ${TimeoutSec}s (exited=$($proc.HasExited))`n--- stdout ---`n$tail`n--- stderr ---`n$errTail"
}

Set-Content -LiteralPath $UrlFile -Value $url -Encoding utf8NoBOM
Write-Host ''
Write-Host 'dev instance: ready' -ForegroundColor Green
Write-Host "  pid:  $($proc.Id)"
Write-Host "  port: $Port"
Write-Host "  url:  $url"
Write-Host "  log:  $logPath"
Write-Host "  err:  $errPath"
Write-Host ''
Write-Host 'Playwright: run `node tools/dev-test.mjs --url <url>` or let dev-test read the URL file.'
