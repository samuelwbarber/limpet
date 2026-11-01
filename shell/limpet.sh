# limpet shell integration for macOS and Linux. Sourced by zsh (5.x) and by
# bash (3.2+, the one macOS ships), either from the user's rc file
# (install.sh adds the line) or by the limpet app through shell/rc/.
#
# This is the Unix counterpart of shell/Limpet.psm1: xssh (resilient ssh with
# the same remote helpers), wput, peek/reels/download/upload, limpet-enroll
# (an SSH key whose passphrase lives in the login Keychain), the agent
# accounts (claude1, codex2, agy1, copilot3, ... with one shared /resume
# history per agent) and the `limpet` banner. The Linux-command shims are not
# needed here: the shell is Unix already.
#
# Portability notes. Every function starts with `emulate -L sh` under zsh, so
# arrays are 0-based and unquoted expansions split the way bash does; nothing
# bash 3.2 lacks is used (no associative arrays, mapfile, ${var^^}, coproc).
# zsh-only syntax sits inside eval strings guarded by $ZSH_VERSION so bash
# never has to parse it.

if [ -n "${BASH_SOURCE:-}" ]; then
  _LIMPET_SELF=${BASH_SOURCE[0]}
else
  eval '_LIMPET_SELF=${(%):-%x}'
fi
case "$_LIMPET_SELF" in
  */*) LIMPET_SHELL_DIR=${LIMPET_SHELL_DIR:-$(cd "${_LIMPET_SELF%/*}" 2>/dev/null && pwd -P)} ;;
  *) LIMPET_SHELL_DIR=${LIMPET_SHELL_DIR:-$(pwd -P)} ;;
esac
export LIMPET_SHELL_DIR

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

_limpet_is_mac() { [ "$(uname -s 2>/dev/null)" = Darwin ]; }

# The real CLI behind a name, skipping our own functions (agy is wrapped).
_limpet_exe() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  if [ -n "${ZSH_VERSION:-}" ]; then whence -p "$1" 2>/dev/null; else type -P "$1" 2>/dev/null; fi
}

_limpet_now_ms() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  if [ -n "${EPOCHREALTIME:-}" ]; then
    local s=${EPOCHREALTIME%.*} f=${EPOCHREALTIME#*.}
    f=${f}000; printf '%s%s\n' "$s" "${f:0:3}"
  elif [ -n "${ZSH_VERSION:-}" ]; then
    eval 'zmodload zsh/datetime 2>/dev/null; local r=$EPOCHREALTIME; local s=${r%.*} f=${r#*.}; f=${f}000; printf "%s%s\n" "$s" "${f:0:3}"'
  else
    printf '%s000\n' "$(date +%s)"
  fi
}

_limpet_stamp() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  printf '%s-%04x\n' "$(date +%Y%m%d-%H%M%S)" "$(( RANDOM % 65536 ))"
}

_limpet_size() { wc -c < "$1" 2>/dev/null | tr -d ' '; }

# Canonical path of a directory, or of a file's directory plus its name.
_limpet_realpath() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local p=$1
  if [ -d "$p" ]; then (cd "$p" 2>/dev/null && pwd -P)
  else
    local d; d=$(cd "$(dirname "$p")" 2>/dev/null && pwd -P) || return 1
    printf '%s/%s\n' "$d" "$(basename "$p")"
  fi
}

_limpet_same_path() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local a b
  a=$(_limpet_realpath "$1") || a=${1%/}
  b=$(_limpet_realpath "$2") || b=${2%/}
  [ "$a" = "$b" ]
}

# The directory a symlink points at, resolved.
_limpet_link_target() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local t; t=$(readlink "$1") || return 1
  case "$t" in /*) ;; *) t=$(dirname "$1")/$t ;; esac
  _limpet_realpath "$t"
}

_limpet_sha1() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 1 | cut -d' ' -f1
  elif command -v sha1sum >/dev/null 2>&1; then sha1sum | cut -d' ' -f1
  else openssl dgst -sha1 | sed 's/.*= *//'; fi
}

_limpet_b64() { base64 | tr -d '\n'; }
_limpet_b64d() {
  local s=$1
  while [ $(( ${#s} % 4 )) -ne 0 ]; do s="$s="; done
  printf '%s' "$s" | tr '_-' '/+' | base64 --decode 2>/dev/null
}

# Where limpet keeps its own per-user files (same as the app's appData).
_limpet_config_dir() {
  if _limpet_is_mac; then printf '%s\n' "$HOME/Library/Application Support/limpet"
  else printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/limpet"; fi
}

_limpet_warn() { printf 'limpet: %s\n' "$*" >&2; }
_limpet_say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------------------
# peek / peak / reels / download / upload: the same helpers xssh injects into
# a remote session, used locally too. limpet-remote.sh is sourced with its
# bash-only bits (re-sourcing ~/.bashrc, PROMPT_COMMAND, export -f) switched
# off, so sourcing this file from ~/.bashrc can't loop.
# ---------------------------------------------------------------------------
if [ -f "$LIMPET_SHELL_DIR/limpet-remote.sh" ]; then
  _limpet_bv=${BASH_VERSION:-}
  BASH_VERSION=
  . "$LIMPET_SHELL_DIR/limpet-remote.sh"
  BASH_VERSION=$_limpet_bv
  unset _limpet_bv
fi
peak() { peek "$@"; }

# ---------------------------------------------------------------------------
# The askpass helper: ssh runs it to get a passphrase/password out of
# LIMPET_ASKPASS. It has to be executable; a copy is made where it isn't.
# ---------------------------------------------------------------------------
_limpet_askpass() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local src="$LIMPET_SHELL_DIR/limpet-askpass.sh"
  if [ -x "$src" ]; then printf '%s\n' "$src"; return 0; fi
  local dst="${TMPDIR:-/tmp}/limpet-askpass-$(id -u).sh"
  if [ ! -x "$dst" ]; then
    { printf '#!/bin/sh\n'; printf "printf '%%s' \"\${LIMPET_ASKPASS:-}\"\n"; } > "$dst" && chmod 700 "$dst"
  fi
  printf '%s\n' "$dst"
}

# ---------------------------------------------------------------------------
# limpet-enroll: password once, then a dedicated key whose passphrase lives
# in the login Keychain (macOS). On Linux the passphrase is kept in a 0600
# file instead, with a warning that it isn't sealed.
# ---------------------------------------------------------------------------
_limpet_hello_dir() { printf '%s/hello\n' "$(_limpet_config_dir)"; }
_limpet_key_path() { printf '%s\n' "${LIMPET_KEY_PATH:-$HOME/.ssh/limpet_ed25519}"; }
_limpet_hosts_file() { printf '%s/hosts.txt\n' "$(_limpet_hello_dir)"; }
_limpet_kc_service() { printf '%s\n' "${LIMPET_KEYCHAIN_SERVICE:-limpet-ssh-key}"; }

_limpet_hello_uses_keychain() { _limpet_is_mac && [ -z "${LIMPET_HELLO_FILE:-}" ]; }

_limpet_hello_pass_file() { printf '%s\n' "${LIMPET_HELLO_FILE:-$(_limpet_hello_dir)/limpet_ed25519.pass}"; }

_limpet_hello_store() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  if _limpet_hello_uses_keychain; then
    security add-generic-password -U -a "${USER:-limpet}" -s "$(_limpet_kc_service)" -w "$1" >/dev/null
  else
    local f; f=$(_limpet_hello_pass_file)
    mkdir -p "$(dirname "$f")" && (umask 077; printf '%s\n' "$1" > "$f")
    _limpet_warn "the key passphrase is kept in $f (0600). There is no Keychain here, so it is not sealed."
  fi
}

_limpet_hello_passphrase() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  if _limpet_hello_uses_keychain; then
    security find-generic-password -a "${USER:-limpet}" -s "$(_limpet_kc_service)" -w 2>/dev/null
  else
    local f; f=$(_limpet_hello_pass_file)
    [ -f "$f" ] && head -n 1 "$f"
  fi
}

_limpet_hello_has_passphrase() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  [ -n "$(_limpet_hello_passphrase)" ]
}

