# Convert demo mp4s to palette-optimized GIFs for the README.
$sp = Split-Path $MyInvocation.MyCommand.Path
$ff = Join-Path $sp 'node_modules\ffmpeg-static\ffmpeg.exe'
$out = Join-Path $sp 'gifs'
New-Item -ItemType Directory -Force $out | Out-Null

foreach ($name in @('shell', 'tabs', 'peek', 'xssh', 'remote', 'drop')) {
    $src = Join-Path $sp "vids\$name.mp4"
    if (-not (Test-Path $src)) { Write-Host "skip $name (no mp4)"; continue }
    $pal = Join-Path $out "$name-pal.png"
    $gif = Join-Path $out "$name.gif"
    & $ff -y -ss 0.6 -i $src -vf "fps=10,scale=840:-1:flags=lanczos,palettegen=stats_mode=diff" $pal 2>$null
    & $ff -y -ss 0.6 -i $src -i $pal -lavfi "fps=10,scale=840:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" $gif 2>$null
    Remove-Item $pal -ErrorAction SilentlyContinue
    Write-Host ("{0}.gif  {1:N0} KB" -f $name, ((Get-Item $gif).Length / 1KB))
}
