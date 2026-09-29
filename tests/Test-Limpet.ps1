# Smoke test for limpet. Exercises every command in a throwaway temp dir and
# reports PASS/FAIL. Run: .\tests\Test-Limpet.ps1
$ErrorActionPreference = 'Stop'
# The module's functions resolve $ErrorActionPreference through THEIR scope
# chain, which roots at global — a script-scoped Stop doesn't reach them when
# this file runs as a child scope, and the Check-Throws tests then miss the
# Write-Error-based failures. Mirror it globally; restored before exit.
$script:savedGlobalEAP = $global:ErrorActionPreference
$global:ErrorActionPreference = 'Stop'

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
    $global:ErrorActionPreference = $script:savedGlobalEAP
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

    # Compare by leaf: Get-ChildItem expands 8.3 short prefixes (GHA's TEMP
    # is C:\Users\RUNNER~1\...) while Join-Path keeps them, so full-path
    # equality is false on such runners.
    $dirs = @(find "$d" -type d)
    Check 'find -type d finds directories' (($dirs | Split-Path -Leaf) -contains 'sub')

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
    $savedTok = $env:LIMPET_TOKEN; $env:LIMPET_TOKEN = '0123456789abcdef0123456789abcdef'
    $rl = Get-HostOut { reels 'https://x' }
    $env:LIMPET_TOKEN = $savedTok
    Check 'reels emits the OSC 5379 verb' ($rl -match '\]5379;reels;aHR0cHM6Ly94')
    Check 'reels carries the app token' ($rl -match ';0123456789abcdef0123456789abcdef')

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