_limpet_hello_enrolled() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local f t; f=$(_limpet_hosts_file); t=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  [ -f "$f" ] && grep -qxF "$t" "$f"
}

_limpet_ensure_key() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local key; key=$(_limpet_key_path)
  if [ -f "$key" ] && _limpet_hello_has_passphrase; then return 0; fi
  mkdir -p "$(dirname "$key")"
  local pass; pass=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
  rm -f "$key" "$key.pub"
  ssh-keygen -t ed25519 -f "$key" -N "$pass" -C limpet -q || { _limpet_warn 'ssh-keygen failed to create the key.'; return 1; }
  _limpet_hello_store "$pass" || { _limpet_warn "couldn't keep the key passphrase."; return 1; }
  [ "$(_limpet_hello_passphrase)" = "$pass" ] || { _limpet_warn 'the kept passphrase does not read back; aborting.'; return 1; }
}

limpet-enroll() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local target='' port=22
  while [ $# -gt 0 ]; do
    case "$1" in -p|--port) port=$2; shift ;; *) target=$1 ;; esac; shift
  done
  if [ -z "$target" ]; then _limpet_warn 'usage: limpet-enroll user@host [-p port]'; return 1; fi
  command -v ssh >/dev/null 2>&1 || { _limpet_warn 'ssh not found.'; return 1; }
  _limpet_ensure_key || return 1
  local key pub; key=$(_limpet_key_path); pub=$(cat "$key.pub")
  printf 'Installing the limpet key on %s (enter the host password once)...\n' "$target"
  local remote="umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '$pub' ~/.ssh/authorized_keys || { if [ -s ~/.ssh/authorized_keys ] && [ \$(tail -c1 ~/.ssh/authorized_keys | wc -l) -eq 0 ]; then echo >> ~/.ssh/authorized_keys; fi; printf '%s\n' '$pub' >> ~/.ssh/authorized_keys; }; echo limpet-key-installed"
  ssh -p "$port" -o PreferredAuthentications=password -o PubkeyAuthentication=no "$target" "$remote" || { _limpet_warn "failed to install the key on $target."; return 1; }
  mkdir -p "$(_limpet_hello_dir)"
  _limpet_hello_enrolled "$target" || printf '%s\n' "$target" | tr '[:upper:]' '[:lower:]' >> "$(_limpet_hosts_file)"
  printf 'Enrolled %s. From now on: xssh %s  (no password).\n' "$target" "$target"
}

limpet-forget() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local target='' port=22 removeRemote=0
  while [ $# -gt 0 ]; do
    case "$1" in -p|--port) port=$2; shift ;; --remove-remote|-RemoveRemote) removeRemote=1 ;; *) target=$1 ;; esac; shift
  done
  [ -n "$target" ] || { _limpet_warn 'usage: limpet-forget user@host [--remove-remote]'; return 1; }
  local key; key=$(_limpet_key_path)
  if [ $removeRemote -eq 1 ] && [ -f "$key.pub" ]; then
    local pub; pub=$(cat "$key.pub")
    local remote="f=~/.ssh/authorized_keys; test -f \$f || { echo limpet-key-removed; exit 0; }; umask 077; { grep -vxF '$pub' \$f > \$f.tmp || true; } && cat \$f.tmp > \$f && rm -f \$f.tmp; grep -qxF '$pub' \$f || echo limpet-key-removed"
    if ssh -p "$port" "$target" "$remote" | grep -q limpet-key-removed; then printf 'Removed the limpet key from %s.\n' "$target"
    else _limpet_warn "could not confirm the limpet key was removed from $target."; fi
  fi
  local f t; f=$(_limpet_hosts_file); t=$(printf '%s' "$target" | tr '[:upper:]' '[:lower:]')
  if [ -f "$f" ]; then grep -vxF "$t" "$f" > "$f.tmp"; mv "$f.tmp" "$f"; fi
  printf 'Forgot %s.\n' "$target"
}

limpet-status() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local key f; key=$(_limpet_key_path); f=$(_limpet_hosts_file)
  printf 'limpet key      : %s\n' "$([ -f "$key" ] && printf '%s' "$key" || printf '(not created)')"
  printf 'kept passphrase : %s\n' "$(_limpet_hello_has_passphrase && printf 'present (%s)' "$(_limpet_hello_uses_keychain && printf Keychain || printf file)" || printf '(none)')"
  printf 'enrolled hosts  :\n'
  if [ -s "$f" ]; then sed 's/^/  /' "$f"; else printf '  (none)\n'; fi
}

# ---------------------------------------------------------------------------
# xssh: a drop-in for ssh that reconnects when the link drops. Same flags as
# the PowerShell one (-Raw, -NoResume, -Resume; also --raw, --no-resume,
# --resume). See shell/Limpet.psm1 for the full story; the bootstrap
# templates below are byte-identical to the ones there.
# ---------------------------------------------------------------------------
_LIMPET_TPL_RESUME='f=$(mktemp); printf %s __B64__ | base64 -d | gunzip > $f; export LIMPET_SH=$f; if command -v tmux >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then s=limpet-__VER__; if tmux has-session -t =$s 2>/dev/null; then rm -f $f; else tmux new -d -s $s bash --rcfile $f -i; fi; exec tmux attach -d -t =$s; elif command -v bash >/dev/null 2>&1; then bash --rcfile $f -i; rm -f $f; else ENV=$f sh -i; rm -f $f; fi'
_LIMPET_TPL_PLAIN='f=$(mktemp); printf %s __B64__ | base64 -d | gunzip > $f; export LIMPET_SH=$f; if command -v bash >/dev/null 2>&1; then bash --rcfile $f -i; else ENV=$f sh -i; fi; rm -f $f'

_limpet_state_file() { printf '%s/limpet-last-ssh.txt\n' "${TMPDIR:-/tmp}"; }

# Can this name be resolved right now? (The wait-for-network check.)
_limpet_resolves() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local h=$1
  [ -n "$h" ] || return 1
  case "$h" in localhost|127.*|::1) return 0 ;; esac
  if command -v getent >/dev/null 2>&1; then getent hosts "$h" >/dev/null 2>&1
  elif command -v host >/dev/null 2>&1; then host -W 2 "$h" >/dev/null 2>&1
  elif command -v nslookup >/dev/null 2>&1; then nslookup "$h" >/dev/null 2>&1
  else ping -c 1 -W 1 "$h" >/dev/null 2>&1; fi
}

