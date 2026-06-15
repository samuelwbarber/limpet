# winux SSH setup helper.
# Sets up key-based auth so resilient sessions (WezTerm mux / mosh) reconnect
# without ever prompting for a password.
#
#   .\setup-ssh.ps1                          # generate key + load agent (local only)
#   .\setup-ssh.ps1 -RemoteHost me@host.com  # also install the key on that host
#
# Generating a key never overwrites an existing one. Installing on a remote
# will prompt for your password ONCE (that's the last time you'll need it).

[CmdletBinding()]
param(
    [string] $RemoteHost,
    [string] $KeyType    = 'ed25519',
    [string] $KeyPath    = (Join-Path $env:USERPROFILE '.ssh\id_ed25519'),
    [string] $Passphrase = '',
    [switch] $NoAgent
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command ssh-keygen -ErrorAction SilentlyContinue)) {
    Write-Error 'OpenSSH client not found. Install it: Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0'
    return
}

# 1. Ensure ~/.ssh exists with sane permissions
$sshDir = Split-Path $KeyPath
if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Force -Path $sshDir | Out-Null }

# 2. Generate the key only if it doesn't already exist
if (Test-Path $KeyPath) {
    Write-Host "Using existing key: $KeyPath" -ForegroundColor Yellow
}
else {
    $comment = "$env:USERNAME@$env:COMPUTERNAME winux"
    $kgArgs  = @('-t', $KeyType, '-f', $KeyPath, '-C', $comment, '-q')
    # Empty passphrase must be passed as '""' so PowerShell doesn't drop the
    # argument and make ssh-keygen prompt interactively (which would hang).
    if ([string]::IsNullOrEmpty($Passphrase)) { ssh-keygen @kgArgs -N '""' }
    else { ssh-keygen @kgArgs -N $Passphrase }
    Write-Host "Generated $KeyType key: $KeyPath" -ForegroundColor Green
}

# 3. Load the key into ssh-agent so it's offered automatically
if (-not $NoAgent) {
    try {
        $svc = Get-Service ssh-agent -ErrorAction Stop
        if ($svc.StartType -eq 'Disabled') { Set-Service ssh-agent -StartupType Manual }
        if ($svc.Status -ne 'Running')     { Start-Service ssh-agent }
        ssh-add $KeyPath 2>$null
        Write-Host 'Key added to ssh-agent.' -ForegroundColor Green
    }
    catch {
        Write-Warning "Could not configure ssh-agent automatically (often needs an elevated shell): $($_.Exception.Message)"
        Write-Warning "Run in an admin PowerShell:  Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent; ssh-add `"$KeyPath`""
    }
}

# 4. Optionally install the public key on a remote host
if ($RemoteHost) {
    Write-Host "Installing public key on $RemoteHost (you may be prompted for your password once)..." -ForegroundColor Cyan
    $remoteCmd = 'umask 077; mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys'
    Get-Content "$KeyPath.pub" | ssh $RemoteHost $remoteCmd
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Done. Test it:  ssh $RemoteHost   (should not ask for a password)" -ForegroundColor Green
    }
    else {
        Write-Warning "Key install returned exit code $LASTEXITCODE; check the host/credentials."
    }
}

# 5. Show the public key and the WezTerm snippet to wire it up
Write-Host "`nYour public key ($KeyPath.pub):" -ForegroundColor Cyan
Get-Content "$KeyPath.pub"

Write-Host "`nAdd a resilient domain to wezterm/wezterm.lua:" -ForegroundColor Cyan
@"
config.ssh_domains = {
  {
    name = 'myserver',
    remote_address = 'your.server.com',
    username = '$env:USERNAME',
    multiplexing = 'WezTerm',   -- persistent session, auto-reconnect
  },
}
"@ | Write-Host