# ---------------------------------------------------------------------------
# claude / claude1 / claude2: one shared /resume history. Everything runs
# against temp dirs; the real ~/.claude* folders are never touched.
# ---------------------------------------------------------------------------
$h = Join-Path $env:TEMP ("limpet_claude_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
try {
    $shared = "$h\shared\projects"
    $c0 = "$h\.claude"; $c1 = "$h\.claude-1"; $c2 = "$h\.claude-2"
    # Solo history in plain claude and in claude-2, with an overlapping
    # project folder, an identical file, and a same-name file that differs.
    New-Item -ItemType Directory -Force -Path "$c0\projects\C--proj\memory", "$c0\projects\C--only0" | Out-Null
    Set-Content "$c0\projects\C--proj\aaa.jsonl" 'a'
    Set-Content "$c0\projects\C--proj\dup.jsonl" 'same'
    Set-Content "$c0\projects\C--proj\clash.jsonl" 'short'
    Set-Content "$c0\projects\C--proj\memory\MEMORY.md" 'mem'
    Set-Content "$c0\projects\C--only0\o.jsonl" 'o'
    New-Item -ItemType Directory -Force -Path "$c2\projects\C--proj" | Out-Null
    Set-Content "$c2\projects\C--proj\bbb.jsonl" 'b'
    Set-Content "$c2\projects\C--proj\dup.jsonl" 'same'
    Set-Content "$c2\projects\C--proj\clash.jsonl" 'longer content here'
    Set-Content "$c0\projects\C--proj\cont.jsonl" 'turn 1'
    Set-Content "$c2\projects\C--proj\cont.jsonl" 'turn 1', 'turn 2'   # the same chat, continued

    $ok = Sync-LimpetClaudeHistory -ConfigDir $c0, $c1, $c2 -Shared $shared
    Check 'sync reports every account synced' ($ok -eq $true)
    foreach ($c in $c0, $c1, $c2) {
        $it = Get-Item -LiteralPath "$c\projects" -Force
        Check "sync junctions $(Split-Path -Leaf $c)\projects to the shared store" (
            ($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -and (Test-Path "$c\projects\C--proj\aaa.jsonl"))
    }
    Check 'sync merges overlapping project folders' ((Test-Path "$shared\C--proj\aaa.jsonl") -and (Test-Path "$shared\C--proj\bbb.jsonl") -and
        (Test-Path "$shared\C--proj\memory\MEMORY.md") -and (Test-Path "$shared\C--only0\o.jsonl"))
    Check 'sync drops an identical duplicate' ((Get-Content "$shared\C--proj\dup.jsonl") -eq 'same' -and
        @(Get-ChildItem "$shared\C--proj" -Filter 'dup.jsonl*').Count -eq 1)
    Check 'sync keeps the fuller transcript and preserves the other' ((Get-Content "$shared\C--proj\clash.jsonl") -eq 'longer content here' -and
        @(Get-ChildItem "$shared\C--proj" -Filter 'clash.jsonl.conflict-*').Count -eq 1)
    Check 'sync keeps a continued transcript without a conflict copy' ((Get-Content "$shared\C--proj\cont.jsonl") -join ',' -eq 'turn 1,turn 2' -and
        @(Get-ChildItem "$shared\C--proj" -Filter 'cont.jsonl*').Count -eq 1)
    Check 'sync leaves no staging folder behind' (@(Get-ChildItem $c0, $c2 -Filter 'projects.migrating-*' -Directory -Force).Count -eq 0)
    Check 'sync is idempotent' ((Sync-LimpetClaudeHistory -ConfigDir $c0, $c1, $c2 -Shared $shared) -eq $true)

    # A projects folder with a file held open by another process: nothing is
    # lost, the account is reported unsynced, and it completes once released.
    $c3 = "$h\.claude-3"
    New-Item -ItemType Directory -Force -Path "$c3\projects\C--proj" | Out-Null
    Set-Content "$c3\projects\C--proj\live.jsonl" 'live'
    $fs = [IO.File]::Open("$c3\projects\C--proj\live.jsonl", 'Open', 'ReadWrite', 'None')
    try {
        $busy = Sync-LimpetClaudeHistory -ConfigDir $c3 -Shared $shared 3>$null
        $kept = @(Get-ChildItem -LiteralPath $c3 -Recurse -Filter 'live.jsonl' -Force)
        Check 'sync backs off when the folder is in use' ($busy -eq $false -and $kept.Count -eq 1)
    }
    finally { $fs.Dispose() }
    Check 'sync completes once the folder is free' ((Sync-LimpetClaudeHistory -ConfigDir $c3 -Shared $shared) -eq $true -and
        (Get-Content "$shared\C--proj\live.jsonl") -eq 'live' -and @(Get-ChildItem $c3 -Filter 'projects.migrating-*' -Directory -Force).Count -eq 0)

    # A junction that already points somewhere else is respected.
    $c4 = "$h\.claude-4"; $elsewhere = "$h\elsewhere"
    New-Item -ItemType Directory -Force -Path $c4, $elsewhere | Out-Null
    New-Item -ItemType Junction -Path "$c4\projects" -Target $elsewhere | Out-Null
    $foreign = Sync-LimpetClaudeHistory -ConfigDir $c4 -Shared $shared 3>$null
    Check 'sync leaves a foreign junction alone' ($foreign -eq $false -and (@((Get-Item "$c4\projects" -Force).Target)[0] -like '*elsewhere'))
}
finally {
    # Drop the junctions first: a recursive delete must not walk through them.
    Get-ChildItem -LiteralPath $h -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
        ForEach-Object { [IO.Directory]::Delete($_.FullName) }
    Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# codex / codex1 / codex2: numbered homes share plain codex's history. Temp
# dirs only; the real ~/.codex* are never touched.
# ---------------------------------------------------------------------------
$x = Join-Path $env:TEMP ("limpet_codex_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
try {
    $hub = "$x\.codex"; $k1 = "$x\.codex-1"; $k2 = "$x\.codex-2"
    $day = 'sessions\2026\09\27'
    $utf8 = New-Object Text.UTF8Encoding($false)
    New-Item -ItemType Directory -Force -Path "$hub\$day", "$k1\$day", "$k1\sessions\2026\09\28", "$k1\archived_sessions", "$k1\thread-writer-locks", $k2 | Out-Null
    [IO.File]::WriteAllText("$hub\$day\rollout-a.jsonl", "a`n", $utf8)
    [IO.File]::WriteAllText("$hub\$day\rollout-moved.jsonl", "one`n", $utf8)
    [IO.File]::WriteAllText("$k1\$day\rollout-moved.jsonl", "one`ntwo`n", $utf8)   # copied to codex1, then continued
    [IO.File]::WriteAllText("$k1\$day\rollout-b.jsonl", "b`n", $utf8)
    [IO.File]::WriteAllText("$k1\sessions\2026\09\28\rollout-c.jsonl", "c`n", $utf8)
    [IO.File]::WriteAllText("$k1\archived_sessions\rollout-old.jsonl", "old`n", $utf8)
    [IO.File]::WriteAllText("$k1\thread-writer-locks\.coordination.lock", '', $utf8)
    [IO.File]::WriteAllText("$k1\thread-writer-locks\01a0dead-0000-7000-8000-000000000000.lock", '', $utf8)   # left by a crash
    [IO.File]::WriteAllText("$hub\session_index.jsonl", (@(
        '{"id":"t1","thread_name":"hub one","updated_at":"2026-09-10T10:00:00Z"}'
        '{"id":"t2","thread_name":"hub two","updated_at":"2026-09-20T10:00:00Z"}') -join "`n") + "`n", $utf8)
    [IO.File]::WriteAllText("$k1\config.toml", "model = `"gpt-x`"`n[projects.'c:\p']`ntrust_level = `"trusted`"`n", $utf8)
    [IO.File]::WriteAllText("$k1\session_index.jsonl", (@(
        '{"id":"t1","thread_name":"renamed in codex1","updated_at":"2026-09-15T10:00:00.5Z"}'
        '{"id":"t2","thread_name":"stale in codex1","updated_at":"2026-09-01T10:00:00Z"}'
        '{"id":"t3","thread_name":"only in codex1","updated_at":"2026-09-05T10:00:00Z"}') -join "`n") + "`n", $utf8)

    $ok = Sync-LimpetCodexHistory -CodexHome $k1, $k2 -Hub $hub
    Check 'codex sync reports every account shared' ($ok -eq $true)
    foreach ($k in $k1, $k2) {
        foreach ($name in 'sessions', 'archived_sessions', 'thread-writer-locks') {
            $it = Get-Item -LiteralPath "$k\$name" -Force
            Check "codex sync junctions $(Split-Path -Leaf $k)\$name to plain codex's" (
                ($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -and (@($it.Target)[0] -like "*\.codex\$name"))
        }
        Check "codex sync hard-links $(Split-Path -Leaf $k)\session_index.jsonl to plain codex's" ((Get-Item -LiteralPath "$k\session_index.jsonl" -Force).LinkType -eq 'HardLink')
    }
    Check "codex sync folds codex1's chats into plain codex's" ((Test-Path "$hub\$day\rollout-a.jsonl") -and (Test-Path "$hub\$day\rollout-b.jsonl") -and
        (Test-Path "$hub\sessions\2026\09\28\rollout-c.jsonl") -and (Test-Path "$hub\archived_sessions\rollout-old.jsonl") -and (Test-Path "$k1\$day\rollout-b.jsonl"))
    Check 'codex sync keeps the continued copy of a moved thread and drops the stale one' (
        [IO.File]::ReadAllText("$hub\$day\rollout-moved.jsonl") -eq "one`ntwo`n" -and @(Get-ChildItem "$hub\$day" -Filter 'rollout-moved.jsonl*').Count -eq 1)
    Check "codex sync doesn't carry old lock files over" (@(Get-ChildItem "$hub\thread-writer-locks" -Force).Count -eq 0 -and
        @(Get-ChildItem $k1 -Filter '*.migrating-*' -Force).Count -eq 0)
    $names = @(Get-Content "$hub\session_index.jsonl" | Where-Object { $_ })
    Check "codex sync adds codex1's newer thread names, oldest first, and skips stale ones" ($names.Count -eq 4 -and
        $names[2] -like '*only in codex1*' -and $names[3] -like '*renamed in codex1*' -and -not ($names -like '*stale in codex1*'))
    $sqliteLine = 'sqlite_home = "' + ($hub -replace '\\', '\\') + '"'
    $k1Config = @(Get-Content "$k1\config.toml")
    Check "codex sync points codex1's sqlite_home (the /resume index) at plain codex's, above its tables" (
        ($k1Config | Where-Object { $_ -notmatch '^\s*(#|$)' } | Select-Object -First 1) -eq $sqliteLine -and
        ($k1Config -contains 'model = "gpt-x"') -and ($k1Config -contains "[projects.'c:\p']") -and ($k1Config -contains 'trust_level = "trusted"'))
    Check 'codex sync gives a home without a config one that holds just sqlite_home' (@(Get-Content "$k2\config.toml") -contains $sqliteLine)
    Check 'codex sync is idempotent' ((Sync-LimpetCodexHistory -CodexHome $k1, $k2 -Hub $hub) -eq $true -and
        @(Get-Content "$hub\session_index.jsonl" | Where-Object { $_ }).Count -eq 4 -and
        @(Get-Content "$k1\config.toml" | Where-Object { $_ -match '^\s*sqlite_home' }).Count -eq 1)
    Add-Content -LiteralPath "$k1\session_index.jsonl" -Value '{"id":"t4","thread_name":"named later in codex1","updated_at":"2026-09-28T10:00:00Z"}'
    Check 'a name given in codex1 afterwards shows up in plain codex too' ((Get-Content "$hub\session_index.jsonl" -Tail 1) -like '*named later in codex1*')

    # A chat open in the home (its thread lock held): nothing is moved until it closes.
    $k3 = "$x\.codex-3"
    New-Item -ItemType Directory -Force -Path "$k3\$day", "$k3\thread-writer-locks" | Out-Null
    [IO.File]::WriteAllText("$k3\$day\rollout-live.jsonl", "live`n", $utf8)
    $lock = [IO.File]::Open("$k3\thread-writer-locks\01a0beef-0000-7000-8000-000000000000.lock", 'Create', 'ReadWrite', 'None')
    try {
        $busy = Sync-LimpetCodexHistory -CodexHome $k3 -Hub $hub 3>$null
        Check 'codex sync leaves a home with a chat open alone' ($busy -eq $false -and -not ((Get-Item "$k3\sessions" -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            (Test-Path "$k3\$day\rollout-live.jsonl") -and -not (Test-Path "$hub\$day\rollout-live.jsonl"))
    }
    finally { $lock.Dispose() }
    Check 'codex sync completes once the chat is closed' ((Sync-LimpetCodexHistory -CodexHome $k3 -Hub $hub) -eq $true -and
        (Test-Path "$hub\$day\rollout-live.jsonl") -and ((Get-Item "$k3\sessions" -Force).Attributes -band [IO.FileAttributes]::ReparsePoint))

    # A sessions junction that already points somewhere else is respected.
    $k4 = "$x\.codex-4"; $elsewhere = "$x\elsewhere"
    New-Item -ItemType Directory -Force -Path $k4, $elsewhere | Out-Null
    New-Item -ItemType Junction -Path "$k4\sessions" -Target $elsewhere | Out-Null
    $foreign = Sync-LimpetCodexHistory -CodexHome $k4 -Hub $hub 3>$null
    Check 'codex sync leaves a foreign junction alone' ($foreign -eq $false -and (@((Get-Item "$k4\sessions" -Force).Target)[0] -like '*elsewhere'))

    # A sqlite_home already set to somewhere else is respected too.
    $k5 = "$x\.codex-5"
    New-Item -ItemType Directory -Force -Path $k5 | Out-Null
    [IO.File]::WriteAllText("$k5\config.toml", "sqlite_home = 'D:\\own'`n", $utf8)
    $ownIndex = Sync-LimpetCodexHistory -CodexHome $k5 -Hub $hub 3>$null
    Check "codex sync leaves a home's own sqlite_home alone" ($ownIndex -eq $false -and [IO.File]::ReadAllText("$k5\config.toml") -eq "sqlite_home = 'D:\\own'`n")
}
finally {
    Get-ChildItem -LiteralPath $x -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
        ForEach-Object { [IO.Directory]::Delete($_.FullName) }
    Remove-Item -Recurse -Force $x -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# copilot / copilot1 / ...: numbered homes share plain copilot's session-state.
# ---------------------------------------------------------------------------
$y = Join-Path $env:TEMP ("limpet_copilot_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
try {
    $hub = "$y\.copilot"; $p1 = "$y\.copilot-1"; $p2 = "$y\.copilot-2"
    $chatA = 'aaaaaaaa-0000-4000-8000-000000000001'; $chatB = 'bbbbbbbb-0000-4000-8000-000000000002'
    New-Item -ItemType Directory -Force -Path "$hub\session-state\$chatA", "$p1\session-state\$chatB", "$p1\session-state\$chatA", "$p1\session-state\.session-operation-locks" | Out-Null
    Set-Content "$hub\session-state\$chatA\events.jsonl" 'e1'
    Set-Content "$p1\session-state\$chatA\events.jsonl" 'e1', 'e2'   # the same chat, continued in copilot1
    Set-Content "$p1\session-state\$chatB\events.jsonl" 'b1'
    Set-Content "$p1\session-state\.session-operation-locks\$chatB.lock" ''
    $ok = Sync-LimpetCopilotHistory -CopilotHome $p1, $p2 -Hub $hub
    Check 'copilot sync reports every account shared' ($ok -eq $true)
    foreach ($p in $p1, $p2) {
        $it = Get-Item -LiteralPath "$p\session-state" -Force
        Check "copilot sync junctions $(Split-Path -Leaf $p)\session-state to plain copilot's" (
            ($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -and (@($it.Target)[0] -like '*\.copilot\session-state'))
    }
    Check "copilot sync folds copilot1's chats in, keeping the continued one" ((Test-Path "$hub\session-state\$chatB\events.jsonl") -and
        ((Get-Content "$hub\session-state\$chatA\events.jsonl") -join ',' -eq 'e1,e2') -and (Test-Path "$p1\session-state\$chatB\events.jsonl"))
    Check 'copilot sync is idempotent' ((Sync-LimpetCopilotHistory -CopilotHome $p1, $p2 -Hub $hub) -eq $true)

    # A chat open in the home (Copilot's in-use mark with a live pid): left alone until it closes.
    $p3 = "$y\.copilot-3"
    New-Item -ItemType Directory -Force -Path "$p3\session-state\$chatB" | Out-Null
    Set-Content "$p3\session-state\$chatB\inuse.$PID.lock" "$PID"
    $busy = Sync-LimpetCopilotHistory -CopilotHome $p3 -Hub $hub 3>$null
    Check 'copilot sync leaves a home with a chat open alone' ($busy -eq $false -and -not ((Get-Item "$p3\session-state" -Force).Attributes -band [IO.FileAttributes]::ReparsePoint))
    Remove-Item "$p3\session-state\$chatB\inuse.$PID.lock"
    Check 'copilot sync completes once the chat is closed' ((Sync-LimpetCopilotHistory -CopilotHome $p3 -Hub $hub) -eq $true)
}
finally {
    Get-ChildItem -LiteralPath $y -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
        ForEach-Object { [IO.Directory]::Delete($_.FullName) }
    Remove-Item -Recurse -Force $y -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# agy / agy1 / ...: one Credential Manager login, swapped per launch. Runs
# against a throwaway credential name and home; agy's real login is untouched.
# ---------------------------------------------------------------------------
$g = Join-Path $env:TEMP ("limpet_agy_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$saved = @{ home = $env:LIMPET_AGENT_HOME; target = $env:LIMPET_AGY_CRED_TARGET; proc = $env:LIMPET_AGY_PROCESS; run = $env:LIMPET_AGENT_RUN; path = $env:PATH }
$m = Get-Module Limpet
try {
    $env:LIMPET_AGENT_HOME = $g
    $env:LIMPET_AGY_CRED_TARGET = 'limpet-test:agy-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $env:LIMPET_AGY_PROCESS = 'limpet-no-such-agy'
    New-Item -ItemType Directory -Force -Path $g | Out-Null
    $jwt = { param($email) 'x.' + ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{ email = $email } | ConvertTo-Json -Compress))).TrimEnd('=').Replace('+', '-').Replace('/', '_')) + '.y' }
    $login = { param($email) [Text.Encoding]::UTF8.GetBytes((@{ token = @{ access_token = "at-$email" }; auth_method = 'oauth'; id_token = (& $jwt $email) } | ConvertTo-Json -Compress)) }
    $inCM = { $c = & $m { [LimpetCredentials]::Read((Get-LimpetAgyTarget)) }; if ($c) { [Text.Encoding]::UTF8.GetString([byte[]]$c[2]) } else { $null } }
    & $m { Initialize-LimpetCredentials }
    $plainLogin = & $login 'plain@example.com'
    & $m { param($b) [LimpetCredentials]::Write((Get-LimpetAgyTarget), 'antigravity', 2, $b) } $plainLogin
    $plainText = [Text.Encoding]::UTF8.GetString($plainLogin)

    Check 'agy1 (never signed in) starts with the login cleared, so agy asks to sign in' ((& $m { Enter-LimpetAgyAccount 'agy1' }) -eq $true -and $null -eq (& $inCM))
    Check "plain agy's login is set aside first, email noted for the menu" ((Test-Path "$g\.agy\login.dat") -and
        ((Get-Content "$g\.agy\account.json" -Raw | ConvertFrom-Json).email -eq 'plain@example.com') -and (Get-Content "$g\.agy\active") -eq 'agy1')
    & $m { param($b) [LimpetCredentials]::Write((Get-LimpetAgyTarget), 'antigravity', 2, $b) } (& $login 'one@example.com')   # signs in as another account
    & $m { Exit-LimpetAgyAccount 'agy1' }
    Check "on exit agy1's login is kept and plain agy's is back" ((& $inCM) -eq $plainText -and (Test-Path "$g\.agy-1\login.dat") -and
        ((Get-Content "$g\.agy-1\account.json" -Raw | ConvertFrom-Json).email -eq 'one@example.com') -and -not (Test-Path "$g\.agy\active"))
    Check 'agy1 comes back signed in next time' ((& $m { Enter-LimpetAgyAccount 'agy1' }) -eq $true -and (& $inCM) -like '*at-one@example.com*')
    $env:LIMPET_AGY_PROCESS = [IO.Path]::GetFileNameWithoutExtension((Get-Process -Id $PID).Path)   # "agy is running"
    Check 'another agy account is refused while one runs' ((& $m { Enter-LimpetAgyAccount 'agy2' } 3>$null) -eq $false -and (& $inCM) -like '*at-one@example.com*')
    $env:LIMPET_AGY_PROCESS = 'limpet-no-such-agy'
    & $m { Exit-LimpetAgyAccount 'agy1' }
    Check 'plain agy is back after the second run too' ((& $inCM) -eq $plainText)

    # A tab closed while agy1 ran: its shell never got to put plain agy back.
    $null = & $m { Enter-LimpetAgyAccount 'agy1' }
    & $m { param($b) [LimpetCredentials]::Write((Get-LimpetAgyTarget), 'antigravity', 2, $b) } (& $login 'one-refreshed@example.com')
    & $m { Repair-LimpetAgyLogin }
    Check "an interrupted agy1 is finished off later: its refreshed login kept, plain agy's back" ((& $inCM) -eq $plainText -and
        -not (Test-Path "$g\.agy\active") -and ((Get-Content "$g\.agy-1\account.json" -Raw | ConvertFrom-Json).email -eq 'one-refreshed@example.com'))

    # The whole launch, against a stand-in agy that reports which login it found.
    $fakeBin = "$g\bin"; $env:LIMPET_AGENT_RUN = "$g\run"
    New-Item -ItemType Directory -Force -Path $fakeBin | Out-Null
    Set-Content -LiteralPath "$fakeBin\agy.cmd" -Encoding Ascii -Value '@echo off', 'echo AGY_RAN %*'
    $env:PATH = "$fakeBin;$env:PATH"
    $out = (agy1 --conversation abc) -join "`n"
    Check 'agy1 launches agy with arguments intact and puts plain agy back after' ($out -like '*AGY_RAN --conversation abc*' -and (& $inCM) -eq $plainText -and -not (Test-Path "$g\.agy\active"))
}
finally {
    try { & $m { [LimpetCredentials]::Delete((Get-LimpetAgyTarget)) } } catch { }
    $env:LIMPET_AGENT_HOME = $saved.home; $env:LIMPET_AGY_CRED_TARGET = $saved.target; $env:LIMPET_AGY_PROCESS = $saved.proc; $env:LIMPET_AGENT_RUN = $saved.run; $env:PATH = $saved.path
    Remove-Item -Recurse -Force $g -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Any number of accounts: discovery from the home dir, numbered commands (real
# functions for dirs that exist, the command-not-found hook for the rest) and
# CLAUDE_CONFIG_DIR / CODEX_HOME routing. Nothing is launched (--limpet-plan)
# and everything lives under a temp home; the real ~/.claude* are untouched.
# ---------------------------------------------------------------------------
$ah = Join-Path $env:TEMP ("limpet_agents_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$savedAgentHome = $env:LIMPET_AGENT_HOME
try {
    New-Item -ItemType Directory -Force -Path "$ah\.claude-2", "$ah\.claude-10", "$ah\.codex-1", "$ah\.agy-3", "$ah\.copilot-2", "$ah\.claude-x", "$ah\.claude-01", "$ah\Documents" | Out-Null
    $env:LIMPET_AGENT_HOME = $ah
    $accts = @(Get-LimpetAgentAccounts)
    Check 'accounts are discovered from the home dir: plain first, numbers ascending, junk ignored' (($accts | ForEach-Object Command) -join ',' -eq 'claude,claude2,claude10,codex,codex1,agy,agy3,copilot,copilot2')
    Check 'each account maps to its own config dir' (($accts | Where-Object Command -eq 'codex1').ConfigDir -eq "$ah\.codex-1" -and
        ($accts | Where-Object Command -eq 'copilot2').ConfigDir -eq "$ah\.copilot-2")

    Import-Module $module -Force   # re-import: the numbered dirs become commands
    Check 'numbered accounts whose dir exists are real commands' (@(Get-Command claude2, claude10, codex1, agy3, copilot2 -ErrorAction SilentlyContinue).Count -eq 5)
    $plan = copilot2 --limpet-plan --resume abc
    Check 'copilot2 runs Copilot with COPILOT_HOME at ~/.copilot-2' (
        $plan.Kind -eq 'copilot' -and $plan.EnvName -eq 'COPILOT_HOME' -and $plan.ConfigDir -eq "$ah\.copilot-2" -and (($plan.Arguments -join ' ') -eq '--resume abc'))
    $plan = agy5 --limpet-plan --conversation abc
    Check 'agy5 runs Antigravity with no directory variable (its login is swapped instead), through the hook' (
        $plan.Kind -eq 'agy' -and -not $plan.EnvName -and $plan.ConfigDir -eq "$ah\.agy-5" -and (Test-Path "$ah\.agy-5"))
    Check 'a Copilot launch shares its history with plain copilot' (
        ((Get-Item "$ah\.copilot-2\session-state" -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -and (Test-Path "$ah\.copilot\session-state"))
    $plan = claude10 --limpet-plan --resume abc
    Check 'claude10 runs Claude with CLAUDE_CONFIG_DIR at ~/.claude-10, arguments intact' (
        $plan.Kind -eq 'claude' -and $plan.EnvName -eq 'CLAUDE_CONFIG_DIR' -and $plan.ConfigDir -eq "$ah\.claude-10" -and (($plan.Arguments -join ' ') -eq '--resume abc'))
    $plan = codex1 --limpet-plan resume xyz
    Check 'codex1 runs Codex with CODEX_HOME at ~/.codex-1' (
        $plan.Kind -eq 'codex' -and $plan.EnvName -eq 'CODEX_HOME' -and $plan.ConfigDir -eq "$ah\.codex-1" -and (($plan.Arguments -join ' ') -eq 'resume xyz'))
    Check 'a number with no dir is not a command yet' (-not (Get-Command claude7 -ErrorAction SilentlyContinue))
    $plan = claude7 --limpet-plan -c
    Check 'claude7 still runs, through the command-not-found hook, and gets its dir' (
        $plan.ConfigDir -eq "$ah\.claude-7" -and (Test-Path "$ah\.claude-7") -and (($plan.Arguments -join ' ') -eq '-c'))
    $plan = codex42 --limpet-plan
    Check 'codex42 likewise' ($plan.Kind -eq 'codex' -and (Test-Path "$ah\.codex-42") -and $plan.Arguments.Count -eq 0)
    Check 'a Claude launch wires every Claude account into the shared store under that home' (
        ((Get-Item "$ah\.claude-7\projects" -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -and
        ((Get-Item "$ah\.claude-2\projects" -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -and (Test-Path "$ah\.claude-shared\projects"))
    Check 'a Codex launch leaves the Claude wiring alone' (-not (Test-Path "$ah\.codex-42\projects"))
    Check "a Codex launch wires every numbered Codex home into plain codex's history" (
        ((Get-Item "$ah\.codex-42\sessions" -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -and
        ((Get-Item "$ah\.codex-1\sessions" -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -and (Test-Path "$ah\.codex\sessions"))

    # A real launch, against a stand-in codex that reports what it was given.
    $fakeBin = "$ah\bin"; $run = "$ah\run"
    New-Item -ItemType Directory -Force -Path $fakeBin | Out-Null
    Set-Content -LiteralPath "$fakeBin\codex.cmd" -Encoding Ascii -Value @(
        '@echo off', 'echo HOME=%CODEX_HOME% ARGS=%*', 'for %%f in ("%LIMPET_AGENT_RUN%\*.json") do (echo NOTE=%%~nxf & type "%%f")')
    $savedPath = $env:PATH; $savedRun = $env:LIMPET_AGENT_RUN; $savedCodexHome = $env:CODEX_HOME
    try {
        $env:PATH = "$fakeBin;$env:PATH"; $env:LIMPET_AGENT_RUN = $run
        $out = (codex1 resume xyz) -join "`n"
        Check 'codex1 launches Codex with CODEX_HOME at ~/.codex-1, arguments intact' ($out -like "*HOME=$ah\.codex-1 ARGS=resume xyz*")
        Check 'while it runs, the shell notes that it launched codex1 (for the app)' ($out -like "*NOTE=$PID.json*" -and $out -like '*"cmd":"codex1"*')
        Check 'the note goes and CODEX_HOME is put back when it exits' (-not (Test-Path "$run\$PID.json") -and $env:CODEX_HOME -eq $savedCodexHome)
    }
    finally { $env:PATH = $savedPath; $env:LIMPET_AGENT_RUN = $savedRun }
    Check 'a leading zero is not an account' ($(try { Invoke-LimpetAgent -Command 'claude01' -Arguments @('--limpet-plan') -ErrorAction Stop; 'ran' } catch { 'refused' }) -eq 'refused')
    Check 'other unknown commands still fail normally' ($(try { nosuchlimpetcommand } catch { 'gone' }) -eq 'gone')
    Check 'plain claude, codex and copilot are never shadowed' (@(Get-Command claude, codex, copilot -CommandType Function -ErrorAction SilentlyContinue).Count -eq 0)
    Check 'plain agy goes through the wrapper (its login may be swapped out)' ((Get-Command agy -CommandType Function -ErrorAction SilentlyContinue).Definition -match "Invoke-LimpetAgent -Command 'agy'")
}
finally {
    if ($null -eq $savedAgentHome) { Remove-Item Env:\LIMPET_AGENT_HOME -ErrorAction SilentlyContinue } else { $env:LIMPET_AGENT_HOME = $savedAgentHome }
    Import-Module $module -Force   # back to the real home's accounts
    Get-ChildItem -LiteralPath $ah -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
        ForEach-Object { [IO.Directory]::Delete($_.FullName) }
    Remove-Item -Recurse -Force $ah -ErrorAction SilentlyContinue
}

$global:ErrorActionPreference = $script:savedGlobalEAP
$color = if ($fail) { 'Red' } else { 'Green' }
Write-Host "`n$pass passed, $fail failed" -ForegroundColor $color
if ($fail) { exit 1 }
