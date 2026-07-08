#!/bin/bash
# Tests for shell/limpet-remote.sh (the helpers xssh injects into remote
# sessions) and for the bootstrap templates in shell/Limpet.psm1 -- the exact
# strings PowerShell sends over ssh. Runs on any Linux with coreutils; the
# tmux resume test is skipped when tmux/script are unavailable.
cd "$(dirname "$0")/.." || exit 1

pass=0; fail=0
check() { if [ "$2" = 0 ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
BEL=$'\007'

# ---- syntax ----
bash -n shell/limpet-remote.sh; check 'bash syntax' $?
sh -n shell/limpet-remote.sh;   check 'POSIX sh syntax' $?

# ---- source: definitions + export -f ----
. shell/limpet-remote.sh
for fn in peek download upload reels xssh _limpet_img_rows _limpet_b64; do
  type "$fn" >/dev/null 2>&1; check "defines $fn" $?
done
bash -c 'type peek >/dev/null 2>&1 && type download >/dev/null 2>&1'
check 'helpers survive a child bash (export -f)' $?

# ---- _limpet_img_rows: formats and clamps ----
mkpng() { # $1 = pixel height, $2 = path (header-only PNG, enough for the parser)
  printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01' > "$2"
  printf "\\x$(printf %02x $(($1 >> 24 & 255)))\\x$(printf %02x $(($1 >> 16 & 255)))\\x$(printf %02x $(($1 >> 8 & 255)))\\x$(printf %02x $(($1 & 255)))" >> "$2"
}
mkpng 200 "$TMP/p200.png"
[ "$(_limpet_img_rows "$TMP/p200.png")" = 12 ]; check 'PNG 200px -> 12 rows' $?
mkpng 10 "$TMP/p10.png"
[ "$(_limpet_img_rows "$TMP/p10.png")" = 2 ]; check 'small images clamp to 2 rows' $?
mkpng 4000 "$TMP/p4k.png"
[ "$(_limpet_img_rows "$TMP/p4k.png")" = 22 ]; check 'tall images clamp to 22 rows' $?
printf 'GIF89a\x0a\x00\x5a\x00' > "$TMP/g.gif"       # height 90, little-endian
[ "$(_limpet_img_rows "$TMP/g.gif")" = 5 ]; check 'GIF height parsed (90px -> 5 rows)' $?
{ printf 'BM'; dd if=/dev/zero bs=1 count=20 2>/dev/null; printf '\x24\x00\x00\x00'; } > "$TMP/b.bmp"  # height 36 at offset 22
[ "$(_limpet_img_rows "$TMP/b.bmp")" = 2 ]; check 'BMP height parsed' $?
printf 'not an image' > "$TMP/x.bin"
[ "$(_limpet_img_rows "$TMP/x.bin")" = 18 ]; check 'unknown format falls back to 18 rows' $?

# ---- peek protocol ----
# sentinel X keeps $() from stripping peek's trailing reserved newlines
out=$(peek "$TMP/p200.png"; printf X); out=${out%X}
case "$out" in *']1337;File=name='*) check 'peek emits OSC 1337 File' 0;; *) check 'peek emits OSC 1337 File' 1;; esac
case "$out" in *";rows=12:"*) check 'peek tags rows from pixel height' 0;; *) check 'peek tags rows from pixel height' 1;; esac
case "$out" in *";size=$(wc -c < "$TMP/p200.png" | tr -d ' ');"*) check 'peek reports the byte size' 0;; *) check 'peek reports the byte size' 1;; esac
payload=${out#*:}; payload=${payload%%"$BEL"*}
printf %s "$payload" | base64 -d 2>/dev/null | cmp -s - "$TMP/p200.png"
check 'peek payload base64 round-trips' $?
tail_nl=${out#*"$BEL"}
[ "$(printf %s "$tail_nl" | wc -l | tr -d ' ')" = 12 ]; check 'peek reserves exactly rows newlines' $?
out2=$(peek "$TMP/p200.png" "$TMP/p10.png")
[ "$(printf %s "$out2" | grep -aoc ']1337;')" = 2 ]; check 'peek handles multiple files' $?
peek "$TMP/nope.png" 2> "$TMP/err" >/dev/null
grep -q 'not found' "$TMP/err"; check 'peek reports missing files' $?
peek 2>/dev/null; [ $? = 1 ]; check 'peek with no args exits 1' $?

# ---- download / upload / reels protocol ----
printf 'hello limpet' > "$TMP/file.txt"
out=$(download "$TMP/file.txt")
case "$out" in *']5379;download;ZmlsZS50eHQ=;aGVsbG8gbGltcGV0'"$BEL"*) check 'download emits name+content b64' 0;; *) check 'download emits name+content b64' 1;; esac
case "$out" in *'PC Downloads'*) check 'download confirms on screen' 0;; *) check 'download confirms on screen' 1;; esac
download "$TMP/nope.txt" 2> "$TMP/err" >/dev/null
grep -q 'not found' "$TMP/err"; check 'download reports missing files' $?

