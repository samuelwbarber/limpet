# winux - run common Linux/Unix commands inside PowerShell.
# Each Unix command is a thin function that parses the usual flags and
# forwards to the native PowerShell cmdlet. Works on Windows PowerShell 5.1+
# and PowerShell 7+.
#
# Design notes:
#  * These are *simple* functions (no [CmdletBinding]/[Parameter]). That is
#    deliberate: advanced functions inherit common parameters, so "-p" binds
#    to -PipelineVariable, "-v" to -Verbose, etc. Simple functions route every
#    token into $args untouched, which is exactly what a Unix-style parser
#    wants. Pipeline input is read through the automatic $input enumerator.
#  * Commands whose names collide with built-in PowerShell aliases (ls, cp,
#    mv, rm, cat) are implemented as Nix* functions and surfaced via global
#    aliases, because a same-named function cannot win command resolution
#    against a built-in alias.

# ---------------------------------------------------------------------------
# Internal helpers (not exported)
# ---------------------------------------------------------------------------

# Parse a token list the way a Unix shell would: clustered short flags (-rf),
# long flags (--force), value flags (-n 10 / -n10 / --lines=10), bare numbers
# (-10 -> count), "--" terminator, and everything else as positional paths.
function ConvertFrom-UnixArgs {
    param(
        [string[]] $Tokens,
        [string[]] $ValueFlags = @()   # short flags that consume a value, e.g. 'n'
    )
    $flags  = @{}
    $values = @{}
    $paths  = [System.Collections.Generic.List[string]]::new()
    if (-not $Tokens) { return [pscustomobject]@{ Flags = $flags; Values = $values; Paths = $paths } }

    for ($i = 0; $i -lt $Tokens.Count; $i++) {
        $t = [string]$Tokens[$i]
        if ([string]::IsNullOrEmpty($t)) { continue }

        if ($t -eq '--') {
            for ($j = $i + 1; $j -lt $Tokens.Count; $j++) { $paths.Add([string]$Tokens[$j]) }
            break
        }
        elseif ($t -match '^--(.+)$') {
            $name = $Matches[1]
            if ($name -match '^(.+?)=(.*)$') { $values[$Matches[1]] = $Matches[2] }
            else { $flags[$name] = $true }
        }
        elseif ($t -match '^-\d+$') {
            $values['n'] = $t.Substring(1)
        }
        elseif ($t -match '^-(.+)$') {
            $chars = $Matches[1].ToCharArray()
            for ($c = 0; $c -lt $chars.Count; $c++) {
                $ch = [string]$chars[$c]
                if ($ValueFlags -contains $ch) {
                    $rest = ''
                    if ($c -lt $chars.Count - 1) { $rest = -join $chars[($c + 1)..($chars.Count - 1)] }
                    if ($rest) { $values[$ch] = $rest; break }
                    elseif ($i + 1 -lt $Tokens.Count) { $values[$ch] = [string]$Tokens[$i + 1]; $i++; break }
                    else { $flags[$ch] = $true }
                }
                else { $flags[$ch] = $true }
            }
        }
        else { $paths.Add($t) }
    }
    [pscustomobject]@{ Flags = $flags; Values = $values; Paths = $paths }
}

function Format-Bytes {
    param([double] $Bytes)
    $u = 'B', 'KB', 'MB', 'GB', 'TB', 'PB'; $i = 0
    while ($Bytes -ge 1024 -and $i -lt $u.Count - 1) { $Bytes /= 1024; $i++ }
    '{0:N1} {1}' -f $Bytes, $u[$i]
}

# ---------------------------------------------------------------------------
# File listing / navigation
# ---------------------------------------------------------------------------

