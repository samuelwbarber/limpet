# limpet-hello: Windows Hello-backed SSH auth.
#
# You type a host's password exactly once (at `Enable-LimpetHello`), which installs
# a limpet SSH key on that host. The key itself is encrypted on disk with a strong
# random passphrase; that passphrase is sealed with a TPM-backed Windows Hello key
# (KeyCredentialManager), so unsealing it *cryptographically* requires a Hello
# prompt (face / fingerprint / PIN). From then on `xssh user@host` just asks for
# Hello once and connects with the key.
#
# Client-side only: no server software beyond sshd, no admin, no extra deps.
#
#   Enable-LimpetHello user@host        # one-time: password -> installs Hello key
#   xssh user@host                     # thereafter: Hello -> connected
#   Disable-LimpetHello user@host       # forget a host (optionally remove remote key)

$ErrorActionPreference = 'Stop'

# --- storage layout -------------------------------------------------------
$script:LimpetHelloDir = Join-Path $env:APPDATA 'limpet\hello'
$script:LimpetKeyPath  = Join-Path $env:USERPROFILE '.ssh\limpet_ed25519'
$script:LimpetPassBlob = Join-Path $script:LimpetHelloDir 'limpet_ed25519.pass'
$script:LimpetHostsFile = Join-Path $script:LimpetHelloDir 'hosts.txt'
$script:LimpetAskpassExe = Join-Path $script:LimpetHelloDir 'limpet-askpass.exe'
$script:LimpetCredName = 'limpet_ssh_key'   # KeyCredentialManager identity name

function _Limpet-EnsureDir { if (-not (Test-Path $script:LimpetHelloDir)) { New-Item -ItemType Directory -Force -Path $script:LimpetHelloDir | Out-Null } }

# --- WinRT async plumbing -------------------------------------------------
# PowerShell can't `await`; convert WinRT IAsyncOperation<T> to a Task and block.
$script:AsTaskGeneric = $null
function _Limpet-InitAwait {
    if ($script:AsTaskGeneric) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
                       $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
}
function _Limpet-Await($op, $resultType) {
    _Limpet-InitAwait
    $m = $script:AsTaskGeneric.MakeGenericMethod($resultType)
    $task = $m.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

# --- TPM / Hello sealing --------------------------------------------------
# A KeyCredential signs data; for RSA (what Hello uses) the PKCS#1 v1.5 signature
# is deterministic, so signing a fixed challenge yields a stable secret we can use
# as AES key material. Producing the signature requires a Hello prompt.

function _Limpet-LoadWinRT {
    [Windows.Security.Credentials.KeyCredentialManager, Windows.Security.Credentials, ContentType = WindowsRuntime] | Out-Null
    [Windows.Security.Credentials.KeyCredential, Windows.Security.Credentials, ContentType = WindowsRuntime] | Out-Null
    [Windows.Security.Cryptography.CryptographicBuffer, Windows.Security.Cryptography, ContentType = WindowsRuntime] | Out-Null
}

function _Limpet-BufferToBytes($buffer) {
    $bytes = $null
    [Windows.Security.Cryptography.CryptographicBuffer]::CopyToByteArray($buffer, [ref]$bytes)
    return $bytes
}
function _Limpet-BytesToBuffer([byte[]]$bytes) {
    return [Windows.Security.Cryptography.CryptographicBuffer]::CreateFromByteArray($bytes)
}

# Get (creating if asked) the limpet Hello credential. Returns the KeyCredential or
# throws a clear error. Creation triggers a Hello enrollment prompt.
function _Limpet-GetCredential([switch]$Create) {
    _Limpet-LoadWinRT
    if ($Create) {
        $res = _Limpet-Await ([Windows.Security.Credentials.KeyCredentialManager]::RequestCreateAsync(
                    $script:LimpetCredName,
                    [Windows.Security.Credentials.KeyCredentialCreationOption]::ReplaceExisting)
                ) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
    }
    else {
        $res = _Limpet-Await ([Windows.Security.Credentials.KeyCredentialManager]::OpenAsync($script:LimpetCredName)
                ) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
    }
    if ($res.Status -ne [Windows.Security.Credentials.KeyCredentialStatus]::Success) {
        throw "Windows Hello key unavailable (status: $($res.Status)). Make sure Hello (PIN/fingerprint/face) is set up in Windows Settings."
    }
    return $res.Credential
}

# Sign a 32-byte challenge with the Hello credential -> raw signature bytes.
# Triggers a Hello prompt.
function _Limpet-Sign($credential, [byte[]]$challenge) {
    $buf = _Limpet-BytesToBuffer $challenge
    $res = _Limpet-Await ($credential.RequestSignAsync($buf)) ([Windows.Security.Credentials.KeyCredentialOperationResult])
    if ($res.Status -ne [Windows.Security.Credentials.KeyCredentialStatus]::Success) {
        throw "Windows Hello verification failed or was cancelled (status: $($res.Status))."
    }
    return _Limpet-BufferToBytes $res.Result
}

function _Limpet-Sha256([byte[]]$data) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return $sha.ComputeHash($data) } finally { $sha.Dispose() }
}
function _Limpet-Hmac([byte[]]$key, [byte[]]$data) {
    $h = New-Object System.Security.Cryptography.HMACSHA256(, $key)
    try { return $h.ComputeHash($data) } finally { $h.Dispose() }
}

