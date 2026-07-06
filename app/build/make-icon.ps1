# Generates the limpet app icon (limpet.ico, multi-resolution) and a 256px PNG
# preview. The mark is the mascot: a cute limpet — a blue conical shell with
# ribbed ridges, its peach foot peeking out underneath with a little face — on
# the app's own dark background (#1e1e2e). A limpet clings to its rock no
# matter how hard the waves hit, which is the whole xssh pitch.
# Re-run to regenerate after tweaking.
#
#   powershell -ExecutionPolicy Bypass -File app\build\make-icon.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = $PSScriptRoot
$icoPath = Join-Path $outDir 'limpet.ico'
$pngPath = Join-Path $outDir 'limpet-256.png'

# Catppuccin Mocha palette (matches the terminal theme in renderer.js).
$bgTop    = [System.Drawing.Color]::FromArgb(255, 30, 30, 46)    # #1e1e2e
$bgBottom = [System.Drawing.Color]::FromArgb(255, 24, 24, 37)    # #181825
$blue     = [System.Drawing.Color]::FromArgb(255, 137, 180, 250) # #89b4fa
$lavender = [System.Drawing.Color]::FromArgb(255, 180, 190, 254) # #b4befe
$peach    = [System.Drawing.Color]::FromArgb(255, 250, 179, 135) # #fab387
$ink      = [System.Drawing.Color]::FromArgb(255, 49, 50, 68)    # #313244
$pink     = [System.Drawing.Color]::FromArgb(110, 243, 139, 168) # #f38ba8, soft

