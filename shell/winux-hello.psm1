# winux-hello: Windows Hello-backed SSH auth.
#
# You type a host's password exactly once (at `Enable-WinuxHello`), which installs
# a winux SSH key on that host. The key itself is encrypted on disk with a strong
# random passphrase; that passphrase is sealed with a TPM-backed Windows Hello key
# (KeyCredentialManager), so unsealing it *cryptographically* requires a Hello
# prompt (face / fingerprint / PIN). From then on `xssh user@host` just asks for
# Hello once and connects with the key.
#
# Client-side only: no server software beyond sshd, no admin, no extra deps.
#
#   Enable-WinuxHello user@host        # one-time: password -> installs Hello key
#   xssh user@host                     # thereafter: Hello -> connected
#   Disable-WinuxHello user@host       # forget a host (optionally remove remote key)

$ErrorActionPreference = 'Stop'

# --- storage layout -------------------------------------------------------
$script:WinuxHelloDir = Join-Path $env:APPDATA 'winux\hello'
$script:WinuxKeyPath  = Join-Path $env:USERPROFILE '.ssh\winux_ed25519'
$script:WinuxPassBlob = Join-Path $script:WinuxHelloDir 'winux_ed25519.pass'
$script:WinuxHostsFile = Join-Path $script:WinuxHelloDir 'hosts.txt'
$script:WinuxAskpassExe = Join-Path $script:WinuxHelloDir 'winux-askpass.exe'
$script:WinuxCredName = 'winux_ssh_key'   # KeyCredentialManager identity name

function _Winux-EnsureDir { if (-not (Test-Path $script:WinuxHelloDir)) { New-Item -ItemType Directory -Force -Path $script:WinuxHelloDir | Out-Null } }

# --- WinRT async plumbing -------------------------------------------------
# PowerShell can't `await`; convert WinRT IAsyncOperation<T> to a Task and block.
$script:AsTaskGeneric = $null
function _Winux-InitAwait {
    if ($script:AsTaskGeneric) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
                       $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
}
function _Winux-Await($op, $resultType) {
    _Winux-InitAwait
    $m = $script:AsTaskGeneric.MakeGenericMethod($resultType)
    $task = $m.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

# --- TPM / Hello sealing --------------------------------------------------
# A KeyCredential signs data; for RSA (what Hello uses) the PKCS#1 v1.5 signature
# is deterministic, so signing a fixed challenge yields a stable secret we can use
# as AES key material. Producing the signature requires a Hello prompt.

function _Winux-LoadWinRT {
    [Windows.Security.Credentials.KeyCredentialManager, Windows.Security.Credentials, ContentType = WindowsRuntime] | Out-Null
    [Windows.Security.Credentials.KeyCredential, Windows.Security.Credentials, ContentType = WindowsRuntime] | Out-Null
    [Windows.Security.Cryptography.CryptographicBuffer, Windows.Security.Cryptography, ContentType = WindowsRuntime] | Out-Null
}

function _Winux-BufferToBytes($buffer) {
    $bytes = $null
    [Windows.Security.Cryptography.CryptographicBuffer]::CopyToByteArray($buffer, [ref]$bytes)
    return $bytes
}
function _Winux-BytesToBuffer([byte[]]$bytes) {
    return [Windows.Security.Cryptography.CryptographicBuffer]::CreateFromByteArray($bytes)
}

# Get (creating if asked) the winux Hello credential. Returns the KeyCredential or
# throws a clear error. Creation triggers a Hello enrollment prompt.
function _Winux-GetCredential([switch]$Create) {
    _Winux-LoadWinRT
    if ($Create) {
        $res = _Winux-Await ([Windows.Security.Credentials.KeyCredentialManager]::RequestCreateAsync(
                    $script:WinuxCredName,
                    [Windows.Security.Credentials.KeyCredentialCreationOption]::ReplaceExisting)
                ) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
    }
    else {
        $res = _Winux-Await ([Windows.Security.Credentials.KeyCredentialManager]::OpenAsync($script:WinuxCredName)
                ) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
    }
    if ($res.Status -ne [Windows.Security.Credentials.KeyCredentialStatus]::Success) {
        throw "Windows Hello key unavailable (status: $($res.Status)). Make sure Hello (PIN/fingerprint/face) is set up in Windows Settings."
    }
    return $res.Credential
}

# Sign a 32-byte challenge with the Hello credential -> raw signature bytes.
# Triggers a Hello prompt.
function _Winux-Sign($credential, [byte[]]$challenge) {
    $buf = _Winux-BytesToBuffer $challenge
    $res = _Winux-Await ($credential.RequestSignAsync($buf)) ([Windows.Security.Credentials.KeyCredentialOperationResult])
    if ($res.Status -ne [Windows.Security.Credentials.KeyCredentialStatus]::Success) {
        throw "Windows Hello verification failed or was cancelled (status: $($res.Status))."
    }
    return _Winux-BufferToBytes $res.Result
}

function _Winux-Sha256([byte[]]$data) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return $sha.ComputeHash($data) } finally { $sha.Dispose() }
}
function _Winux-Hmac([byte[]]$key, [byte[]]$data) {
    $h = New-Object System.Security.Cryptography.HMACSHA256(, $key)
    try { return $h.ComputeHash($data) } finally { $h.Dispose() }
}