function NixLs {
    $p = ConvertFrom-UnixArgs $args
    $gci = @{}
    if ($p.Paths.Count) { $gci.Path = @($p.Paths) }
    if ($p.Flags['a'] -or $p.Flags['all'])       { $gci.Force = $true }
    if ($p.Flags['R'] -or $p.Flags['recursive']) { $gci.Recurse = $true }

    $items = Get-ChildItem @gci
    if     ($p.Flags['t']) { $items = $items | Sort-Object LastWriteTime -Descending }
    elseif ($p.Flags['S']) { $items = $items | Sort-Object Length -Descending }
    if ($p.Flags['r']) { $items = @($items); [array]::Reverse($items) }

    if ($p.Flags['l']) {
        $items | Format-Table -AutoSize Mode, @{ n = 'Size'; e = { Format-Bytes $_.Length } }, LastWriteTime, Name
    }
    else { $items }
}

# ---------------------------------------------------------------------------
# Copy / move / remove / make
# ---------------------------------------------------------------------------

function NixRm {
    $p = ConvertFrom-UnixArgs $args
    if (-not $p.Paths.Count) { Write-Error 'rm: missing operand'; return }
    $rp = @{ Path = @($p.Paths) }
    if ($p.Flags['r'] -or $p.Flags['R'] -or $p.Flags['recursive']) { $rp.Recurse = $true }
    if ($p.Flags['f'] -or $p.Flags['force']) { $rp.Force = $true; $rp.ErrorAction = 'SilentlyContinue' }
    Remove-Item @rp
}

function NixCp {
    $p = ConvertFrom-UnixArgs $args
    $paths = @($p.Paths)
    if ($paths.Count -lt 2) { Write-Error 'cp: need source and destination'; return }
    $cp = @{ Path = $paths[0..($paths.Count - 2)]; Destination = $paths[-1] }
    if ($p.Flags['r'] -or $p.Flags['R'] -or $p.Flags['recursive']) { $cp.Recurse = $true }
    if ($p.Flags['f'] -or $p.Flags['force']) { $cp.Force = $true }
    Copy-Item @cp
}

function NixMv {
    $p = ConvertFrom-UnixArgs $args
    $paths = @($p.Paths)
    if ($paths.Count -lt 2) { Write-Error 'mv: need source and destination'; return }
    $mv = @{ Path = $paths[0..($paths.Count - 2)]; Destination = $paths[-1] }
    if ($p.Flags['f'] -or $p.Flags['force']) { $mv.Force = $true }
    Move-Item @mv
}

function mkdir {
    $p = ConvertFrom-UnixArgs $args
    if (-not $p.Paths.Count) { Write-Error 'mkdir: missing operand'; return }
    foreach ($d in $p.Paths) {
        New-Item -ItemType Directory -Path $d -Force:([bool]($p.Flags['p'])) | Out-Null
    }
}

function touch {
    $p = ConvertFrom-UnixArgs $args
    foreach ($f in $p.Paths) {
        if (Test-Path -LiteralPath $f) { (Get-Item -LiteralPath $f).LastWriteTime = Get-Date }
        else { New-Item -ItemType File -Path $f | Out-Null }
    }
}

# ---------------------------------------------------------------------------
# Viewing file contents
# ---------------------------------------------------------------------------

function NixCat {
    $pipe = @($input)
    $p = ConvertFrom-UnixArgs $args
    $lines = if ($p.Paths.Count) { Get-Content -Path @($p.Paths) } else { $pipe }
    if ($p.Flags['n']) {
        $i = 1; foreach ($l in $lines) { '{0,6}  {1}' -f $i, $l; $i++ }
    }
    else { $lines }
}

function head {
    $pipe = @($input)
    $p = ConvertFrom-UnixArgs $args -ValueFlags @('n')
    $count = if ($p.Values['n']) { [int]$p.Values['n'] } else { 10 }
    $src = if ($p.Paths.Count) { Get-Content -Path $p.Paths[0] } else { $pipe }
    $src | Select-Object -First $count
}