xssh() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  if [ $# -eq 0 ]; then _limpet_warn 'xssh: usage is the same as ssh, e.g. xssh user@host'; return 1; fi
  local raw=0 resume=1 resumeExplicit=0 a
  local rest; rest=()
  for a in "$@"; do
    case "$a" in
      -Raw|--raw) raw=1 ;;
      -Resume|--resume) resume=1; resumeExplicit=1 ;;
      -NoResume|--no-resume) resume=0 ;;
      *) rest+=("$a") ;;
    esac
  done
  [ $raw -eq 1 ] && [ $resumeExplicit -eq 0 ] && resume=0

  local sshArgs hasAlive=0
  sshArgs=()
  for a in "${rest[@]}"; do case "$a" in *ServerAliveInterval*) hasAlive=1 ;; esac; done
  if [ $hasAlive -eq 0 ]; then sshArgs=(-o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes); fi
  sshArgs+=("${rest[@]}")

  # The destination (first bare token, skipping options and their values).
  local valueLetters='BbcDEeFIiJLlmOoPpQRSWw' hostTok='' sshPort='' tok ch val i len
  set -- "${rest[@]}"
  while [ $# -gt 0 ]; do
    tok=$1; shift
    if [ "$tok" = -- ]; then hostTok=${1:-}; break; fi
    case "$tok" in
      -?*)
        i=1; len=${#tok}
        while [ $i -lt $len ]; do
          ch=${tok:$i:1}
          case "$valueLetters" in
            *"$ch"*)
              if [ $((i + 1)) -lt $len ]; then val=${tok:$((i + 1))}; else val=${1:-}; [ $# -gt 0 ] && shift; fi
              if [ "$ch" = p ]; then sshPort=$val
              elif [ "$ch" = o ]; then
                case "$val" in *Port*) sshPort=$(printf '%s' "$val" | sed -n 's/^[[:space:]]*Port[[:space:]]*[= ][[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p') ;; esac
              fi
              break ;;
          esac
          i=$((i + 1))
        done
        continue ;;
    esac
    hostTok=$tok; break
  done
  if [ -n "$hostTok" ]; then
    { printf '%s\n' "$hostTok"; [ -n "$sshPort" ] && printf '%s\n' "$sshPort"; } > "$(_limpet_state_file)" 2>/dev/null
  fi

  # Enrolled host: the limpet key, its passphrase handed to ssh via askpass.
  local helloActive=0 passCached=0 secret='' helper=''
  if [ -n "$hostTok" ] && _limpet_hello_enrolled "$hostTok" && [ -f "$(_limpet_key_path)" ]; then
    secret=$(_limpet_hello_passphrase)
    if [ -n "$secret" ]; then
      printf 'xssh: using the limpet key (Keychain)...\n'
      helper=$(_limpet_askpass)
      sshArgs=(-i "$(_limpet_key_path)" -o IdentitiesOnly=yes -o PreferredAuthentications=publickey -o StrictHostKeyChecking=accept-new "${sshArgs[@]}")
      helloActive=1
    else
      printf 'xssh: the limpet key passphrase could not be read; falling back to normal auth.\n'
    fi
  fi

  # Password auto-reconnect: capture it once if key/agent auth doesn't work.
  if [ $helloActive -eq 0 ] && [ -n "$hostTok" ] && [ "${LIMPET_NO_PWCACHE:-}" != 1 ]; then
    if ! ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "${sshArgs[@]}" true >/dev/null 2>&1; then
      printf 'xssh: password for %s (cached for auto-reconnect): ' "$hostTok" >&2
      # No `read -s`: zsh's blocks when stdin isn't a terminal. stty does the hiding.
      if [ -t 0 ]; then stty -echo 2>/dev/null; IFS= read -r secret; stty echo 2>/dev/null; else IFS= read -r secret; fi
      printf '\n' >&2
      if [ -n "$secret" ]; then helper=$(_limpet_askpass); passCached=1; fi
    fi
  fi

  # The remote helpers, sent fresh each connect (nothing persisted there).
  local integrated=0 scriptPath="$LIMPET_SHELL_DIR/limpet-remote.sh"
  if [ $raw -eq 0 ] && [ -f "$scriptPath" ]; then
    local tmp b64 ver tpl
    tmp=$(mktemp "${TMPDIR:-/tmp}/limpet-boot.XXXXXX")
    {
      case "${LIMPET_TOKEN:-}" in ????????????????????????????????) printf 'LIMPET_TOKEN=%s\n' "$LIMPET_TOKEN" ;; esac
      cat "$scriptPath"
    } > "$tmp"
    b64=$(gzip -c -n < "$tmp" | _limpet_b64)
    ver=$(_limpet_sha1 < "$tmp" | cut -c1-12)
    rm -f "$tmp"
    if [ $resume -eq 1 ]; then tpl=$_LIMPET_TPL_RESUME; else tpl=$_LIMPET_TPL_PLAIN; fi
    tpl=${tpl/__B64__/$b64}
    tpl=${tpl/__VER__/$ver}
    sshArgs=(-t "${sshArgs[@]}" "$tpl")
    integrated=1
  elif [ $resume -eq 1 ]; then
    sshArgs=(-t "${sshArgs[@]}" 'if command -v tmux >/dev/null 2>&1; then tmux new -A -D -s limpet; else exec ${SHELL:-sh} -il; fi')
  fi

  printf '\033[90mxssh: resilient ssh (auto-reconnect on drop; Ctrl+C to stop)\033[0m\n'
  [ $helloActive -eq 1 ] && printf '\033[90m      auth: limpet key (passphrase from the Keychain)\033[0m\n'
  [ $passCached -eq 1 ] && printf "\033[90m      auth: password cached this session -- reconnects won't re-prompt\033[0m\n"
  [ $resume -eq 1 ] && printf "\033[90m      session: kept alive in remote tmux 'limpet' -- reconnects resume where you left off (-NoResume to skip)\033[0m\n"
  [ $integrated -eq 1 ] && printf '\033[90m      in-session: peek <img> | download <file> | upload <pc-path> | reels [url]\033[0m\n'

  local dnsHost=${hostTok##*@} hadSession=0 tellApp=0 code start elapsed waited
  case "${LIMPET_TOKEN:-}" in ????????????????????????????????) [ -n "$hostTok" ] && tellApp=1 ;; esac
  if [ $tellApp -eq 1 ]; then printf '\033]5379;xssh;%s;%s;%s\007' "$(printf '%s' "$hostTok" | _limpet_b64)" "$sshPort" "$LIMPET_TOKEN"; fi
  while :; do
    start=$(date +%s)
    if [ -n "$helper" ]; then
      # A subshell, so the secret is in ssh's environment and nowhere else
      # (zsh keeps a `VAR=x cmd` prefix when cmd is a function).
      ( LIMPET_ASKPASS=$secret; SSH_ASKPASS=$helper; SSH_ASKPASS_REQUIRE=force
        export LIMPET_ASKPASS SSH_ASKPASS SSH_ASKPASS_REQUIRE
        ssh "${sshArgs[@]}" )
    else
      ssh "${sshArgs[@]}"
    fi
    code=$?
    elapsed=$(( $(date +%s) - start ))
    [ $code -eq 0 ] && break
    [ $elapsed -ge 5 ] && hadSession=1
    if [ $elapsed -lt 5 ]; then
      if [ $hadSession -eq 0 ]; then
        printf '\033[31m[xssh] connection exited immediately (code %s): host/auth error, not a drop. Stopping.\033[0m\n' "$code"
        break
      fi
      printf "\033[33m[xssh] can't reach %s -- waiting for network... (Ctrl+C to stop)\033[0m\n" "$dnsHost"
      waited=0
      while [ $waited -lt 60 ]; do
        sleep 3; waited=$((waited + 3))
        _limpet_resolves "$dnsHost" && break
      done
      continue
    fi
    printf '\n\033[33m[xssh] link dropped (exit %s) -- reconnecting in 2s... (Ctrl+C to stop)\033[0m\n' "$code"
    sleep 2
  done
  if [ $tellApp -eq 1 ]; then printf '\033]5379;xssh;;;%s\007' "$LIMPET_TOKEN"; fi
  secret=''
  return 0
}

