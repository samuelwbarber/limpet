# winux installer.
# Wires the three layers together without copying anything around:
#   * adds the Winux import to your PowerShell profile (Linux commands)
#   * points WezTerm at this repo's config (rendering + resilient SSH)
#   * sets WINUX_HOME so the WezTerm config can find the module
# Re-running is safe (idempotent).

$ErrorActionPreference = 'Stop'
$repo   = $PSScriptRoot
$module = Join-Path $repo 'shell\Winux.psd1'
$wezcfg = Join-Path $repo 'wezterm\wezterm.lua'

Write-Host "winux repo: $repo" -ForegroundColor Cyan

# 1. Environment: where the module lives (read by wezterm.lua)
[Environment]::SetEnvironmentVariable('WINUX_HOME', $repo, 'User')
$env:WINUX_HOME = $repo

# 2. PowerShell profile: auto-import Winux in every session (any host)
$profilePath = $PROFILE.CurrentUserAllHosts
$profileDir  = Split-Path $profilePath
if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Force -Path $profileDir | Out-Null }

$marker  = '# >>> winux >>>'
$block   = "`n$marker`nImport-Module `"$module`"`n# <<< winux <<<`n"
$current = if (Test-Path $profilePath) { Get-Content $profilePath -Raw } else { '' }

if ($current -notmatch [regex]::Escape($marker)) {
    Add-Content -Path $profilePath -Value $block
    Write-Host "Added Winux import to $profilePath" -ForegroundColor Green
}
else {
    Write-Host "Profile already references winux; left unchanged." -ForegroundColor Yellow
}

# 3. WezTerm: point it at this repo's config (no file copy)
if (Get-Command wezterm -ErrorAction SilentlyContinue) {
    [Environment]::SetEnvironmentVariable('WEZTERM_CONFIG_FILE', $wezcfg, 'User')
    Write-Host "WezTerm detected; WEZTERM_CONFIG_FILE -> $wezcfg" -ForegroundColor Green
}
else {
    Write-Host "WezTerm not installed (optional, recommended for rendering)." -ForegroundColor Yellow
    Write-Host "  Install: winget install wez.wezterm  (or grab the portable zip, see README)"
}

# 4. Optional companions
if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) {
    Write-Host "PowerShell 7 not installed (optional)." -ForegroundColor Yellow
    Write-Host "  Install: winget install Microsoft.PowerShell"
}

Write-Host "`nDone. Open a new terminal, or run '. `$PROFILE' in this one, to load winux." -ForegroundColor Cyan