function tail {
    $pipe = @($input)
    $p = ConvertFrom-UnixArgs $args -ValueFlags @('n')
    $count = if ($p.Values['n']) { [int]$p.Values['n'] } else { 10 }
    if ($p.Paths.Count) {
        if ($p.Flags['f']) { Get-Content -Path $p.Paths[0] -Tail $count -Wait }
        else { Get-Content -Path $p.Paths[0] -Tail $count }
    }
    else { $pipe | Select-Object -Last $count }
}

# ---------------------------------------------------------------------------
# Searching
# ---------------------------------------------------------------------------

function grep {
    $pipe = @($input)
    $p = ConvertFrom-UnixArgs $args
    $paths = @($p.Paths)
    if (-not $paths.Count) { Write-Error 'grep: missing pattern'; return }
    $pattern = $paths[0]
    $files = if ($paths.Count -gt 1) { $paths[1..($paths.Count - 1)] } else { @() }

    $ss = @{ Pattern = $pattern }
    if (-not $p.Flags['i']) { $ss.CaseSensitive = $true }  # grep is case-sensitive by default
    if ($p.Flags['v']) { $ss.NotMatch = $true }

    if ($files.Count) {
        if ($p.Flags['r'] -or $p.Flags['R']) {
            Get-ChildItem -Path $files -Recurse -File | Select-String @ss
        }
        else { Select-String -Path $files @ss }
    }
    else { $pipe | Select-String @ss }
}

# Subset of find: find [path] -name PATTERN -type f|d
function find {
    $a = $args
    $path = '.'; $name = '*'; $type = $null; $i = 0
    if ($a.Count -and $a[0] -notmatch '^-') { $path = $a[0]; $i = 1 }
    for (; $i -lt $a.Count; $i++) {
        switch -Regex ($a[$i]) {
            '^-i?name$' { $i++; $name = $a[$i] }
            '^-type$'   { $i++; $type = $a[$i] }
        }
    }
    $items = Get-ChildItem -Path $path -Recurse -Filter $name -ErrorAction SilentlyContinue
    if     ($type -eq 'f') { $items = $items | Where-Object { -not $_.PSIsContainer } }
    elseif ($type -eq 'd') { $items = $items | Where-Object { $_.PSIsContainer } }
    $items | Select-Object -ExpandProperty FullName
}

function which {
    foreach ($n in $args) {
        $c = Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) {
            switch ($c.CommandType) {
                'Application' { $c.Source }
                'Alias'       { "$n -> $($c.Definition)" }
                default       { "${n}: $($c.CommandType)" }
            }
        }
        else { Write-Warning "which: $n not found" }
    }
}

# ---------------------------------------------------------------------------
# Disk usage / permissions
# ---------------------------------------------------------------------------

function du {
    $p = ConvertFrom-UnixArgs $args
    $targets = if ($p.Paths.Count) { @($p.Paths) } else { @('.') }
    foreach ($t in $targets) {
        $sum = (Get-ChildItem -Path $t -Recurse -File -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum).Sum
        [pscustomobject]@{ Size = (Format-Bytes ([double]$sum)); Path = $t }
    }
}

function df {
    Get-PSDrive -PSProvider FileSystem | ForEach-Object {
        [pscustomobject]@{
            Filesystem = $_.Name
            Size       = Format-Bytes ([double]($_.Used + $_.Free))
            Used       = Format-Bytes ([double]$_.Used)
            Avail      = Format-Bytes ([double]$_.Free)
            Root       = $_.Root
        }
    }
}

function chmod {
    Write-Warning 'chmod is a no-op on Windows (NTFS uses ACLs). Use icacls for real permission changes.'
}

# ---------------------------------------------------------------------------
# Resilient SSH: a drop-in for ssh that auto-reconnects (no password, via your
# key) when the link drops. Use exactly like ssh:
#     xssh user@host
#     xssh -p 2222 root@1.2.3.4
#     xssh user@host -t "tmux attach -t main || tmux new -s main"   # survive drops
# Reconnect is fully client-side. For session survival across a drop, run tmux
# on the remote (the -t example above) -- nothing else needs installing.
# ---------------------------------------------------------------------------

