# winux: install the trzsz client (tssh) so you can drag-and-drop files onto an
# SSH session to upload them to the remote's current directory.
#
# This installs only the CLIENT half (tssh.exe) into winux\bin and adds it to
# PATH. You also need trzsz (trz/tsz) on the REMOTE host -- instructions print
# at the end. Once both are present, `xssh user@host` routes through tssh and
# dragging files onto the window uploads them.

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$winuxHome = if ($env:WINUX_HOME) { $env:WINUX_HOME } else { $PSScriptRoot }
$bin = Join-Path $winuxHome 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null

Write-Host 'Fetching latest trzsz-ssh (tssh) release...' -ForegroundColor Cyan
$rel = Invoke-RestMethod 'https://api.github.com/repos/trzsz/trzsz-ssh/releases/latest' -Headers @{ 'User-Agent' = 'winux' }
$asset = $rel.assets | Where-Object { $_.name -match 'windows' -and $_.name -match 'x86_64' } | Select-Object -First 1
if (-not $asset) { throw 'No windows x86_64 asset found for trzsz-ssh.' }

$zip = Join-Path $env:TEMP $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $zip
$tmp = Join-Path $env:TEMP ('tssh_' + [guid]::NewGuid().ToString('N').Substring(0, 6))
Expand-Archive $zip $tmp -Force
$tssh = Get-ChildItem $tmp -Recurse -Filter 'tssh.exe' | Select-Object -First 1
if (-not $tssh) { throw 'tssh.exe not found in the downloaded archive.' }
Copy-Item $tssh.FullName (Join-Path $bin 'tssh.exe') -Force
Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Installed: $(Join-Path $bin 'tssh.exe')  ($($rel.tag_name))" -ForegroundColor Green

# Put winux\bin on the user PATH so tssh is discoverable
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$bin*") {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin), 'User')
    Write-Host "Added $bin to user PATH." -ForegroundColor Green
}
$env:Path = $env:Path.TrimEnd(';') + ';' + $bin

Write-Host ''
Write-Host 'CLIENT ready. Install trzsz on the REMOTE host (one time):' -ForegroundColor Cyan
Write-Host '  Debian/Ubuntu : sudo apt install trzsz'
Write-Host '  Any Linux/pip : python3 -m pip install trzsz'
Write-Host '  Manual binary : https://github.com/trzsz/trzsz-go/releases'
Write-Host ''
Write-Host 'Then connect with winux as usual:' -ForegroundColor Cyan
Write-Host '  xssh user@host        # now routes through tssh; resilient + drag-drop'
Write-Host '  (force plain ssh:  xssh -Plain user@host)'
Write-Host ''
Write-Host 'Drag files or folders onto the window to upload them to the remote''s current dir.'
