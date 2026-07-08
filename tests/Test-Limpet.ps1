# Smoke test for limpet. Exercises every command in a throwaway temp dir and
# reports PASS/FAIL. Run: .\tests\Test-Limpet.ps1
$ErrorActionPreference = 'Stop'

$module = Join-Path (Split-Path $PSScriptRoot -Parent) 'shell\Limpet.psd1'
Import-Module $module -Force

$pass = 0; $fail = 0
function Check($name, $cond) {
    if ($cond) { Write-Host "PASS  $name" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "FAIL  $name" -ForegroundColor Red;   $script:fail++ }
}

# The Linux-flag commands only work if the module actually took over the
# built-in aliases; check that first so a takeover failure reads as itself
# instead of as a parameter error deep in some later check.
foreach ($a in @{ ls = 'NixLs'; rm = 'NixRm'; cp = 'NixCp'; mv = 'NixMv'; cat = 'NixCat' }.GetEnumerator()) {
    $cur = Get-Alias -Name $a.Key -ErrorAction SilentlyContinue
    Check "alias $($a.Key) -> $($a.Value)" ($cur -and $cur.Definition -eq $a.Value)
}
if ($fail) {
    Get-Alias ls, rm, cp, mv, cat -ErrorAction SilentlyContinue | Format-Table Name, Definition, Options | Out-String | Write-Host
    Write-Host "$pass passed, $fail failed (alias takeover failed; skipping command checks)" -ForegroundColor Red
    exit 1
}

