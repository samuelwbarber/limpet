# limpet installer.
# Wires the three layers together without copying anything around:
#   * adds the Limpet import to your PowerShell profile (Linux commands)
#   * points WezTerm at this repo's config (rendering + resilient SSH)
#   * sets LIMPET_HOME so the WezTerm config can find the module
# Re-running is safe (idempotent).

$ErrorActionPreference = 'Stop'
$repo   = $PSScriptRoot
$module = Join-Path $repo 'shell\Limpet.psd1'
$wezcfg = Join-Path $repo 'wezterm\wezterm.lua'

Write-Host "limpet repo: $repo" -ForegroundColor Cyan

# 1. Environment: where the module lives (read by wezterm.lua)
[Environment]::SetEnvironmentVariable('LIMPET_HOME', $repo, 'User')
$env:LIMPET_HOME = $repo

# 2. PowerShell profile: auto-import Limpet in every session (any host)
$profilePath = $PROFILE.CurrentUserAllHosts
$profileDir  = Split-Path $profilePath
if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Force -Path $profileDir | Out-Null }

$marker  = '# >>> limpet >>>'
$block   = "`n$marker`nImport-Module `"$module`"`n# <<< limpet <<<`n"
$current = if (Test-Path $profilePath) { Get-Content $profilePath -Raw } else { '' }

if ($current -notmatch [regex]::Escape($marker)) {
    Add-Content -Path $profilePath -Value $block
    Write-Host "Added Limpet import to $profilePath" -ForegroundColor Green
}
else {
    Write-Host "Profile already references limpet; left unchanged." -ForegroundColor Yellow
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

# 4. Start Menu shortcut: launch the Electron app by typing 'limpet' in Windows search
$electron = Join-Path $repo 'app\node_modules\electron\dist\electron.exe'
$appDir   = Join-Path $repo 'app'
if (Test-Path $electron) {
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $lnkPath   = Join-Path $startMenu 'limpet.lnk'
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnkPath)
    $icoPath = Join-Path $repo 'app\build\limpet.ico'
    $icon    = if (Test-Path $icoPath) { "$icoPath,0" } else { "$electron,0" }
    $sc.TargetPath       = $electron
    $sc.Arguments        = "`"$appDir`""
    $sc.WorkingDirectory = $appDir
    $sc.IconLocation     = $icon
    $sc.Description       = 'limpet - hybrid PowerShell/Linux terminal'
    $sc.WindowStyle      = 1
    $sc.Save()
    Write-Host "Start Menu shortcut created; search 'limpet' to launch the app." -ForegroundColor Green
}
else {
    Write-Host "Electron not installed yet; run 'npm install' in $appDir, then re-run this installer for the 'limpet' search shortcut." -ForegroundColor Yellow
}

# 5. Optional companions
if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) {
    Write-Host "PowerShell 7 not installed (optional)." -ForegroundColor Yellow
    Write-Host "  Install: winget install Microsoft.PowerShell"
}

Write-Host "`nDone. Open a new terminal, or run '. `$PROFILE' in this one, to load limpet." -ForegroundColor Cyan