# AES-256-CBC encrypt-then-MAC. Keys derived from the Hello signature.
function _Limpet-AesEncrypt([byte[]]$plain, [byte[]]$sig) {
    $encKey = _Limpet-Sha256 ($sig + [byte]1)
    $macKey = _Limpet-Sha256 ($sig + [byte]2)
    $aes = [System.Security.Cryptography.Aes]::Create()
    try {
        $aes.KeySize = 256; $aes.Key = $encKey; $aes.GenerateIV()
        $iv = $aes.IV
        $enc = $aes.CreateEncryptor()
        $ct = $enc.TransformFinalBlock($plain, 0, $plain.Length)
        $mac = _Limpet-Hmac $macKey ($iv + $ct)
        return @{ iv = $iv; ct = $ct; mac = $mac }
    } finally { $aes.Dispose() }
}
function _Limpet-AesDecrypt($parts, [byte[]]$sig) {
    $encKey = _Limpet-Sha256 ($sig + [byte]1)
    $macKey = _Limpet-Sha256 ($sig + [byte]2)
    $expect = _Limpet-Hmac $macKey ($parts.iv + $parts.ct)
    if (-not [System.Linq.Enumerable]::SequenceEqual([byte[]]$expect, [byte[]]$parts.mac)) {
        throw 'limpet-hello: integrity check failed (wrong Hello identity or tampered data).'
    }
    $aes = [System.Security.Cryptography.Aes]::Create()
    try {
        $aes.KeySize = 256; $aes.Key = $encKey; $aes.IV = $parts.iv
        $dec = $aes.CreateDecryptor()
        return $dec.TransformFinalBlock($parts.ct, 0, $parts.ct.Length)
    } finally { $aes.Dispose() }
}

# Blob format (base64 of): magic 'WX1' | challenge(32) | iv(16) | mac(32) | ct
function _Limpet-PackBlob([byte[]]$challenge, $parts) {
    $magic = [Text.Encoding]::ASCII.GetBytes('WX1')
    $all = $magic + $challenge + $parts.iv + $parts.mac + $parts.ct
    return [Convert]::ToBase64String($all)
}
function _Limpet-UnpackBlob([string]$b64) {
    $all = [Convert]::FromBase64String($b64)
    $magic = [Text.Encoding]::ASCII.GetString($all[0..2])
    if ($magic -ne 'WX1') { throw 'limpet-hello: unrecognized sealed-secret format.' }
    return @{
        challenge = $all[3..34]
        iv        = $all[35..50]
        mac       = $all[51..82]
        ct        = $all[83..($all.Length - 1)]
    }
}

# Seal arbitrary text with Hello. Creates the credential if missing.
function Protect-LimpetSecret {
    param([Parameter(Mandatory)][string]$Text, [switch]$CreateCredential)
    _Limpet-EnsureDir
    $cred = if ($CreateCredential) { _Limpet-GetCredential -Create } else { _Limpet-GetCredential }
    $challenge = New-Object byte[] 32
    ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($challenge)
    $sig = _Limpet-Sign $cred $challenge
    $plain = [Text.Encoding]::UTF8.GetBytes($Text)
    $parts = _Limpet-AesEncrypt $plain $sig
    return _Limpet-PackBlob $challenge $parts
}

