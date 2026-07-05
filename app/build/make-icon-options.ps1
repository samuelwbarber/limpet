# Renders 5 penguin/Windows-hybrid icon concepts as 256px PNG previews so we can
# pick one. The chosen design gets promoted to winux.ico by make-icon.ps1.
#
#   powershell -ExecutionPolicy Bypass -File app\build\make-icon-options.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = $PSScriptRoot

# palette
$blue    = [System.Drawing.Color]::FromArgb(255, 0, 120, 212)    # Windows blue
$blueLt  = [System.Drawing.Color]::FromArgb(255, 80, 170, 245)
$blueDk  = [System.Drawing.Color]::FromArgb(255, 10, 95, 176)
$dark    = [System.Drawing.Color]::FromArgb(255, 30, 30, 46)     # #1e1e2e
$darkDn  = [System.Drawing.Color]::FromArgb(255, 24, 24, 37)
$slate   = [System.Drawing.Color]::FromArgb(255, 49, 50, 68)
$white   = [System.Drawing.Color]::FromArgb(255, 245, 245, 250)
$rimCol  = [System.Drawing.Color]::FromArgb(255, 205, 214, 244)
$black   = [System.Drawing.Color]::FromArgb(255, 22, 22, 30)
$orange  = [System.Drawing.Color]::FromArgb(255, 250, 175, 60)
$green   = [System.Drawing.Color]::FromArgb(255, 166, 227, 161)
# Microsoft 4-square colors
$msR = [System.Drawing.Color]::FromArgb(255, 242, 80, 34)
$msG = [System.Drawing.Color]::FromArgb(255, 127, 186, 0)
$msB = [System.Drawing.Color]::FromArgb(255, 0, 164, 239)
$msY = [System.Drawing.Color]::FromArgb(255, 255, 185, 0)

function New-Canvas([int]$S) {
    $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    return @{ bmp = $bmp; g = $g }
}

function Get-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# Dark/blue/etc rounded tile background. $mode: 'blue','dark','white','split'
function Draw-Tile($g, [int]$S, [string]$mode) {
    $pad = [float]($S * 0.06); $r = [float]($S * 0.20)
    $w = [float]($S - 2 * $pad)
    $path = Get-RoundRect $pad $pad $w $w $r
    $rect = New-Object System.Drawing.RectangleF($pad, $pad, $w, $w)
    switch ($mode) {
        'blue'  { $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $blueLt, $blueDk, 90.0) }
        'white' { $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, ([System.Drawing.Color]::FromArgb(255,250,250,255)), ([System.Drawing.Color]::FromArgb(255,225,228,240)), 90.0) }
        default { $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $dark, $darkDn, 90.0) }
    }
    $g.FillPath($br, $path)
    if ($mode -eq 'split') {
        # overlay: lower-right diagonal half in Windows blue, clipped to the tile
        $g.SetClip($path)
        $tri = [System.Drawing.PointF[]]@(
            (New-Object System.Drawing.PointF($S, $pad)),
            (New-Object System.Drawing.PointF($S, $S)),
            (New-Object System.Drawing.PointF($pad, $S)))
        $tb = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $blueLt, $blueDk, 60.0)
        $g.FillPolygon($tb, $tri)
        $g.ResetClip(); $tb.Dispose()
    }
    $br.Dispose()
    return $path
}

function Fill-Ellipse($g, $brush, [float]$cx, [float]$cy, [float]$rx, [float]$ry) {
    $g.FillEllipse($brush, $cx - $rx, $cy - $ry, $rx * 2, $ry * 2)
}
function Stroke-Ellipse($g, $pen, [float]$cx, [float]$cy, [float]$rx, [float]$ry) {
    $g.DrawEllipse($pen, $cx - $rx, $cy - $ry, $rx * 2, $ry * 2)
}

