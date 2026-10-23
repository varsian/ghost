#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
    Install (or refresh) the Live2D plugin bundle into a DSH profile by file-level links.

.DESCRIPTION
    Idempotent, safe to re-run. For the target profile directory this script:

      1. creates directory junctions at <profile>/node_modules/@local/dsh-live2d-bundle
         and <profile>/node_modules/@local/dsh-live2d pointing at this repository's
         package directories (symlinks on non-Windows hosts);
      2. adds "link:<absolute path>" entries for both packages to the profile's
         package.json dependencies;
      3. appends @local/dsh-live2d-bundle to dsh.profile.bundles (order preserved,
         no duplicate);
      4. verifies that Node resolves both packages from the profile.

    A profile whose HMR row is enabled recomposes as soon as step 3 changes the
    ordered bundle list, so the bundle appears on the Plugins page without an app
    restart. The target profile's package.json is backed up once as
    package.json.lead-backup (the pristine pre-install copy) and is never
    overwritten by later runs.

    The Desktop app owns ~/.dsh/profiles/desktop exclusively: run this script from
    the normal install step; it performs file-level writes only and never restarts
    the app.

.PARAMETER ProfileDir
    Absolute path of the profile directory (the one containing package.json).
    Defaults to $env:DSH_HOME/profiles/web when DSH_HOME is set.

.PARAMETER RepoRoot
    Root of the live2d-pet/ directory. Defaults to the parent of tools/.

.PARAMETER PythonPath
    TTS python interpreter. Rendered into the <PYTHON> placeholder of the TTS
    bridge patch (tts-bridge/bundle/cordis.patch.yml). Optional; when omitted the
    placeholder is left in place and a warning is printed.

.PARAMETER VoicesDir
    Reference-voice folder. Rendered into the <VOICES_DIR> placeholder of the TTS
    bridge patch. Optional; when omitted the placeholder is left in place.

.PARAMETER ModelDir
    VoxCPM 1.5 model directory (weights + config + tokenizer). Rendered into the
    <MODELS_DIR> placeholder of the TTS bridge patch. Optional; when omitted the
    placeholder is left in place and a warning is printed.

.PARAMETER CacheDir
    Daemon cache directory (transcripts / default WAV output). Rendered into the
    <CACHE_DIR> placeholder of the TTS bridge patch. Optional; when omitted the
    placeholder is left in place.

.PARAMETER NoVerify
    Skip the post-install resolution check.

.EXAMPLE
    ./tools/install.ps1 -ProfileDir '<DSH_PROFILE>' `
        -PythonPath '<PYTHON>' -VoicesDir '<VOICES_DIR>' `
        -ModelDir '<MODELS_DIR>' -CacheDir '<CACHE_DIR>'