# AES-256-CBC encrypt-then-MAC. Keys derived from the Hello signature.
function _Winux-AesEncrypt([byte[]]$plain, [byte[]]$sig) {
    $encKey = _Winux-Sha256 ($sig + [byte]1)
    $macKey = _Winux-Sha256 ($sig + [byte]2)
    $aes = [System.Security.Cryptography.Aes]::Create()
    try {
        $aes.KeySize = 256; $aes.Key = $encKey; $aes.GenerateIV()
        $iv = $aes.IV
        $enc = $aes.CreateEncryptor()
        $ct = $enc.TransformFinalBlock($plain, 0, $plain.Length)
        $mac = _Winux-Hmac $macKey ($iv + $ct)
        return @{ iv = $iv; ct = $ct; mac = $mac }
    } finally { $aes.Dispose() }
}
function _Winux-AesDecrypt($parts, [byte[]]$sig) {
    $encKey = _Winux-Sha256 ($sig + [byte]1)
    $macKey = _Winux-Sha256 ($sig + [byte]2)
    $expect = _Winux-Hmac $macKey ($parts.iv + $parts.ct)
    if (-not [System.Linq.Enumerable]::SequenceEqual([byte[]]$expect, [byte[]]$parts.mac)) {
        throw 'winux-hello: integrity check failed (wrong Hello identity or tampered data).'
    }
    $aes = [System.Security.Cryptography.Aes]::Create()
    try {
        $aes.KeySize = 256; $aes.Key = $encKey; $aes.IV = $parts.iv
        $dec = $aes.CreateDecryptor()
        return $dec.TransformFinalBlock($parts.ct, 0, $parts.ct.Length)
    } finally { $aes.Dispose() }
}

# Blob format (base64 of): magic 'WX1' | challenge(32) | iv(16) | mac(32) | ct
function _Winux-PackBlob([byte[]]$challenge, $parts) {
    $magic = [Text.Encoding]::ASCII.GetBytes('WX1')
    $all = $magic + $challenge + $parts.iv + $parts.mac + $parts.ct
    return [Convert]::ToBase64String($all)
}
function _Winux-UnpackBlob([string]$b64) {
    $all = [Convert]::FromBase64String($b64)
    $magic = [Text.Encoding]::ASCII.GetString($all[0..2])
    if ($magic -ne 'WX1') { throw 'winux-hello: unrecognized sealed-secret format.' }
    return @{
        challenge = $all[3..34]
        iv        = $all[35..50]
        mac       = $all[51..82]
        ct        = $all[83..($all.Length - 1)]
    }
}

# Seal arbitrary text with Hello. Creates the credential if missing.
function Protect-WinuxSecret {
    param([Parameter(Mandatory)][string]$Text, [switch]$CreateCredential)
    _Winux-EnsureDir
    $cred = if ($CreateCredential) { _Winux-GetCredential -Create } else { _Winux-GetCredential }
    $challenge = New-Object byte[] 32
    ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($challenge)
    $sig = _Winux-Sign $cred $challenge
    $plain = [Text.Encoding]::UTF8.GetBytes($Text)
    $parts = _Winux-AesEncrypt $plain $sig
    return _Winux-PackBlob $challenge $parts
}