# ---------------------------------------------------------------------------
# wput: client-side scp to a remote dir, defaulting to the last xssh host.
#     wput report.pdf | wput ./build -Dest /var/www | wput a b -To me@host -Port 2222
# ---------------------------------------------------------------------------
wput() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local files to='' dest='' port=22 portSet=0 key="$HOME/.ssh/id_ed25519" f
  files=()
  while [ $# -gt 0 ]; do
    case "$1" in
      -To|--to) to=$2; shift ;;
      -Dest|--dest) dest=$2; shift ;;
      -Port|--port) port=$2; portSet=1; shift ;;
      -Key|--key) key=$2; shift ;;
      *) files+=("$1") ;;
    esac
    shift
  done
  if [ ${#files[@]} -eq 0 ]; then _limpet_warn 'wput: no files. Usage: wput <files> [-To user@host] [-Dest /remote/dir] [-Port N] [-Key path]'; return 1; fi
  if [ -z "$to" ] && [ -f "$(_limpet_state_file)" ]; then
    to=$(sed -n '1p' "$(_limpet_state_file)" | tr -d '[:space:]')
    if [ $portSet -eq 0 ]; then
      local p2; p2=$(sed -n '2p' "$(_limpet_state_file)" | tr -d '[:space:]')
      [ -n "$p2" ] && port=$p2
    fi
  fi
  if [ -z "$to" ]; then _limpet_warn 'wput: no target. Pass -To user@host, or connect with xssh first so wput can reuse that host.'; return 1; fi
  for f in "${files[@]}"; do
    [ -e "$f" ] || { _limpet_warn "wput: local path not found: $f"; return 1; }
  done
  local scpArgs; scpArgs=(-r -P "$port")
  [ -f "$key" ] && scpArgs+=(-i "$key")
  printf '\033[36mwput -> %s:%s\033[0m\n' "$to" "${dest:-~}"
  scp "${scpArgs[@]}" "${files[@]}" "$to:$dest"
  local rc=$?
  if [ $rc -eq 0 ]; then printf '\033[32mUploaded %s item(s).\033[0m\n' "${#files[@]}"
  else printf '\033[31mwput: scp exited with code %s\033[0m\n' "$rc"; fi
  return $rc
}

# ---------------------------------------------------------------------------
# Branding
# ---------------------------------------------------------------------------
limpet() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local logo="$LIMPET_SHELL_DIR/limpet-logo.txt" letters line li c prev art px2 row i n
  letters=()
  if [ -f "$logo" ]; then
    while IFS= read -r line || [ -n "$line" ]; do letters+=("$line"); done < "$logo"
  fi
  art=('.......LL.......' '......BBBB......' '.....BBLLBB.....' '....BBBLLBBB....' '...BBLBLLBLBB...'
       '..BBLBBLLBBLBB..' '.BBLBBBLLBBBLBB.' '.BBBBBBBBBBBBBB.' '..PRPKPPPPKPRP..' '...PPPPKKPPPP...')
  px2=$(printf '\342\226\210\342\226\210')
  if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then
    printf '\n'
    i=0
    for row in "${art[@]}"; do
      line='  '; prev=''; n=0
      while [ $n -lt ${#row} ]; do
        c=${row:$n:1}; n=$((n + 1))
        if [ "$c" = . ]; then line="$line  "; continue; fi
        if [ "$prev" != "$c" ]; then
          case "$c" in
            B) line="$line"$'\033[38;2;137;180;250m' ;; L) line="$line"$'\033[38;2;180;190;254m' ;;
            P) line="$line"$'\033[38;2;250;179;135m' ;; K) line="$line"$'\033[38;2;49;50;68m' ;;
            R) line="$line"$'\033[38;2;243;139;168m' ;;
          esac
          prev=$c
        fi
        line="$line$px2"
      done
      line="$line"$'\033[0m'
      li=$((i - 3))
      if [ $li -ge 0 ] && [ $li -lt ${#letters[@]} ]; then line="$line   "$'\033[38;2;137;220;235m'"${letters[$li]}"$'\033[0m'; fi
      printf '%s\n' "$line"
      i=$((i + 1))
    done
  else
    for line in "${letters[@]}"; do printf '%s\n' "$line"; done
  fi
  printf '\n'
  printf '\033[37m  Your shell, with SSH that does not drop.\033[0m\n'
  printf '\033[90m  Resilient: xssh user@host   (drop-in for ssh, auto-reconnects)\033[0m\n'
  printf '\033[90m  Key auth : limpet-enroll user@host  (password once, then a Keychain-kept key)\033[0m\n'
  printf '\033[90m  Upload   : wput <files>     (client-side scp to your last xssh host)\033[0m\n'
  printf '\033[90m  Images   : peek <file>      (show an image inline)\033[0m\n'
  printf '\033[90m  Reels    : reels [url]      (dock a page on the right; default Instagram reels)\033[0m\n'
  printf '\033[90m  Agents   : claude1, ... / codex1, ... / agy1, ... / copilot1, ... (separate logins; one /resume history per agent)\033[0m\n'
  printf '\033[90m  Docs     : see README.md / docs/COMMANDS.md\033[0m\n'
}

# ---------------------------------------------------------------------------
# Agent accounts: claudeN / codexN / agyN / copilotN, one /resume history
# per agent. See Limpet.psm1 for the full description; the mechanics here
# are symlinks and hard links instead of junctions.
# ---------------------------------------------------------------------------
_LIMPET_KINDS='claude codex agy copilot'

_limpet_env_name() {
  case "$1" in claude) printf CLAUDE_CONFIG_DIR ;; codex) printf CODEX_HOME ;; copilot) printf COPILOT_HOME ;; esac
}

_limpet_agent_home() { printf '%s\n' "${LIMPET_AGENT_HOME:-$HOME}"; }

_limpet_is_number() { case "$1" in ''|*[!0-9]*|0*) return 1 ;; esac; return 0; }

# The numbers of a kind's accounts under a home, ascending, one per line.
_limpet_account_numbers() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local kind=$1 home=$2 d n
  for d in "$home"/."$kind"-*; do
    [ -d "$d" ] || continue
    n=${d##*/."$kind"-}
    _limpet_is_number "$n" && printf '%s\n' "$n"
  done | sort -n -u
}

# Every account: "<cmd> <kind> <number> <configDir>" per line, plain ones first.
limpet_agent_accounts() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local home=${1:-$(_limpet_agent_home)} kind n
  for kind in $_LIMPET_KINDS; do
    printf '%s %s 0 %s\n' "$kind" "$kind" "$home/.$kind"
    for n in $(_limpet_account_numbers "$kind" "$home"); do
      printf '%s%s %s %s %s\n' "$kind" "$n" "$kind" "$n" "$home/.$kind-$n"
    done
  done
}

# Resolve a command name into _LR_CMD/_LR_KIND/_LR_N/_LR_DIR; 1 if not an account.
_limpet_resolve() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local cmd=$1 home=${2:-$(_limpet_agent_home)} kind n
  _LR_CMD=''; _LR_KIND=''; _LR_N=''; _LR_DIR=''
  for kind in $_LIMPET_KINDS; do
    case "$cmd" in
      "$kind") _LR_CMD=$cmd; _LR_KIND=$kind; _LR_N=0; _LR_DIR="$home/.$kind"; return 0 ;;
      "$kind"*)
        n=${cmd#"$kind"}
        if _limpet_is_number "$n"; then _LR_CMD=$cmd; _LR_KIND=$kind; _LR_N=$n; _LR_DIR="$home/.$kind-$n"; return 0; fi ;;
    esac
  done
  return 1
}

_limpet_is_account() { _limpet_resolve "$1" >/dev/null 2>&1; }

# ---- shared folders ---------------------------------------------------------

# Move everything under $1 into $2 (recursing into folders on both sides).
# Same-name files: identical, or one a prefix of the other -> the longer one
# keeps the name; otherwise the larger keeps the name and the other is kept
# as <name>.conflict-<stamp>. Adds anything that couldn't be moved to
# _LIMPET_LEFT. Empties and removes $1.
_limpet_merge_dir() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local src=$1 dest=$2 stamp=$3 item name target a b common t1 t2
  mkdir -p "$dest" || { _LIMPET_LEFT=$((_LIMPET_LEFT + 1)); return; }
  for item in "$src"/* "$src"/.[!.]* "$src"/..?*; do
    [ -e "$item" ] || [ -L "$item" ] || continue
    name=${item##*/}; target="$dest/$name"
    if [ -d "$item" ] && [ ! -L "$item" ]; then
      if [ -e "$target" ]; then _limpet_merge_dir "$item" "$target" "$stamp"
      else mv "$item" "$target" 2>/dev/null || _LIMPET_LEFT=$((_LIMPET_LEFT + 1)); fi
      continue
    fi
    if [ ! -e "$target" ] && [ ! -L "$target" ]; then
      mv "$item" "$target" 2>/dev/null || _LIMPET_LEFT=$((_LIMPET_LEFT + 1))
      continue
    fi
    a=$(_limpet_size "$item"); b=$(_limpet_size "$target")
    if [ "$a" -lt "$b" ]; then common=$a; else common=$b; fi
    t1=$(mktemp "${TMPDIR:-/tmp}/limpet-cmp.XXXXXX"); t2=$(mktemp "${TMPDIR:-/tmp}/limpet-cmp.XXXXXX")
    head -c "$common" "$item" > "$t1"; head -c "$common" "$target" > "$t2"
    if cmp -s "$t1" "$t2"; then
      # Duplicate, or one continues the other: keep the longer.
      if [ "$a" -gt "$b" ]; then mv -f "$item" "$target" 2>/dev/null || _LIMPET_LEFT=$((_LIMPET_LEFT + 1))
      else rm -f "$item" 2>/dev/null || _LIMPET_LEFT=$((_LIMPET_LEFT + 1)); fi
    elif [ "$a" -gt "$b" ]; then
      mv "$target" "$dest/$name.conflict-$stamp" && mv "$item" "$target" || _LIMPET_LEFT=$((_LIMPET_LEFT + 1))
    else
      mv "$item" "$dest/$name.conflict-$stamp" 2>/dev/null || _LIMPET_LEFT=$((_LIMPET_LEFT + 1))
    fi
    rm -f "$t1" "$t2"
  done
  rmdir "$src" 2>/dev/null
}