.EXAMPLE
    $env:DSH_HOME = '<path-to-dsh-home>'
    ./tools/install.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = '',
    [string]$RepoRoot = '',
    [string]$PythonPath = '',
    [string]$VoicesDir = '',
    [string]$ModelDir = '',
    [string]$CacheDir = '',
    [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$BundlePackage = '@local/dsh-live2d-bundle'
$BridgePackage = '@local/dsh-live2d-tts-bridge'
$PluginPackage = '@local/dsh-live2d'

function Write-Step([string]$Text) { Write-Host "==> $Text" }
function Fail([string]$Text) { Write-Host "error: $Text" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- repo root --
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
# This script lives in live2d-pet/tools; the bridge bundle is part of the
# sibling tts-bridge/ project at the repository root, not under live2d-pet/.
$TopRoot = Split-Path -Parent $RepoRoot
$BundleDir = Join-Path $RepoRoot 'packages/bundle'
$BridgeDir = Join-Path $TopRoot 'tts-bridge/bundle'
$PluginDir = Join-Path $RepoRoot 'packages/plugin'

foreach ($required in @(
        @{ Path = (Join-Path $BundleDir 'package.json'); What = 'bundle package' },
        @{ Path = (Join-Path $BundleDir 'cordis.patch.yml'); What = 'bundle patch' },
        @{ Path = (Join-Path $BridgeDir 'package.json'); What = 'TTS bridge bundle package' },
        @{ Path = (Join-Path $BridgeDir 'cordis.patch.yml'); What = 'TTS bridge bundle patch' },
        @{ Path = (Join-Path $PluginDir 'package.json'); What = 'plugin package' })) {
    if (-not (Test-Path -LiteralPath $required.Path)) {
        Fail "$($required.What) not found: $($required.Path) (set -RepoRoot)"
    }
}

# ------------------------------------------------------------- profile dir --
if (-not $ProfileDir) {
    if ($env:DSH_HOME) {
        $ProfileDir = Join-Path $env:DSH_HOME 'profiles/web'
    }
    else {
        Fail 'no -ProfileDir and DSH_HOME is not set; pass -ProfileDir <profile directory>'
    }
}
if (-not (Test-Path -LiteralPath $ProfileDir)) { Fail "profile directory not found: $ProfileDir" }
$ProfileDir = (Resolve-Path -LiteralPath $ProfileDir).Path
$ProfileJson = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $ProfileJson)) { Fail "profile package.json not found: $ProfileJson" }

Write-Step "profile: $ProfileDir"
Write-Step "repo:    $RepoRoot"

# --------------------------------------------------------------- junctions --
function Set-DirectoryLink {
    param([string]$LinkPath, [string]$TargetPath)

    $parent = Split-Path -Parent $LinkPath
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    $existing = Get-Item -LiteralPath $LinkPath -Force -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        if ($existing.LinkType) {
            Remove-Item -LiteralPath $LinkPath -Force -Recurse
        }
        elseif (-not $existing.PSIsContainer) {
            Fail "refusing to replace a file at $LinkPath"
        }
        else {
            Fail "refusing to replace a real directory at $LinkPath (remove it manually if it is a stale copy)"
        }
    }

    try {
        New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath | Out-Null
        return 'junction'
    }
    catch {
        New-Item -ItemType SymbolicLink -Path $LinkPath -Target $TargetPath | Out-Null
        return 'symlink'
    }
}

$localScope = Join-Path $ProfileDir 'node_modules/@local'
$bundleLink = Join-Path $localScope 'dsh-live2d-bundle'
$bridgeLink = Join-Path $localScope 'dsh-live2d-tts-bridge'
$pluginLink = Join-Path $localScope 'dsh-live2d'

$bundleKind = Set-DirectoryLink -LinkPath $bundleLink -TargetPath $BundleDir
Write-Step "linked  $bundleLink -> $BundleDir ($bundleKind)"
$bridgeKind = Set-DirectoryLink -LinkPath $bridgeLink -TargetPath $BridgeDir
Write-Step "linked  $bridgeLink -> $BridgeDir ($bridgeKind)"
$pluginKind = Set-DirectoryLink -LinkPath $pluginLink -TargetPath $PluginDir
Write-Step "linked  $pluginLink -> $PluginDir ($pluginKind)"

# --------------------------------------------------------- profile manifest --
$node = (Get-Command node -ErrorAction Stop).Source
$helper = Join-Path ([System.IO.Path]::GetTempPath()) ("live2d-install-{0}.mjs" -f ([guid]::NewGuid().ToString('N')))
$helperCode = @'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [profileDir, repoRoot, bridgeRoot] = process.argv.slice(2)
const pkgPath = join(profileDir, 'package.json')
const backupPath = pkgPath + '.lead-backup'
const raw = readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(raw)

