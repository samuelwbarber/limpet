# Tests for shell/limpet.sh, the zsh/bash integration. Run with either shell:
#     zsh tests/test-limpet-sh.sh
#     bash tests/test-limpet-sh.sh
# Everything happens under a throwaway home (LIMPET_AGENT_HOME, HOME,
# LIMPET_AGENT_RUN all point at it) with ssh/codex/agy/copilot stubbed on a
# temp PATH, so the real ~/.claude* and friends are never touched. Mirrors
# tests/Test-Limpet.ps1 and tests/Test-Xssh.ps1 where they apply.

if [ -n "${BASH_SOURCE:-}" ]; then self=${BASH_SOURCE[0]}; else eval 'self=${(%):-%x}'; fi
cd "$(dirname "$self")/.." || exit 1
REPO=$(pwd -P)
if [ -n "${ZSH_VERSION:-}" ]; then SHELL_NAME=zsh; emulate sh; else SHELL_NAME=bash; fi

pass=0; fail=0
check() { if [ "$2" = 0 ]; then echo "PASS  $1"; pass=$((pass + 1)); else echo "FAIL  $1"; fail=$((fail + 1)); fi; }
# check_ok NAME COMMAND...: PASS when the command succeeds.
check_ok() { local n=$1; shift; "$@" >/dev/null 2>&1; check "$n" $?; }
contains() { case "$1" in *"$2"*) return 0 ;; esac; return 1; }
is_link() { [ -L "$1" ]; }
link_to() { [ "$(cd "$(dirname "$1")" && cd "$(readlink "$1")" && pwd -P)" = "$(cd "$2" && pwd -P)" ]; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/limpet-sh-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" LIMPET_AGENT_HOME="$TMP/home" LIMPET_AGENT_RUN="$TMP/run" TMPDIR="$TMP/tmp"
export LIMPET_AGY_TOKEN_FILE="$TMP/agy-token" LIMPET_AGY_PROCESS=limpet-no-such-agy LIMPET_HELLO_FILE="$TMP/hello.pass"
export XDG_CONFIG_HOME="$TMP/xdg"
mkdir -p "$HOME" "$TMPDIR" "$TMP/bin"
unset LIMPET_TOKEN LIMPET_NO_PWCACHE ZDOTDIR
# A PATH without any real agent CLI on it (WSL appends the Windows PATH).
PATH="$TMP/bin:/usr/local/bin:/usr/bin:/bin"
BEL=$(printf '\007'); ESC=$(printf '\033')

# ---- load ----
. "$REPO/shell/limpet.sh"
check "sources under $SHELL_NAME" $?
for fn in xssh wput peek peak reels download upload limpet limpet-enroll limpet-forget limpet-status agy limpet_invoke_agent limpet_agent_accounts limpet_sync_claude_history limpet_sync_codex_history limpet_sync_copilot_history; do
  type "$fn" >/dev/null 2>&1; check "defines $fn" $?
done
[ "$LIMPET_SHELL_DIR" = "$REPO/shell" ]; check 'LIMPET_SHELL_DIR points at shell/' $?
ms=$(_limpet_now_ms); case "$ms" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) r=0 ;; *) r=1 ;; esac; check "_limpet_now_ms is milliseconds ($ms)" $r
case "$(_limpet_stamp)" in [0-9]*-[0-9]*-????) r=0 ;; *) r=1 ;; esac; check 'stamp has the date and a random suffix' $r
if [ -n "${ZSH_VERSION:-}" ]; then
  contains " ${precmd_functions[*]} " ' _limpet_title '; check 'title hook registered in precmd_functions' $?
else
  contains "$PROMPT_COMMAND" _limpet_title; check 'title hook registered in PROMPT_COMMAND' $?
fi
out=$(cd "$TMP" && _limpet_title); [ "$out" = "${ESC}]2;$(basename "$TMP")${BEL}" ]; check 'title is the current folder name' $?
[ "$(_limpet_askpass)" = "$REPO/shell/limpet-askpass.sh" ] || [ -x "$(_limpet_askpass)" ]; check 'askpass helper is executable' $?
[ "$(LIMPET_ASKPASS=hunter2 "$(_limpet_askpass)")" = hunter2 ]; check 'askpass helper prints LIMPET_ASKPASS' $?

