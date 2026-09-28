# limpet installer.
# Wires everything up without copying anything around:
#   * adds the Limpet import to your PowerShell profile (Linux commands)
#   * installs the app (Electron and its terminal binary) if it isn't yet
#   * creates the Start Menu shortcut, so 'limpet' in Windows search opens it
# Re-running is safe (idempotent).

$ErrorActionPreference = 'Stop'
$repo   = $PSScriptRoot
$module = Join-Path $repo 'shell\Limpet.psd1'

Write-Host "limpet repo: $repo" -ForegroundColor Cyan

# 1. PowerShell profile: auto-import Limpet in every session (any host)
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

# 2. The app: Electron plus a ConPTY binary built for it. `npm run setup` skips
#    node-pty's own install script, which fails on current Node (it spawns a
#    .cmd without a shell) and takes the whole `npm install` down with it.
$appDir   = Join-Path $repo 'app'
$electron = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
$conpty   = Join-Path $appDir 'node_modules\@homebridge\node-pty-prebuilt-multiarch\build\Release\conpty.node'

function Test-LimpetApp {
    $ErrorActionPreference = 'Continue' # a failed load is an answer, not an error
    if (-not ((Test-Path $electron) -and (Test-Path $conpty))) { return $false }
    # The binary has to be Electron's build, not one made for the system Node.
    # (electron.exe is a GUI program: piping its output is what makes
    # PowerShell wait for it and set $LASTEXITCODE.)
    $env:ELECTRON_RUN_AS_NODE = '1'
    try { & $electron -e 'require(process.argv[1])' $conpty 2>$null | Out-Null; $LASTEXITCODE -eq 0 }
    finally { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
}

if (Test-LimpetApp) {
    Write-Host "App already installed." -ForegroundColor DarkGray
}
elseif (Get-Command npm -ErrorAction SilentlyContinue) {
    Write-Host "Installing the app (Electron and its terminal binary)..." -ForegroundColor Cyan
    Push-Location $appDir
    try { $ErrorActionPreference = 'Continue'; npm run setup }
    finally { $ErrorActionPreference = 'Stop'; Pop-Location }
    if (-not (Test-LimpetApp)) { throw "App install failed (see above). Retry with: cd `"$appDir`"; npm run setup" }
    Write-Host "App installed." -ForegroundColor Green
}
else {
    Write-Host "Node.js not found, so the app wasn't installed." -ForegroundColor Yellow
    Write-Host "  Install: winget install OpenJS.NodeJS.LTS   (then re-run .\install.ps1 in a new terminal)"
}

# 3. Start Menu shortcut: launch the Electron app by typing 'limpet' in Windows search
if (Test-Path $electron) {
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    if (-not (Test-Path $startMenu)) { New-Item -ItemType Directory -Force -Path $startMenu | Out-Null }
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
    Write-Host "Start Menu shortcut created; type 'limpet' in Windows search to open the app." -ForegroundColor Green
}
else {
    Write-Host "No Start Menu shortcut yet: the app isn't installed. Re-run this installer once Node.js is installed." -ForegroundColor Yellow
}

# 4. Optional companions
if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) {
    Write-Host "PowerShell 7 not installed (optional)." -ForegroundColor Yellow
    Write-Host "  Install: winget install Microsoft.PowerShell"
}

Write-Host "`nDone. Open a new terminal, or run '. `$PROFILE' in this one, to load limpet." -ForegroundColor Cyan