# Unseal text sealed by Protect-LimpetSecret. Triggers a Hello prompt.
function Unprotect-LimpetSecret {
    param([Parameter(Mandatory)][string]$Blob)
    $cred = _Limpet-GetCredential
    $parts = _Limpet-UnpackBlob $Blob
    $sig = _Limpet-Sign $cred $parts.challenge
    $plain = _Limpet-AesDecrypt $parts $sig
    return [Text.Encoding]::UTF8.GetString($plain)
}

# --- askpass helper -------------------------------------------------------
# ssh invokes SSH_ASKPASS via CreateProcess, so it must be a real .exe (a .cmd or
# .ps1 won't work). Compile a tiny console exe that just echoes an env var. The
# secret is passed in LIMPET_ASKPASS for the lifetime of the ssh call only.
function _Limpet-EnsureAskpass {
    if (Test-Path $script:LimpetAskpassExe) { return $script:LimpetAskpassExe }
    _Limpet-EnsureDir
    $src = @'
using System;
class A { static void Main() {
    var s = Environment.GetEnvironmentVariable("LIMPET_ASKPASS");
    Console.Out.Write(s ?? "");
} }
'@
    Add-Type -TypeDefinition $src -OutputAssembly $script:LimpetAskpassExe -OutputType ConsoleApplication
    return $script:LimpetAskpassExe
}

# Public: path to the askpass exe (compiling it on first use). Also exposes the
# limpet key path, for xssh.
function Get-LimpetAskpass { _Limpet-EnsureAskpass }
function Get-LimpetKeyPath { $script:LimpetKeyPath }

# --- host enrollment registry --------------------------------------------
function _Limpet-NormalizeTarget([string]$target) { return $target.Trim().ToLowerInvariant() }
function Test-LimpetHelloEnrolled {
    param([Parameter(Mandatory)][string]$Target)
    if (-not (Test-Path $script:LimpetHostsFile)) { return $false }
    $t = _Limpet-NormalizeTarget $Target
    return (Get-Content $script:LimpetHostsFile | ForEach-Object { $_.Trim().ToLowerInvariant() }) -contains $t
}
function _Limpet-AddHost([string]$target) {
    _Limpet-EnsureDir
    if (-not (Test-LimpetHelloEnrolled $target)) { Add-Content -Path $script:LimpetHostsFile -Value (_Limpet-NormalizeTarget $target) -Encoding ascii }
}
function _Limpet-RemoveHost([string]$target) {
    if (-not (Test-Path $script:LimpetHostsFile)) { return }
    $t = _Limpet-NormalizeTarget $target
    (Get-Content $script:LimpetHostsFile | Where-Object { $_.Trim().ToLowerInvariant() -ne $t }) | Set-Content -Path $script:LimpetHostsFile -Encoding ascii
}

# --- key generation -------------------------------------------------------
# Generate the limpet key (if absent) with a strong random passphrase, and seal
# that passphrase with Hello. Returns the passphrase (plaintext, for immediate use
# during enrollment only).
function _Limpet-EnsureKey {
    if ((Test-Path $script:LimpetKeyPath) -and (Test-Path $script:LimpetPassBlob)) { return $null }
    $sshDir = Split-Path $script:LimpetKeyPath
    if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Force -Path $sshDir | Out-Null }

    # 32 random bytes -> base64 passphrase.
    $pbytes = New-Object byte[] 32
    ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($pbytes)
    $passphrase = [Convert]::ToBase64String($pbytes)

    if (Test-Path $script:LimpetKeyPath) { Remove-Item $script:LimpetKeyPath, "$($script:LimpetKeyPath).pub" -Force -ErrorAction SilentlyContinue }
    & ssh-keygen -t ed25519 -f $script:LimpetKeyPath -N $passphrase -C 'limpet-hello' -q
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $script:LimpetKeyPath)) { throw 'limpet-hello: ssh-keygen failed to create the key.' }

    Write-Host 'Sealing the key passphrase with Windows Hello...' -ForegroundColor Cyan
    $blob = Protect-LimpetSecret -Text $passphrase -CreateCredential
    # Verify the seal round-trips before we depend on it (catches any non-determinism).
    $check = Unprotect-LimpetSecret -Blob $blob
    if ($check -ne $passphrase) { throw 'limpet-hello: seal/unseal verification failed; aborting.' }
    Set-Content -Path $script:LimpetPassBlob -Value $blob -Encoding ascii
    return $passphrase
}