# ---- banner, peek, reels ----
[ "$(limpet | wc -c | tr -d ' ')" -gt 100 ]; check 'limpet banner prints' $?
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01\x00\x00\x00\xc8' > "$TMP/tall.png"   # 200px tall -> 12 rows
pk=$(peek "$TMP/tall.png"; printf X); pk=${pk%X}
contains "$pk" ']5379;peek;h;'; check 'peek emits the OSC 5379 header' $?
contains "$pk" ";$(_limpet_size "$TMP/tall.png");12$BEL"; check 'peek tags the row count from pixel height' $?
tail_nl=${pk##*"$BEL"}; [ "$(printf %s "$tail_nl" | wc -l | tr -d ' ')" = 12 ]; check 'peek reserves exactly rows newlines' $?
cp "$TMP/tall.png" "$TMP/tall2.png"
[ "$(peek "$TMP/tall.png" "$TMP/tall2.png" | grep -aoc ']5379;peek;h;')" = 2 ]; check 'peek takes multiple files' $?
peek "$TMP/nope.png" 2>"$TMP/err" >/dev/null; grep -q 'not found' "$TMP/err"; check 'peek on a missing file errors' $?
peek 2>"$TMP/err" >/dev/null; grep -qi usage "$TMP/err"; check 'peek with no args shows usage' $?
contains "$(peak "$TMP/tall.png")" ']5379;peek;h;'; check 'peak is peek' $?
rl=$(LIMPET_TOKEN=0123456789abcdef0123456789abcdef reels 'https://x')
contains "$rl" ']5379;reels;aHR0cHM6Ly94'; check 'reels emits the OSC 5379 verb' $?
contains "$rl" ';0123456789abcdef0123456789abcdef'; check 'reels carries the app token' $?

# ---- wput / xssh argument handling ----
wput 2>"$TMP/err"; grep -q 'no files' "$TMP/err"; check 'wput with no files errors' $?
wput "$TMP/nope.bin" -To u@h 2>"$TMP/err"; grep -q 'not found' "$TMP/err"; check 'wput rejects a missing local path' $?
rm -f "$(_limpet_state_file)"
wput "$TMP/tall.png" 2>"$TMP/err"; grep -q 'no target' "$TMP/err"; check 'wput without a host or a previous xssh errors' $?
xssh 2>"$TMP/err"; grep -qi usage "$TMP/err"; check 'xssh with no args shows usage' $?

# ---- enroll helpers (the non-interactive surface) ----
[ "$(_limpet_key_path)" = "$HOME/.ssh/limpet_ed25519" ]; check 'key path is ~/.ssh/limpet_ed25519' $?
_limpet_hello_enrolled 'ci-test@nohost.invalid'; [ $? = 1 ]; check 'an unknown host is not enrolled' $?
mkdir -p "$(_limpet_hello_dir)"; printf 'me@box\n' >> "$(_limpet_hosts_file)"
_limpet_hello_enrolled 'ME@box'; check 'enrolment is case-insensitive' $?
limpet-forget me@box >/dev/null; _limpet_hello_enrolled me@box; [ $? = 1 ]; check 'limpet-forget drops the host' $?
contains "$(limpet-status)" '(not created)'; check 'limpet-status reports no key' $?
_limpet_hello_store 'secret-pass' 2>/dev/null; [ "$(_limpet_hello_passphrase)" = secret-pass ]; check 'passphrase store round-trips (file mode)' $?
rm -f "$LIMPET_HELLO_FILE"

# ---- xssh: what it sends, per flag combo (ssh stubbed) ----
export LIMPET_NO_PWCACHE=1
ssh() { printf '%s\n' "$*" > "$TMP/captured"; return 0; }
combo() { rm -f "$TMP/captured"; xssh "$@" user@localhost >/dev/null 2>&1; cat "$TMP/captured" 2>/dev/null; }
c=$(combo)
contains "$c" 'base64 -d'; check 'default: injects the integration' $?
contains "$c" 'base64 -d | gunzip'; check 'default: decompresses with gunzip' $?
contains "$c" 'tmux new -d -s $s ' && contains "$c" 'tmux attach -d -t =$s'; check 'default: resumes the tmux "limpet-<ver>" session' $?
contains "$c" 'bash --rcfile $f -i'; check 'default: session sources the fresh script' $?
printf '%s' "$c" | grep -qE 's=limpet-[0-9a-f]{12};'; check 'default: names the session for the helper version' $?
contains "$c" 'kill-session'; [ $? = 1 ]; check 'default: never kills an existing session' $?
contains "$c" 'ServerAliveInterval=15'; check 'default: adds keepalive options' $?
case "$c" in '-t -o ServerAliveInterval=15 '*) r=0 ;; *) r=1 ;; esac; check 'default: forces a tty (-t), keepalives first' $r
contains "$c" "'"; [ $? = 1 ]; check 'default: bootstrap has no single quotes' $?
contains "$c" '"'; [ $? = 1 ]; check 'default: bootstrap has no double quotes' $?
c=$(combo -NoResume)
contains "$c" 'base64 -d | gunzip'; check '-NoResume: still injects' $?
contains "$c" tmux; [ $? = 1 ]; check '-NoResume: no tmux wrap' $?
c=$(combo --no-resume); contains "$c" tmux; [ $? = 1 ]; check '--no-resume works too' $?
c=$(combo -Raw)
contains "$c" 'base64 -d'; r1=$?; contains "$c" tmux; r2=$?; [ $r1 = 1 ] && [ $r2 = 1 ]; check '-Raw: plain ssh, nothing added' $?
c=$(combo -Raw -Resume)
contains "$c" 'tmux new -A -D -s limpet' && ! contains "$c" 'base64 -d'; check '-Raw -Resume: bare tmux, no inject' $?
rm -f "$TMP/captured"; xssh -Raw -o ServerAliveInterval=5 user@localhost >/dev/null 2>&1
contains "$(cat "$TMP/captured")" 'ServerAliveInterval=15'; [ $? = 1 ]; check 'keepalives not duplicated when user sets them' $?
rm -f "$TMP/captured"; xssh -Raw -i /keys/k -J jump@host user@localhost >/dev/null 2>&1
contains "$(cat "$TMP/captured")" '-i /keys/k -J jump@host user@localhost'; check 'passthrough args survive in order' $?
[ "$(sed -n 1p "$(_limpet_state_file)")" = user@localhost ]; check 'remembers the host for wput' $?
rm -f "$TMP/captured"; xssh -Raw -p 2222 me@box >/dev/null 2>&1
[ "$(sed -n 1p "$(_limpet_state_file)")" = me@box ] && [ "$(sed -n 2p "$(_limpet_state_file)")" = 2222 ]; check 'remembers -p port for wput' $?
rm -f "$TMP/captured"; xssh -Raw -o Port=2200 me@box >/dev/null 2>&1
[ "$(sed -n 2p "$(_limpet_state_file)")" = 2200 ]; check 'remembers -o Port=N for wput' $?
rm -f "$TMP/captured"; xssh -Raw -vv4 -p2223 -l me box >/dev/null 2>&1
[ "$(sed -n 1p "$(_limpet_state_file)")" = box ] && [ "$(sed -n 2p "$(_limpet_state_file)")" = 2223 ]; check 'clustered flags and attached values are parsed like ssh' $?
# wput reuses the last host and port
scp() { printf '%s\n' "$*" > "$TMP/scp-captured"; return 0; }
xssh -Raw -p 2222 me@box >/dev/null 2>&1
wput "$TMP/tall.png" >/dev/null 2>&1
contains "$(cat "$TMP/scp-captured")" '-P 2222' && contains "$(cat "$TMP/scp-captured")" 'me@box:'; check 'wput defaults to the last xssh host and port' $?
wput "$TMP/tall.png" -To x@y -Dest /var/www -Port 9 >/dev/null 2>&1
contains "$(cat "$TMP/scp-captured")" '-P 9' && contains "$(cat "$TMP/scp-captured")" 'x@y:/var/www'; check 'wput -To/-Dest/-Port are honoured' $?
unset -f scp