const toLink = (p) => 'link:' + resolve(p).split('\\').join('/')
const wanted = {
  '@local/dsh-live2d-bundle': toLink(join(repoRoot, 'packages', 'bundle')),
  '@local/dsh-live2d-tts-bridge': toLink(bridgeRoot),
  '@local/dsh-live2d': toLink(join(repoRoot, 'packages', 'plugin')),
}
const dependencies = { ...(pkg.dependencies ?? {}), ...wanted }
// Independent switchable bundles: the avatar itself, then the optional TTS bridge
// (the bridge must come later so its tool-tts override composes after the voice bundle).
const selectedBundles = ['@local/dsh-live2d-bundle', '@local/dsh-live2d-tts-bridge']
const current = pkg.dsh?.profile?.bundles
const bundles = (Array.isArray(current) ? current : []).filter((name) => !selectedBundles.includes(name))
bundles.push(...selectedBundles)

if (!existsSync(backupPath)) copyFileSync(pkgPath, backupPath)
const updated = {
  ...pkg,
  dependencies,
  dsh: { ...(pkg.dsh ?? {}), profile: { ...(pkg.dsh?.profile ?? {}), bundles } },
}
writeFileSync(pkgPath, JSON.stringify(updated, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ packageJson: pkgPath, backup: backupPath, dependencies: wanted, bundles }, null, 2))
'@
Set-Content -LiteralPath $helper -Value $helperCode -Encoding utf8NoBOM
try {
    Write-Step 'updating profile package.json'
    & $node $helper $ProfileDir $RepoRoot $BridgeDir
    if ($LASTEXITCODE -ne 0) { Fail 'profile package.json update failed' }
}
finally {
    Remove-Item -LiteralPath $helper -Force -ErrorAction SilentlyContinue
}

# --------------------------------------------------- bundle patch rendering --
# The TTS bridge patch keeps placeholders so no machine-specific path is
# hardcoded in the repository:
#   <PLUGIN_DIR>  -> absolute path of this live2d-pet/ directory (automatic)
#   <PYTHON>      -> -PythonPath
#   <VOICES_DIR>  -> -VoicesDir
#   <MODELS_DIR>  -> -ModelDir   (VoxCPM 1.5 weights directory)
#   <CACHE_DIR>   -> -CacheDir   (daemon cache directory)
$patchPath = Join-Path $BundleDir 'cordis.patch.yml'
$patchText = Get-Content -LiteralPath $patchPath -Raw
foreach ($renderTarget in @(
        (Join-Path $BundleDir 'cordis.patch.yml'),
        (Join-Path $BridgeDir 'cordis.patch.yml'))) {
    $text = Get-Content -LiteralPath $renderTarget -Raw
    $rendered = $text
    if ($rendered.Contains('<PLUGIN_DIR>')) {
        $rendered = $rendered.Replace('<PLUGIN_DIR>', $RepoRoot)
        Write-Step "rendered <PLUGIN_DIR> in $renderTarget"
    }
    if ($PythonPath -and $rendered.Contains('<PYTHON>')) {
        $rendered = $rendered.Replace('<PYTHON>', $PythonPath)
        Write-Step "rendered <PYTHON> in $renderTarget"
    }
    if ($VoicesDir -and $rendered.Contains('<VOICES_DIR>')) {
        $rendered = $rendered.Replace('<VOICES_DIR>', $VoicesDir)
        Write-Step "rendered <VOICES_DIR> in $renderTarget"
    }
    if ($ModelDir -and $rendered.Contains('<MODELS_DIR>')) {
        $rendered = $rendered.Replace('<MODELS_DIR>', $ModelDir)
        Write-Step "rendered <MODELS_DIR> in $renderTarget"
    }
    if ($CacheDir -and $rendered.Contains('<CACHE_DIR>')) {
        $rendered = $rendered.Replace('<CACHE_DIR>', $CacheDir)
        Write-Step "rendered <CACHE_DIR> in $renderTarget"
    }
    if ($rendered -ne $text) {
        Set-Content -LiteralPath $renderTarget -Value $rendered -Encoding utf8NoBOM -NoNewline
    }
    if ($rendered -match '<PYTHON>|<VOICES_DIR>|<MODELS_DIR>|<CACHE_DIR>') {
        Write-Host "warning: $renderTarget still contains <PYTHON>/<VOICES_DIR>/<MODELS_DIR>/<CACHE_DIR> placeholders - pass -PythonPath/-VoicesDir/-ModelDir/-CacheDir or edit it manually" -ForegroundColor Yellow
    }
}
$patchText = Get-Content -LiteralPath $patchPath -Raw