# Make $1 a symlink to $2 (folding a real folder there into $2 first).
# $3 stamp, $4 agent name for warnings, $5 'discard' to delete rather than
# merge what was there (lock folders). Returns 0 when fully shared.
_limpet_connect_shared() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local link=$1 shared=$2 stamp=$3 agent=$4 discard=${5:-} parent leaf target stage ok=0
  parent=$(dirname "$link"); leaf=$(basename "$link")
  mkdir -p "$parent" "$shared" || return 1
  if [ -L "$link" ]; then
    target=$(_limpet_link_target "$link")
    if [ -z "$target" ] || ! _limpet_same_path "$target" "$shared"; then
      _limpet_warn "$link already links to '$(readlink "$link")', not the shared store; leaving it alone (history not synced for this account)."
      return 1
    fi
  elif [ -e "$link" ]; then
    mv "$link" "$parent/$leaf.migrating-$stamp" || {
      _limpet_warn "couldn't move $link aside. Is a $agent session open there? History isn't synced for this account yet; it'll be retried next launch."
      return 1
    }
  fi
  if [ ! -e "$link" ] && [ ! -L "$link" ]; then
    ln -s "$shared" "$link" || { _limpet_warn "couldn't create the link $link -> $shared; history not synced for this account."; return 1; }
  fi
  for stage in "$parent/$leaf".migrating-*; do
    [ -d "$stage" ] || continue
    if [ "$discard" = discard ]; then rm -rf "$stage"; continue; fi
    _LIMPET_LEFT=0
    _limpet_merge_dir "$stage" "$shared" "$stamp"
    if [ "$_LIMPET_LEFT" -gt 0 ]; then
      _limpet_warn "$_LIMPET_LEFT item(s) under $stage couldn't be moved into the shared store. They'll be folded in next launch."
      ok=1
    fi
  done
  return $ok
}

# ---- Claude: every account's projects/ -> ~/.claude-shared/projects ----------
limpet_sync_claude_history() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local home shared='' dirs dir stamp ok=0 n
  home=$(_limpet_agent_home)
  dirs=()
  while [ $# -gt 0 ]; do
    case "$1" in --shared|-Shared) shared=$2; shift ;; *) dirs+=("$1") ;; esac; shift
  done
  [ -n "$shared" ] || shared="$home/.claude-shared/projects"
  if [ ${#dirs[@]} -eq 0 ]; then
    dirs+=("$home/.claude")
    for n in $(_limpet_account_numbers claude "$home"); do dirs+=("$home/.claude-$n"); done
  fi
  stamp=$(_limpet_stamp)
  mkdir -p "$shared"
  for dir in "${dirs[@]}"; do
    _limpet_connect_shared "$dir/projects" "$shared" "$stamp" Claude || ok=1
  done
  return $ok
}

# ---- Codex: numbered homes share plain ~/.codex's history --------------------
_LIMPET_CODEX_SHARED='sessions archived_sessions thread-writer-locks'

_limpet_codex_busy() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local locks="$1/thread-writer-locks" f
  [ -d "$locks" ] && [ ! -L "$locks" ] || return 1
  command -v lsof >/dev/null 2>&1 || return 1
  for f in "$locks"/*.lock; do
    [ -f "$f" ] || continue
    if lsof -t -- "$f" >/dev/null 2>&1; then return 0; fi
  done
  return 1
}

# Share thread names: <home>/session_index.jsonl becomes a hard link to the
# hub's, after this home's newer names are appended (oldest first).
_limpet_connect_codex_index() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local home=$1 hub=$2 stamp=$3 hubFile="$2/session_index.jsonl" file="$1/session_index.jsonl" aside line id when latest new
  [ -f "$hubFile" ] || : > "$hubFile"
  if [ "$file" -ef "$hubFile" ]; then return 0; fi
  aside="$file.migrating-$stamp"
  if [ -f "$file" ]; then
    new=$(mktemp "${TMPDIR:-/tmp}/limpet-idx.XXXXXX")
    while IFS= read -r line || [ -n "$line" ]; do
      [ -n "$(printf '%s' "$line" | tr -d '[:space:]')" ] || continue
      grep -qxF -- "$line" "$hubFile" && continue
      id=$(printf '%s' "$line" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      when=$(printf '%s' "$line" | sed -n 's/.*"updated_at"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      latest=$(grep -F "\"id\":\"$id\"" "$hubFile" | sed -n 's/.*"updated_at"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sort | tail -n 1)
      if [ -z "$latest" ] || [[ "$when" > "$latest" ]]; then printf '%s\t%s\n' "$when" "$line" >> "$new"; fi
    done < "$file"
    if [ -s "$new" ]; then
      if [ -s "$hubFile" ] && [ "$(tail -c 1 "$hubFile" | od -An -c | tr -d ' ')" != '\n' ]; then printf '\n' >> "$hubFile"; fi
      sort "$new" | cut -f2- >> "$hubFile"
    fi
    rm -f "$new"
    mv "$file" "$aside" || { _limpet_warn "couldn't share thread names from $file; they'll be retried next launch."; return 1; }
  fi
  if ln "$hubFile" "$file"; then rm -f "$aside"; return 0; fi
  [ -f "$aside" ] && [ ! -e "$file" ] && mv "$aside" "$file"
  _limpet_warn "couldn't share thread names from $file; they'll be retried next launch."
  return 1
}

# Point this home's sqlite state at the hub's: `sqlite_home` at the top of
# config.toml. Prints 'set', 'ok', or nothing (another value is there).
_limpet_set_codex_sqlite_home() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local home=$1 hub=$2 config="$1/config.toml" top value tmp
  top=$([ -f "$config" ] && awk '/^[[:space:]]*\[/ { exit } { print }' "$config")
  value=$(printf '%s\n' "$top" | sed -n "s/^[[:space:]]*sqlite_home[[:space:]]*=[[:space:]]*'\([^']*\)'.*/\1/p; s/^[[:space:]]*sqlite_home[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1)
  if printf '%s\n' "$top" | grep -q '^[[:space:]]*sqlite_home[[:space:]]*='; then
    if _limpet_same_path "$value" "$hub"; then printf 'ok\n'; return 0; fi
    _limpet_warn "$config already sets sqlite_home to '$value'; leaving it alone, so that account lists only its own threads in /resume."
    return 1
  fi
  tmp=$(mktemp "${TMPDIR:-/tmp}/limpet-toml.XXXXXX")
  {
    printf "# limpet: share plain codex's thread index (/resume list) and other state\n"
    printf 'sqlite_home = "%s"\n' "$(printf '%s' "$hub" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    if [ -s "$config" ]; then printf '\n'; cat "$config"; fi
  } > "$tmp" && mv "$tmp" "$config" || { rm -f "$tmp"; return 1; }
  printf 'set\n'
}