# in the app: tell it the host (tokened), and that ssh ended
export LIMPET_TOKEN=0123456789abcdef0123456789abcdef
t64=$(printf '%s' me@box | base64 | tr -d '\n')
out=$(xssh -Raw -p 2222 me@box 2>/dev/null)
contains "$out" "${ESC}]5379;xssh;$t64;2222;${LIMPET_TOKEN}${BEL}"; check 'in app: reports host + port on connect' $?
contains "$out" "${ESC}]5379;xssh;;;${LIMPET_TOKEN}${BEL}"; check 'in app: reports when ssh ends' $?
c=$(combo)
b64=$(printf '%s' "$c" | sed -n 's/.*printf %s \([A-Za-z0-9+/=]*\) | base64.*/\1/p')
printf '%s' "$b64" | base64 --decode | gunzip | head -n 1 | grep -q "^LIMPET_TOKEN=$LIMPET_TOKEN\$"; check 'in app: the injected helpers carry the token' $?
printf '%s' "$b64" | base64 --decode | gunzip | tail -n +2 | cmp -s - "$REPO/shell/limpet-remote.sh"; check 'the injected script is limpet-remote.sh, byte for byte' $?
unset LIMPET_TOKEN
out=$(xssh -Raw me@box 2>/dev/null)
contains "$out" ']5379;xssh'; [ $? = 1 ]; check 'outside the app: no reports' $?

# ---- reconnect policy ----
calls=0
ssh() { calls=$((calls + 1)); printf '%s\n' "$calls" > "$TMP/calls"; case "$(cat "$TMP/calls")" in 1) sleep 6; return 255 ;; 2) return 255 ;; *) return 0 ;; esac; }
: > "$TMP/calls"; calls=0
xssh -Raw user@localhost >/dev/null 2>&1
[ "$(cat "$TMP/calls")" = 3 ]; check 'offline blip after a session: waits and reconnects' $?
ssh() { calls=$((calls + 1)); printf '%s\n' "$calls" > "$TMP/calls"; return 255; }
calls=0; xssh -Raw user@localhost >/dev/null 2>&1
[ "$(cat "$TMP/calls")" = 1 ]; check 'instant first failure: stops (no retry loop)' $?
ssh() { calls=$((calls + 1)); printf '%s\n' "$calls" > "$TMP/calls"; return 0; }
calls=0; xssh -Raw user@localhost >/dev/null 2>&1
[ "$(cat "$TMP/calls")" = 1 ]; check 'clean exit: no reconnect' $?

# ---- password caching for auto-reconnect ----
unset LIMPET_NO_PWCACHE
ssh() {
  case "$*" in *BatchMode*) printf probed > "$TMP/probed"; return 0 ;; esac
  printf '%s' "${SSH_ASKPASS_REQUIRE:-unset}" > "$TMP/req"; printf '%s' "${LIMPET_ASKPASS:-}" > "$TMP/pw"; return 0
}
rm -f "$TMP/probed" "$TMP/req"; xssh -Raw user@localhost >/dev/null 2>&1 </dev/null
[ -f "$TMP/probed" ]; check 'pwcache: probes whether key auth works' $?
[ "$(cat "$TMP/req")" = unset ]; check 'pwcache: key auth -> askpass not forced' $?
ssh() {
  case "$*" in *BatchMode*) return 255 ;; esac
  printf '%s' "${SSH_ASKPASS_REQUIRE:-unset}" > "$TMP/req"; printf '%s' "${LIMPET_ASKPASS:-}" > "$TMP/pw"; printf '%s' "${SSH_ASKPASS:-}" > "$TMP/helper"; return 0
}
printf 'hunter2\n' | xssh -Raw user@localhost >/dev/null 2>&1
[ "$(cat "$TMP/req")" = force ]; check 'pwcache: no key -> forces askpass on connect' $?
[ "$(cat "$TMP/pw")" = hunter2 ]; check 'pwcache: no key -> replays the typed password' $?
[ -x "$(cat "$TMP/helper")" ]; check 'pwcache: points ssh at the askpass helper' $?
[ -z "${LIMPET_ASKPASS:-}" ] && [ -z "${SSH_ASKPASS_REQUIRE:-}" ]; check 'pwcache: askpass wiring never leaks into the shell' $?
# enrolled host: the limpet key and its kept passphrase
mkdir -p "$HOME/.ssh" "$(_limpet_hello_dir)"; : > "$(_limpet_key_path)"; printf 'me@box\n' > "$(_limpet_hosts_file)"
_limpet_hello_store 'kept-pass' 2>/dev/null
ssh() { printf '%s' "$*" > "$TMP/captured"; printf '%s' "${LIMPET_ASKPASS:-}" > "$TMP/pw"; return 0; }
xssh -Raw me@box >/dev/null 2>&1
contains "$(cat "$TMP/captured")" "-i $(_limpet_key_path) -o IdentitiesOnly=yes -o PreferredAuthentications=publickey" && [ "$(cat "$TMP/pw")" = kept-pass ]; check 'enrolled host: connects with the limpet key and its kept passphrase' $?
rm -f "$(_limpet_key_path)" "$(_limpet_hosts_file)" "$LIMPET_HELLO_FILE"
unset -f ssh
export LIMPET_NO_PWCACHE=1