function New-IconBitmap([int]$S) {
    $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    # Rounded-rectangle "window" background with a vertical gradient.
    $pad = [float]($S * 0.06)
    $r   = [float]($S * 0.20)
    $x0  = $pad; $y0 = $pad
    $w   = [float]($S - 2 * $pad); $h = $w
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x0, $y0, $d, $d, 180, 90)
    $path.AddArc($x0 + $w - $d, $y0, $d, $d, 270, 90)
    $path.AddArc($x0 + $w - $d, $y0 + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x0, $y0 + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $rect = New-Object System.Drawing.RectangleF($x0, $y0, $w, $h)
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $bgTop, $bgBottom, 90.0)
    $g.FillPath($grad, $path)

    # Subtle blue rim.
    $rimPen = New-Object System.Drawing.Pen($blue, [float]($S * 0.012))
    $rimPen.Color = [System.Drawing.Color]::FromArgb(60, $blue)
    $g.DrawPath($rimPen, $path)

    # Peach foot peeking out under the shell (the face lives here).
    $footBrush = New-Object System.Drawing.SolidBrush($peach)
    $g.FillEllipse($footBrush, [float]($S * 0.24), [float]($S * 0.54), [float]($S * 0.52), [float]($S * 0.22))

    # Conical shell: slightly concave sides up to a rounded apex, gently bowed
    # base so it sits over the foot.
    $shell = New-Object System.Drawing.Drawing2D.GraphicsPath
    $shell.AddBezier(
        [float]($S * 0.20), [float]($S * 0.62),
        [float]($S * 0.28), [float]($S * 0.44),
        [float]($S * 0.38), [float]($S * 0.26),
        [float]($S * 0.50), [float]($S * 0.20))
    $shell.AddBezier(
        [float]($S * 0.50), [float]($S * 0.20),
        [float]($S * 0.62), [float]($S * 0.26),
        [float]($S * 0.72), [float]($S * 0.44),
        [float]($S * 0.80), [float]($S * 0.62))
    $shell.AddBezier(
        [float]($S * 0.80), [float]($S * 0.62),
        [float]($S * 0.68), [float]($S * 0.675),
        [float]($S * 0.32), [float]($S * 0.675),
        [float]($S * 0.20), [float]($S * 0.62))
    $shell.CloseFigure()
    $shellBrush = New-Object System.Drawing.SolidBrush($blue)
    $g.FillPath($shellBrush, $shell)

    # Ribs radiating from the apex, clipped to the shell.
    $g.SetClip($shell)
    $ribPen = New-Object System.Drawing.Pen($lavender, [float]($S * 0.025))
    $ribPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $ribPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    foreach ($bx in 0.30, 0.435, 0.565, 0.70) {
        $g.DrawLine($ribPen, [float]($S * 0.50), [float]($S * 0.225),
                             [float]($S * $bx), [float]($S * 0.635))
    }
    $g.ResetClip()

    # Rounded knob on the apex.
    $knobBrush = New-Object System.Drawing.SolidBrush($lavender)
    $g.FillEllipse($knobBrush, [float]($S * 0.455), [float]($S * 0.175), [float]($S * 0.09), [float]($S * 0.09))

    # Face — only at sizes where it survives (a 16px face is just mud).
    if ($S -ge 24) {
        $inkBrush   = New-Object System.Drawing.SolidBrush($ink)
        $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
        foreach ($ex in 0.40, 0.60) {
            $g.FillEllipse($inkBrush, [float]($S * ($ex - 0.028)), [float]($S * 0.657), [float]($S * 0.056), [float]($S * 0.056))
            $g.FillEllipse($whiteBrush, [float]($S * ($ex - 0.018)), [float]($S * 0.664), [float]($S * 0.02), [float]($S * 0.02))
        }
        $smilePen = New-Object System.Drawing.Pen($ink, [float]($S * 0.016))
        $smilePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $smilePen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
        $g.DrawArc($smilePen, [float]($S * 0.45), [float]($S * 0.645), [float]($S * 0.10), [float]($S * 0.07), 25, 130)
        $blushBrush = New-Object System.Drawing.SolidBrush($pink)
        $g.FillEllipse($blushBrush, [float]($S * 0.295), [float]($S * 0.672), [float]($S * 0.065), [float]($S * 0.038))
        $g.FillEllipse($blushBrush, [float]($S * 0.64),  [float]($S * 0.672), [float]($S * 0.065), [float]($S * 0.038))
        $inkBrush.Dispose(); $whiteBrush.Dispose(); $smilePen.Dispose(); $blushBrush.Dispose()
    }

    $g.Dispose()
    $grad.Dispose(); $rimPen.Dispose(); $footBrush.Dispose(); $shellBrush.Dispose()
    $ribPen.Dispose(); $knobBrush.Dispose(); $shell.Dispose(); $path.Dispose()
    return $bmp
}

# Render each size and PNG-encode it into memory.
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = @()
foreach ($s in $sizes) {
    $bmp = New-IconBitmap $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += , @{ size = $s; bytes = $ms.ToArray() }
    if ($s -eq 256) { [System.IO.File]::WriteAllBytes($pngPath, $ms.ToArray()) }
    $ms.Dispose(); $bmp.Dispose()
}

# Assemble the .ico (ICONDIR + ICONDIRENTRY[] + PNG payloads). PNG-compressed
# entries are supported by Windows Vista and later.
$fs = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)               # reserved
$bw.Write([UInt16]1)               # type: icon
$bw.Write([UInt16]$pngs.Count)     # image count

$offset = 6 + 16 * $pngs.Count
foreach ($p in $pngs) {
    $dim = if ($p.size -ge 256) { 0 } else { $p.size }
    $bw.Write([Byte]$dim)          # width  (0 => 256)
    $bw.Write([Byte]$dim)          # height (0 => 256)
    $bw.Write([Byte]0)             # palette
    $bw.Write([Byte]0)             # reserved
    $bw.Write([UInt16]1)           # color planes
    $bw.Write([UInt16]32)          # bits per pixel
    $bw.Write([UInt32]$p.bytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $p.bytes.Length
}
foreach ($p in $pngs) { $bw.Write($p.bytes) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $fs.ToArray())
$bw.Dispose(); $fs.Dispose()

Write-Host "Wrote $icoPath ($($pngs.Count) sizes) and $pngPath"