pwd64=$(printf %s "$TMP" | base64 | tr -d '\n')
out=$(cd "$TMP" && upload '/pc/path file.txt')
case "$out" in *']5379;upload;L3BjL3BhdGggZmlsZS50eHQ=;'"$pwd64$BEL"*) check 'upload sends pc path + remote cwd' 0;; *) check 'upload sends pc path + remote cwd' 1;; esac

out=$(reels 'https://x')
case "$out" in *']5379;reels;aHR0cHM6Ly94'"$BEL"*) check 'reels sends the url' 0;; *) check 'reels sends the url' 1;; esac
out=$(reels)
case "$out" in *']5379;reels;'"$BEL"*) check 'bare reels toggles' 0;; *) check 'bare reels toggles' 1;; esac

# ---- remote xssh hop (ssh stubbed on PATH) ----
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nprintf "%%s\\n" "$@" > "$SSH_CAPTURE"\n' > "$TMP/bin/ssh"
chmod +x "$TMP/bin/ssh"
export PATH="$TMP/bin:$PATH" SSH_CAPTURE="$TMP/sshargs"

unset LIMPET_SH
xssh host1 2> "$TMP/hoperr"
grep -q 'plain ssh' "$TMP/hoperr"; check 'hop without LIMPET_SH warns and falls back' $?
grep -qx 'host1' "$SSH_CAPTURE"; check 'fallback passes args through' $?

export LIMPET_SH="$PWD/shell/limpet-remote.sh"
xssh host2 >/dev/null 2>&1
grep -qx -- '-t' "$SSH_CAPTURE"; check 'hop forces a tty' $?
grep -q 'base64 -d' "$SSH_CAPTURE"; check 'hop re-injects the helpers' $?
grep -q 'LIMPET_SH' "$SSH_CAPTURE"; check 'hop chains LIMPET_SH onward' $?

# ---- the real bootstrap templates out of Limpet.psm1 ----
mapfile -t TPLS < <(sed -n "s/^ *\$tpl = '\(.*\)'\$/\1/p" shell/Limpet.psm1 | sed "s/''/'/g")
[ "${#TPLS[@]}" = 2 ]; check 'found both bootstrap templates in Limpet.psm1' $?
b64=$(base64 -w0 shell/limpet-remote.sh)
RESUME=''; PLAIN=''
for t in "${TPLS[@]}"; do
  case "$t" in *tmux*) RESUME=${t/__B64__/$b64};; *) PLAIN=${t/__B64__/$b64};; esac
done
[ -n "$RESUME" ] && [ -n "$PLAIN" ]; check 'templates split into resume/plain' $?

printf 'type peek >/dev/null 2>&1 && echo BOOT-OK\nexit\n' | sh -c "$PLAIN" 2>/dev/null | grep -qa 'BOOT-OK'
check 'plain bootstrap defines helpers in an interactive bash' $?

printf 'type peek >/dev/null 2>&1 && echo SH-OK\nexit\n' | ENV="$PWD/shell/limpet-remote.sh" sh -i 2>/dev/null | grep -qa 'SH-OK'
check 'bash-less fallback: ENV= loads helpers in plain sh' $?

if command -v tmux >/dev/null 2>&1 && command -v script >/dev/null 2>&1; then
  tmux kill-session -t limpet 2>/dev/null
  export BOOT="$RESUME"
  { sleep 2; printf 'export M=alive; type peek >/dev/null 2>&1 && echo TMUX-OK\n'; sleep 1; printf 'tmux detach\n'; sleep 1; } \
    | script -qec 'sh -c "$BOOT"' /dev/null > "$TMP/t1.log" 2>&1
  grep -qa 'TMUX-OK' "$TMP/t1.log"; check 'resume bootstrap: helpers live inside tmux' $?
  { sleep 2; printf '[ "$M" = alive ] && echo TMUX-RESUMED\n'; sleep 1; printf 'tmux kill-session -t limpet\n'; sleep 1; } \
    | script -qec 'sh -c "$BOOT"' /dev/null > "$TMP/t2.log" 2>&1
  grep -qa 'TMUX-RESUMED' "$TMP/t2.log"; check 'resume bootstrap: reconnect resumes the same shell' $?
else
  echo 'SKIP  tmux/script unavailable: resume bootstrap untested'
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