# ---- claude / claude1 / claude2: one shared /resume history ----
h="$TMP/claude"; shared="$h/shared/projects"; c0="$h/.claude"; c1="$h/.claude-1"; c2="$h/.claude-2"
mkdir -p "$c0/projects/C--proj/memory" "$c0/projects/C--only0" "$c2/projects/C--proj"
printf 'a\n' > "$c0/projects/C--proj/aaa.jsonl"; printf 'same\n' > "$c0/projects/C--proj/dup.jsonl"; printf 'short\n' > "$c0/projects/C--proj/clash.jsonl"
printf 'mem\n' > "$c0/projects/C--proj/memory/MEMORY.md"; printf 'o\n' > "$c0/projects/C--only0/o.jsonl"
printf 'b\n' > "$c2/projects/C--proj/bbb.jsonl"; printf 'same\n' > "$c2/projects/C--proj/dup.jsonl"; printf 'longer content here\n' > "$c2/projects/C--proj/clash.jsonl"
printf 'turn 1\n' > "$c0/projects/C--proj/cont.jsonl"; printf 'turn 1\nturn 2\n' > "$c2/projects/C--proj/cont.jsonl"
limpet_sync_claude_history --shared "$shared" "$c0" "$c1" "$c2"; check 'sync reports every account synced' $?
for c in "$c0" "$c1" "$c2"; do
  is_link "$c/projects" && link_to "$c/projects" "$shared" && [ -f "$c/projects/C--proj/aaa.jsonl" ]; check "sync links $(basename "$c")/projects to the shared store" $?
done
[ -f "$shared/C--proj/aaa.jsonl" ] && [ -f "$shared/C--proj/bbb.jsonl" ] && [ -f "$shared/C--proj/memory/MEMORY.md" ] && [ -f "$shared/C--only0/o.jsonl" ]; check 'sync merges overlapping project folders' $?
[ "$(cat "$shared/C--proj/dup.jsonl")" = same ] && [ "$(ls "$shared/C--proj" | grep -c '^dup.jsonl')" = 1 ]; check 'sync drops an identical duplicate' $?
[ "$(cat "$shared/C--proj/clash.jsonl")" = 'longer content here' ] && [ "$(ls "$shared/C--proj" | grep -c '^clash.jsonl.conflict-')" = 1 ]; check 'sync keeps the fuller transcript and preserves the other' $?
[ "$(cat "$shared/C--proj/cont.jsonl" | tr '\n' ,)" = 'turn 1,turn 2,' ] && [ "$(ls "$shared/C--proj" | grep -c '^cont.jsonl')" = 1 ]; check 'sync keeps a continued transcript without a conflict copy' $?
[ "$(ls -d "$c0"/projects.migrating-* "$c2"/projects.migrating-* 2>/dev/null | wc -l | tr -d ' ')" = 0 ]; check 'sync leaves no staging folder behind' $?
limpet_sync_claude_history --shared "$shared" "$c0" "$c1" "$c2"; check 'sync is idempotent' $?
c4="$h/.claude-4"; elsewhere="$h/elsewhere"; mkdir -p "$c4" "$elsewhere"; ln -s "$elsewhere" "$c4/projects"
limpet_sync_claude_history --shared "$shared" "$c4" 2>/dev/null; [ $? = 1 ] && [ "$(readlink "$c4/projects")" = "$elsewhere" ]; check 'sync leaves a foreign link alone' $?

# ---- codex / codex1 / codex2: numbered homes share plain codex's history ----
x="$TMP/codex"; hub="$x/.codex"; k1="$x/.codex-1"; k2="$x/.codex-2"; day='sessions/2026/09/27'
mkdir -p "$hub/$day" "$k1/$day" "$k1/sessions/2026/09/28" "$k1/archived_sessions" "$k1/thread-writer-locks" "$k2"
printf 'a\n' > "$hub/$day/rollout-a.jsonl"; printf 'one\n' > "$hub/$day/rollout-moved.jsonl"
printf 'one\ntwo\n' > "$k1/$day/rollout-moved.jsonl"; printf 'b\n' > "$k1/$day/rollout-b.jsonl"
printf 'c\n' > "$k1/sessions/2026/09/28/rollout-c.jsonl"; printf 'old\n' > "$k1/archived_sessions/rollout-old.jsonl"
: > "$k1/thread-writer-locks/.coordination.lock"; : > "$k1/thread-writer-locks/01a0dead-0000-7000-8000-000000000000.lock"
printf '%s\n' '{"id":"t1","thread_name":"hub one","updated_at":"2026-09-10T10:00:00Z"}' '{"id":"t2","thread_name":"hub two","updated_at":"2026-09-20T10:00:00Z"}' > "$hub/session_index.jsonl"
printf 'model = "gpt-x"\n[projects."/p"]\ntrust_level = "trusted"\n' > "$k1/config.toml"
printf '%s\n' '{"id":"t1","thread_name":"renamed in codex1","updated_at":"2026-09-15T10:00:00.5Z"}' '{"id":"t2","thread_name":"stale in codex1","updated_at":"2026-09-01T10:00:00Z"}' '{"id":"t3","thread_name":"only in codex1","updated_at":"2026-09-05T10:00:00Z"}' > "$k1/session_index.jsonl"
export FAKE_APPSERVER_LOG="$TMP/appserver.log"
export LIMPET_CODEX_APPSERVER="sh $REPO/tests/fake-codex-appserver.sh"
limpet_sync_codex_history --hub "$hub" "$k1" "$k2"; check 'codex sync reports every account shared' $?
for k in "$k1" "$k2"; do
  for name in sessions archived_sessions thread-writer-locks; do
    is_link "$k/$name" && link_to "$k/$name" "$hub/$name"; check "codex sync links $(basename "$k")/$name to plain codex's" $?
  done
  [ "$k/session_index.jsonl" -ef "$hub/session_index.jsonl" ]; check "codex sync hard-links $(basename "$k")/session_index.jsonl to plain codex's" $?