# Ask `codex app-server` to index the threads moved into the hub (every page,
# active and archived), then name the blank ones from session_index.jsonl.
_limpet_codex_reindex() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local hub=$1 timeout=${2:-180} dir deadline rid=0 line id cursor params archived indexOnly page names n name nl
  local codexCmd="${LIMPET_CODEX_APPSERVER:-codex app-server}"
  dir=$(mktemp -d "${TMPDIR:-/tmp}/limpet-rpc.XXXXXX") || return 1
  mkfifo "$dir/in" "$dir/out" || { rm -rf "$dir"; return 1; }
  ( cd / && env -u CODEX_SQLITE_HOME CODEX_HOME="$hub" sh -c "$codexCmd" < "$dir/in" > "$dir/out" 2>/dev/null ) &
  local spid=$!
  exec 7> "$dir/in" 8< "$dir/out"
  deadline=$(( $(date +%s) + timeout ))
  _LIMPET_RPC_RESULT=''
  # _limpet_rpc <method> <params-json>: sets _LIMPET_RPC_RESULT to the reply line.
  _limpet_rpc() {
    local method=$1 p=$2 left l
    rid=$((rid + 1))
    printf '{"id":%s,"method":"%s","params":%s}\n' "$rid" "$method" "$p" >&7 || return 1
    while :; do
      left=$(( deadline - $(date +%s) ))
      [ $left -gt 0 ] || return 1
      if ! read -r -t "$left" l <&8; then return 1; fi
      case "$l" in
        *"\"id\":$rid,"*|*"\"id\":$rid}"*)
          case "$l" in *'"error"'*) return 1 ;; esac
          _LIMPET_RPC_RESULT=$l; return 0 ;;
      esac
    done
  }
  nl=$(printf '\n')
  local ok=0
  if _limpet_rpc initialize '{"clientInfo":{"name":"limpet","version":"0.1.0"}}'; then
    printf '{"method":"initialized","params":{}}\n' >&7
    for indexOnly in false true; do
      page=''
      for archived in false true; do
        cursor=''
        while :; do
          params="{\"sortKey\":\"updated_at\",\"archived\":$archived,\"limit\":100,\"useStateDbOnly\":$indexOnly"
          [ -n "$cursor" ] && params="$params,\"cursor\":\"$cursor\""
          params="$params}"
          _limpet_rpc thread/list "$params" || { ok=1; break 2; }
          [ "$indexOnly" = true ] && page="$page$_LIMPET_RPC_RESULT$nl"
          cursor=$(printf '%s' "$_LIMPET_RPC_RESULT" | sed -n 's/.*"nextCursor"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
          [ -n "$cursor" ] || break
        done
      done
    done
    if [ $ok -eq 0 ]; then
      # Blank names in the index get the latest name session_index.jsonl holds.
      names=$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*"thread_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1	\2/p' "$hub/session_index.jsonl" 2>/dev/null)
      printf '%s' "$page" | sed 's/"id":"/\
/g' | while IFS= read -r line; do
        id=${line:0:36}
        case "$id" in ????????-????-????-????-????????????) ;; *) continue ;; esac
        case "$line" in *'"name":null'*|*'"name":""'*) ;; *) continue ;; esac
        name=$(printf '%s\n' "$names" | awk -F'\t' -v id="$id" '$1 == id { n = $2 } END { print n }')
        [ -n "$name" ] || continue
        name=$(printf '%s' "$name" | sed 's/\\/\\\\/g; s/"/\\"/g')
        _limpet_rpc thread/name/set "{\"threadId\":\"$id\",\"name\":\"$name\"}" || :
      done
    fi
  else
    ok=1
  fi
  exec 7>&- 8<&-
  n=0; while kill -0 "$spid" 2>/dev/null && [ $n -lt 20 ]; do sleep 0.25; n=$((n + 1)); done
  kill -0 "$spid" 2>/dev/null && kill "$spid" 2>/dev/null
  rm -rf "$dir"
  unset -f _limpet_rpc
  [ $ok -eq 0 ] || _limpet_warn "couldn't get Codex to index the threads moved into $hub; it'll be retried next launch."
  return $ok
}

_limpet_sync_codex_home() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local home=$1 hub=$2 stamp=$3 name d reindex="$2/.limpet-reindex" state cmd
  mkdir -p "$home"
  if _limpet_codex_busy "$home"; then
    cmd=codex${home##*/.codex-}
    _limpet_warn "a chat is open in $cmd right now, so its history isn't shared yet; it will be the next time $cmd starts with none open."
    return 1
  fi
  for d in "$home"/sessions "$home"/archived_sessions "$home"/sessions.migrating-* "$home"/archived_sessions.migrating-*; do
    if [ -d "$d" ] && [ ! -L "$d" ]; then : > "$reindex"; break; fi
  done
  for name in $_LIMPET_CODEX_SHARED; do
    if [ "$name" = thread-writer-locks ]; then
      _limpet_connect_shared "$home/$name" "$hub/$name" "$stamp" Codex discard || return 1
    else
      _limpet_connect_shared "$home/$name" "$hub/$name" "$stamp" Codex || return 1
    fi
  done
  _limpet_connect_codex_index "$home" "$hub" "$stamp" || return 1
  state=$(_limpet_set_codex_sqlite_home "$home" "$hub") || return 1
  if [ "$state" = set ] && [ -f "$home/state_5.sqlite" ]; then : > "$reindex"; fi
  [ -n "$state" ]
}

limpet_sync_codex_history() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local home hub='' homes dir stamp ok=0 n reindex
  home=$(_limpet_agent_home)
  homes=()
  while [ $# -gt 0 ]; do
    case "$1" in --hub|-Hub) hub=$2; shift ;; *) homes+=("$1") ;; esac; shift
  done
  [ -n "$hub" ] || hub="$home/.codex"
  if [ ${#homes[@]} -eq 0 ]; then
    for n in $(_limpet_account_numbers codex "$home"); do homes+=("$home/.codex-$n"); done
  fi
  stamp=$(_limpet_stamp)
  mkdir -p "$hub"
  for dir in "${homes[@]}"; do
    _limpet_same_path "$dir" "$hub" && continue
    _limpet_sync_codex_home "$dir" "$hub" "$stamp" || ok=1
  done
  reindex="$hub/.limpet-reindex"
  if [ -f "$reindex" ] && { [ -n "${LIMPET_CODEX_APPSERVER:-}" ] || [ -n "$(_limpet_exe codex)" ]; }; then
    if _limpet_codex_reindex "$hub"; then rm -f "$reindex"; else ok=1; fi
  fi
  return $ok
}

# ---- Copilot: numbered homes share plain ~/.copilot's session-state ----------
_limpet_copilot_busy() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local state="$1/session-state" chat mark pid
  [ -d "$state" ] && [ ! -L "$state" ] || return 1
  for chat in "$state"/*; do
    [ -d "$chat" ] || continue
    for mark in "$chat"/inuse.*.lock; do
      [ -f "$mark" ] || continue
      pid=${mark##*/inuse.}; pid=${pid%.lock}
      _limpet_is_number "$pid" && kill -0 "$pid" 2>/dev/null && return 0
    done
  done
  return 1
}

