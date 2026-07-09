# limpet - run common Linux/Unix commands inside PowerShell.
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
#     xssh -NoResume user@host    # reconnect to a fresh shell instead of tmux
# Reconnect is fully client-side. By default the remote shell is kept alive in
# a tmux session named "limpet" (when the remote has tmux), so after a drop --
# lid closed, wifi change -- you land back exactly where you left off, running
# processes and all. -NoResume skips the tmux wrap; -Raw skips the whole
# limpet bootstrap (plain resilient ssh).
# ---------------------------------------------------------------------------

function xssh {
    if (-not $args.Count) { Write-Error 'xssh: usage is the same as ssh, e.g. xssh user@host'; return }

    $raw = $false; $resume = $true; $resumeExplicit = $false; $rest = @()
    foreach ($a in $args) {
        if ($a -ieq '-Raw') { $raw = $true }
        elseif ($a -ieq '-Resume') { $resume = $true; $resumeExplicit = $true }
        elseif ($a -ieq '-NoResume') { $resume = $false }
        else { $rest += $a }
    }
    # -Raw alone means fully plain; combine with an explicit -Resume for a
    # bare tmux attach without the integration.
    if ($raw -and -not $resumeExplicit) { $resume = $false }

    $sshArgs = @($rest)
    # Add keepalives so dropped links are detected promptly, unless the caller
    # already specified them.
    if (-not ($sshArgs -match 'ServerAliveInterval')) {
        $sshArgs = @('-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'TCPKeepAlive=yes') + $sshArgs
    }

    # Remember the destination host so `wput` can default to it. Parse like ssh:
    # skip options and their values (so -J jump@host is not mistaken for the
    # destination); the first bare token is the host.
    $noValueFlags = '-4','-6','-A','-a','-C','-f','-G','-g','-K','-k','-M','-N','-n','-q','-s','-T','-t','-V','-v','-X','-x','-Y','-y'
    $hostTok = $null
    for ($hi = 0; $hi -lt $rest.Count; $hi++) {
        $tok = [string]$rest[$hi]
        if ($tok.StartsWith('-')) {
            if ($noValueFlags -notcontains $tok) { $hi++ }  # this flag consumes a value
            continue
        }
        $hostTok = $tok; break
    }
    if ($hostTok) { Set-Content -Path (Join-Path $env:TEMP 'limpet-last-ssh.txt') -Value $hostTok -Encoding ascii }

    # Windows Hello auth: if this host was enrolled (Enable-LimpetHello), unseal the
    # limpet key's passphrase with one Hello prompt and feed it to ssh via an
    # askpass helper. The passphrase stays cached in this process for the whole
    # resilient loop (so reconnects don't re-prompt) and is wiped on exit.
    $helloActive = $false
    if ($hostTok -and (Get-Command Test-LimpetHelloEnrolled -ErrorAction SilentlyContinue) -and (Test-LimpetHelloEnrolled $hostTok)) {
        $keyPath = Get-LimpetKeyPath
        if (Test-Path $keyPath) {
            try {
                Write-Host 'xssh: Windows Hello...' -ForegroundColor Cyan
                $env:LIMPET_ASKPASS = Get-LimpetHelloPassphrase
                $env:SSH_ASKPASS = Get-LimpetAskpass
                $env:SSH_ASKPASS_REQUIRE = 'force'
                # accept-new keeps the askpass helper from being handed a host-key
                # yes/no prompt (it only ever answers the key passphrase).
                $sshArgs = @('-i', $keyPath, '-o', 'IdentitiesOnly=yes',
                             '-o', 'PreferredAuthentications=publickey',
                             '-o', 'StrictHostKeyChecking=accept-new') + $sshArgs
                $helloActive = $true
            }
            catch {
                $env:LIMPET_ASKPASS = $null; $env:SSH_ASKPASS = $null; $env:SSH_ASKPASS_REQUIRE = $null
                Write-Host "xssh: Hello unlock failed ($($_.Exception.Message)); falling back to normal auth." -ForegroundColor Yellow
            }
        }
    }

    # Load limpet shell integration into the remote session (sent fresh each
    # connect; nothing persisted on the server). Gives peek/download/upload.
    $integrated = $false
    if (-not $raw) {
        $scriptPath = Join-Path $PSScriptRoot 'limpet-remote.sh'
        if (Test-Path $scriptPath) {
            $scriptRaw = Get-Content $scriptPath -Raw
            $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($scriptRaw))
            # A short content hash stamps the tmux session so a reconnect can tell a
            # session running THIS helper version from a stale one.
            $ver = -join (([Security.Cryptography.SHA1]::Create().ComputeHash(
                        [Text.Encoding]::UTF8.GetBytes($scriptRaw)))[0..5] | ForEach-Object { $_.ToString('x2') })
            # LIMPET_SH points at the (session-lifetime) script so nested shells can
            # re-source it and the remote xssh function can carry it across hops.
            if ($resume) {
                # The tmux session's shell sources the freshly-injected script itself
                # (bash --rcfile $f), exactly like the -NoResume path -- NOT via
                # `export -f` env inheritance, which a pre-existing tmux server
                # ignores (it keeps its own start-time env, so a new session would
                # get a stale peek). Each session is stamped with the helper version;
                # a reconnect resumes a matching session but recreates a stale one, so
                # a helper update always takes effect. -d detaches the dropped client.
                # NOTE: this whole string is one ssh.exe argument, and Windows mangles
                # embedded double quotes on the way to the remote -- so it uses NO
                # double quotes (case, not [ = ]; the tmux command is a bare unquoted
                # `bash --rcfile $f -i`, which tmux execs directly, so no `exec`).
                $tpl = 'f=$(mktemp); printf %s ''__B64__'' | base64 -d > $f; export LIMPET_SH=$f; if command -v tmux >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then if tmux has-session -t limpet 2>/dev/null; then v=$(tmux show-environment -t limpet _LIMPET_VER 2>/dev/null); case ${v#*=} in __VER__) ;; *) tmux kill-session -t limpet 2>/dev/null ;; esac; fi; if tmux has-session -t limpet 2>/dev/null; then rm -f $f; else tmux new -d -s limpet bash --rcfile $f -i; tmux setenv -t limpet _LIMPET_VER __VER__; fi; exec tmux attach -d -t limpet; elif command -v bash >/dev/null 2>&1; then bash --rcfile $f -i; rm -f $f; else ENV=$f sh -i; rm -f $f; fi'
            }
            else {
                $tpl = 'f=$(mktemp); printf %s ''__B64__'' | base64 -d > $f; export LIMPET_SH=$f; if command -v bash >/dev/null 2>&1; then bash --rcfile $f -i; else ENV=$f sh -i; fi; rm -f $f'
            }
            $sshArgs = @('-t') + $sshArgs + @($tpl.Replace('__B64__', $b64).Replace('__VER__', $ver))
            $integrated = $true
        }
    }
    elseif ($resume) {
        $sshArgs = @('-t') + $sshArgs + @('if command -v tmux >/dev/null 2>&1; then tmux new -A -D -s limpet; else exec ${SHELL:-sh} -il; fi')
    }

    Write-Host "xssh: resilient ssh (auto-reconnect on drop; Ctrl+C to stop)" -ForegroundColor DarkGray
    if ($helloActive) { Write-Host "      auth: Windows Hello (limpet key)" -ForegroundColor DarkGray }
    if ($resume) { Write-Host "      session: kept alive in remote tmux 'limpet' -- reconnects resume where you left off (-NoResume to skip)" -ForegroundColor DarkGray }
    if ($integrated) { Write-Host "      in-session: peek <img> | download <file> | upload <pc-path> | reels [url]" -ForegroundColor DarkGray }

    $dnsHost = if ($hostTok) { ($hostTok -split '@')[-1] } else { $null }
    $hadSession = $false
    try {
        while ($true) {
            $start = Get-Date
            ssh @sshArgs
            $code = $LASTEXITCODE
            $elapsed = ((Get-Date) - $start).TotalSeconds

            if ($code -eq 0) { break }   # clean logout / detach
            if ($elapsed -ge 5) { $hadSession = $true }

            # A near-instant non-zero exit means ssh never connected at all.
            if ($elapsed -lt 5) {
                # Before any session existed that's a bad host / auth / usage error --
                # retrying would loop forever, so stop.
                if (-not $hadSession) {
                    Write-Host "[xssh] connection exited immediately (code $code): host/auth error, not a drop. Stopping." -ForegroundColor Red
                    break
                }
                # After a live session it almost always means the machine is offline
                # (lid closed, wifi/VPN still coming up after resume): wait for the
                # host to become resolvable again, then reconnect.
                Write-Host "[xssh] can't reach $dnsHost -- waiting for network... (Ctrl+C to stop)" -ForegroundColor Yellow
                $waited = 0
                while ($waited -lt 60) {
                    Start-Sleep -Seconds 3; $waited += 3
                    if ($dnsHost) {
                        try { [void][System.Net.Dns]::GetHostEntry($dnsHost); break } catch { }
                    }
                }
                continue
            }

            Write-Host "`n[xssh] link dropped (exit $code) -- reconnecting in 2s... (Ctrl+C to stop)" -ForegroundColor Yellow
            Start-Sleep -Seconds 2
        }
    }
    finally {
        # Wipe the cached passphrase and askpass wiring from this process.
        if ($helloActive) {
            $env:LIMPET_ASKPASS = $null
            $env:SSH_ASKPASS = $null
            $env:SSH_ASKPASS_REQUIRE = $null
        }
    }
}