done
[ -f "$hub/$day/rollout-a.jsonl" ] && [ -f "$hub/$day/rollout-b.jsonl" ] && [ -f "$hub/sessions/2026/09/28/rollout-c.jsonl" ] && [ -f "$hub/archived_sessions/rollout-old.jsonl" ] && [ -f "$k1/$day/rollout-b.jsonl" ]; check "codex sync folds codex1's chats into plain codex's" $?
[ "$(cat "$hub/$day/rollout-moved.jsonl" | tr '\n' ,)" = 'one,two,' ] && [ "$(ls "$hub/$day" | grep -c '^rollout-moved.jsonl')" = 1 ]; check 'codex sync keeps the continued copy of a moved thread and drops the stale one' $?
[ "$(ls -A "$hub/thread-writer-locks" | wc -l | tr -d ' ')" = 0 ] && [ "$(ls -d "$k1"/*.migrating-* 2>/dev/null | wc -l | tr -d ' ')" = 0 ]; check "codex sync doesn't carry old lock files over" $?
[ "$(grep -c . "$hub/session_index.jsonl")" = 4 ] && contains "$(sed -n 3p "$hub/session_index.jsonl")" 'only in codex1' && contains "$(sed -n 4p "$hub/session_index.jsonl")" 'renamed in codex1' && ! grep -q 'stale in codex1' "$hub/session_index.jsonl"; check "codex sync adds codex1's newer thread names, oldest first, and skips stale ones" $?
sqliteLine="sqlite_home = \"$hub\""
[ "$(grep -v '^[[:space:]]*\(#\|$\)' "$k1/config.toml" | head -n 1)" = "$sqliteLine" ] && grep -qF 'model = "gpt-x"' "$k1/config.toml" && grep -qF '[projects."/p"]' "$k1/config.toml" && grep -qF 'trust_level = "trusted"' "$k1/config.toml"; check "codex sync points codex1's sqlite_home (the /resume index) at plain codex's, above its tables" $?
grep -qxF "$sqliteLine" "$k2/config.toml"; check 'codex sync gives a home without a config one that holds just sqlite_home' $?
limpet_sync_codex_history --hub "$hub" "$k1" "$k2" && [ "$(grep -c . "$hub/session_index.jsonl")" = 4 ] && [ "$(grep -c '^[[:space:]]*sqlite_home' "$k1/config.toml")" = 1 ]; check 'codex sync is idempotent' $?
printf '%s\n' '{"id":"t4","thread_name":"named later in codex1","updated_at":"2026-09-28T10:00:00Z"}' >> "$k1/session_index.jsonl"
contains "$(tail -n 1 "$hub/session_index.jsonl")" 'named later in codex1'; check 'a name given in codex1 afterwards shows up in plain codex too' $?
# the moved-in threads were indexed through codex app-server, blank names filled from session_index.jsonl
[ ! -f "$hub/.limpet-reindex" ]; check 'codex sync clears the reindex note once codex has indexed the moved threads' $?
grep -q "^home=$hub\$" "$FAKE_APPSERVER_LOG"; check 'reindex: codex app-server runs with CODEX_HOME at the hub' $?
[ "$(grep -c '^list=' "$FAKE_APPSERVER_LOG")" = 6 ]; check 'reindex: lists every page, active and archived, from the folder and then the index' $?
grep -q '"useStateDbOnly":false' "$FAKE_APPSERVER_LOG" && grep -q '"useStateDbOnly":true' "$FAKE_APPSERVER_LOG" && grep -q '"cursor":"p2"' "$FAKE_APPSERVER_LOG"; check 'reindex: follows the cursor and asks both ways' $?
printf '%s\n' '{"id":"01a00000-0000-7000-8000-00000000aaaa","thread_name":"first name","updated_at":"2026-09-01T00:00:00Z"}' '{"id":"01a00000-0000-7000-8000-00000000aaaa","thread_name":"aaaa renamed","updated_at":"2026-09-02T00:00:00Z"}' '{"id":"01a00000-0000-7000-8000-00000000bbbb","thread_name":"bbbb name","updated_at":"2026-09-02T00:00:00Z"}' '{"id":"01a00000-0000-7000-8000-00000000cccc","thread_name":"ignored","updated_at":"2026-09-02T00:00:00Z"}' >> "$hub/session_index.jsonl"
: > "$FAKE_APPSERVER_LOG"; : > "$hub/.limpet-reindex"
limpet_sync_codex_history --hub "$hub" "$k1" "$k2"; check 'reindex runs again while the note is there' $?
grep -q '"threadId":"01a00000-0000-7000-8000-00000000aaaa","name":"aaaa renamed"' "$FAKE_APPSERVER_LOG" && grep -q '"threadId":"01a00000-0000-7000-8000-00000000bbbb","name":"bbbb name"' "$FAKE_APPSERVER_LOG"; check 'reindex: blank names get the latest name from session_index.jsonl' $?
[ "$(grep '^name=' "$FAKE_APPSERVER_LOG" | grep -c cccc)" = 0 ]; check 'reindex: a thread that already has a name is left alone' $?
# a chat open in the home (its thread lock held): nothing is moved until it closes
k3="$x/.codex-3"; mkdir -p "$k3/$day" "$k3/thread-writer-locks"; printf 'live\n' > "$k3/$day/rollout-live.jsonl"
if command -v lsof >/dev/null 2>&1; then
  ( exec 9<>"$k3/thread-writer-locks/01a0beef-0000-7000-8000-000000000000.lock"; sleep 30 ) & holder=$!
  sleep 0.5
  limpet_sync_codex_history --hub "$hub" "$k3" 2>/dev/null; [ $? = 1 ] && [ ! -L "$k3/sessions" ] && [ -f "$k3/$day/rollout-live.jsonl" ] && [ ! -f "$hub/$day/rollout-live.jsonl" ]; check 'codex sync leaves a home with a chat open alone' $?
  kill $holder 2>/dev/null; wait $holder 2>/dev/null
  limpet_sync_codex_history --hub "$hub" "$k3" && [ -f "$hub/$day/rollout-live.jsonl" ] && is_link "$k3/sessions"; check 'codex sync completes once the chat is closed' $?
else
  echo 'SKIP  lsof unavailable: busy-home checks untested'
fi
k4="$x/.codex-4"; elsewhere="$x/elsewhere"; mkdir -p "$k4" "$elsewhere"; ln -s "$elsewhere" "$k4/sessions"
limpet_sync_codex_history --hub "$hub" "$k4" 2>/dev/null; [ $? = 1 ] && [ "$(readlink "$k4/sessions")" = "$elsewhere" ]; check 'codex sync leaves a foreign link alone' $?
k5="$x/.codex-5"; mkdir -p "$k5"; printf "sqlite_home = '/own'\n" > "$k5/config.toml"
limpet_sync_codex_history --hub "$hub" "$k5" 2>/dev/null; [ $? = 1 ] && [ "$(cat "$k5/config.toml")" = "sqlite_home = '/own'" ]; check "codex sync leaves a home's own sqlite_home alone" $?
unset LIMPET_CODEX_APPSERVER