function xssh {
    if (-not $args.Count) { Write-Error 'xssh: usage is the same as ssh, e.g. xssh user@host'; return }

    $sshArgs = @($args)
    # Add keepalives so dropped links are detected promptly, unless the caller
    # already specified them.
    if (-not ($sshArgs -match 'ServerAliveInterval')) {
        $sshArgs = @('-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'TCPKeepAlive=yes') + $sshArgs
    }

    # Remember the host so `wput` can default to it for client-side uploads.
    $hostTok = $args | Where-Object { $_ -like '*@*' -and $_ -notlike '-*' } | Select-Object -First 1
    if (-not $hostTok) { $hostTok = $args | Where-Object { $_ -notlike '-*' } | Select-Object -First 1 }
    if ($hostTok) { Set-Content -Path (Join-Path $env:TEMP 'winux-last-ssh.txt') -Value $hostTok -Encoding ascii }

    Write-Host "xssh: resilient ssh (auto-reconnect on drop; Ctrl+C to stop)" -ForegroundColor DarkGray
    if ($hostTok) { Write-Host "      upload files with:  wput <files>   (client-side scp -> $hostTok)" -ForegroundColor DarkGray }
    while ($true) {
        $start = Get-Date
        ssh @sshArgs
        $code = $LASTEXITCODE
        $elapsed = ((Get-Date) - $start).TotalSeconds

        if ($code -eq 0) { break }   # clean logout / detach

        # A near-instant non-zero exit means ssh never connected (bad host, auth
        # failure, usage error) -- retrying would loop forever, so stop.
        if ($elapsed -lt 5) {
            Write-Host "[xssh] connection exited immediately (code $code): host/auth error, not a drop. Stopping." -ForegroundColor Red
            break
        }

        Write-Host "`n[xssh] link dropped (exit $code) -- reconnecting in 2s... (Ctrl+C to stop)" -ForegroundColor Yellow
        Start-Sleep -Seconds 2
    }
}

# ---------------------------------------------------------------------------
# wput: client-side-only upload. scp's local files/folders to a remote dir,
# passwordless via your SSH key, needing nothing on the server but sshd.
# Pairs with WezTerm's drag-drop (which pastes the path): at a LOCAL prompt,
# type `wput `, drag the files, Enter.
#     wput report.pdf                       -> last xssh host, remote home (~)
#     wput .\build -Dest /var/www           -> a specific remote dir
#     wput a.txt b.txt -To me@host -Port 2222
# Note: "current remote dir" can't be detected client-side without the remote
# advertising it; pass -Dest for a specific directory.
# ---------------------------------------------------------------------------

function wput {
    $files = @(); $to = $null; $dest = ''; $port = 22
    $key = (Join-Path $env:USERPROFILE '.ssh\id_ed25519')

    $a = @($args); $i = 0
    while ($i -lt $a.Count) {
        switch -Regex ($a[$i]) {
            '^-To$'   { $to   = $a[++$i] }
            '^-Dest$' { $dest = $a[++$i] }
            '^-Port$' { $port = $a[++$i] }
            '^-Key$'  { $key  = $a[++$i] }
            default   { $files += $a[$i] }
        }
        $i++
    }

    if (-not $files.Count) { Write-Error 'wput: no files. Usage: wput <files> [-To user@host] [-Dest /remote/dir] [-Port N] [-Key path]'; return }

    if (-not $to) {
        $state = Join-Path $env:TEMP 'winux-last-ssh.txt'
        if (Test-Path $state) { $to = (Get-Content $state -Raw).Trim() }
    }
    if (-not $to) { Write-Error 'wput: no target. Pass -To user@host, or connect with xssh first so wput can reuse that host.'; return }

    foreach ($f in $files) {
        if (-not (Test-Path -LiteralPath $f)) { Write-Error "wput: local path not found: $f"; return }
    }

    $scpArgs = @('-r', '-P', "$port")
    if (Test-Path $key) { $scpArgs += @('-i', $key) }
    $scpArgs += $files
    $scpArgs += ('{0}:{1}' -f $to, $dest)

    Write-Host ("wput -> {0}:{1}" -f $to, $(if ($dest) { $dest } else { '~' })) -ForegroundColor Cyan
    scp @scpArgs
    if ($LASTEXITCODE -eq 0) { Write-Host "Uploaded $($files.Count) item(s)." -ForegroundColor Green }
    else { Write-Host "wput: scp exited with code $LASTEXITCODE" -ForegroundColor Red }
}

# ---------------------------------------------------------------------------
# peek: show an image inline in the terminal. Emits the iTerm2 inline-image
# escape, which winux's xterm image addon renders. `peak` is an alias.
#   peek screenshot.png
# ---------------------------------------------------------------------------

function peek {
    param([Parameter(Mandatory = $true)] [string] $Path)
    $rp = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $rp) { Write-Error "peek: file not found: $Path"; return }
    $bytes = [IO.File]::ReadAllBytes($rp.Path)
    $b64 = [Convert]::ToBase64String($bytes)
    $name64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFileName($rp.Path)))
    $e = [char]27; $bel = [char]7
    Write-Host -NoNewline ("{0}]1337;File=name={1};size={2};inline=1;preserveAspectRatio=1:{3}{4}" -f $e, $name64, $bytes.Length, $b64, $bel)
    Write-Host ''
}

