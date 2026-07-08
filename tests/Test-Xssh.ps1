# xssh behavior tests. ssh is stubbed with a function, so no network is used:
# these verify what xssh SENDS (bootstrap variants, keepalives, passthrough
# args) and how it reacts to exits (drop vs auth error vs offline blip).
$ErrorActionPreference = 'Stop'

$module = Join-Path (Split-Path $PSScriptRoot -Parent) 'shell\Limpet.psd1'
Import-Module $module -Force

$pass = 0; $fail = 0
function Check($name, $cond) {
    if ($cond) { Write-Host "PASS  $name" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "FAIL  $name" -ForegroundColor Red;   $script:fail++ }
}

# Preserve the user's real "last ssh host" state file; xssh writes it.
$stateFile = Join-Path $env:TEMP 'limpet-last-ssh.txt'
$stateBackup = if (Test-Path $stateFile) { Get-Content $stateFile -Raw } else { $null }

try {
    # ---- what xssh sends, per flag combo (ssh captures its args) ----
    function global:ssh { $script:captured = $args -join ' '; cmd /c exit 0 }

    function Invoke-Combo($flags) {
        $script:captured = $null
        if ($flags) { xssh @flags user@localhost *>$null } else { xssh user@localhost *>$null }
        $script:captured
    }

    $c = Invoke-Combo @()
    Check 'default: injects the integration'    ($c -like '*base64 -d*')
    Check 'default: resumes via tmux "limpet"'  ($c -like '*tmux new -A -D -s limpet*')
    Check 'default: adds keepalive options'     ($c -like '*ServerAliveInterval=15*')
    Check 'default: forces a tty (-t)'          ($c -like '*-t *')

    $c = Invoke-Combo @('-NoResume')
    Check '-NoResume: still injects'            ($c -like '*base64 -d*')
    Check '-NoResume: no tmux wrap'             ($c -notlike '*tmux*')

    $c = Invoke-Combo @('-Raw')
    Check '-Raw: plain ssh, nothing added'      ($c -notlike '*base64 -d*' -and $c -notlike '*tmux*')

    $c = Invoke-Combo @('-Raw', '-Resume')
    Check '-Raw -Resume: bare tmux, no inject'  ($c -like '*tmux new -A -D -s limpet*' -and $c -notlike '*base64 -d*')

    $script:captured = $null
    xssh -Raw -o ServerAliveInterval=5 user@localhost *>$null
    Check 'keepalives not duplicated when user sets them' ($script:captured -notlike '*ServerAliveInterval=15*')

    $script:captured = $null
    xssh -Raw -i C:\keys\k -J jump@host user@localhost *>$null
    Check 'passthrough args survive in order' ($script:captured -like '*-i C:\keys\k -J jump@host user@localhost*')

    Check 'remembers the host for wput' ((Get-Content $stateFile -Raw).Trim() -eq 'user@localhost')

    # ---- reconnect policy ----
    # a live session that drops, then an instant failure (offline after resume),
    # then success: xssh must wait for the network, not stop.
    $script:calls = 0
    function global:ssh {
        $script:calls++
        switch ($script:calls) {
            1 { Start-Sleep -Seconds 6; cmd /c exit 255 }
            2 { cmd /c exit 255 }
            default { cmd /c exit 0 }
        }
    }
    xssh -Raw user@localhost *>$null
    Check 'offline blip after a session: waits and reconnects' ($script:calls -eq 3)

    # an instant failure on the FIRST attempt is a host/auth error: stop.
    $script:calls = 0
    function global:ssh { $script:calls++; cmd /c exit 255 }
    xssh -Raw user@localhost *>$null
    Check 'instant first failure: stops (no retry loop)' ($script:calls -eq 1)

    # a clean exit (logout / tmux detach) ends the loop quietly.
    $script:calls = 0
    function global:ssh { $script:calls++; cmd /c exit 0 }
    xssh -Raw user@localhost *>$null
    Check 'clean exit: no reconnect' ($script:calls -eq 1)
}
finally {
    Remove-Item Function:\ssh -Force -ErrorAction SilentlyContinue
    if ($null -ne $stateBackup) { Set-Content -Path $stateFile -Value $stateBackup -NoNewline }
    else { Remove-Item $stateFile -Force -ErrorAction SilentlyContinue }
}

$color = if ($fail) { 'Red' } else { 'Green' }
Write-Host "`n$pass passed, $fail failed" -ForegroundColor $color
if ($fail) { exit 1 }