# ---- copilot / copilot1 / ...: numbered homes share plain copilot's session-state ----
y="$TMP/copilot"; hub="$y/.copilot"; p1="$y/.copilot-1"; p2="$y/.copilot-2"
chatA=aaaaaaaa-0000-4000-8000-000000000001; chatB=bbbbbbbb-0000-4000-8000-000000000002
mkdir -p "$hub/session-state/$chatA" "$p1/session-state/$chatB" "$p1/session-state/$chatA" "$p1/session-state/.session-operation-locks"
printf 'e1\n' > "$hub/session-state/$chatA/events.jsonl"; printf 'e1\ne2\n' > "$p1/session-state/$chatA/events.jsonl"; printf 'b1\n' > "$p1/session-state/$chatB/events.jsonl"
: > "$p1/session-state/.session-operation-locks/$chatB.lock"
limpet_sync_copilot_history --hub "$hub" "$p1" "$p2"; check 'copilot sync reports every account shared' $?
for p in "$p1" "$p2"; do is_link "$p/session-state" && link_to "$p/session-state" "$hub/session-state"; check "copilot sync links $(basename "$p")/session-state to plain copilot's" $?; done
[ -f "$hub/session-state/$chatB/events.jsonl" ] && [ "$(cat "$hub/session-state/$chatA/events.jsonl" | tr '\n' ,)" = 'e1,e2,' ] && [ -f "$p1/session-state/$chatB/events.jsonl" ]; check "copilot sync folds copilot1's chats in, keeping the continued one" $?
limpet_sync_copilot_history --hub "$hub" "$p1" "$p2"; check 'copilot sync is idempotent' $?
p3="$y/.copilot-3"; mkdir -p "$p3/session-state/$chatB"; printf '%s' "$$" > "$p3/session-state/$chatB/inuse.$$.lock"
limpet_sync_copilot_history --hub "$hub" "$p3" 2>/dev/null; [ $? = 1 ] && [ ! -L "$p3/session-state" ]; check 'copilot sync leaves a home with a chat open alone' $?
rm "$p3/session-state/$chatB/inuse.$$.lock"
limpet_sync_copilot_history --hub "$hub" "$p3"; check 'copilot sync completes once the chat is closed' $?

# ---- agy / agy1 / ...: one login, swapped per launch (token-file store) ----
g="$TMP/agy"; mkdir -p "$g"
export LIMPET_AGENT_HOME="$g" LIMPET_AGENT_RUN="$g/run"
jwt() { printf 'x.%s.y' "$(printf '{"email":"%s"}' "$1" | base64 | tr -d '\n=' | tr '+/' '-_')"; }
login() { printf '{"token":{"access_token":"at-%s"},"auth_method":"oauth","id_token":"%s"}' "$1" "$(jwt "$1")"; }
inStore() { cat "$LIMPET_AGY_TOKEN_FILE" 2>/dev/null; }
plainLogin=$(login plain@example.com)
_limpet_agy_cred_write "$plainLogin"
_limpet_agy_enter agy1 && [ -z "$(inStore)" ]; check 'agy1 (never signed in) starts with the login cleared, so agy asks to sign in' $?
[ -f "$g/.agy/login.dat" ] && contains "$(cat "$g/.agy/account.json")" '"email":"plain@example.com"' && [ "$(cat "$g/.agy/active")" = agy1 ]; check "plain agy's login is set aside first, email noted for the menu" $?
_limpet_agy_cred_write "$(login one@example.com)"   # signs in as another account
_limpet_agy_exit agy1
[ "$(inStore)" = "$plainLogin" ] && [ -f "$g/.agy-1/login.dat" ] && contains "$(cat "$g/.agy-1/account.json")" 'one@example.com' && [ ! -f "$g/.agy/active" ]; check "on exit agy1's login is kept and plain agy's is back" $?
_limpet_agy_enter agy1 && contains "$(inStore)" 'at-one@example.com'; check 'agy1 comes back signed in next time' $?
cp "$(command -v sleep)" "$TMP/bin/limpet-fake-agy"; "$TMP/bin/limpet-fake-agy" 30 & agyPid=$!
sleep 0.3
export LIMPET_AGY_PROCESS=limpet-fake-agy
_limpet_agy_enter agy2 2>/dev/null; [ $? = 1 ] && contains "$(inStore)" 'at-one@example.com'; check 'another agy account is refused while one runs' $?
kill $agyPid 2>/dev/null; wait $agyPid 2>/dev/null
export LIMPET_AGY_PROCESS=limpet-no-such-agy
_limpet_agy_exit agy1
[ "$(inStore)" = "$plainLogin" ]; check 'plain agy is back after the second run too' $?
_limpet_agy_enter agy1 >/dev/null
_limpet_agy_cred_write "$(login one-refreshed@example.com)"
_limpet_agy_repair
[ "$(inStore)" = "$plainLogin" ] && [ ! -f "$g/.agy/active" ] && contains "$(cat "$g/.agy-1/account.json")" 'one-refreshed@example.com'; check "an interrupted agy1 is finished off later: its refreshed login kept, plain agy's back" $?
[ "$(stat -c %a "$g/.agy-1/login.dat" 2>/dev/null || stat -f %Lp "$g/.agy-1/login.dat")" = 600 ]; check 'a kept login is 0600' $?
# the whole launch, against a stand-in agy that reports which login it found
printf '#!/bin/sh\necho "AGY_RAN $*"\n' > "$TMP/bin/agy"; chmod +x "$TMP/bin/agy"
out=$(agy1 --conversation abc)
contains "$out" 'AGY_RAN --conversation abc' && [ "$(inStore)" = "$plainLogin" ] && [ ! -f "$g/.agy/active" ]; check 'agy1 launches agy with arguments intact and puts plain agy back after' $?
rm -f "$TMP/bin/agy"

