# Client-side resilient SSH. Uses the built-in Windows OpenSSH client plus your
# key, and reconnects automatically (no password) when the link drops. By
# default it runs tmux on the remote so your session survives drops; pass
# -NoTmux for a pure reconnect with no server-side requirement at all.
#
#   .\ssh-resilient.ps1 -Target root@1.2.3.4
#   .\ssh-resilient.ps1 -Target me@host -Port 2222 -Session work
#   .\ssh-resilient.ps1 -Target me@host -NoTmux        # zero server-side; fresh shell on reconnect
#
# Stop it by logging out / detaching (Ctrl+b d) for a clean exit, or Ctrl+C.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Target,   # user@host
    [int]    $Port          = 22,
    [string] $Session       = 'main',
    [string] $KeyPath       = (Join-Path $env:USERPROFILE '.ssh\id_ed25519'),
    [switch] $NoTmux,
    [int]    $RetryDelaySeconds = 2,
    [int]    $AliveInterval = 15,   # seconds between keepalive probes
    [int]    $AliveCountMax = 3     # missed probes before ssh declares the link dead
)

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Error 'OpenSSH client (ssh.exe) not found. Install: Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0'
    return
}

$sshArgs = @(
    '-o', "ServerAliveInterval=$AliveInterval",
    '-o', "ServerAliveCountMax=$AliveCountMax",
    '-o', 'TCPKeepAlive=yes',
    '-p', "$Port"
)
if (Test-Path $KeyPath) { $sshArgs += @('-i', $KeyPath) }

if ($NoTmux) {
    $sshArgs += $Target
}
else {
    # Reattach to the named session if it exists, otherwise start it.
    $remote = "tmux attach -t $Session || tmux new -s $Session"
    $sshArgs += @('-t', $Target, $remote)
}

$label = if ($NoTmux) { "$Target" } else { "$Target (tmux: $Session)" }
Write-Host "Resilient SSH -> $label" -ForegroundColor Cyan
Write-Host "Auto-reconnects on drop. Log out or detach (Ctrl+b d) to exit cleanly.`n" -ForegroundColor DarkGray

while ($true) {
    ssh @sshArgs
    $code = $LASTEXITCODE

    # 0 = clean logout or tmux detach -> stop. Anything else = dropped link -> retry.
    if ($code -eq 0) {
        Write-Host "`nSession ended cleanly." -ForegroundColor Green
        break
    }

    Write-Host "`nConnection lost (ssh exit $code). Reconnecting in $RetryDelaySeconds s... (Ctrl+C to stop)" -ForegroundColor Yellow
    Start-Sleep -Seconds $RetryDelaySeconds
}