# Draw a Tux-style penguin centered at (cx,cy) with total height h.
# $bellyWindow adds a 2x2 window grid on the belly. $rim adds a light outline.
function Draw-Penguin($g, [int]$S, [float]$cx, [float]$cy, [float]$h, [bool]$bellyWindow, [bool]$rim) {
    $bodyBrush  = New-Object System.Drawing.SolidBrush($black)
    $whiteBrush = New-Object System.Drawing.SolidBrush($white)
    $orangeBrush = New-Object System.Drawing.SolidBrush($orange)

    $top = $cy - $h / 2
    # head + body (one black silhouette built from two ellipses)
    $headCx = $cx; $headCy = $top + $h * 0.20; $headR = $h * 0.21
    $bodyCx = $cx; $bodyCy = $top + $h * 0.64; $bodyRx = $h * 0.30; $bodyRy = $h * 0.36

    # flippers (black) on the body sides
    Fill-Ellipse $g $bodyBrush ($cx - $bodyRx * 0.95) ($bodyCy) ($h * 0.085) ($h * 0.22)
    Fill-Ellipse $g $bodyBrush ($cx + $bodyRx * 0.95) ($bodyCy) ($h * 0.085) ($h * 0.22)
    Fill-Ellipse $g $bodyBrush $bodyCx $bodyCy $bodyRx $bodyRy
    Fill-Ellipse $g $bodyBrush $headCx $headCy $headR $headR

    if ($rim) {
        $rimPen = New-Object System.Drawing.Pen($rimCol, [float]($S * 0.018))
        Stroke-Ellipse $g $rimPen $bodyCx $bodyCy $bodyRx $bodyRy
        Stroke-Ellipse $g $rimPen $headCx $headCy $headR $headR
        $rimPen.Dispose()
    }

    # white face + belly (drawn over to hide internal overlap lines)
    $faceCx = $cx; $faceCy = $top + $h * 0.225; $faceRx = $h * 0.145; $faceRy = $h * 0.16
    $belCx = $cx; $belCy = $top + $h * 0.66; $belRx = $h * 0.205; $belRy = $h * 0.265
    Fill-Ellipse $g $whiteBrush $faceCx $faceCy $faceRx $faceRy
    Fill-Ellipse $g $whiteBrush $belCx $belCy $belRx $belRy

    if ($bellyWindow) {
        $belPath = New-Object System.Drawing.Drawing2D.GraphicsPath
        $belPath.AddEllipse($belCx - $belRx, $belCy - $belRy, $belRx * 2, $belRy * 2)
        $g.SetClip($belPath)
        $mPen = New-Object System.Drawing.Pen($blue, [float]($h * 0.045))
        $g.DrawLine($mPen, $belCx, ($belCy - $belRy), $belCx, ($belCy + $belRy))
        $g.DrawLine($mPen, ($belCx - $belRx), $belCy, ($belCx + $belRx), $belCy)
        $g.ResetClip(); $mPen.Dispose(); $belPath.Dispose()
        $bPen = New-Object System.Drawing.Pen($blue, [float]($h * 0.04))
        Stroke-Ellipse $g $bPen $belCx $belCy $belRx $belRy
        $bPen.Dispose()
    }

    # eyes
    $eyeBrush = New-Object System.Drawing.SolidBrush($black)
    $eyeR = $h * 0.032
    Fill-Ellipse $g $eyeBrush ($cx - $h * 0.06) ($faceCy - $h * 0.01) $eyeR ($eyeR * 1.25)
    Fill-Ellipse $g $eyeBrush ($cx + $h * 0.06) ($faceCy - $h * 0.01) $eyeR ($eyeR * 1.25)

    # beak (orange diamond)
    $beak = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF($cx, ($faceCy + $h * 0.05))),
        (New-Object System.Drawing.PointF(($cx - $h * 0.055), ($faceCy + $h * 0.095))),
        (New-Object System.Drawing.PointF($cx, ($faceCy + $h * 0.14))),
        (New-Object System.Drawing.PointF(($cx + $h * 0.055), ($faceCy + $h * 0.095))))
    $g.FillPolygon($orangeBrush, $beak)

    # feet
    $footY = $top + $h * 0.99
    Fill-Ellipse $g $orangeBrush ($cx - $h * 0.13) $footY ($h * 0.11) ($h * 0.05)
    Fill-Ellipse $g $orangeBrush ($cx + $h * 0.13) $footY ($h * 0.11) ($h * 0.05)

    $bodyBrush.Dispose(); $whiteBrush.Dispose(); $orangeBrush.Dispose(); $eyeBrush.Dispose()
}