# Unseal text sealed by Protect-WinuxSecret. Triggers a Hello prompt.
function Unprotect-WinuxSecret {
    param([Parameter(Mandatory)][string]$Blob)
    $cred = _Winux-GetCredential
    $parts = _Winux-UnpackBlob $Blob
    $sig = _Winux-Sign $cred $parts.challenge
    $plain = _Winux-AesDecrypt $parts $sig
    return [Text.Encoding]::UTF8.GetString($plain)
}

# --- askpass helper -------------------------------------------------------
# ssh invokes SSH_ASKPASS via CreateProcess, so it must be a real .exe (a .cmd or
# .ps1 won't work). Compile a tiny console exe that just echoes an env var. The
# secret is passed in WINUX_ASKPASS for the lifetime of the ssh call only.
function _Winux-EnsureAskpass {
    if (Test-Path $script:WinuxAskpassExe) { return $script:WinuxAskpassExe }
    _Winux-EnsureDir
    $src = @'
using System;
class A { static void Main() {
    var s = Environment.GetEnvironmentVariable("WINUX_ASKPASS");
    Console.Out.Write(s ?? "");
} }
'@
    Add-Type -TypeDefinition $src -OutputAssembly $script:WinuxAskpassExe -OutputType ConsoleApplication
    return $script:WinuxAskpassExe
}

# Public: path to the askpass exe (compiling it on first use). Also exposes the
# winux key path, for xssh.
function Get-WinuxAskpass { _Winux-EnsureAskpass }
function Get-WinuxKeyPath { $script:WinuxKeyPath }

# --- host enrollment registry --------------------------------------------
function _Winux-NormalizeTarget([string]$target) { return $target.Trim().ToLowerInvariant() }
function Test-WinuxHelloEnrolled {
    param([Parameter(Mandatory)][string]$Target)
    if (-not (Test-Path $script:WinuxHostsFile)) { return $false }
    $t = _Winux-NormalizeTarget $Target
    return (Get-Content $script:WinuxHostsFile | ForEach-Object { $_.Trim().ToLowerInvariant() }) -contains $t
}
function _Winux-AddHost([string]$target) {
    _Winux-EnsureDir
    if (-not (Test-WinuxHelloEnrolled $target)) { Add-Content -Path $script:WinuxHostsFile -Value (_Winux-NormalizeTarget $target) -Encoding ascii }
}
function _Winux-RemoveHost([string]$target) {
    if (-not (Test-Path $script:WinuxHostsFile)) { return }
    $t = _Winux-NormalizeTarget $target
    (Get-Content $script:WinuxHostsFile | Where-Object { $_.Trim().ToLowerInvariant() -ne $t }) | Set-Content -Path $script:WinuxHostsFile -Encoding ascii
}

# --- key generation -------------------------------------------------------
# Generate the winux key (if absent) with a strong random passphrase, and seal
# that passphrase with Hello. Returns the passphrase (plaintext, for immediate use
# during enrollment only).
function _Winux-EnsureKey {
    if ((Test-Path $script:WinuxKeyPath) -and (Test-Path $script:WinuxPassBlob)) { return $null }
    $sshDir = Split-Path $script:WinuxKeyPath
    if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Force -Path $sshDir | Out-Null }

    # 32 random bytes -> base64 passphrase.
    $pbytes = New-Object byte[] 32
    ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($pbytes)
    $passphrase = [Convert]::ToBase64String($pbytes)

    if (Test-Path $script:WinuxKeyPath) { Remove-Item $script:WinuxKeyPath, "$($script:WinuxKeyPath).pub" -Force -ErrorAction SilentlyContinue }
    & ssh-keygen -t ed25519 -f $script:WinuxKeyPath -N $passphrase -C 'winux-hello' -q
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $script:WinuxKeyPath)) { throw 'winux-hello: ssh-keygen failed to create the key.' }

    Write-Host 'Sealing the key passphrase with Windows Hello...' -ForegroundColor Cyan
    $blob = Protect-WinuxSecret -Text $passphrase -CreateCredential
    # Verify the seal round-trips before we depend on it (catches any non-determinism).
    $check = Unprotect-WinuxSecret -Blob $blob
    if ($check -ne $passphrase) { throw 'winux-hello: seal/unseal verification failed; aborting.' }
    Set-Content -Path $script:WinuxPassBlob -Value $blob -Encoding ascii
    return $passphrase
}