limpet_sync_copilot_history() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local home hub='' homes dir stamp ok=0 n cmd
  home=$(_limpet_agent_home)
  homes=()
  while [ $# -gt 0 ]; do
    case "$1" in --hub|-Hub) hub=$2; shift ;; *) homes+=("$1") ;; esac; shift
  done
  [ -n "$hub" ] || hub="$home/.copilot"
  if [ ${#homes[@]} -eq 0 ]; then
    for n in $(_limpet_account_numbers copilot "$home"); do homes+=("$home/.copilot-$n"); done
  fi
  stamp=$(_limpet_stamp)
  mkdir -p "$hub"
  for dir in "${homes[@]}"; do
    _limpet_same_path "$dir" "$hub" && continue
    mkdir -p "$dir"
    if _limpet_copilot_busy "$dir"; then
      cmd=copilot${dir##*/.copilot-}
      _limpet_warn "a chat is open in $cmd right now, so its history isn't shared yet; it will be the next time $cmd starts with none open."
      ok=1; continue
    fi
    _limpet_connect_shared "$dir/session-state" "$hub/session-state" "$stamp" Copilot || ok=1
  done
  return $ok
}

# ---- Antigravity (agy): one login, swapped per launch ------------------------
# agy keeps its single login in the login Keychain on macOS and in a token
# file on Linux (~/.gemini/antigravity-cli/antigravity-oauth-token). Each
# agyN account's login is kept aside (Keychain item limpet:agy:<cmd>, or
# ~/.agy-N/login.dat 0600) and swapped in for the launch. LIMPET_AGY_TOKEN_FILE
# forces the file store (tests); LIMPET_AGY_KEYCHAIN_SERVICE /
# LIMPET_AGY_KEYCHAIN_ACCOUNT name the Keychain item (best effort: the real
# agy's item name on macOS has not been verified).
_limpet_agy_uses_file() { [ -n "${LIMPET_AGY_TOKEN_FILE:-}" ] || ! _limpet_is_mac; }
_limpet_agy_token_file() { printf '%s\n' "${LIMPET_AGY_TOKEN_FILE:-$HOME/.gemini/antigravity-cli/antigravity-oauth-token}"; }
_limpet_agy_kc_account() { printf '%s\n' "${LIMPET_AGY_KEYCHAIN_ACCOUNT:-antigravity}"; }
_limpet_agy_kc_service() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local s
  if [ -n "${LIMPET_AGY_KEYCHAIN_SERVICE:-}" ]; then printf '%s\n' "$LIMPET_AGY_KEYCHAIN_SERVICE"; return; fi
  for s in gemini:antigravity gemini; do
    if security find-generic-password -s "$s" -a "$(_limpet_agy_kc_account)" >/dev/null 2>&1; then printf '%s\n' "$s"; return; fi
  done
  printf 'gemini:antigravity\n'
}

_limpet_agy_cred_read() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  if _limpet_agy_uses_file; then
    local f; f=$(_limpet_agy_token_file); [ -f "$f" ] && cat "$f"
  else
    security find-generic-password -s "$(_limpet_agy_kc_service)" -a "$(_limpet_agy_kc_account)" -w 2>/dev/null
  fi
}
_limpet_agy_cred_write() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  if _limpet_agy_uses_file; then
    local f; f=$(_limpet_agy_token_file); mkdir -p "$(dirname "$f")"
    (umask 077; printf '%s' "$1" > "$f.new") && mv -f "$f.new" "$f"
  else
    security add-generic-password -U -s "$(_limpet_agy_kc_service)" -a "$(_limpet_agy_kc_account)" -w "$1" >/dev/null
  fi
}
_limpet_agy_cred_delete() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  if _limpet_agy_uses_file; then rm -f "$(_limpet_agy_token_file)"
  else security delete-generic-password -s "$(_limpet_agy_kc_service)" -a "$(_limpet_agy_kc_account)" >/dev/null 2>&1 || :; fi
}

# The kept copy of an account's login: read / write / exists / delete.
_limpet_agy_kept_read() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local dir=$1 cmd=$2
  if _limpet_agy_uses_file; then [ -f "$dir/login.dat" ] && cat "$dir/login.dat"
  else security find-generic-password -s "limpet:agy:$cmd" -a "${USER:-limpet}" -w 2>/dev/null; fi
}
_limpet_agy_kept_write() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local dir=$1 cmd=$2 blob=$3
  mkdir -p "$dir"
  if _limpet_agy_uses_file; then
    (umask 077; printf '%s' "$blob" > "$dir/login.dat.new") && mv -f "$dir/login.dat.new" "$dir/login.dat"
  else
    security add-generic-password -U -s "limpet:agy:$cmd" -a "${USER:-limpet}" -w "$blob" >/dev/null || return 1
    (umask 077; printf '{"keychain":"limpet:agy:%s"}' "$cmd" > "$dir/login.dat")
  fi
}
_limpet_agy_kept_exists() { [ -f "$1/login.dat" ]; }

_limpet_agy_active_file() { printf '%s/.agy/active\n' "$(_limpet_agent_home)"; }
_limpet_agy_active() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local f cmd; f=$(_limpet_agy_active_file)
  cmd=$([ -f "$f" ] && tr -d '[:space:]' < "$f")
  if [ -n "$cmd" ] && _limpet_resolve "$cmd" && [ "$_LR_KIND" = agy ]; then printf '%s\n' "$cmd"; else printf 'agy\n'; fi
}
_limpet_agy_set_active() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local f; f=$(_limpet_agy_active_file)
  if [ "$1" = agy ]; then rm -f "$f"; else mkdir -p "$(dirname "$f")" && printf '%s' "$1" > "$f"; fi
}
_limpet_agy_running() { pgrep -x "${LIMPET_AGY_PROCESS:-agy}" >/dev/null 2>&1; }

_limpet_jwt_email() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local part; part=$(printf '%s' "$1" | cut -d. -f2)
  [ -n "$part" ] || return 0
  _limpet_b64d "$part" | sed -n 's/.*"email"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# Keep the login now in the store as $1's (login.dat + account.json with its email).
_limpet_agy_save_login() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local cmd=$1 cred dir idt email
  cred=$(_limpet_agy_cred_read)
  [ -n "$cred" ] || return 0
  _limpet_resolve "$cmd" || return 1
  dir=$_LR_DIR
  _limpet_agy_kept_write "$dir" "$cmd" "$cred" || { _limpet_warn "couldn't store $cmd's agy login safely."; return 1; }
  [ "$(_limpet_agy_kept_read "$dir" "$cmd")" = "$cred" ] || { _limpet_warn "couldn't store $cmd's agy login safely."; return 1; }
  idt=$(printf '%s' "$cred" | sed -n 's/.*"id_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  email=''; [ -n "$idt" ] && email=$(_limpet_jwt_email "$idt")
  printf '{"email":"%s"}' "$email" > "$dir/account.json"
}

# Put $1's kept login into the store, or clear it so agy asks to sign in.
_limpet_agy_restore_login() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local cmd=$1 blob
  _limpet_resolve "$cmd" || return 1
  if ! _limpet_agy_kept_exists "$_LR_DIR"; then _limpet_agy_cred_delete; return 0; fi
  blob=$(_limpet_agy_kept_read "$_LR_DIR" "$cmd")
  _limpet_agy_cred_write "$blob"
}

# A launch whose shell was closed while agy ran never put plain agy's login
# back; finish that once no agy is running.
_limpet_agy_repair() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local active
  [ -f "$(_limpet_agy_active_file)" ] || return 0
  active=$(_limpet_agy_active)
  [ "$active" = agy ] && return 0
  _limpet_agy_running && return 0
  if _limpet_agy_save_login "$active" && _limpet_agy_restore_login agy; then _limpet_agy_set_active agy
  else _limpet_warn "couldn't put plain agy's login back after $active; it is kept in $(dirname "$(_limpet_agy_active_file)")."; fi
}

_limpet_agy_enter() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local cmd=$1 active
  _limpet_agy_repair
  active=$(_limpet_agy_active)
  [ "$active" = "$cmd" ] && return 0
  if _limpet_agy_running; then
    _limpet_warn "agy is already running as $active, and agy can hold only one login at a time. Close it, then run $cmd again."
    return 1
  fi
  _limpet_agy_save_login "$active" || { _limpet_warn "couldn't switch agy to $cmd; nothing was changed."; return 1; }
  _limpet_agy_restore_login "$cmd" || { _limpet_warn "couldn't switch agy to $cmd; nothing was changed."; return 1; }
  _limpet_agy_set_active "$cmd"
}