# The patch is the single source of truth for the port and ingest token.
$hostPort = 34567
$portMatch = [regex]::Match($patchText, '(?m)^\s*port:\s*(\d+)\s*$')
if ($portMatch.Success) { $hostPort = [int]$portMatch.Groups[1].Value }
$ingestToken = 'dsh-live2d-local'
$tokenMatch = [regex]::Match($patchText, "(?m)^\s*ingestToken:\s*'([^']*)'")
if ($tokenMatch.Success) { $ingestToken = $tokenMatch.Groups[1].Value }

# ---------------------------------------------------- TTS shim sidecar JSON --
# The Python shim reads this file for the real daemon path and the ingest URL.
# Missing tool-tts (e.g. a profile without the voice bundle) is a warning, not
# an install failure: the bridge is optional for the overlay itself.
function Resolve-TtsDaemon {
    $relative = 'node_modules/@deepseek-ai/dsh-tool-tts/python/tts_daemon.py'
    $candidates = [System.Collections.Generic.List[string]]::new()
    $candidates.Add((Join-Path $ProfileDir $relative))

    $dshBin = $env:DSH_BIN
    if (-not $dshBin) {
        $dshBin = Join-Path $env:APPDATA 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js'
    }
    if (Test-Path -LiteralPath $dshBin) {
        $dshPackageDir = Split-Path -Parent (Split-Path -Parent (Resolve-Path -LiteralPath $dshBin).Path)
        $candidates.Add((Join-Path $dshPackageDir 'node_modules/@deepseek-ai/dsh-tool-tts/python/tts_daemon.py'))
    }
    $globalRoot = Join-Path $env:APPDATA 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-tts/python/tts_daemon.py'
    $candidates.Add($globalRoot)

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    return $null
}

$realDaemon = Resolve-TtsDaemon
$shimJsonPath = Join-Path $PluginDir 'python/live2d_tts_shim.json'
$shimDir = Split-Path -Parent $shimJsonPath
if (-not (Test-Path -LiteralPath $shimDir)) { New-Item -ItemType Directory -Force -Path $shimDir | Out-Null }
$sidecar = [ordered]@{
    realDaemon   = if ($realDaemon) { $realDaemon } else { '' }
    ingestUrl    = "http://127.0.0.1:$hostPort/ingest"
    token        = $ingestToken
    enabledFile  = (Join-Path $PluginDir 'data/tts-bridge.enabled')
    hopMs        = 20
    envelopeGain = 3.0
    batchFrames  = 4
    # Extra lip-sync delay for devices whose real latency is higher than the
    # player's estimate (e.g. some Bluetooth headsets); 0 = trust the player.
    latencyExtraMs = 0
}
Set-Content -LiteralPath $shimJsonPath -Value ($sidecar | ConvertTo-Json -Depth 4) -Encoding utf8NoBOM
if ($realDaemon) {
    Write-Step "wrote TTS shim sidecar $shimJsonPath (realDaemon: $realDaemon)"
}
else {
    Write-Host 'warning: TTS bridge disabled (tool-tts not installed) — the overlay still works without lip sync' -ForegroundColor Yellow
    Write-Step "wrote TTS shim sidecar $shimJsonPath (realDaemon: empty)"
}