# ---- any number of accounts: discovery, numbered commands, the hook, env routing ----
ah="$TMP/agents"; mkdir -p "$ah/.claude-2" "$ah/.claude-10" "$ah/.codex-1" "$ah/.agy-3" "$ah/.copilot-2" "$ah/.claude-x" "$ah/.claude-01" "$ah/Documents"
export LIMPET_AGENT_HOME="$ah" LIMPET_AGENT_RUN="$ah/run"
[ "$(limpet_agent_accounts | cut -d' ' -f1 | tr '\n' ,)" = 'claude,claude2,claude10,codex,codex1,agy,agy3,copilot,copilot2,' ]; check 'accounts are discovered from the home dir: plain first, numbers ascending, junk ignored' $?
[ "$(limpet_agent_accounts | awk '$1 == "codex1" { print $4 }')" = "$ah/.codex-1" ] && [ "$(limpet_agent_accounts | awk '$1 == "copilot2" { print $4 }')" = "$ah/.copilot-2" ]; check 'each account maps to its own config dir' $?
. "$REPO/shell/limpet.sh"   # re-source: the numbered dirs become commands
n=0; for c in claude2 claude10 codex1 agy3 copilot2; do type "$c" >/dev/null 2>&1 && n=$((n + 1)); done; [ $n = 5 ]; check 'numbered accounts whose dir exists are real commands' $?
plan=$(copilot2 --limpet-plan --resume abc)
contains "$plan" 'kind=copilot' && contains "$plan" 'envName=COPILOT_HOME' && contains "$plan" "configDir=$ah/.copilot-2" && contains "$plan" 'args=--resume abc'; check 'copilot2 runs Copilot with COPILOT_HOME at ~/.copilot-2' $?
plan=$(agy5 --limpet-plan --conversation abc 2>/dev/null)
contains "$plan" 'kind=agy' && contains "$plan" 'envName=' && ! contains "$plan" 'envName=C' && contains "$plan" "configDir=$ah/.agy-5" && [ -d "$ah/.agy-5" ]; check 'agy5 runs Antigravity with no directory variable (its login is swapped instead), through the hook' $?
is_link "$ah/.copilot-2/session-state" && [ -d "$ah/.copilot/session-state" ]; check 'a Copilot launch shares its history with plain copilot' $?
plan=$(claude10 --limpet-plan --resume abc)
contains "$plan" 'kind=claude' && contains "$plan" 'envName=CLAUDE_CONFIG_DIR' && contains "$plan" "configDir=$ah/.claude-10" && contains "$plan" 'args=--resume abc'; check 'claude10 runs Claude with CLAUDE_CONFIG_DIR at ~/.claude-10, arguments intact' $?
plan=$(codex1 --limpet-plan resume xyz)
contains "$plan" 'kind=codex' && contains "$plan" 'envName=CODEX_HOME' && contains "$plan" "configDir=$ah/.codex-1" && contains "$plan" 'args=resume xyz'; check 'codex1 runs Codex with CODEX_HOME at ~/.codex-1' $?
type claude7 >/dev/null 2>&1; [ $? != 0 ]; check 'a number with no dir is not a command yet' $?
plan=$(claude7 --limpet-plan -c 2>/dev/null)
contains "$plan" "configDir=$ah/.claude-7" && [ -d "$ah/.claude-7" ] && contains "$plan" 'args=-c'; check 'claude7 still runs, through the command-not-found hook, and gets its dir' $?
plan=$(codex42 --limpet-plan 2>/dev/null)
contains "$plan" 'kind=codex' && [ -d "$ah/.codex-42" ] && contains "$plan" "$(printf 'args=\n')"; check 'codex42 likewise' $?
is_link "$ah/.claude-7/projects" && is_link "$ah/.claude-2/projects" && [ -d "$ah/.claude-shared/projects" ]; check 'a Claude launch wires every Claude account into the shared store under that home' $?
[ ! -e "$ah/.codex-42/projects" ]; check 'a Codex launch leaves the Claude wiring alone' $?
is_link "$ah/.codex-42/sessions" && is_link "$ah/.codex-1/sessions" && [ -d "$ah/.codex/sessions" ]; check "a Codex launch wires every numbered Codex home into plain codex's history" $?
# a real launch, against a stand-in codex that reports what it was given
printf '#!/bin/sh\necho "HOME=$CODEX_HOME ARGS=$*"\nfor f in "$LIMPET_AGENT_RUN"/*.json; do [ -f "$f" ] && { echo "NOTE=$(basename "$f")"; cat "$f"; echo; }; done\n' > "$TMP/bin/codex"; chmod +x "$TMP/bin/codex"
savedCodexHome=${CODEX_HOME:-}
out=$(codex1 resume xyz)
contains "$out" "HOME=$ah/.codex-1 ARGS=resume xyz"; check 'codex1 launches Codex with CODEX_HOME at ~/.codex-1, arguments intact' $?
contains "$out" "NOTE=$$.json" && contains "$out" '"cmd":"codex1"' && contains "$out" "\"pid\":$$,"; check 'while it runs, the shell notes that it launched codex1 (for the app)' $?
[ ! -f "$ah/run/$$.json" ] && [ "${CODEX_HOME:-}" = "$savedCodexHome" ]; check 'the note goes and CODEX_HOME is put back when it exits' $?
printf '{"cmd":"codex9","pid":999999,"startedAt":1}' > "$ah/run/999999.json"
codex1 resume xyz >/dev/null; [ ! -f "$ah/run/999999.json" ]; check 'a note left by a dead shell is cleared on the next launch' $?
rm -f "$TMP/bin/codex"
limpet_invoke_agent claude01 --limpet-plan 2>/dev/null; [ $? = 1 ]; check 'a leading zero is not an account' $?
nosuchlimpetcommand >/dev/null 2>&1; [ $? = 127 ]; check 'other unknown commands still fail normally (127)' $?
n=0; for c in claude codex copilot; do type "$c" 2>/dev/null | grep -q function && n=$((n + 1)); done; [ $n = 0 ]; check 'plain claude, codex and copilot are never shadowed' $?
type agy 2>/dev/null | grep -q function; check 'plain agy goes through the wrapper (its login may be swapped out)' $?
out=$(claude10 2>&1); contains "$out" 'not on PATH'; check 'a missing CLI is reported, not crashed on' $?

