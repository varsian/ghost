#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
    Remove the Live2D plugin bundle from a DSH profile (reverse of install.ps1).

.DESCRIPTION
    Removes @local/dsh-live2d-bundle from the profile's dsh.profile.bundles and
    deletes the @local junction/symlink entries created by install.ps1. Dependency
    entries are kept by default (they are inert without the bundle selection); use
    -RemoveDependencies to drop them too, or -RestoreBackup to restore the pristine
    package.json saved by install.ps1 as package.json.lead-backup.

    A running profile with HMR recomposes after the bundle-list change.

.PARAMETER ProfileDir
    Absolute path of the profile directory. Defaults to $env:DSH_HOME/profiles/web.

.PARAMETER RestoreBackup
    Restore package.json from package.json.lead-backup when that backup exists.

.PARAMETER RemoveDependencies
    Also remove the @local/* dependency entries from package.json.

.EXAMPLE
    $env:DSH_HOME = '<DSH_HOME>'
    ./tools/uninstall.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = '',
    [switch]$RestoreBackup,
    [switch]$RemoveDependencies
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$BundlePackages = @('@local/dsh-live2d-bundle', '@local/dsh-live2d-tts-bridge')

function Write-Step([string]$Text) { Write-Host "==> $Text" }
function Fail([string]$Text) { Write-Host "error: $Text" -ForegroundColor Red; exit 1 }

if (-not $ProfileDir) {
    if ($env:DSH_HOME) { $ProfileDir = Join-Path $env:DSH_HOME 'profiles/web' }
    else { Fail 'no -ProfileDir and DSH_HOME is not set; pass -ProfileDir <profile directory>' }
}
if (-not (Test-Path -LiteralPath $ProfileDir)) { Fail "profile directory not found: $ProfileDir" }
$ProfileDir = (Resolve-Path -LiteralPath $ProfileDir).Path
$ProfileJson = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $ProfileJson)) { Fail "profile package.json not found: $ProfileJson" }

$backup = "$ProfileJson.lead-backup"
if ($RestoreBackup) {
    if (-not (Test-Path -LiteralPath $backup)) { Fail "backup not found: $backup" }
    Copy-Item -LiteralPath $backup -Destination $ProfileJson -Force
    Write-Step "restored $ProfileJson from $backup"
}
else {
    $node = (Get-Command node -ErrorAction Stop).Source
    $helper = Join-Path ([System.IO.Path]::GetTempPath()) ("live2d-uninstall-{0}.mjs" -f ([guid]::NewGuid().ToString('N')))
    $code = @'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [profileDir, bundleList, removeDependencies] = process.argv.slice(2)
const bundleNames = bundleList.split(',').filter(Boolean)
const pkgPath = join(profileDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const current = pkg.dsh?.profile?.bundles
if (Array.isArray(current)) {
  pkg.dsh.profile.bundles = current.filter((name) => !bundleNames.includes(name))
}
if (removeDependencies === 'true' && pkg.dependencies) {
  for (const name of Object.keys(pkg.dependencies)) {
    if (name.startsWith('@local/')) delete pkg.dependencies[name]
  }
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ packageJson: pkgPath, bundles: pkg.dsh?.profile?.bundles }, null, 2))
'@
    Set-Content -LiteralPath $helper -Value $code -Encoding utf8NoBOM
    try {
        Write-Step 'removing the bundle selection from the profile package.json'
        & $node $helper $ProfileDir ($BundlePackages -join ',') ([string]$RemoveDependencies.IsPresent)
        if ($LASTEXITCODE -ne 0) { Fail 'profile package.json update failed' }
    }
    finally {
        Remove-Item -LiteralPath $helper -Force -ErrorAction SilentlyContinue
    }
}

$localScope = Join-Path $ProfileDir 'node_modules/@local'
foreach ($name in @('dsh-live2d-bundle', 'dsh-live2d-tts-bridge', 'dsh-live2d')) {
    $linkPath = Join-Path $localScope $name
    $existing = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $existing) { continue }
    if (-not $existing.LinkType) {
        Write-Host "warning: $linkPath is a real directory, leaving it in place" -ForegroundColor Yellow
        continue
    }
    Remove-Item -LiteralPath $linkPath -Force -Recurse
    Write-Step "removed link $linkPath"
}

# Restore the tts workspace config files that install.ps1 pointed at the shim.
try {
    $documents = Join-Path $env:USERPROFILE 'Documents'
    if (Test-Path -LiteralPath $documents) {
        $configs = Get-ChildItem -LiteralPath $documents -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'tts.config.yml' } |
            Where-Object { Test-Path -LiteralPath $_ }
        foreach ($ttsConfig in $configs) {
            $backup = "$ttsConfig.lead-backup"
            if (Test-Path -LiteralPath $backup) {
                Copy-Item -LiteralPath $backup -Destination $ttsConfig -Force
                Remove-Item -LiteralPath $backup -Force
                Write-Step "restored tts.config.yml from backup: $ttsConfig"
            }
            else {
                $text = Get-Content -LiteralPath $ttsConfig -Raw
                $newText = [regex]::Replace($text, '(?m)^\s*daemonScript\s*:.*$', 'daemonScript: ""')
                if ($newText -ne $text) {
                    Set-Content -LiteralPath $ttsConfig -Value $newText -Encoding utf8NoBOM
                    Write-Step "cleared tts.config.yml daemonScript: $ttsConfig"
                }
            }
        }
    }
}
catch {
    Write-Host "warning: could not restore tts.config.yml: $_" -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'uninstall: OK' -ForegroundColor Green
Write-Host "  profile: $ProfileDir"
Write-Host '  A running profile with HMR recomposes after the bundle-list change.'