_limpet_agy_exit() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local cmd=$1 i=0
  while [ $i -lt 12 ] && _limpet_agy_running; do sleep 0.25; i=$((i + 1)); done
  _limpet_agy_running && return 0
  [ "$(_limpet_agy_active)" = "$cmd" ] || return 0
  if _limpet_agy_save_login "$cmd"; then
    if [ "$cmd" != agy ]; then _limpet_agy_restore_login agy && _limpet_agy_set_active agy; fi
  else
    _limpet_warn "couldn't put plain agy's login back; it is kept in $(dirname "$(_limpet_agy_active_file)") and goes back the next time an agyN exits."
  fi
}

# ---- launch notes and the launcher ------------------------------------------
_limpet_agent_run_dir() {
  if [ -n "${LIMPET_AGENT_RUN:-}" ]; then printf '%s\n' "$LIMPET_AGENT_RUN"
  else printf '%s/agents\n' "$(_limpet_config_dir)"; fi
}

# Note that this shell is launching $1 (for the app); path in _LIMPET_NOTE.
_limpet_note_launch() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local dir old pid
  _LIMPET_NOTE=''
  dir=$(_limpet_agent_run_dir)
  mkdir -p "$dir" 2>/dev/null || return 0
  for old in "$dir"/*.json; do
    [ -f "$old" ] || continue
    pid=${old##*/}; pid=${pid%.json}
    _limpet_is_number "$pid" && ! kill -0 "$pid" 2>/dev/null && rm -f "$old"
  done
  _LIMPET_NOTE="$dir/$$.json"
  printf '{"cmd":"%s","pid":%s,"startedAt":%s}' "$1" "$$" "$(_limpet_now_ms)" > "$_LIMPET_NOTE" 2>/dev/null || _LIMPET_NOTE=''
}

# Run an agent CLI as one limpet account: claude3 -> CLAUDE_CONFIG_DIR=~/.claude-3,
# codex2 -> CODEX_HOME=~/.codex-2, copilot1 -> COPILOT_HOME=~/.copilot-1, agy2 ->
# Antigravity with ~/.agy-2's login swapped in. `--limpet-plan` among the
# arguments prints the resolved plan instead of launching.
limpet_invoke_agent() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local cmd=$1 kind dir envName exe plan=0 a args what rc
  shift
  if ! _limpet_resolve "$cmd"; then
    _limpet_warn "'$cmd' is not an agent account (claude, claude1, ..., codex, codex1, ..., agy, agy1, ..., copilot, copilot1, ...)."
    return 1
  fi
  kind=$_LR_KIND; dir=$_LR_DIR; envName=$(_limpet_env_name "$kind")
  mkdir -p "$dir"
  case "$kind" in
    claude) limpet_sync_claude_history >/dev/null 2>&1 || : ;;
    codex) limpet_sync_codex_history >/dev/null 2>&1 || : ;;
    copilot) limpet_sync_copilot_history >/dev/null 2>&1 || : ;;
  esac
  exe=$(_limpet_exe "$kind")
  args=()
  for a in "$@"; do
    if [ "$a" = --limpet-plan ]; then plan=1; else args+=("$a"); fi
  done
  if [ $plan -eq 1 ]; then
    printf 'cmd=%s\nkind=%s\nconfigDir=%s\nenvName=%s\nexe=%s\nargs=%s\n' "$cmd" "$kind" "$dir" "$envName" "$exe" "${args[*]}"
    return 0
  fi
  if [ -z "$exe" ]; then
    case "$kind" in
      claude) what='claude CLI (Claude Code)' ;; codex) what='codex CLI (npm i -g @openai/codex)' ;;
      agy) what='agy CLI (Antigravity)' ;; copilot) what='copilot CLI (npm i -g @github/copilot)' ;;
    esac
    _limpet_warn "the $what is not on PATH. Install it, then rerun $cmd."
    return 1
  fi
  if [ "$kind" = agy ]; then _limpet_agy_enter "$cmd" || return 1; fi
  _LIMPET_NOTE=''
  [ "$kind" != claude ] && _limpet_note_launch "$cmd"
  case "$kind" in
    claude) CLAUDE_CONFIG_DIR="$dir" "$exe" "${args[@]}" ;;
    codex) CODEX_HOME="$dir" "$exe" "${args[@]}" ;;
    copilot) COPILOT_HOME="$dir" "$exe" "${args[@]}" ;;
    *) "$exe" "${args[@]}" ;;
  esac
  rc=$?
  [ -n "$_LIMPET_NOTE" ] && rm -f "$_LIMPET_NOTE"
  [ "$kind" = agy ] && _limpet_agy_exit "$cmd"
  return $rc
}

# Plain agy goes through the wrapper too: it has to find its own login, which
# an agyN may have swapped out, and must not start while another account runs.
agy() { limpet_invoke_agent agy "$@"; }

# Numbered commands whose directory exists become real functions (tab
# completion); the rest are caught by the command-not-found hook.
_limpet_define_account_functions() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local line cmd n
  limpet_agent_accounts | while read -r cmd _ n _; do
    [ "$n" != 0 ] && printf '%s\n' "$cmd"
  done
}
for _limpet_cmd in $(_limpet_define_account_functions); do
  eval "$_limpet_cmd() { limpet_invoke_agent $_limpet_cmd \"\$@\"; }"
done
unset _limpet_cmd

_limpet_cnf() {
  [ -n "${ZSH_VERSION:-}" ] && emulate -L sh
  local cmd=$1
  shift
  case "$cmd" in
    claude*|codex*|agy*|copilot*)
      if _limpet_is_account "$cmd"; then limpet_invoke_agent "$cmd" "$@"; return $?; fi ;;
  esac
  if command -v _limpet_prev_cnf >/dev/null 2>&1; then _limpet_prev_cnf "$cmd" "$@"; return $?; fi
  printf '%s: command not found: %s\n' "${ZSH_VERSION:+zsh}${BASH_VERSION:+bash}" "$cmd" >&2
  return 127
}
# A hook that was already installed (Ubuntu's command-not-found, say) is kept
# as _limpet_prev_cnf and still sees everything else. Re-sourcing this file
# must not capture limpet's own hook as the previous one.
if [ -n "${ZSH_VERSION:-}" ]; then
  # zsh semantics inside, whatever emulation the sourcing shell is in.
  eval '
    _limpet_zsh_install_cnf() {
      emulate -L zsh
      if (( $+functions[command_not_found_handler] )) && [[ $functions[command_not_found_handler] != *_limpet_cnf* ]]; then
        functions[_limpet_prev_cnf]=$functions[command_not_found_handler]
      fi
      command_not_found_handler() { _limpet_cnf "$@"; }
    }
    _limpet_zsh_install_cnf
  '
else
  if declare -f command_not_found_handle >/dev/null 2>&1; then
    case "$(declare -f command_not_found_handle)" in
      *_limpet_cnf*) ;;
      *) eval "$(declare -f command_not_found_handle | sed '1s/command_not_found_handle/_limpet_prev_cnf/')" ;;
    esac
  fi
  command_not_found_handle() { _limpet_cnf "$@"; }
fi

# Finish any agyN launch whose shell was closed before it put plain agy's login back.
_limpet_agy_repair 2>/dev/null || :

# ---------------------------------------------------------------------------
# Tab-friendly window title: the current folder's name before each prompt.
# ---------------------------------------------------------------------------
_limpet_title() {
  local leaf=${PWD##*/}
  printf '\033]2;%s\007' "${leaf:-$PWD}"
}
if [ -n "${ZSH_VERSION:-}" ]; then
  eval '
    _limpet_zsh_install_title() {
      emulate -L zsh
      typeset -ga precmd_functions
      if (( ${precmd_functions[(I)_limpet_title]} == 0 )); then precmd_functions+=(_limpet_title); fi
    }
    _limpet_zsh_install_title
  '
else
  case "${PROMPT_COMMAND:-}" in
    *_limpet_title*) ;;
    *) PROMPT_COMMAND="_limpet_title${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac
fi