function peak { peek @args }

# ---------------------------------------------------------------------------
# Branding: `winux` prints the logo, version, and the available commands.
# ---------------------------------------------------------------------------

function winux {
    $logo = Join-Path $PSScriptRoot 'winux-logo.txt'
    if (Test-Path $logo) { Get-Content $logo -Encoding UTF8 | ForEach-Object { Write-Host $_ -ForegroundColor Cyan } }
    Write-Host ''
    Write-Host '  PowerShell + Linux commands, with SSH that does not drop.' -ForegroundColor Gray
    Write-Host '  Commands : ls rm cp mv mkdir touch cat head tail grep find which du df chmod' -ForegroundColor DarkGray
    Write-Host '  Resilient: xssh user@host   (drop-in for ssh, auto-reconnects)' -ForegroundColor DarkGray
    Write-Host '  Upload   : wput <files>     (client-side scp to your last xssh host)' -ForegroundColor DarkGray
    Write-Host '  Images   : peek <file>      (show an image inline)' -ForegroundColor DarkGray
    Write-Host '  Docs     : see README.md / docs/COMMANDS.md' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Load: point global aliases at the Nix* functions, overriding the built-in
# read-only aliases. Set-Alias -Scope Global -Force reliably wins, where
# removing the alias from module scope does not. Restore on Remove-Module.
# ---------------------------------------------------------------------------

$script:NixAliases = @{
    ls = 'NixLs'; cp = 'NixCp'; mv = 'NixMv'; rm = 'NixRm'; cat = 'NixCat'
}
$script:OriginalAliases = @{
    ls = 'Get-ChildItem'; cp = 'Copy-Item'; mv = 'Move-Item'
    rm = 'Remove-Item';   cat = 'Get-Content'
}
foreach ($name in $script:NixAliases.Keys) {
    Set-Alias -Name $name -Value $script:NixAliases[$name] -Scope Global -Force -Option AllScope -ErrorAction SilentlyContinue
}

$ExecutionContext.SessionState.Module.OnRemove = {
    foreach ($name in $script:OriginalAliases.Keys) {
        Set-Alias -Name $name -Value $script:OriginalAliases[$name] -Scope Global -Force -ErrorAction SilentlyContinue
    }
}

Export-ModuleMember -Function NixLs, NixRm, NixCp, NixMv, NixCat, mkdir, touch, head, tail, grep, find, which, du, df, chmod, xssh, wput, peek, peak, winux