# ---------------------------------------------------------------------------
# wput: client-side-only upload. scp's local files/folders to a remote dir,
# passwordless via your SSH key, needing nothing on the server but sshd.
# The app's drag-drop covers small files in-session; wput is for folders,
# big files, or plain terminals.
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
        $state = Join-Path $env:TEMP 'limpet-last-ssh.txt'
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
# escape tagged with a limpet-private rows=N field, then prints N newlines.
# ConPTY cannot know an image occupies screen rows, so the newlines reserve
# real blank rows in its model and the limpet app draws the image over them —
# without this, the next prompt overdraws the image. `peak` is an alias.
#   peek screenshot.png shot*.jpg
# ---------------------------------------------------------------------------

function peek {
    if (-not $args.Count) { Write-Error 'peek: usage: peek <image> [...]'; return }
    foreach ($arg in $args) {
        $rps = Resolve-Path -Path $arg -ErrorAction SilentlyContinue
        if (-not $rps) { Write-Error "peek: file not found: $arg"; continue }
        foreach ($rp in @($rps)) {
            if (-not (Test-Path -LiteralPath $rp.Path -PathType Leaf)) { continue }
            $bytes = [IO.File]::ReadAllBytes($rp.Path)

            # Display height in terminal rows, from the image's pixel height
            # (~18 px per row in the limpet app; the app fits the image into the
            # reserved rows preserving aspect, so this only sets the scale).
            $rows = 18
            try {
                Add-Type -AssemblyName System.Drawing -ErrorAction Stop
                $ms = New-Object System.IO.MemoryStream(, $bytes)
                $img = [System.Drawing.Image]::FromStream($ms, $false, $false)
                $rows = [int][Math]::Ceiling($img.Height / 18.0)
                $img.Dispose(); $ms.Dispose()
            } catch { }
            $rows = [Math]::Max(2, [Math]::Min(22, $rows))

            $b64 = [Convert]::ToBase64String($bytes)
            $name64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFileName($rp.Path)))
            $e = [char]27; $bel = [char]7
            Write-Host -NoNewline ("{0}]1337;File=name={1};size={2};inline=1;preserveAspectRatio=1;rows={3}:{4}{5}" -f $e, $name64, $bytes.Length, $rows, $b64, $bel)
            Write-Host -NoNewline ("`n" * $rows)
        }
    }
}

