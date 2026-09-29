# limpet installer.
# Wires everything up without copying anything around:
#   * adds the Limpet import to your PowerShell profile (Linux commands)
#   * creates the Start Menu shortcut for the app
# Re-running is safe (idempotent).

$ErrorActionPreference = 'Stop'
$repo   = $PSScriptRoot
$module = Join-Path $repo 'shell\Limpet.psd1'

Write-Host "limpet repo: $repo" -ForegroundColor Cyan

# 1. PowerShell profiles: auto-import Limpet in every session (any host), for
#    both Windows PowerShell 5.1 and PowerShell 7 (they use separate profiles).
#    Profiles are scripts, so a Restricted/AllSigned policy blocks them; warn
#    rather than change the policy behind the user's back.
$policy = Get-ExecutionPolicy
if ($policy -in 'Restricted', 'AllSigned') {
    Write-Warning "Execution policy is $policy, so your profile (and limpet) won't load. Fix it with:"
    Write-Host   "  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned" -ForegroundColor Yellow
}

$docs    = [Environment]::GetFolderPath('MyDocuments')
$marker  = '# >>> limpet >>>'
$import  = "Import-Module `"$module`""
$block   = "`n$marker`n$import`n# <<< limpet <<<`n"
foreach ($profilePath in @((Join-Path $docs 'WindowsPowerShell\profile.ps1'), (Join-Path $docs 'PowerShell\profile.ps1'))) {
    $profileDir = Split-Path $profilePath
    if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Force -Path $profileDir | Out-Null }
    $current = if (Test-Path $profilePath) { Get-Content $profilePath -Raw } else { '' }
    if ($null -eq $current) { $current = '' }

    if ($current -notmatch [regex]::Escape($marker)) {
        Add-Content -Path $profilePath -Value $block
        Write-Host "Added Limpet import to $profilePath" -ForegroundColor Green
    }
    else {
        # Repo moved? Point the existing block's Import-Module at this checkout.
        $re = '(?m)(^' + [regex]::Escape($marker) + '\r?\n)Import-Module [^\r\n]*'
        $updated = [regex]::Replace($current, $re, { param($mm) $mm.Groups[1].Value + $import })
        if ($updated -ne $current) {
            Set-Content -Path $profilePath -Value $updated.TrimEnd("`r", "`n") -Encoding UTF8
            Write-Host "Updated the Limpet import path in $profilePath" -ForegroundColor Green
        }
        else { Write-Host "$profilePath already imports limpet; left unchanged." -ForegroundColor Yellow }
    }
}

# 2. Start Menu shortcut: launch the Electron app by typing 'limpet' in Windows search
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

# 3. Optional companions
if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) {
    Write-Host "PowerShell 7 not installed (optional)." -ForegroundColor Yellow
    Write-Host "  Install: winget install Microsoft.PowerShell"
}

Write-Host "`nDone. Open a new terminal, or run '. `$PROFILE' in this one, to load limpet." -ForegroundColor Cyan