# Microsoft-style 2x2 colored squares, top-left at (x,y), each square size q, gap g.
function Draw-MSsquares($g, [float]$x, [float]$y, [float]$q, [float]$gap) {
    $b1 = New-Object System.Drawing.SolidBrush($msR)
    $b2 = New-Object System.Drawing.SolidBrush($msG)
    $b3 = New-Object System.Drawing.SolidBrush($msB)
    $b4 = New-Object System.Drawing.SolidBrush($msY)
    $g.FillRectangle($b1, $x, $y, $q, $q)
    $g.FillRectangle($b2, $x + $q + $gap, $y, $q, $q)
    $g.FillRectangle($b3, $x, $y + $q + $gap, $q, $q)
    $g.FillRectangle($b4, $x + $q + $gap, $y + $q + $gap, $q, $q)
    $b1.Dispose(); $b2.Dispose(); $b3.Dispose(); $b4.Dispose()
}

function Draw-Prompt($g, [int]$S, [float]$shift) {
    $stroke = [float]($S * 0.075)
    $pen = New-Object System.Drawing.Pen($blueLt, $stroke)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $pts = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF([float]($S * 0.22), [float]($S * 0.30 + $shift))),
        (New-Object System.Drawing.PointF([float]($S * 0.40), [float]($S * 0.44 + $shift))),
        (New-Object System.Drawing.PointF([float]($S * 0.22), [float]($S * 0.58 + $shift))))
    $g.DrawLines($pen, $pts)
    $pen.Dispose()
}

# ---- the five concepts ----
function Render-Option([int]$n, [int]$S) {
    $c = New-Canvas $S; $g = $c.g
    switch ($n) {
        1 { # Classic Tux on Windows-blue tile
            Draw-Tile $g $S 'blue' | Out-Null
            Draw-Penguin $g $S ([float]($S*0.5)) ([float]($S*0.52)) ([float]($S*0.62)) $false $false
        }
        2 { # Tux with a Windows windowpane belly, dark tile
            Draw-Tile $g $S 'dark' | Out-Null
            Draw-Penguin $g $S ([float]($S*0.5)) ([float]($S*0.52)) ([float]($S*0.62)) $true $true
        }
        3 { # Diagonal split tile (dark + blue), Tux centered
            Draw-Tile $g $S 'split' | Out-Null
            Draw-Penguin $g $S ([float]($S*0.5)) ([float]($S*0.52)) ([float]($S*0.62)) $false $true
        }
        4 { # Tux on light tile with Microsoft 4-square mark in the corner
            Draw-Tile $g $S 'white' | Out-Null
            Draw-Penguin $g $S ([float]($S*0.44)) ([float]($S*0.54)) ([float]($S*0.60)) $false $false
            $q = [float]($S*0.085); $gap = [float]($S*0.018)
            Draw-MSsquares $g ([float]($S*0.66)) ([float]($S*0.16)) $q $gap
        }
        5 { # Terminal tile: ">" prompt + small Tux as the cursor
            Draw-Tile $g $S 'dark' | Out-Null
            Draw-Prompt $g $S 0
            Draw-Penguin $g $S ([float]($S*0.64)) ([float]($S*0.56)) ([float]($S*0.42)) $false $true
        }
    }
    $g.Dispose()
    $path = Join-Path $outDir ("winux-opt{0}.png" -f $n)
    $c.bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $c.bmp.Dispose()
    Write-Host "wrote $path"
}

1..5 | ForEach-Object { Render-Option $_ 256 }
