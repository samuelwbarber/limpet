# Smoke test for winux. Exercises every command in a throwaway temp dir and
# reports PASS/FAIL. Run: .\tests\Test-Winux.ps1
$ErrorActionPreference = 'Stop'

$module = Join-Path (Split-Path $PSScriptRoot -Parent) 'shell\Winux.psd1'
Import-Module $module -Force

$pass = 0; $fail = 0
function Check($name, $cond) {
    if ($cond) { Write-Host "PASS  $name" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "FAIL  $name" -ForegroundColor Red;   $script:fail++ }
}

$d = Join-Path $env:TEMP ("winux_test_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
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
    rm -rf "$d" 2>$null
}

$color = if ($fail) { 'Red' } else { 'Green' }
Write-Host "`n$pass passed, $fail failed" -ForegroundColor $color
if ($fail) { exit 1 }
