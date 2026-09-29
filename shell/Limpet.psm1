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
# Resilient SSH: a drop-in for ssh that auto-reconnects when the link drops.
# Reconnects are password-free: if the host uses key/agent or Windows Hello auth
# nothing is typed, and if it uses a login PASSWORD that password is captured
# once up front and replayed to every reconnect (so a drop resumes silently
# instead of re-prompting). Use exactly like ssh:
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

    # Password auto-reconnect: on a host that authenticates with a login PASSWORD
    # (no key/agent, not Hello-enrolled), ssh would re-prompt on every reconnect.
    # Capture the password ONCE now and feed it to every (re)connect through the
    # same askpass helper the Hello path uses, so a drop resumes without typing.
    # A quick BatchMode probe first checks whether key/agent auth already works --
    # if so we skip this entirely, so key users never see a prompt. The password
    # is held only in this process for the loop's lifetime and wiped on exit.
    # Opt out with LIMPET_NO_PWCACHE=1 (also how the test suite disables it).
    $passCached = $false
    if (-not $helloActive -and $hostTok -and $env:LIMPET_NO_PWCACHE -ne '1' -and
        (Get-Command Get-LimpetAskpass -ErrorAction SilentlyContinue)) {
        try {
            # Non-interactive probe: succeeds only if publickey/agent/gssapi auth
            # works with no password. BatchMode never sends a password (so it can't
            # trip fail2ban); accept-new avoids a host-key yes/no prompt.
            $probe = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
                       '-o', 'StrictHostKeyChecking=accept-new') + $sshArgs
            & ssh @probe 'true' 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) {
                $sec = Read-Host "xssh: password for $hostTok (cached for auto-reconnect)" -AsSecureString
                if ($sec -and $sec.Length -gt 0) {
                    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
                    try { $env:LIMPET_ASKPASS = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
                    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
                    $env:SSH_ASKPASS = Get-LimpetAskpass
                    $env:SSH_ASKPASS_REQUIRE = 'force'
                    $passCached = $true
                }
            }
        }
        catch {
            $env:LIMPET_ASKPASS = $null; $env:SSH_ASKPASS = $null; $env:SSH_ASKPASS_REQUIRE = $null
            Write-Host "xssh: password cache setup failed ($($_.Exception.Message)); reconnects may re-prompt." -ForegroundColor Yellow
        }
    }

    # Load limpet shell integration into the remote session (sent fresh each
    # connect; nothing persisted on the server). Gives peek/download/upload.
    $integrated = $false
    if (-not $raw) {
        $scriptPath = Join-Path $PSScriptRoot 'limpet-remote.sh'
        if (Test-Path $scriptPath) {
            $scriptRaw = Get-Content $scriptPath -Raw
            # Inside the limpet app, hand the helpers the app's secret so it
            # trusts their download/upload/reels requests (see limpet-remote.sh).
            if ($env:LIMPET_TOKEN -match '^[0-9a-f]{32}$') { $scriptRaw = "LIMPET_TOKEN=$($env:LIMPET_TOKEN)`n" + $scriptRaw }
            $scriptBytes = [Text.Encoding]::UTF8.GetBytes($scriptRaw)
            # gzip BEFORE base64. The bootstrap is one ssh.exe argument, and a long
            # single arg handed through PowerShell -> ssh.exe gets a newline injected
            # past ~8-9 KB (the raw-base64 script was ~9.5 KB), which split the remote
            # `bash -c` mid-command -> "unexpected EOF" / garbage -> dead session with
            # no `download`/`peek`. Compressing the ~7 KB script to a ~4 KB base64 keeps
            # the whole command well under that limit (verified: <=8100 transmits intact,
            # 9500 corrupts). The remote decodes with `base64 -d | gunzip` (both are on
            # every Linux box). gzip is lossless, so the remote gets the exact bytes the
            # old raw-base64 path delivered.
            $ms = New-Object IO.MemoryStream
            $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Compress)
            $gz.Write($scriptBytes, 0, $scriptBytes.Length); $gz.Close()
            $b64 = [Convert]::ToBase64String($ms.ToArray())
            # A short content hash stamps the tmux session so a reconnect can tell a
            # session running THIS helper version from a stale one.
            $ver = -join (([Security.Cryptography.SHA1]::Create().ComputeHash(
                        $scriptBytes))[0..5] | ForEach-Object { $_.ToString('x2') })
            # LIMPET_SH points at the (session-lifetime) script so nested shells can
            # re-source it and the remote xssh function can carry it across hops.
            if ($resume) {
                # The tmux session's shell sources the freshly-injected script itself
                # (bash --rcfile $f), exactly like the -NoResume path -- NOT via
                # `export -f` env inheritance, which a pre-existing tmux server
                # ignores (it keeps its own start-time env, so a new session would
                # get a stale peek). The session is named for the helper version
                # (limpet-<hash>, token included), so a reconnect resumes the session
                # running these exact helpers, and a helper update (or another PC)
                # starts its own session beside the old one. Never kill a session:
                # it may be running someone's work (older ones stay reachable with
                # `tmux ls` / `tmux attach -t <name>`). `=` makes -t match the name
                # exactly, not as a prefix. -d detaches the dropped client.
                # NOTE: this whole string is one ssh.exe argument. Windows/PowerShell
                # mangle BOTH embedded double AND single quotes when handing a native
                # exe a long arg (single quotes made the remote `bash -c` choke on an
                # unbalanced quote -> "unexpected EOF" -> dead session). So the template
                # contains NO quotes of either kind; the tmux command
                # is a bare unquoted `bash --rcfile $f -i` (tmux execs it directly, no
                # `exec`); and __B64__ is left UNQUOTED -- the base64 alphabet
                # (A-Za-z0-9+/=) has no shell-special or glob chars, so it needs none.
                $tpl = 'f=$(mktemp); printf %s __B64__ | base64 -d | gunzip > $f; export LIMPET_SH=$f; if command -v tmux >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then s=limpet-__VER__; if tmux has-session -t =$s 2>/dev/null; then rm -f $f; else tmux new -d -s $s bash --rcfile $f -i; fi; exec tmux attach -d -t =$s; elif command -v bash >/dev/null 2>&1; then bash --rcfile $f -i; rm -f $f; else ENV=$f sh -i; rm -f $f; fi'
            }
            else {
                $tpl = 'f=$(mktemp); printf %s __B64__ | base64 -d | gunzip > $f; export LIMPET_SH=$f; if command -v bash >/dev/null 2>&1; then bash --rcfile $f -i; else ENV=$f sh -i; fi; rm -f $f'
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
    if ($passCached) { Write-Host "      auth: password cached this session -- reconnects won't re-prompt" -ForegroundColor DarkGray }
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
        # Wipe the cached passphrase/password and askpass wiring from this process.
        if ($helloActive -or $passCached) {
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
    Write-Host -NoNewline ("{0}]5379;reels;{1};{2}{3}" -f $e, $u64, $env:LIMPET_TOKEN, $bel)
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
    Write-Host '  Agents   : claude1, ... / codex1, ... / agy1, ... / copilot1, ... (separate logins; one /resume history per agent)' -ForegroundColor DarkGray
    Write-Host '  Docs     : see README.md / docs/COMMANDS.md' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Any number of Claude Code, Codex, Antigravity (agy) and Copilot accounts;
# one /resume history per agent.
#
# `claude1`, `claude2`, `claude3`, ... each launch the Claude Code CLI against
# their own config directory (~/.claude-1, ~/.claude-2, ...), so each stays
# logged in to a different account -- e.g. personal and work -- with no
# re-authenticating. Plain `claude` keeps its own login in ~/.claude. In the
# same way `codex1`, `codex2`, ... run the OpenAI Codex CLI with CODEX_HOME at
# ~/.codex-1, ~/.codex-2, ...; plain `codex` stays on ~/.codex. `copilot1`, ...
# run the GitHub Copilot CLI with COPILOT_HOME at ~/.copilot-1, .... `agy1`, ...
# run Antigravity, which has no such setting and keeps one login in Windows
# Credential Manager, so limpet keeps each account's login in ~/.agy-N and
# swaps it in for the launch (see Enter-LimpetAgyAccount).
#
# There is no list of accounts. A numbered command whose directory exists is
# defined as a real function at import (tab completion, Get-Command); any
# other number is caught by PowerShell's command-not-found hook, so `claude7`
# works the first time it is typed and creates ~/.claude-7 on the way. Sign in
# there once (/login) and it stays signed in; the limpet app's tab menu lists
# every signed-in account.
#
# All Claude configs' `projects` folders are junctioned to one shared store
# (~/.claude-shared/projects), so `/resume` lists the same sessions whichever
# account you're in. Transcripts are named by unique id, so accounts never
# collide even running side by side. The wiring is made whenever a numbered
# claude command runs (or on demand with Sync-LimpetClaudeHistory); a
# pre-existing solo `projects` folder is folded into the shared store,
# merged file by file, never clobbered.
#
# Only `projects/` is shared. The up-arrow prompt history (history.jsonl)
# stays per account: Claude Code refuses to read that file through a link.
#
# Codex accounts share plain ~/.codex's history. Codex keeps each chat as a
# rollout file under <CODEX_HOME>/sessions, so each numbered home's `sessions`
# and `archived_sessions` are junctioned to ~/.codex's. `thread-writer-locks`
# goes with them: it is how Codex refuses a second writer on a thread, which
# only holds across accounts if they all look in one place. Thread names live
# in session_index.jsonl, which Codex only appends to, so a hard link shares
# it. The /resume picker lists threads from Codex's sqlite index, not from the
# folder, so each numbered home's config.toml also gets `sqlite_home` pointed
# at ~/.codex; threads moved in from a home are then indexed there once
# (Update-LimpetCodexThreadIndex). Logins, the rest of config and the up-arrow
# prompt history stay per account. ~/.codex itself is the hub rather than a new
# store: the Codex app and editor extensions use it directly and its data
# never has to move. A numbered home's own chats are folded in on its first
# sync; a home with a chat open right now is left alone until the next launch.
#
# Copilot accounts share plain ~/.copilot's the same way: `session-state` (one
# folder per chat, which Copilot's resume list is built from, with its in-use
# markers and operation locks) is junctioned to ~/.copilot's. Antigravity
# accounts share everything but the login already: agy always keeps its chats
# in ~/.gemini.
# ---------------------------------------------------------------------------

# The agents, in menu order, and the variable that points each at an account's
# directory (agy has none; its login is swapped instead).
$script:LimpetAgentKinds = [ordered]@{ claude = 'CLAUDE_CONFIG_DIR'; codex = 'CODEX_HOME'; agy = $null; copilot = 'COPILOT_HOME' }
$script:LimpetAgentPattern = '(' + ($script:LimpetAgentKinds.Keys -join '|') + ')'

# Where the account directories live. Tests point this at a temp folder.
function Get-LimpetAgentHome { if ($env:LIMPET_AGENT_HOME) { $env:LIMPET_AGENT_HOME } else { $HOME } }

# Every account with a config dir under the home, plain ones first, numbers
# ascending: @{ Command = 'claude3'; Kind = 'claude'; Number = 3; ConfigDir = '...\.claude-3' }
function Get-LimpetAgentAccounts {
    param([string]$AgentHome = (Get-LimpetAgentHome))
    $found = @{}
    foreach ($kind in $script:LimpetAgentKinds.Keys) { $found[$kind] = @() }
    foreach ($d in @(Get-ChildItem -LiteralPath $AgentHome -Directory -Force -ErrorAction SilentlyContinue)) {
        if ($d.Name -match "^\.$($script:LimpetAgentPattern)-([1-9]\d*)$") { $found[$Matches[1]] += [int]$Matches[2] }
    }
    foreach ($kind in $script:LimpetAgentKinds.Keys) {
        [pscustomobject]@{ Command = $kind; Kind = $kind; Number = 0; ConfigDir = (Join-Path $AgentHome ".$kind") }
        foreach ($n in @($found[$kind] | Sort-Object -Unique)) {
            [pscustomobject]@{ Command = "$kind$n"; Kind = $kind; Number = $n; ConfigDir = (Join-Path $AgentHome ".$kind-$n") }
        }
    }
}

# The account a command name denotes (claude, claude3, codex12, agy2,
# copilot1), or $null.
function Resolve-LimpetAgentCommand {
    param([string]$Command, [string]$AgentHome = (Get-LimpetAgentHome))
    if ($Command -notmatch "^$($script:LimpetAgentPattern)([1-9]\d*)?$") { return $null }
    $kind = $Matches[1]
    $n = if ($Matches[2]) { [int]$Matches[2] } else { 0 }
    $dir = if ($n) { ".$kind-$n" } else { ".$kind" }
    [pscustomobject]@{ Command = $Command; Kind = $kind; Number = $n; ConfigDir = (Join-Path $AgentHome $dir) }
}

# Every Claude config dir: ~/.claude plus each ~/.claude-N present.
function Get-LimpetClaudeConfigDirs {
    @(Get-LimpetAgentAccounts | Where-Object { $_.Kind -eq 'claude' } | ForEach-Object { $_.ConfigDir })
}

function Get-LimpetAgentExe([string]$Kind) {
    # The real CLI (npm shim or exe). Our wrappers are numbered (claude1, ...),
    # so there's nothing to recurse into here.
    $cmd = Get-Command $Kind -CommandType Application, ExternalScript -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return $null
}

function Get-LimpetCodexExe { Get-LimpetAgentExe 'codex' }

function Get-LimpetClaudeSharedStore { Join-Path (Get-LimpetAgentHome) '.claude-shared\projects' }

function Test-LimpetSamePath([string]$A, [string]$B) {
    # Junction targets can come back with a \\?\ prefix or a trailing slash.
    $na = [IO.Path]::GetFullPath(($A -replace '^\\\\\?\\', '')).TrimEnd('\', '/')
    $nb = [IO.Path]::GetFullPath(($B -replace '^\\\\\?\\', '')).TrimEnd('\', '/')
    return [string]::Equals($na, $nb, [StringComparison]::OrdinalIgnoreCase)
}

function Get-LimpetPrefixHash {
    # SHA-256 of the first $Length bytes of a file; $null if it is shorter.
    param([string]$Path, [long]$Length)
    $sha = [Security.Cryptography.SHA256]::Create()
    $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try {
        $buf = New-Object byte[] 1048576
        $left = $Length
        while ($left -gt 0) {
            $n = $fs.Read($buf, 0, [int][Math]::Min([long]$buf.Length, $left))
            if ($n -le 0) { return $null }
            [void]$sha.TransformBlock($buf, 0, $n, $null, 0)
            $left -= $n
        }
        [void]$sha.TransformFinalBlock($buf, 0, 0)
        return [BitConverter]::ToString($sha.Hash)
    }
    finally { $fs.Dispose(); $sha.Dispose() }
}

function Merge-LimpetDirectory {
    # Move everything under $Source into $Dest, recursing where a folder
    # already exists on both sides. Same-name files: identical, or one is the
    # other with more appended (a transcript copied to another account and
    # continued there) -> the longer one keeps the real name and the other is
    # dropped; otherwise the larger one keeps the real name and the other is
    # kept alongside as <name>.conflict-<stamp> (no longer a *.jsonl, so
    # /resume doesn't list it, but nothing is lost). Anything
    # that can't be moved (a file open in a running session) stays put and
    # is counted; the count is returned. Source folders emptied by the merge
    # are removed. Same volume throughout, so every move is a rename.
    param([string]$Source, [string]$Dest, [string]$Stamp)
    $left = 0
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    foreach ($item in @(Get-ChildItem -LiteralPath $Source -Force)) {
        $target = Join-Path $Dest $item.Name
        try {
            if ($item.PSIsContainer) {
                if (Test-Path -LiteralPath $target) {
                    $left += Merge-LimpetDirectory -Source $item.FullName -Dest $target -Stamp $Stamp
                }
                else {
                    Move-Item -LiteralPath $item.FullName -Destination $target -ErrorAction Stop
                }
                continue
            }
            if (-not (Test-Path -LiteralPath $target)) {
                Move-Item -LiteralPath $item.FullName -Destination $target -ErrorAction Stop
                continue
            }
            $existing = Get-Item -LiteralPath $target -Force
            $common = [Math]::Min($item.Length, $existing.Length)
            if ((Get-LimpetPrefixHash $item.FullName $common) -eq (Get-LimpetPrefixHash $existing.FullName $common)) {
                # Duplicate, or one continues the other: keep the longer.
                if ($item.Length -gt $existing.Length) { [IO.File]::Replace($item.FullName, $existing.FullName, [NullString]::Value) }
                else { Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop }
                continue
            }
            $conflict = Join-Path $Dest ('{0}.conflict-{1}' -f $item.Name, $Stamp)
            if ($item.Length -gt $existing.Length) {
                # The incoming file is the fuller transcript: it takes the real name.
                Move-Item -LiteralPath $existing.FullName -Destination $conflict -ErrorAction Stop
                Move-Item -LiteralPath $item.FullName -Destination $target -ErrorAction Stop
            }
            else {
                Move-Item -LiteralPath $item.FullName -Destination $conflict -ErrorAction Stop
            }
        }
        catch { $left++ }
    }
    if ($left -eq 0) { Remove-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue }
    return $left
}

function Connect-LimpetSharedFolder {
    # Make the folder $Link a junction to $Shared. Returns $true when it is,
    # with nothing left over. $Agent names the CLI in warnings. With -Discard
    # a folder already there holds nothing worth keeping (lock files) and is
    # deleted rather than merged.
    param([string]$Link, [string]$Shared, [string]$Stamp, [string]$Agent, [switch]$Discard)
    $parent = Split-Path -Parent $Link
    $leaf = Split-Path -Leaf $Link
    New-Item -ItemType Directory -Force -Path $parent, $Shared | Out-Null
    $item = Get-Item -LiteralPath $Link -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        $target = @($item.Target)[0]
        if (-not $target -or -not (Test-LimpetSamePath $target $Shared)) {
            Write-Warning "limpet: $Link already links to '$target', not the shared store; leaving it alone (history not synced for this account)."
            return $false
        }
        # Already junctioned; fall through to fold in any leftovers.
    }
    elseif ($item) {
        # A real folder from solo use. Swap it out from under the agent with
        # one atomic rename so the junction goes in straight away (a live
        # session keeps appending, now into the shared store), then fold the
        # old contents in. If the rename is refused nothing has changed.
        try { Rename-Item -LiteralPath $Link -NewName "$leaf.migrating-$Stamp" -ErrorAction Stop }
        catch {
            Write-Warning "limpet: couldn't move $Link aside ($($_.Exception.Message)). Is a $Agent session open there? History isn't synced for this account yet; it'll be retried next launch."
            return $false
        }
    }
    if (-not (Test-Path -LiteralPath $Link)) {
        try { New-Item -ItemType Junction -Path $Link -Target $Shared -ErrorAction Stop | Out-Null }
        catch {
            Write-Warning "limpet: couldn't create the junction $Link -> $Shared ($($_.Exception.Message)); history not synced for this account."
            return $false
        }
    }
    # Fold in anything set aside, now or by an earlier interrupted run.
    $ok = $true
    foreach ($stage in @(Get-ChildItem -LiteralPath $parent -Directory -Filter "$leaf.migrating-*" -Force -ErrorAction SilentlyContinue)) {
        if ($Discard) {
            # Still in use? Then it goes next time; the junction is in already.
            Remove-Item -LiteralPath $stage.FullName -Recurse -Force -ErrorAction SilentlyContinue
            continue
        }
        $left = Merge-LimpetDirectory -Source $stage.FullName -Dest $Shared -Stamp $Stamp
        if ($left -gt 0) {
            Write-Warning "limpet: $left item(s) under $($stage.FullName) couldn't be moved into the shared store (open in a running session?). They'll be folded in next launch."
            $ok = $false
        }
    }
    return $ok
}

function Sync-LimpetClaudeHistory {
    <#
    .SYNOPSIS
    Point every Claude Code account's projects/ folder at the shared store so
    /resume lists the same sessions from claude, claude1, claude2, ...
    .DESCRIPTION
    Runs automatically whenever a numbered claude command launches. Run it by
    hand after using plain claude on a machine where no numbered account has
    been started, or to check the wiring. Returns $true when every account is
    synced; otherwise a warning says which one isn't and why.
    #>
    [CmdletBinding()]
    param(
        # Config dirs to wire up. Default: ~/.claude plus every ~/.claude-N that exists.
        [string[]]$ConfigDir,
        # Where the shared transcripts live.
        [string]$Shared = (Get-LimpetClaudeSharedStore)
    )
    if (-not $ConfigDir) {
        $ConfigDir = Get-LimpetClaudeConfigDirs
    }
    $stamp = '{0:yyyyMMdd-HHmmss}-{1}' -f (Get-Date), ([guid]::NewGuid().ToString('N').Substring(0, 4))
    New-Item -ItemType Directory -Force -Path $Shared | Out-Null
    $ok = $true
    foreach ($dir in $ConfigDir) {
        if (-not (Connect-LimpetSharedFolder -Link (Join-Path $dir 'projects') -Shared $Shared -Stamp $stamp -Agent 'Claude')) { $ok = $false }
    }
    return $ok
}

# Plain codex's home: the history every other Codex account shares.
function Get-LimpetCodexHub { Join-Path (Get-LimpetAgentHome) '.codex' }

# What a numbered Codex home shares with the hub. The lock folder goes last:
# while it is still the home's own, a chat open in that home shows up in it,
# which is what Test-LimpetCodexBusy looks for.
$script:LimpetCodexSharedFolders = @('sessions', 'archived_sessions', 'thread-writer-locks')

function Test-LimpetCodexBusy([string]$CodexHome) {
    # Is a chat open in this home right now? Codex holds
    # thread-writer-locks/<thread>.lock open while a thread is loaded and
    # deletes it after, so a lock file that can't be opened exclusively is in
    # use. Once the folder is shared there is nothing home-specific to see.
    $locks = Join-Path $CodexHome 'thread-writer-locks'
    $item = Get-Item -LiteralPath $locks -Force -ErrorAction SilentlyContinue
    if (-not $item -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
    foreach ($f in @(Get-ChildItem -LiteralPath $locks -File -Filter '*.lock' -Force -ErrorAction SilentlyContinue)) {
        try { [IO.File]::Open($f.FullName, 'Open', 'Read', 'None').Dispose() }
        catch { return $true }
    }
    return $false
}

function Test-LimpetHardLinked([string]$A, [string]$B) {
    # Are $A and $B one file under two names?
    $item = Get-Item -LiteralPath $A -Force -ErrorAction SilentlyContinue
    if (-not $item -or $item.LinkType -ne 'HardLink') { return $false }
    $names = @($item.Target | Where-Object { $_ })
    if (-not $names.Count) {
        # Windows PowerShell lists a hard link's other names; pwsh 7 doesn't.
        $drive = Split-Path -Qualifier $item.FullName
        $names = @(fsutil hardlink list $item.FullName 2>$null | ForEach-Object { "$drive$_" })
    }
    foreach ($n in $names) { if (Test-LimpetSamePath $n $B) { return $true } }
    return $false
}

function Read-LimpetLines([string]$Path) {
    # A text file's non-empty lines, read without blocking a writer that has it open.
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite, Delete')
    try { $text = (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd() }
    finally { $fs.Dispose() }
    return @($text -split "`r?`n" | Where-Object { $_.Trim() })
}

function Connect-LimpetCodexIndex {
    # Share thread names: <home>/session_index.jsonl becomes a hard link to the
    # hub's. Codex only appends to that file and a thread's last line wins, so
    # this home's own names are appended to the hub's first -- just the ones
    # newer than the hub's name for that thread, oldest first.
    param([string]$CodexHome, [string]$Hub, [string]$Stamp)
    $hubFile = Join-Path $Hub 'session_index.jsonl'
    $file = Join-Path $CodexHome 'session_index.jsonl'
    if (-not (Test-Path -LiteralPath $hubFile)) { New-Item -ItemType File -Force -Path $hubFile | Out-Null }
    if (Test-LimpetHardLinked $file $hubFile) { return $true }
    $when = {
        param($line)
        $t = [DateTimeOffset]::MinValue
        if ($line -match '"updated_at"\s*:\s*"([^"]+)"') {
            [void][DateTimeOffset]::TryParse($Matches[1], [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$t)
        }
        $t
    }
    $idOf = { param($line) if ($line -match '"id"\s*:\s*"([^"]+)"') { $Matches[1] } else { '' } }
    $aside = "$file.migrating-$Stamp"
    try {
        if (Test-Path -LiteralPath $file) {
            $hubLines = Read-LimpetLines $hubFile
            $seen = New-Object 'System.Collections.Generic.HashSet[string]'
            $latest = @{}
            foreach ($line in $hubLines) {
                [void]$seen.Add($line)
                $id = & $idOf $line; $t = & $when $line
                if (-not $latest.ContainsKey($id) -or $t -gt $latest[$id]) { $latest[$id] = $t }
            }
            $new = @(Read-LimpetLines $file | Where-Object {
                    -not $seen.Contains($_) -and (-not $latest.ContainsKey((& $idOf $_)) -or (& $when $_) -gt $latest[(& $idOf $_)]) } |
                Sort-Object { & $when $_ })
            if ($new.Count) {
                $text = ($new -join "`n") + "`n"
                $size = (Get-Item -LiteralPath $hubFile -Force).Length
                if ($size -gt 0) {
                    $fs = [IO.File]::Open($hubFile, 'Open', 'Read', 'ReadWrite, Delete')
                    try { [void]$fs.Seek(-1, 'End'); if ($fs.ReadByte() -ne 10) { $text = "`n$text" } } finally { $fs.Dispose() }
                }
                [IO.File]::AppendAllText($hubFile, $text, (New-Object Text.UTF8Encoding($false)))
            }
            Rename-Item -LiteralPath $file -NewName (Split-Path -Leaf $aside) -ErrorAction Stop
        }
        New-Item -ItemType HardLink -Path $file -Target $hubFile -ErrorAction Stop | Out-Null
        Remove-Item -LiteralPath $aside -Force -ErrorAction SilentlyContinue
        return $true
    }
    catch {
        if (-not (Test-Path -LiteralPath $file) -and (Test-Path -LiteralPath $aside)) { Rename-Item -LiteralPath $aside -NewName (Split-Path -Leaf $file) -ErrorAction SilentlyContinue }
        Write-Warning "limpet: couldn't share thread names from $file ($($_.Exception.Message)); they'll be retried next launch."
        return $false
    }
}

function Set-LimpetCodexSqliteHome {
    # Point this home's sqlite state at the hub's: `sqlite_home` in its
    # config.toml (a top-level key, so it goes above the first [table]).
    # That state holds the thread index the resume picker lists, so without
    # it each account would still list only the threads it indexed itself.
    # Returns 'set' when just added, 'ok' when already there, $null when the
    # config names some other place (left alone, with a warning).
    param([string]$CodexHome, [string]$Hub)
    $config = Join-Path $CodexHome 'config.toml'
    $raw = if (Test-Path -LiteralPath $config) { [IO.File]::ReadAllText($config) } else { '' }
    $top = ($raw -split '(?m)^\s*\[', 2)[0]
    if ($top -match '(?m)^\s*sqlite_home\s*=\s*(?:''([^'']*)''|"((?:[^"\\]|\\.)*)")') {
        $value = if ($Matches[1]) { $Matches[1] } else { $Matches[2] -replace '\\(.)', '$1' }
        if (Test-LimpetSamePath $value $Hub) { return 'ok' }
        Write-Warning "limpet: $config already sets sqlite_home to '$value'; leaving it alone, so that account lists only its own threads in /resume."
        return $null
    }
    $nl = if ($raw -match "`r`n") { "`r`n" } else { "`n" }
    $quoted = '"' + ($Hub -replace '\\', '\\' -replace '"', '\"') + '"'
    $line = "# limpet: share plain codex's thread index (/resume list) and other state$nl" + "sqlite_home = $quoted$nl"
    [IO.File]::WriteAllText($config, $line + $(if ($raw) { $nl + $raw } else { '' }), (New-Object Text.UTF8Encoding($false)))
    return 'set'
}

function Update-LimpetCodexThreadIndex {
    # Get threads that were moved into the hub from another account into the
    # shared thread index. Codex only indexes a rollout when it writes it, or
    # when a thread listing that scans the sessions folder comes across one
    # it lacks, so ask `codex app-server` for such a listing, every page of
    # it, active and archived. Returns $true when it got to the end.
    param([string]$Hub, [int]$TimeoutSec = 180)
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $env:ComSpec
    $psi.Arguments = '/d /c codex app-server'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $psi.EnvironmentVariables['CODEX_HOME'] = $Hub
    $psi.EnvironmentVariables.Remove('CODEX_SQLITE_HOME')
    $proc = [Diagnostics.Process]::Start($psi)
    $null = $proc.StandardError.ReadToEndAsync()   # drain it so the server never blocks on it
    # Windows PowerShell's Process sends a UTF-8 byte-order mark down stdin as
    # it starts, which would spoil the first message. Start with an empty
    # line for it to spoil (the server logs it and reads on), then write
    # without one.
    $stdin = New-Object IO.StreamWriter($proc.StandardInput.BaseStream, (New-Object Text.UTF8Encoding($false)))
    $stdin.NewLine = "`n"
    $stdin.WriteLine()
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $rpc = @{ id = 0 }
    $call = {
        param($method, $params)
        $id = ++$rpc.id
        $stdin.WriteLine((@{ id = $id; method = $method; params = $params } | ConvertTo-Json -Compress -Depth 5))
        $stdin.Flush()
        while ($true) {
            $left = [int]($deadline - (Get-Date)).TotalMilliseconds
            if ($left -le 0) { throw 'timed out' }
            $read = $proc.StandardOutput.ReadLineAsync()
            if (-not $read.Wait($left)) { throw 'timed out' }
            if ($null -eq $read.Result) { throw 'codex app-server exited' }
            try { $msg = $read.Result | ConvertFrom-Json } catch { continue }
            if ($msg.id -ne $id) { continue }
            if ($msg.error) { throw "$method failed: $($msg.error.message)" }
            return $msg.result
        }
    }
    $list = {
        # Every thread, active and archived: from the index alone, or by
        # scanning the sessions folder (which indexes what it finds).
        param([bool]$IndexOnly)
        foreach ($archived in $false, $true) {
            $cursor = $null
            do {
                $params = @{ sortKey = 'updated_at'; archived = $archived; limit = 100; useStateDbOnly = $IndexOnly }
                if ($cursor) { $params.cursor = $cursor }
                $page = & $call 'thread/list' $params
                $page.data
                $cursor = $page.nextCursor
            } while ($cursor)
        }
    }
    try {
        $null = & $call 'initialize' @{ clientInfo = @{ name = 'limpet'; version = '0.1.0' } }
        $stdin.WriteLine('{"method":"initialized","params":{}}')
        $null = & $list $false
        # The picker shows a thread's name from the index, and indexing a
        # moved-in thread from its file leaves that blank. Fill each blank in
        # from session_index.jsonl (last line wins) through Codex's own rename,
        # which keeps the thread's place in the list.
        $names = @{}
        foreach ($line in (Read-LimpetLines (Join-Path $Hub 'session_index.jsonl'))) {
            try { $e = $line | ConvertFrom-Json } catch { continue }
            if ($e.id -and $e.thread_name) { $names[[string]$e.id] = [string]$e.thread_name }
        }
        foreach ($t in @(& $list $true)) {
            $name = $names[[string]$t.id]
            if ($name -and -not $t.name) { $null = & $call 'thread/name/set' @{ threadId = $t.id; name = $name } }
        }
        return $true
    }
    catch {
        Write-Warning "limpet: couldn't get Codex to index the threads moved into $Hub ($($_.Exception.Message)); it'll be retried next launch."
        return $false
    }
    finally {
        try { $stdin.Close() } catch { }
        if (-not $proc.WaitForExit(5000)) { & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null }
        $proc.Dispose()
    }
}

function Sync-LimpetCodexHome {
    # Wire one numbered Codex home to the hub. Returns $true when it is fully
    # shared. Leaves <hub>/.limpet-reindex when threads it brought along
    # still need to go into the shared index (Sync-LimpetCodexHistory does that).
    param([string]$CodexHome, [string]$Hub, [string]$Stamp)
    New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
    if (Test-LimpetCodexBusy $CodexHome) {
        $cmd = (Split-Path -Leaf $CodexHome) -replace '^\.codex-', 'codex'
        Write-Warning "limpet: a chat is open in $cmd right now, so its history isn't shared yet; it will be the next time $cmd starts with none open."
        return $false
    }
    $reindex = Join-Path $Hub '.limpet-reindex'
    $ownThreads = @(Get-ChildItem -LiteralPath $CodexHome -Directory -Force -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -match '^(archived_)?sessions(\.migrating-.*)?$' -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
    if ($ownThreads.Count) { New-Item -ItemType File -Force -Path $reindex | Out-Null }
    foreach ($name in $script:LimpetCodexSharedFolders) {
        $ok = Connect-LimpetSharedFolder -Link (Join-Path $CodexHome $name) -Shared (Join-Path $Hub $name) -Stamp $Stamp -Agent 'Codex' -Discard:($name -eq 'thread-writer-locks')
        if (-not $ok) { return $false }
    }
    if (-not (Connect-LimpetCodexIndex -CodexHome $CodexHome -Hub $Hub -Stamp $Stamp)) { return $false }
    $state = Set-LimpetCodexSqliteHome -CodexHome $CodexHome -Hub $Hub
    # Newly pointed at the hub: whatever this home had indexed on its own must
    # be indexed again there.
    if ($state -eq 'set' -and (Test-Path -LiteralPath (Join-Path $CodexHome 'state_5.sqlite'))) { New-Item -ItemType File -Force -Path $reindex | Out-Null }
    return [bool]$state
}

function Sync-LimpetCodexHistory {
    <#
    .SYNOPSIS
    Share plain codex's /resume history (~/.codex) with codex1, codex2, ...
    .DESCRIPTION
    Runs automatically whenever a numbered codex command launches. Each
    ~/.codex-N gets its sessions, archived_sessions and thread-writer-locks
    folders junctioned to ~/.codex's, its session_index.jsonl (thread names)
    hard-linked to ~/.codex's and `sqlite_home` in its config.toml pointed at
    ~/.codex (the thread index /resume lists from), after folding in whatever
    it had of its own; threads it brought along are then indexed in ~/.codex
    by the codex CLI. A home with a chat open is skipped with a warning and
    picked up on a later launch. Returns $true when every Codex account is
    shared.
    #>
    [CmdletBinding()]
    param(
        # Numbered Codex homes to wire up. Default: every ~/.codex-N that exists.
        [string[]]$CodexHome,
        # The home they share with.
        [string]$Hub = (Get-LimpetCodexHub)
    )
    if (-not $CodexHome) {
        $CodexHome = @(Get-LimpetAgentAccounts | Where-Object { $_.Kind -eq 'codex' -and $_.Number -gt 0 } | ForEach-Object { $_.ConfigDir })
    }
    $stamp = '{0:yyyyMMdd-HHmmss}-{1}' -f (Get-Date), ([guid]::NewGuid().ToString('N').Substring(0, 4))
    New-Item -ItemType Directory -Force -Path $Hub | Out-Null
    $ok = $true
    foreach ($dir in $CodexHome) {
        if (Test-LimpetSamePath $dir $Hub) { continue }
        if (-not (Sync-LimpetCodexHome -CodexHome $dir -Hub $Hub -Stamp $stamp)) { $ok = $false }
    }
    # Threads moved in from other homes still to be indexed: done with the
    # codex CLI, so with none installed the note just waits for one.
    $reindex = Join-Path $Hub '.limpet-reindex'
    if ((Test-Path -LiteralPath $reindex) -and (Get-LimpetCodexExe)) {
        if (Update-LimpetCodexThreadIndex -Hub $Hub) { Remove-Item -LiteralPath $reindex -Force -ErrorAction SilentlyContinue }
        else { $ok = $false }
    }
    return $ok
}

# Plain copilot's home: the history every other Copilot account shares.
function Get-LimpetCopilotHub { Join-Path (Get-LimpetAgentHome) '.copilot' }

function Test-LimpetCopilotBusy([string]$CopilotHome) {
    # Is a chat open in this home right now? Copilot marks a chat's folder
    # with inuse.<pid>.lock while a process has it open. Once the folder is
    # shared there is nothing home-specific to see.
    $state = Join-Path $CopilotHome 'session-state'
    $item = Get-Item -LiteralPath $state -Force -ErrorAction SilentlyContinue
    if (-not $item -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
    foreach ($chat in @(Get-ChildItem -LiteralPath $state -Directory -Force -ErrorAction SilentlyContinue)) {
        foreach ($mark in @(Get-ChildItem -LiteralPath $chat.FullName -Filter 'inuse.*.lock' -File -Force -ErrorAction SilentlyContinue)) {
            if ($mark.Name -match '^inuse\.(\d+)\.lock$' -and (Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue)) { return $true }
        }
    }
    return $false
}

function Sync-LimpetCopilotHistory {
    <#
    .SYNOPSIS
    Share plain copilot's /resume history (~/.copilot) with copilot1, copilot2, ...
    .DESCRIPTION
    Runs automatically whenever a numbered copilot command launches. Each
    ~/.copilot-N gets its session-state folder (one folder per chat, which
    Copilot's resume list is built from) junctioned to ~/.copilot's, after
    folding in whatever it had of its own. A home with a chat open is skipped
    with a warning and picked up on a later launch. Returns $true when every
    Copilot account is shared.
    #>
    [CmdletBinding()]
    param(
        # Numbered Copilot homes to wire up. Default: every ~/.copilot-N that exists.
        [string[]]$CopilotHome,
        # The home they share with.
        [string]$Hub = (Get-LimpetCopilotHub)
    )
    if (-not $CopilotHome) {
        $CopilotHome = @(Get-LimpetAgentAccounts | Where-Object { $_.Kind -eq 'copilot' -and $_.Number -gt 0 } | ForEach-Object { $_.ConfigDir })
    }
    $stamp = '{0:yyyyMMdd-HHmmss}-{1}' -f (Get-Date), ([guid]::NewGuid().ToString('N').Substring(0, 4))
    New-Item -ItemType Directory -Force -Path $Hub | Out-Null
    $ok = $true
    foreach ($dir in $CopilotHome) {
        if (Test-LimpetSamePath $dir $Hub) { continue }
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        if (Test-LimpetCopilotBusy $dir) {
            $cmd = (Split-Path -Leaf $dir) -replace '^\.copilot-', 'copilot'
            Write-Warning "limpet: a chat is open in $cmd right now, so its history isn't shared yet; it will be the next time $cmd starts with none open."
            $ok = $false
            continue
        }
        if (-not (Connect-LimpetSharedFolder -Link (Join-Path $dir 'session-state') -Shared (Join-Path $Hub 'session-state') -Stamp $stamp -Agent 'Copilot')) { $ok = $false }
    }
    return $ok
}

# ---------------------------------------------------------------------------
# Antigravity (agy) accounts. agy keeps its one login in Windows Credential
# Manager (generic credential "gemini:antigravity") and everything else in
# ~/.gemini, with no setting to move either. So every agy account shares the
# chats already, and limpet gives each its own login by keeping a copy of it
# in ~/.agy-N (login.dat, encrypted for this Windows user with DPAPI) and
# swapping it into Credential Manager for the length of the launch. Plain
# agy's own login is set aside in ~/.agy meanwhile and put back afterwards, so
# plain `agy` always finds its own account. Credential Manager holds one login
# at a time, so while one agy account is running another is refused.
# LIMPET_AGY_CRED_TARGET and LIMPET_AGY_PROCESS stand in for the credential
# name and agy's process name (tests).
# ---------------------------------------------------------------------------

function Get-LimpetAgyTarget { if ($env:LIMPET_AGY_CRED_TARGET) { $env:LIMPET_AGY_CRED_TARGET } else { 'gemini:antigravity' } }

function Initialize-LimpetCredentials {
    if ('LimpetCredentials' -as [type]) { return }
    Add-Type -AssemblyName System.Security
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LimpetCredentials {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDENTIAL {
        public uint Flags; public uint Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
        public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWrite(ref CREDENTIAL cred, uint flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
    const uint GENERIC = 1;
    const int ERROR_NOT_FOUND = 1168;
    // { userName, persist, blob } of a generic credential, or null if there is none.
    public static object[] Read(string target) {
        IntPtr p;
        if (!CredRead(target, GENERIC, 0, out p)) {
            int err = Marshal.GetLastWin32Error();
            if (err == ERROR_NOT_FOUND) return null;
            throw new System.ComponentModel.Win32Exception(err);
        }
        try {
            var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            var blob = new byte[c.CredentialBlobSize];
            if (blob.Length > 0) Marshal.Copy(c.CredentialBlob, blob, 0, blob.Length);
            return new object[] { c.UserName, c.Persist, blob };
        }
        finally { CredFree(p); }
    }
    public static void Write(string target, string userName, uint persist, byte[] blob) {
        var c = new CREDENTIAL { Type = GENERIC, TargetName = target, UserName = userName, Persist = persist, CredentialBlobSize = (uint)blob.Length };
        c.CredentialBlob = Marshal.AllocHGlobal(Math.Max(1, blob.Length));
        try {
            Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
            if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(c.CredentialBlob); }
    }
    public static void Delete(string target) {
        if (!CredDelete(target, GENERIC, 0)) {
            int err = Marshal.GetLastWin32Error();
            if (err != ERROR_NOT_FOUND) throw new System.ComponentModel.Win32Exception(err);
        }
    }
}
'@
}

# Which account's login is in Credential Manager now: the command noted in
# ~/.agy/active, or plain agy when there's no note.
function Get-LimpetAgyActiveFile { Join-Path (Get-LimpetAgentHome) '.agy\active' }
function Get-LimpetAgyActive {
    $file = Get-LimpetAgyActiveFile
    $cmd = if (Test-Path -LiteralPath $file) { ([IO.File]::ReadAllText($file)).Trim() } else { '' }
    if (Resolve-LimpetAgentCommand -Command $cmd) { $cmd } else { 'agy' }
}
function Set-LimpetAgyActive([string]$Command) {
    $file = Get-LimpetAgyActiveFile
    if ($Command -eq 'agy') { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue; return }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
    [IO.File]::WriteAllText($file, $Command)
}

function Get-LimpetAgyProcesses {
    $name = if ($env:LIMPET_AGY_PROCESS) { $env:LIMPET_AGY_PROCESS } else { 'agy' }
    @(Get-Process -Name $name -ErrorAction SilentlyContinue)
}

# The email in an OAuth id_token (a JWT), or ''.
function Get-LimpetJwtEmail([string]$Token) {
    try {
        $part = $Token.Split('.')[1].Replace('-', '+').Replace('_', '/')
        $part += '=' * ((4 - $part.Length % 4) % 4)
        $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part)) | ConvertFrom-Json
        if ($claims.email) { return [string]$claims.email }
    }
    catch { }
    return ''
}

function Save-LimpetAgyLogin([string]$Command) {
    # Keep the login now in Credential Manager as $Command's: login.dat
    # (DPAPI) plus account.json with just its email, for the app's menu.
    # Read back before returning $true, since the credential may be replaced
    # next. Nothing in Credential Manager (never signed in) is fine too.
    Initialize-LimpetCredentials
    $cred = [LimpetCredentials]::Read((Get-LimpetAgyTarget))
    if (-not $cred) { return $true }
    $dir = (Resolve-LimpetAgentCommand -Command $Command).ConfigDir
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $record = [ordered]@{ userName = [string]$cred[0]; persist = [uint32]$cred[1]; blob = [Convert]::ToBase64String([byte[]]$cred[2]) }
    $plain = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress))
    $sealed = [Security.Cryptography.ProtectedData]::Protect($plain, $null, 'CurrentUser')
    $file = Join-Path $dir 'login.dat'
    [IO.File]::WriteAllBytes("$file.new", $sealed)
    $check = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes("$file.new"), $null, 'CurrentUser')
    if ([Convert]::ToBase64String($check) -ne [Convert]::ToBase64String($plain)) { throw "limpet: couldn't store $Command's agy login safely." }
    Move-Item -LiteralPath "$file.new" -Destination $file -Force
    $email = ''
    try { $email = Get-LimpetJwtEmail ([Text.Encoding]::UTF8.GetString([byte[]]$cred[2]) | ConvertFrom-Json).id_token } catch { }
    [IO.File]::WriteAllText((Join-Path $dir 'account.json'), (@{ email = $email } | ConvertTo-Json -Compress))
    return $true
}

function Restore-LimpetAgyLogin([string]$Command) {
    # Put $Command's kept login into Credential Manager, or clear it so agy
    # asks to sign in when that account has none yet.
    Initialize-LimpetCredentials
    $file = Join-Path (Resolve-LimpetAgentCommand -Command $Command).ConfigDir 'login.dat'
    if (-not (Test-Path -LiteralPath $file)) { [LimpetCredentials]::Delete((Get-LimpetAgyTarget)); return }
    $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file), $null, 'CurrentUser')
    $record = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
    [LimpetCredentials]::Write((Get-LimpetAgyTarget), [string]$record.userName, [uint32]$record.persist, [Convert]::FromBase64String($record.blob))
}

function Repair-LimpetAgyLogin {
    # A launch whose shell was closed or killed while agy ran (closing its
    # limpet tab, say) never got to put plain agy's login back. Once no agy is
    # running, finish that: keep the login in Credential Manager as the
    # account that ran, and restore plain agy's. Runs as the module loads (so
    # every new tab) and before each agy launch; a no-op unless an account
    # other than plain agy is noted as active.
    if (-not (Test-Path -LiteralPath (Get-LimpetAgyActiveFile))) { return }
    $active = Get-LimpetAgyActive
    if ($active -eq 'agy' -or (Get-LimpetAgyProcesses).Count) { return }
    try {
        $null = Save-LimpetAgyLogin $active
        Restore-LimpetAgyLogin 'agy'
        Set-LimpetAgyActive 'agy'
    }
    catch { Write-Warning "limpet: couldn't put plain agy's login back after $active ($($_.Exception.Message)); it is kept in $(Split-Path -Parent (Get-LimpetAgyActiveFile))." }
}

function Enter-LimpetAgyAccount([string]$Command) {
    # Get $Command's login into Credential Manager for a launch. $false (with
    # a warning) when another agy account is running and holds it.
    try {
        Repair-LimpetAgyLogin
        $active = Get-LimpetAgyActive
        if ($active -eq $Command) { return $true }
        if ((Get-LimpetAgyProcesses).Count) {
            Write-Warning "limpet: agy is already running as $active, and agy can hold only one login at a time. Close it, then run $Command again."
            return $false
        }
        $null = Save-LimpetAgyLogin $active   # throws rather than lose it
        Restore-LimpetAgyLogin $Command
        Set-LimpetAgyActive $Command
        return $true
    }
    catch {
        Write-Warning "limpet: couldn't switch agy to $Command ($($_.Exception.Message)); nothing was changed."
        return $false
    }
}

function Exit-LimpetAgyAccount([string]$Command) {
    # After a launch: keep $Command's (possibly refreshed) login and put plain
    # agy's back. Left to the last one out if another agy of this account is
    # still running.
    for ($i = 0; $i -lt 12 -and (Get-LimpetAgyProcesses).Count; $i++) { Start-Sleep -Milliseconds 250 }
    if ((Get-LimpetAgyProcesses).Count -or (Get-LimpetAgyActive) -ne $Command) { return }
    try {
        $null = Save-LimpetAgyLogin $Command
        if ($Command -ne 'agy') {
            Restore-LimpetAgyLogin 'agy'
            Set-LimpetAgyActive 'agy'
        }
    }
    catch { Write-Warning "limpet: couldn't put plain agy's login back ($($_.Exception.Message)); it is kept in $(Split-Path -Parent (Get-LimpetAgyActiveFile)) and goes back the next time an agyN exits." }
}

# Where a shell notes which account it launched, for the limpet app:
# <dir>/<shell pid>.json. Claude Code leaves a per-process file of its own;
# the others don't, and with the history shared a chat's files no longer show
# which account wrote them. LIMPET_AGENT_RUN overrides the folder (tests).
function Get-LimpetAgentRunDir { if ($env:LIMPET_AGENT_RUN) { $env:LIMPET_AGENT_RUN } else { Join-Path $env:APPDATA 'limpet\agents' } }

function Set-LimpetAgentLaunch([string]$Command) {
    # Note that this shell is launching $Command; returns the note's path
    # ($null if it couldn't be written). Notes left by shells that were
    # closed mid-launch are cleared on the way.
    try {
        $dir = Get-LimpetAgentRunDir
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        foreach ($old in @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
            if ($old.BaseName -match '^\d+$' -and -not (Get-Process -Id ([int]$old.BaseName) -ErrorAction SilentlyContinue)) {
                Remove-Item -LiteralPath $old.FullName -Force -ErrorAction SilentlyContinue
            }
        }
        $note = Join-Path $dir "$PID.json"
        $json = '{{"cmd":"{0}","pid":{1},"startedAt":{2}}}' -f $Command, $PID, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        [IO.File]::WriteAllText($note, $json)
        return $note
    }
    catch { return $null }
}

function Invoke-LimpetAgent {
    <#
    .SYNOPSIS
    Run an agent CLI as one limpet account: claude3 -> Claude Code with
    CLAUDE_CONFIG_DIR=~/.claude-3, codex2 -> Codex with CODEX_HOME=~/.codex-2,
    copilot1 -> Copilot with COPILOT_HOME=~/.copilot-1, agy2 -> Antigravity
    with ~/.agy-2's login swapped in.
    .DESCRIPTION
    What the numbered commands call. The directory is created if missing, a
    launch first wires every account of that agent into its shared history,
    and Arguments go to the CLI untouched (`claude3 -c`, `codex2 resume <id>`).
    The env var is set for this launch only and put back afterwards, so plain
    `claude` / `codex` / `copilot` keep their usual directories; agy's login is
    put back the same way. With '--limpet-plan' among the arguments nothing is
    launched; the resolved plan is returned instead (tests).
    #>
    param(
        [Parameter(Mandatory)][string]$Command,
        [object[]]$Arguments = @()
    )
    $account = Resolve-LimpetAgentCommand -Command $Command
    if (-not $account) {
        Write-Error "limpet: '$Command' is not an agent account (claude, claude1, ..., codex, codex1, ..., agy, agy1, ..., copilot, copilot1, ...)."
        return
    }
    New-Item -ItemType Directory -Force -Path $account.ConfigDir | Out-Null
    $envName = $script:LimpetAgentKinds[$account.Kind]
    # Wire up every account of this agent, not just this one, so the plain
    # account's history is in the shared store too.
    switch ($account.Kind) {
        'claude' { Sync-LimpetClaudeHistory | Out-Null }
        'codex' { Sync-LimpetCodexHistory | Out-Null }
        'copilot' { Sync-LimpetCopilotHistory | Out-Null }
    }
    $exe = Get-LimpetAgentExe $account.Kind
    if ($Arguments -contains '--limpet-plan') {
        return [pscustomobject]@{
            Command = $Command; Kind = $account.Kind; ConfigDir = $account.ConfigDir; EnvName = $envName; Exe = $exe
            Arguments = @($Arguments | Where-Object { $_ -ne '--limpet-plan' })
        }
    }
    if (-not $exe) {
        $what = @{ claude = 'claude CLI (Claude Code)'; codex = 'codex CLI (npm i -g @openai/codex)'; agy = 'agy CLI (Antigravity)'; copilot = 'copilot CLI (npm i -g @github/copilot)' }[$account.Kind]
        Write-Warning "limpet: the $what is not on PATH. Install it, then rerun $Command."
        return
    }
    if ($account.Kind -eq 'agy' -and -not (Enter-LimpetAgyAccount $account.Command)) { return }
    $prev = if ($envName) { [Environment]::GetEnvironmentVariable($envName, 'Process') }
    $note = if ($account.Kind -ne 'claude') { Set-LimpetAgentLaunch $account.Command }
    try {
        if ($envName) { [Environment]::SetEnvironmentVariable($envName, $account.ConfigDir, 'Process') }
        & $exe @Arguments
    }
    finally {
        if ($envName) { [Environment]::SetEnvironmentVariable($envName, $prev, 'Process') }
        if ($note) { Remove-Item -LiteralPath $note -Force -ErrorAction SilentlyContinue }
        if ($account.Kind -eq 'agy') { Exit-LimpetAgyAccount $account.Command }
    }
}

# Numbered commands whose directory already exists become real functions, so
# they tab-complete and Get-Command sees them. The export list at the bottom
# picks them up.
$script:LimpetAgentFunctions = @()
foreach ($acct in @(Get-LimpetAgentAccounts | Where-Object { $_.Number -gt 0 })) {
    Set-Item -Path "function:$($acct.Command)" -Value ([scriptblock]::Create("Invoke-LimpetAgent -Command '$($acct.Command)' -Arguments `$args"))
    $script:LimpetAgentFunctions += $acct.Command
}

# Plain agy goes through the wrapper too, unlike plain claude / codex /
# copilot: it has to find its own login in Credential Manager, which an agyN
# may have swapped out, and must not start while another agy account runs.
function agy { Invoke-LimpetAgent -Command 'agy' -Arguments $args }
$script:LimpetAgentFunctions += 'agy'

# Finish any agyN launch whose shell was closed before it could put plain
# agy's login back.
try { Repair-LimpetAgyLogin } catch { }

# Any other claudeN / codexN / agyN / copilotN is caught by PowerShell's
# command-not-found hook and dispatched the same way (its directory gets
# created on first run). A hook that was already installed still sees
# everything else; both are put back on Remove-Module.
$script:LimpetPreviousCommandNotFound = $ExecutionContext.InvokeCommand.CommandNotFoundAction
$ExecutionContext.InvokeCommand.CommandNotFoundAction = {
    param($CommandName, $EventArgs)
    if ($CommandName -match '^(claude|codex|agy|copilot)[1-9]\d*$') {
        $EventArgs.CommandScriptBlock = [scriptblock]::Create("Invoke-LimpetAgent -Command '$CommandName' -Arguments `$args")
        $EventArgs.StopSearch = $true
        return
    }
    if ($script:LimpetPreviousCommandNotFound) { & $script:LimpetPreviousCommandNotFound $CommandName $EventArgs }
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
    $ExecutionContext.InvokeCommand.CommandNotFoundAction = $script:LimpetPreviousCommandNotFound
}

Export-ModuleMember -Function (@('NixLs', 'NixRm', 'NixCp', 'NixMv', 'NixCat', 'mkdir', 'touch', 'head', 'tail', 'grep', 'find', 'which', 'du', 'df', 'chmod', 'xssh', 'wput', 'peek', 'peak', 'reels', 'limpet',
    'Invoke-LimpetAgent', 'Get-LimpetAgentAccounts', 'Sync-LimpetClaudeHistory', 'Sync-LimpetCodexHistory', 'Sync-LimpetCopilotHistory',
    'Enable-LimpetHello', 'Disable-LimpetHello', 'Get-LimpetHelloStatus', 'Get-LimpetHelloPassphrase', 'Test-LimpetHelloEnrolled', 'Protect-LimpetSecret', 'Unprotect-LimpetSecret', 'Get-LimpetAskpass', 'Get-LimpetKeyPath') +
    $script:LimpetAgentFunctions)
