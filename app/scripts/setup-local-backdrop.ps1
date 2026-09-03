[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$appRoot = Split-Path -Parent $PSScriptRoot
$localRoot = Join-Path $appRoot 'local-ai'
$binDir = Join-Path $localRoot 'bin'
$modelDir = Join-Path $localRoot 'models'
$downloadDir = Join-Path $localRoot 'downloads'
$exe = Join-Path $binDir 'sd-cli.exe'
$model = Join-Path $modelDir 'sdxs-512-tinySDdistilled_Q8_0.gguf'
$previousModel = Join-Path $modelDir 'lcm-dreamshaper-v7-f16.gguf'
$legacyIncompleteModel = Join-Path $modelDir 'lcm-dreamshaper-v7.safetensors'
$generatorArchive = 'sd-master-6b3edaa-bin-win-cpu-x64.zip'
$generatorUrl = "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-841-6b3edaa/$generatorArchive"
$generatorSha256 = 'a36edb067de09fc9f70fcd193e519ff62592f860744558d7918762c7c3401050'
$modelUrl = 'https://huggingface.co/concedo/sdxs-512-tinySDdistilled-GGUF/resolve/main/sdxs-512-tinySDdistilled_Q8_0.gguf'
$modelSha256 = '409ab23582ee074c6b9d5395784fc0741b0599fb9d138686c69087c71678eb6a'

New-Item -ItemType Directory -Force -Path $binDir, $modelDir, $downloadDir | Out-Null

function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Download-File([string]$Url, [string]$Destination) {
    $partial = "$Destination.partial"
    $curlArgs = @('-L', '--fail', '--retry', '4', '--retry-delay', '3')
    if (Test-Path -LiteralPath $partial) { $curlArgs += @('--continue-at', '-') }
    $curlArgs += @('--output', $partial, $Url)
    & curl.exe @curlArgs
    if ($LASTEXITCODE -ne 0) { throw "download failed with curl exit code $LASTEXITCODE" }
    Move-Item -LiteralPath $partial -Destination $Destination -Force
}

if ($Force -or -not (Test-Path -LiteralPath $exe)) {
    Write-Host 'Fetching the pinned stable-diffusion.cpp CPU build...' -ForegroundColor Cyan
    $zip = Join-Path $downloadDir $generatorArchive
    Download-File $generatorUrl $zip
    if ((Get-Sha256 $zip) -ne $generatorSha256) { throw 'stable-diffusion.cpp archive checksum mismatch.' }

    $extractDir = Join-Path $localRoot ('.extract-' + $PID)
    $resolvedLocal = [IO.Path]::GetFullPath($localRoot).TrimEnd('\') + '\'
    $resolvedExtract = [IO.Path]::GetFullPath($extractDir)
    if (-not $resolvedExtract.StartsWith($resolvedLocal, [StringComparison]::OrdinalIgnoreCase)) {
        throw "refusing unsafe extraction path: $resolvedExtract"
    }
    try {
        New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
        Expand-Archive -LiteralPath $zip -DestinationPath $extractDir -Force
        $foundExe = Get-ChildItem -LiteralPath $extractDir -Filter 'sd-cli.exe' -File -Recurse | Select-Object -First 1
        if (-not $foundExe) { throw 'sd-cli.exe was not present in the downloaded archive.' }
        Get-ChildItem -LiteralPath $foundExe.Directory.FullName -Force |
            Copy-Item -Destination $binDir -Recurse -Force
    }
    finally {
        if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
    }
}
else {
    Write-Host 'stable-diffusion.cpp is already installed.' -ForegroundColor DarkGray
}

$modelOk = (Test-Path -LiteralPath $model) -and
    ((Get-Item -LiteralPath $model).Length -eq 682847200) -and
    ((Get-Sha256 $model) -eq $modelSha256)
if (-not $modelOk) {
    $driveName = [IO.Path]::GetPathRoot($localRoot).TrimEnd(':\')
    $drive = Get-PSDrive -Name $driveName
    if ($drive.Free -lt 2GB) { throw 'At least 2 GB of free disk space is required for the local backdrop model.' }
    Write-Host 'Downloading the 651 MB local one-step image model (one time only)...' -ForegroundColor Cyan
    Download-File $modelUrl $model
    Write-Host 'Verifying model checksum...' -ForegroundColor Cyan
    if ((Get-Sha256 $model) -ne $modelSha256) { throw 'Local image model checksum mismatch.' }
}
else {
    Write-Host 'Local image model is already installed.' -ForegroundColor DarkGray
}

# Do not delete the previous model automatically. An older Limpet window may
# still be running code that references it; removing it here would disrupt that
# active session. It is safe to remove manually after every older window closes.
if (Test-Path -LiteralPath $previousModel) {
    Write-Host "Previous model retained for active older windows: $previousModel" -ForegroundColor DarkGray
}

# An early development setup pointed at the upstream Diffusers UNet-only file,
# which cannot generate by itself. Remove that exact obsolete repo-local file
# after the complete GGUF has been verified successfully.
if (Test-Path -LiteralPath $legacyIncompleteModel) {
    Remove-Item -LiteralPath $legacyIncompleteModel -Force
    Write-Host 'Removed obsolete incomplete model.' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host 'Local Limpet backdrops are ready.' -ForegroundColor Green
Write-Host "  Generator: $exe"
Write-Host "  Model    : $model"
Write-Host 'No API key or network connection is used during generation.'