# Unseal the key passphrase (Hello prompt). Used by xssh.
function Get-WinuxHelloPassphrase {
    if (-not (Test-Path $script:WinuxPassBlob)) { throw 'winux-hello: no sealed passphrase. Run Enable-WinuxHello <user@host> first.' }
    $blob = Get-Content $script:WinuxPassBlob -Raw
    return Unprotect-WinuxSecret -Blob $blob.Trim()
}

# --- public commands ------------------------------------------------------

# One-time enrollment: install the winux key on a host (asks for its password
# once) and remember it for Hello-based connects.
function Enable-WinuxHello {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Target,   # user@host
        [int]$Port = 22
    )
    if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { Write-Error 'OpenSSH client (ssh.exe) not found.'; return }

    # Ensure key + sealed passphrase exist (may prompt Hello to create/seal).
    try { _Winux-EnsureKey | Out-Null }
    catch { Write-Error $_; return }

    $pub = Get-Content "$($script:WinuxKeyPath).pub" -Raw
    $pub = $pub.Trim()

    Write-Host "Installing winux key on $Target (enter the host password once)..." -ForegroundColor Cyan
    # Append our public key to the remote authorized_keys (idempotent), creating
    # ~/.ssh with correct perms. Uses the password interactively this one time.
    $remote = "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; " +
              "grep -qxF '$pub' ~/.ssh/authorized_keys || printf '%s\n' '$pub' >> ~/.ssh/authorized_keys; " +
              "echo winux-key-installed"
    & ssh -p $Port -o PreferredAuthentications=password -o PubkeyAuthentication=no $Target $remote
    if ($LASTEXITCODE -ne 0) { Write-Error "winux-hello: failed to install key on $Target (ssh exit $LASTEXITCODE)."; return }

    _Winux-AddHost $Target
    Write-Host "Enrolled $Target. From now on: xssh $Target  (Windows Hello, no password)." -ForegroundColor Green
}

# Forget a host. -RemoveRemote also strips the winux key from its authorized_keys.
function Disable-WinuxHello {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Target,
        [int]$Port = 22,
        [switch]$RemoveRemote
    )
    if ($RemoveRemote -and (Test-Path "$($script:WinuxKeyPath).pub")) {
        $pub = (Get-Content "$($script:WinuxKeyPath).pub" -Raw).Trim()
        $remote = "test -f ~/.ssh/authorized_keys && grep -vxF '$pub' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.tmp && mv ~/.ssh/authorized_keys.tmp ~/.ssh/authorized_keys; echo winux-key-removed"
        & ssh -p $Port $Target $remote
    }
    _Winux-RemoveHost $Target
    Write-Host "Forgot $Target." -ForegroundColor Yellow
}

function Get-WinuxHelloStatus {
    Write-Host "winux Hello key : $(if (Test-Path $script:WinuxKeyPath) { $script:WinuxKeyPath } else { '(not created)' })"
    Write-Host "sealed passphrase: $(if (Test-Path $script:WinuxPassBlob) { 'present' } else { '(none)' })"
    Write-Host "enrolled hosts  :"
    if (Test-Path $script:WinuxHostsFile) { Get-Content $script:WinuxHostsFile | ForEach-Object { Write-Host "  $_" } }
    else { Write-Host '  (none)' }
}

Export-ModuleMember -Function Enable-WinuxHello, Disable-WinuxHello, Get-WinuxHelloStatus,
    Get-WinuxHelloPassphrase, Test-WinuxHelloEnrolled, Protect-WinuxSecret, Unprotect-WinuxSecret,
    Get-WinuxAskpass, Get-WinuxKeyPath