$d = Join-Path $env:TEMP ("limpet_test_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
try {
    mkdir -p "$d/sub" | Out-Null
    Check 'mkdir -p creates nested dir' (Test-Path "$d/sub")

    "line1`nline2`nline3`nFOO bar`nfoo baz" | Out-File "$d/a.txt" -Encoding utf8
    touch "$d/empty.txt"
    Check 'touch creates file' (Test-Path "$d/empty.txt")

    cp "$d/a.txt" "$d/b.txt"
    Check 'cp copies file' (Test-Path "$d/b.txt")

    cp -r "$d/sub" "$d/sub2"
    Check 'cp -r copies dir' (Test-Path "$d/sub2")

    $listed = ls "$d" | Select-Object -ExpandProperty Name
    Check 'ls lists entries' (($listed -contains 'a.txt') -and ($listed -contains 'b.txt'))

    $numbered = cat -n "$d/a.txt"
    Check 'cat -n numbers lines' (($numbered | Measure-Object).Count -eq 5 -and $numbered[0] -match '1\s+line1')

    $h = head -n 2 "$d/a.txt"
    Check 'head -n 2 returns 2 lines' (($h | Measure-Object).Count -eq 2 -and $h[0] -eq 'line1')

    $t = tail -2 "$d/a.txt"
    Check 'tail -2 returns last 2 lines' (($t | Measure-Object).Count -eq 2 -and $t[-1] -eq 'foo baz')

    $cs = @(grep foo "$d/a.txt")
    Check 'grep is case-sensitive by default' ($cs.Count -eq 1)

    $ci = @(grep -i foo "$d/a.txt")
    Check 'grep -i is case-insensitive' ($ci.Count -eq 2)

    $piped = @('apple.txt', 'banana.log', 'cherry.txt' | grep txt)
    Check 'grep reads from pipeline' ($piped.Count -eq 2)

    $found = @(find "$d" -name '*.txt' -type f)
    Check 'find -name -type f' ($found.Count -eq 3)

    $git = which git
    Check 'which resolves a command' ($null -ne $git)

    mv "$d/b.txt" "$d/renamed.txt"
    Check 'mv renames' ((Test-Path "$d/renamed.txt") -and -not (Test-Path "$d/b.txt"))

    rm -rf "$d/sub2"
    Check 'rm -rf removes dir tree' (-not (Test-Path "$d/sub2"))
}
finally {
    # native cleanup: must not depend on the module under test
    Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Extended coverage: remaining flags, du/df/chmod/which, the peek/reels
# protocol output, wput/xssh argument errors, Hello helpers, the banner.
# ---------------------------------------------------------------------------

# Run a block, return $true if it threw a message matching $like.
function Check-Throws($name, [scriptblock]$block, $like) {
    $threw = $false
    try { & $block *>$null } catch { $threw = "$_" -like $like }
    Check $name $threw
}
# Join every Write-Host record into one string (peek/reels write to the host).
function Get-HostOut([scriptblock]$block) { -join (& $block 6>&1 | ForEach-Object { "$_" }) }

$d = Join-Path $env:TEMP ("limpet_test_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
try {
    New-Item -ItemType Directory -Path "$d\sub" -Force | Out-Null
    "line1`nline2`nline3`nFOO bar`nfoo baz" | Out-File "$d\a.txt" -Encoding utf8
    "more lines here" | Out-File "$d\sub\b.txt" -Encoding utf8

    $two = cat "$d\a.txt" "$d\sub\b.txt"
    Check 'cat concatenates multiple files' (($two | Measure-Object).Count -eq 6)

    Check 'head -n3 (attached count)' ((head -n3 "$d\a.txt" | Measure-Object).Count -eq 3)
    $t10 = 1..20 | tail
    Check 'tail defaults to 10 from the pipeline' ($t10.Count -eq 10 -and $t10[-1] -eq 20)

    Check 'grep -v inverts the match' ((@(grep -v foo "$d\a.txt")).Count -eq 4)
    Check 'grep -r searches directories' ((@(grep -r line "$d")).Count -eq 4)
    Check-Throws 'grep with no pattern errors' { grep } '*missing pattern*'

    $dirs = @(find "$d" -type d)
    Check 'find -type d finds directories' ($dirs -contains (Join-Path $d 'sub'))

    mkdir "$d\m1" "$d\m2"
    Check 'mkdir accepts multiple dirs' ((Test-Path "$d\m1") -and (Test-Path "$d\m2"))

    (Get-Item "$d\a.txt").LastWriteTime = (Get-Date).AddDays(-1)
    touch "$d\a.txt"
    Check 'touch updates an existing file mtime' ((Get-Item "$d\a.txt").LastWriteTime -gt (Get-Date).AddMinutes(-5))

    $hidden = New-Item -ItemType File -Path "$d\.secret" -Force
    $hidden.Attributes = $hidden.Attributes -bor [IO.FileAttributes]::Hidden
    Check 'ls hides hidden files'    ((ls "$d" | Select-Object -ExpandProperty Name) -notcontains '.secret')
    Check 'ls -a shows hidden files' ((ls -a "$d" | Select-Object -ExpandProperty Name) -contains '.secret')
    Check 'ls -l renders the long format' ($null -ne (ls -l "$d"))

    rm -f "$d\ghost.txt"   # missing + -f: must be silent, like the real rm
    Check 'rm -f on a missing file stays quiet' $true

    $duo = du "$d"
    Check 'du reports a size for a path' ($duo.Path -eq "$d" -and $duo.Size -match '\d')
    Check 'df lists the system drive' ($null -ne (df | Where-Object Root -like 'C:*'))
    Check 'chmod warns it is a no-op' ((chmod +x "$d\a.txt" 3>&1 | Out-String) -match 'no-op')

    Check 'which explains aliases' ((which rm) -eq 'rm -> NixRm')
    Check 'which warns on misses' ((which no-such-cmd-xyz 3>&1 | Out-String) -match 'not found')

    # ---- peek protocol ----
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap 30, 200   # 200px tall -> ceil(200/18) = 12 rows
    $bmp.Save("$d\tall.png", [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()

    $pk = Get-HostOut { peek "$d\tall.png" }
    Check 'peek emits an OSC 1337 File sequence' ($pk -match '\]1337;File=name=')
    Check 'peek tags the row count from pixel height' ($pk -match ';rows=12:')
    $reserved = ($pk -split [char]7)[1]
    Check 'peek reserves exactly rows newlines' (([regex]::Matches($reserved, "`n")).Count -eq 12)

    Copy-Item "$d\tall.png" "$d\tall2.png"
    $pk2 = Get-HostOut { peek "$d\tall.png" "$d\tall2.png" }
    Check 'peek takes multiple files' (([regex]::Matches($pk2, '1337')).Count -eq 2)
    $pkw = Get-HostOut { peek "$d\tall*.png" }
    Check 'peek expands wildcards' (([regex]::Matches($pkw, '1337')).Count -eq 2)
    Check-Throws 'peek on a missing file errors' { peek "$d\nope.png" } '*not found*'
    Check-Throws 'peek with no args shows usage' { peek } '*usage*'
    Check 'peak is peek' ((Get-HostOut { peak "$d\tall.png" }) -match '\]1337;')

    # ---- reels protocol ----
    $rl = Get-HostOut { reels 'https://x' }
    Check 'reels emits the OSC 5379 verb' ($rl -match '\]5379;reels;aHR0cHM6Ly94')

    # ---- wput / xssh argument handling ----
    Check-Throws 'wput with no files errors' { wput } '*no files*'
    Check-Throws 'wput rejects a missing local path' { wput "$d\nope.bin" -To u@h } '*not found*'
    Check-Throws 'xssh with no args shows usage' { xssh } '*usage*'

    # ---- Windows Hello helpers (the non-interactive surface) ----
    Check 'Get-LimpetKeyPath returns the limpet key path' ((Get-LimpetKeyPath) -like '*limpet_ed25519')
    Check 'Test-LimpetHelloEnrolled is false for unknown hosts' (-not (Test-LimpetHelloEnrolled 'ci-test@nohost.invalid'))
    $askpass = Get-LimpetAskpass
    Check 'Get-LimpetAskpass materializes the helper' (Test-Path $askpass)

    # ---- banner ----
    Check 'limpet banner prints' ((Get-HostOut { limpet }).Length -gt 100)
}
finally {
    Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
}

$color = if ($fail) { 'Red' } else { 'Green' }
Write-Host "`n$pass passed, $fail failed" -ForegroundColor $color
if ($fail) { exit 1 }