function peak { peek @args }

# Dock a webpage on the right side of the limpet window. No args toggles the
# Instagram reels feed; pass a URL to open something else. Talks to the app via
# the same private OSC channel as peek/download (works locally and over ssh).
function reels {
    $url = if ($args.Count) { [string]$args[0] } else { '' }
    $u64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($url))
    $e = [char]27; $bel = [char]7
    Write-Host -NoNewline ("{0}]5379;reels;{1}{2}" -f $e, $u64, $bel)
}

# ---------------------------------------------------------------------------
# Branding: `limpet` prints the logo, version, and the available commands.
# ---------------------------------------------------------------------------

function limpet {
    $logoPath = Join-Path $PSScriptRoot 'limpet-logo.txt'
    $letters = if (Test-Path $logoPath) { @(Get-Content $logoPath -Encoding UTF8) } else { @() }

    # The mascot, as truecolor pixel art (each cell is two full blocks): blue
    # ribbed shell, peach foot peeking out with a face. Rendered next to the
    # lettering; hosts without VT support just get the plain letters.
    $art = @(
        '.......LL.......'
        '......BBBB......'
        '.....BBLLBB.....'
        '....BBBLLBBB....'
        '...BBLBLLBLBB...'
        '..BBLBBLLBBLBB..'
        '.BBLBBBLLBBBLBB.'
        '.BBBBBBBBBBBBBB.'
        '..PRPKPPPPKPRP..'
        '...PPPPKKPPPP...'
    )
    # Catppuccin Mocha: blue, lavender, peach, ink, pink; letters in sky.
    $rgb = @{ B = '137;180;250'; L = '180;190;254'; P = '250;179;135'; K = '49;50;68'; R = '243;139;168' }
    $e = [char]27
    $px2 = [string][char]0x2588 * 2
    if ($Host.UI.SupportsVirtualTerminal) {
        Write-Host ''
        for ($i = 0; $i -lt $art.Count; $i++) {
            $line = '  '
            $prev = ''
            foreach ($c in $art[$i].ToCharArray()) {
                if ($c -eq '.') { $line += '  '; continue }
                if ($prev -ne $c) { $line += "$e[38;2;$($rgb[[string]$c])m"; $prev = $c }
                $line += $px2
            }
            $line += "$e[0m"
            $li = $i - 3   # lettering rides alongside the shell, rows 3..7
            if ($li -ge 0 -and $li -lt $letters.Count) {
                $line += "   $e[38;2;137;220;235m$($letters[$li])$e[0m"
            }
            Write-Host $line
        }
    }
    else {
        $letters | ForEach-Object { Write-Host $_ -ForegroundColor Cyan }
    }
    Write-Host ''
    Write-Host '  PowerShell + Linux commands, with SSH that does not drop.' -ForegroundColor Gray
    Write-Host '  Commands : ls rm cp mv mkdir touch cat head tail grep find which du df chmod' -ForegroundColor DarkGray
    Write-Host '  Resilient: xssh user@host   (drop-in for ssh, auto-reconnects)' -ForegroundColor DarkGray
    Write-Host '  Hello SSH: Enable-LimpetHello user@host  (password once, then Windows Hello)' -ForegroundColor DarkGray
    Write-Host '  Upload   : wput <files>     (client-side scp to your last xssh host)' -ForegroundColor DarkGray
    Write-Host '  Images   : peek <file>      (show an image inline)' -ForegroundColor DarkGray
    Write-Host '  Reels    : reels [url]      (dock a page on the right; default Instagram reels)' -ForegroundColor DarkGray
    Write-Host '  Docs     : see README.md / docs/COMMANDS.md' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Load: point global aliases at the Nix* functions, overriding the built-in
# read-only aliases. Set-Alias -Scope Global -Force reliably wins, where
# removing the alias from module scope does not. Restore on Remove-Module.
# Scopes that existed before import hold their own AllScope copies which this
# cannot reach; limpet-aliases.ps1 (ScriptsToProcess) rewrites those from
# inside the caller's scope chain.
# ---------------------------------------------------------------------------

$script:NixAliases = @{
    ls = 'NixLs'; cp = 'NixCp'; mv = 'NixMv'; rm = 'NixRm'; cat = 'NixCat'
}
$script:OriginalAliases = @{
    ls = 'Get-ChildItem'; cp = 'Copy-Item'; mv = 'Move-Item'
    rm = 'Remove-Item';   cat = 'Get-Content'
}
foreach ($name in $script:NixAliases.Keys) {
    $target = $script:NixAliases[$name]
    Set-Alias -Name $name -Value $target -Scope Global -Force -Option AllScope -ErrorAction SilentlyContinue
    $cur = Get-Alias -Name $name -ErrorAction SilentlyContinue
    if ($cur -and $cur.Definition -eq $target) { continue }
    # Some hosts refuse the one-shot overwrite. Try replacing through the
    # Alias: drive, then removing the built-in wherever it's visible and
    # setting ours fresh.
    Set-Item -Path "Alias:\$name" -Value $target -Force -ErrorAction SilentlyContinue
    $cur = Get-Alias -Name $name -ErrorAction SilentlyContinue
    if ($cur -and $cur.Definition -eq $target) { continue }
    for ($i = 0; $i -lt 10 -and (Test-Path "Alias:\$name"); $i++) {
        Remove-Item -Path "Alias:\$name" -Force -ErrorAction SilentlyContinue
    }
    Set-Alias -Name $name -Value $target -Scope Global -Force -Option AllScope -ErrorAction SilentlyContinue
    $cur = Get-Alias -Name $name -ErrorAction SilentlyContinue
    if (-not $cur -or $cur.Definition -ne $target) {
        Write-Warning ("limpet: could not point '{0}' at {1} (it is {2}); its Linux-style flags won't work in this session." -f `
            $name, $target, $(if ($cur) { $cur.Definition } else { 'gone' }))
    }
}

# Tab-friendly window title: the current folder, not powershell.exe's path
# (that's what the app's tab labels show). Global so it drives the session's
# real prompt; the prompt text itself matches PowerShell's default.
function global:prompt {
    $loc = $ExecutionContext.SessionState.Path.CurrentLocation
    $leaf = Split-Path -Leaf $loc.Path
    if (-not $leaf) { $leaf = $loc.Path }
    $Host.UI.RawUI.WindowTitle = $leaf
    "PS $loc$('>' * ($NestedPromptLevel + 1)) "
}

$ExecutionContext.SessionState.Module.OnRemove = {
    foreach ($name in $script:OriginalAliases.Keys) {
        Set-Alias -Name $name -Value $script:OriginalAliases[$name] -Scope Global -Force -ErrorAction SilentlyContinue
    }
}

Export-ModuleMember -Function NixLs, NixRm, NixCp, NixMv, NixCat, mkdir, touch, head, tail, grep, find, which, du, df, chmod, xssh, wput, peek, peak, reels, limpet,
    Enable-LimpetHello, Disable-LimpetHello, Get-LimpetHelloStatus, Get-LimpetHelloPassphrase, Test-LimpetHelloEnrolled, Protect-LimpetSecret, Unprotect-LimpetSecret, Get-LimpetAskpass, Get-LimpetKeyPath
