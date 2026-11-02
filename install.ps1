# claude-devin installer — Windows PowerShell.
# Usage:  irm https://raw.githubusercontent.com/JoShMiQueL/claude-devin/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$Repo    = 'JoShMiQueL/claude-devin'
$Branch  = 'main'
$Base    = "https://raw.githubusercontent.com/$Repo/$Branch"
$BinDir  = Join-Path $env:USERPROFILE '.local\bin'
$AppDir  = Join-Path $env:USERPROFILE '.claude-devin'

foreach ($cmd in 'node') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Error "claude-devin: '$cmd' is required (install Node.js >=18 from https://nodejs.org)"
  }
}

New-Item -ItemType Directory -Force -Path $AppDir, $BinDir | Out-Null

Write-Host "-> downloading claude-devin..."
Invoke-WebRequest -Uri "$Base/claude-devin/cli.mjs"          -OutFile (Join-Path $AppDir 'cli.mjs')
Invoke-WebRequest -Uri "$Base/claude-devin/proxy-bundle.mjs" -OutFile (Join-Path $AppDir 'proxy-bundle.mjs')

$Launcher = Join-Path $BinDir 'claude-devin.cmd'
@"
@echo off
node "$AppDir\cli.mjs" %*
"@ | Set-Content -Path $Launcher -Encoding ascii

Write-Host ""
Write-Host "[ok] installed to $AppDir"
Write-Host "[ok] launcher at $Launcher"

# PATH check — add $BinDir to the user PATH if missing.
$UserPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if ($UserPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable('PATH', "$UserPath;$BinDir", 'User')
  Write-Host "[ok] added $BinDir to your user PATH (restart your terminal)"
}

Write-Host ""
Write-Host "Next:"
Write-Host "  claude-devin install-claude   # if you don't have Claude Code yet"
Write-Host "  claude-devin login            # sign in with Devin"
Write-Host "  claude-devin                  # start claude on your Devin subscription"
