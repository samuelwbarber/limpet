# Convert demo mp4s to palette-optimized GIFs for the README.
# Usage: .\togif.ps1 [name ...]   (default: every scenario with an mp4)
$sp = Split-Path $MyInvocation.MyCommand.Path
$ff = Join-Path $sp 'node_modules\ffmpeg-static\ffmpeg.exe'
$out = Join-Path $sp 'gifs'
New-Item -ItemType Directory -Force $out | Out-Null

# Long-running scenarios (agents replying, an image generating) play faster.
$speed = @{ switch = 1.6; backdrop = 3.0 }
$names = if ($args.Count) { $args } else { @('shell', 'tabs', 'peek', 'xssh', 'remote', 'drop', 'switch', 'backdrop') }

foreach ($name in $names) {
    $src = Join-Path $sp "vids\$name.mp4"
    if (-not (Test-Path $src)) { Write-Host "skip $name (no mp4)"; continue }
    $pal = Join-Path $out "$name-pal.png"
    $gif = Join-Path $out "$name.gif"
    $pts = if ($speed.ContainsKey($name)) { "setpts=PTS/$($speed[$name])," } else { '' }
    & $ff -y -ss 0.6 -i $src -vf "${pts}fps=10,scale=840:-1:flags=lanczos,palettegen=stats_mode=diff" $pal 2>$null
    & $ff -y -ss 0.6 -i $src -i $pal -lavfi "${pts}fps=10,scale=840:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" $gif 2>$null
    Remove-Item $pal -ErrorAction SilentlyContinue
    Write-Host ("{0}.gif  {1:N0} KB" -f $name, ((Get-Item $gif).Length / 1KB))
}