# ---- the rc files the app uses ----
if command -v zsh >/dev/null 2>&1; then
  uz="$TMP/userzdot"; mkdir -p "$uz"
  printf 'export U_ENV=1\n' > "$uz/.zshenv"; printf 'export U_PROFILE=1\n' > "$uz/.zprofile"; printf 'export U_RC=1\nalias mine=echo\n' > "$uz/.zshrc"; printf 'export U_LOGIN=1\n' > "$uz/.zlogin"
  out=$(skip_global_compinit=1 ZDOTDIR="$REPO/shell/rc/zsh" LIMPET_USER_ZDOTDIR="$uz" LIMPET_SHELL_DIR="$REPO/shell" zsh -ilc 'echo "env=$U_ENV profile=$U_PROFILE rc=$U_RC login=$U_LOGIN zdot=$ZDOTDIR"; type xssh >/dev/null && echo HAVE_XSSH; alias mine' 2>/dev/null)
  contains "$out" 'env=1 profile=1 rc=1 login=1'; check "zsh rc: the user's .zshenv/.zprofile/.zshrc/.zlogin all run" $?
  contains "$out" HAVE_XSSH && contains "$out" 'mine=echo'; check 'zsh rc: limpet loads on top of the user rc' $?
  contains "$out" "zdot=$uz"; check "zsh rc: ZDOTDIR is handed back to the user's" $?
  out=$(skip_global_compinit=1 ZDOTDIR="$REPO/shell/rc/zsh" LIMPET_USER_ZDOTDIR="$TMP/nouser" LIMPET_SHELL_DIR="$REPO/shell" zsh -ilc 'echo "zdot=[$ZDOTDIR]"; type xssh >/dev/null && echo HAVE_XSSH' 2>/dev/null)
  contains "$out" HAVE_XSSH && contains "$out" "zdot=[$TMP/nouser]"; check 'zsh rc: works with no user rc files at all' $?
fi
if command -v bash >/dev/null 2>&1; then
  bh="$TMP/bashhome"; mkdir -p "$bh"; printf 'export B_PROFILE=1\n' > "$bh/.bash_profile"; printf 'export B_RC=1\n' > "$bh/.bashrc"
  out=$(HOME="$bh" LIMPET_SHELL_DIR="$REPO/shell" bash --rcfile "$REPO/shell/rc/bash/limpet-rc.bash" -ic 'echo "profile=$B_PROFILE rc=$B_RC"; type xssh >/dev/null && echo HAVE_XSSH' 2>/dev/null)
  contains "$out" 'profile=1 rc=1' && contains "$out" HAVE_XSSH; check "bash rc: the user's profile and .bashrc run, then limpet" $?
  printf 'source "%s"\n' "$REPO/shell/limpet.sh" > "$bh/.bashrc"
  out=$(HOME="$bh" LIMPET_SHELL_DIR="$REPO/shell" bash --rcfile "$REPO/shell/rc/bash/limpet-rc.bash" -ic 'type xssh >/dev/null && echo HAVE_XSSH' 2>/dev/null)
  contains "$out" HAVE_XSSH; check 'bash: a ~/.bashrc that sources limpet.sh does not loop' $?
fi

# ---- install.sh ----
ih="$TMP/installhome"; mkdir -p "$ih"; printf 'export OLD=1\n' > "$ih/.zshrc"
( cd "$TMP" && HOME="$ih" SHELL=/bin/zsh LIMPET_SKIP_NPM=1 sh "$REPO/install.sh" >/dev/null 2>&1 )
grep -qF "source \"$REPO/shell/limpet.sh\"" "$ih/.zshrc" && grep -q '>>> limpet >>>' "$ih/.zshrc" && grep -q 'export OLD=1' "$ih/.zshrc"; check 'install.sh adds the limpet block to ~/.zshrc' $?
( cd "$TMP" && HOME="$ih" SHELL=/bin/zsh LIMPET_SKIP_NPM=1 sh "$REPO/install.sh" >/dev/null 2>&1 )
[ "$(grep -c '>>> limpet >>>' "$ih/.zshrc")" = 1 ]; check 'install.sh is idempotent' $?
sed -i.bak "s#source \"$REPO/shell/limpet.sh\"#source \"/old/place/shell/limpet.sh\"#" "$ih/.zshrc" && rm -f "$ih/.zshrc.bak"
( cd "$TMP" && HOME="$ih" SHELL=/bin/zsh LIMPET_SKIP_NPM=1 sh "$REPO/install.sh" >/dev/null 2>&1 )
grep -qF "source \"$REPO/shell/limpet.sh\"" "$ih/.zshrc" && ! grep -q '/old/place' "$ih/.zshrc" && [ "$(grep -c '>>> limpet >>>' "$ih/.zshrc")" = 1 ]; check 'install.sh updates a moved repo path inside the block' $?
( cd "$TMP" && HOME="$ih" SHELL=/bin/bash LIMPET_SKIP_NPM=1 sh "$REPO/install.sh" >/dev/null 2>&1 )
grep -qF "source \"$REPO/shell/limpet.sh\"" "$ih/.bashrc"; check 'install.sh wires ~/.bashrc when bash is the login shell' $?

# ---- the bootstrap templates match the PowerShell module's ----
tplR=$(sed -n "s/^_LIMPET_TPL_RESUME='\(.*\)'\$/\1/p" "$REPO/shell/limpet.sh")
tplP=$(sed -n "s/^_LIMPET_TPL_PLAIN='\(.*\)'\$/\1/p" "$REPO/shell/limpet.sh")
psTpls=$(tr -d '\r' < "$REPO/shell/Limpet.psm1" | sed -n "s/^ *\$tpl = '\(.*\)'\$/\1/p" | sed "s/''/'/g")
printf '%s\n' "$psTpls" | grep -qxF "$tplR" && printf '%s\n' "$psTpls" | grep -qxF "$tplP"; check 'bootstrap templates are byte-identical to Limpet.psm1' $?

echo
echo "$pass passed, $fail failed ($SHELL_NAME)"
[ "$fail" = 0 ]