# ------------------------------------------- tts workspace config (tts.config.yml) --
# tool-tts merges its workspace `tts.config.yml` ABOVE the plugin row config, and
# that generated file records `daemonScript: ""`. An explicit empty value beats
# the bridge bundle's `daemonScript`, so the shim would never be spawned even
# though the row config is correct. Point the file at the shim; uninstall.ps1
# restores the original file (kept next to it as *.lead-backup).
$shimScript = (Join-Path $PluginDir 'python/live2d_tts_shim.py').Replace('\', '/')
$ttsConfigs = @()
try {
    $documents = Join-Path $env:USERPROFILE 'Documents'
    if (Test-Path -LiteralPath $documents) {
        $ttsConfigs = Get-ChildItem -LiteralPath $documents -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'tts.config.yml' } |
            Where-Object { Test-Path -LiteralPath $_ }
    }
}
catch {
    Write-Host "warning: could not scan for tts.config.yml: $_" -ForegroundColor Yellow
}
$updatedTtsConfigs = @()
foreach ($ttsConfig in $ttsConfigs) {
    try {
        $text = Get-Content -LiteralPath $ttsConfig -Raw
        if ($text -notmatch '(?m)^\s*daemonScript\s*:') { continue }
        $backup = "$ttsConfig.lead-backup"
        if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $ttsConfig -Destination $backup -Force }
        $newText = [regex]::Replace($text, '(?m)^\s*daemonScript\s*:.*$', 'daemonScript: "' + $shimScript + '"')
        if ($newText -ne $text) {
            Set-Content -LiteralPath $ttsConfig -Value $newText -Encoding utf8NoBOM
            $updatedTtsConfigs += $ttsConfig
        }
    }
    catch {
        Write-Host "warning: could not update $ttsConfig : $_" -ForegroundColor Yellow
    }
}
if ($updatedTtsConfigs.Count -gt 0) {
    Write-Step ("tts.config.yml daemonScript -> shim: " + ($updatedTtsConfigs -join '; '))
}
else {
    Write-Step 'tts.config.yml: no daemonScript override to update'
}

# ------------------------------------------------------------------- verify --
if (-not $NoVerify) {
    $verifyHelper = Join-Path ([System.IO.Path]::GetTempPath()) ("live2d-verify-{0}.mjs" -f ([guid]::NewGuid().ToString('N')))
    $verifyCode = @'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [profileDir] = process.argv.slice(2)
const require = createRequire(join(profileDir, 'package.json'))
let failed = false
for (const name of ['@local/dsh-live2d-bundle', '@local/dsh-live2d-tts-bridge', '@local/dsh-live2d']) {
  try {
    const manifestPath = require.resolve(name + '/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const extra = name.endsWith('-bundle') ? `dsh.bundle.patch=${manifest.dsh?.bundle?.patch}` : `dsh.client=${JSON.stringify(manifest.dsh?.client)}`
    console.log(`ok: ${name} -> ${manifestPath} (${extra})`)
  } catch (error) {
    failed = true
    console.log(`FAIL: ${name} does not resolve from ${profileDir}: ${error.message}`)
  }
}
process.exit(failed ? 1 : 0)
'@
    Set-Content -LiteralPath $verifyHelper -Value $verifyCode -Encoding utf8NoBOM
    try {
        Write-Step 'verifying module resolution from the profile'
        & $node $verifyHelper $ProfileDir
        if ($LASTEXITCODE -ne 0) { Fail 'verification failed; the profile would not load the bundle' }
    }
    finally {
        Remove-Item -LiteralPath $verifyHelper -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host 'install: OK' -ForegroundColor Green
Write-Host "  avatar bundle:  $BundlePackage ($BundleDir)"
Write-Host "  TTS bridge bundle: $BridgePackage ($BridgeDir)  (independent optional plugin)"
Write-Host "  plugin:  $PluginPackage ($PluginDir)"
Write-Host '  Plugins page: two independent switchable entries — Live2D 桌宠 and Live2D × TTS 联动桥.'
Write-Host '  A running profile with HMR recomposes on the bundle-list change (a few seconds).'
Write-Host '  Run tools/dev-start.ps1 to start/inspect the dev instance, tools/uninstall.ps1 to revert.'