# Unseal the key passphrase (Hello prompt). Used by xssh.
function Get-LimpetHelloPassphrase {
    if (-not (Test-Path $script:LimpetPassBlob)) { throw 'limpet-hello: no sealed passphrase. Run Enable-LimpetHello <user@host> first.' }
    $blob = Get-Content $script:LimpetPassBlob -Raw
    return Unprotect-LimpetSecret -Blob $blob.Trim()
}

# --- public commands ------------------------------------------------------

# One-time enrollment: install the limpet key on a host (asks for its password
# once) and remember it for Hello-based connects.
function Enable-LimpetHello {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Target,   # user@host
        [int]$Port = 22
    )
    if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { Write-Error 'OpenSSH client (ssh.exe) not found.'; return }

    # Ensure key + sealed passphrase exist (may prompt Hello to create/seal).
    try { _Limpet-EnsureKey | Out-Null }
    catch { Write-Error $_; return }

    $pub = Get-Content "$($script:LimpetKeyPath).pub" -Raw
    $pub = $pub.Trim()

    Write-Host "Installing limpet key on $Target (enter the host password once)..." -ForegroundColor Cyan
    # Append our public key to the remote authorized_keys (idempotent), creating
    # ~/.ssh with correct perms. Uses the password interactively this one time.
    $remote = "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; " +
              "grep -qxF '$pub' ~/.ssh/authorized_keys || printf '%s\n' '$pub' >> ~/.ssh/authorized_keys; " +
              "echo limpet-key-installed"
    & ssh -p $Port -o PreferredAuthentications=password -o PubkeyAuthentication=no $Target $remote
    if ($LASTEXITCODE -ne 0) { Write-Error "limpet-hello: failed to install key on $Target (ssh exit $LASTEXITCODE)."; return }

    _Limpet-AddHost $Target
    Write-Host "Enrolled $Target. From now on: xssh $Target  (Windows Hello, no password)." -ForegroundColor Green
}

# Forget a host. -RemoveRemote also strips the limpet key from its authorized_keys.
function Disable-LimpetHello {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Target,
        [int]$Port = 22,
        [switch]$RemoveRemote
    )
    if ($RemoveRemote -and (Test-Path "$($script:LimpetKeyPath).pub")) {
        $pub = (Get-Content "$($script:LimpetKeyPath).pub" -Raw).Trim()
        $remote = "test -f ~/.ssh/authorized_keys && grep -vxF '$pub' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.tmp && mv ~/.ssh/authorized_keys.tmp ~/.ssh/authorized_keys; echo limpet-key-removed"
        & ssh -p $Port $Target $remote
    }
    _Limpet-RemoveHost $Target
    Write-Host "Forgot $Target." -ForegroundColor Yellow
}

function Get-LimpetHelloStatus {
    Write-Host "limpet Hello key : $(if (Test-Path $script:LimpetKeyPath) { $script:LimpetKeyPath } else { '(not created)' })"
    Write-Host "sealed passphrase: $(if (Test-Path $script:LimpetPassBlob) { 'present' } else { '(none)' })"
    Write-Host "enrolled hosts  :"
    if (Test-Path $script:LimpetHostsFile) { Get-Content $script:LimpetHostsFile | ForEach-Object { Write-Host "  $_" } }
    else { Write-Host '  (none)' }
}

Export-ModuleMember -Function Enable-LimpetHello, Disable-LimpetHello, Get-LimpetHelloStatus,
    Get-LimpetHelloPassphrase, Test-LimpetHelloEnrolled, Protect-LimpetSecret, Unprotect-LimpetSecret,
    Get-LimpetAskpass, Get-LimpetKeyPath
