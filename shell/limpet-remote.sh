# limpet shell integration. Loaded into a remote session by `xssh` (sent fresh
# each connect; nothing is persisted on the server). Defines peek/download/upload
# which talk back to the limpet app via escape sequences.

# bash --rcfile skips ~/.bashrc, so restore it -- but only under bash: plain
# sh (the ENV= fallback) would choke on bashisms in it.
[ -n "${BASH_VERSION:-}" ] && [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"

_limpet_b64() { base64 | tr -d '\n'; }

# Emit a raw escape sequence to the terminal. Inside tmux the outer terminal
# (the limpet app) never sees our OSC sequences -- tmux swallows anything it
# doesn't recognise -- so wrap them in tmux's passthrough (DCS tmux; ... ST,
# every ESC doubled) and turn passthrough on for this pane. tmux then forwards
# the un-escaped bytes straight to the app. Outside tmux it's a plain print.
_LIMPET_ESC=$(printf '\033')
_limpet_emit() {
  if [ -n "${TMUX:-}" ]; then
    [ -n "${_LIMPET_PT:-}" ] || { tmux set -p allow-passthrough on 2>/dev/null; _LIMPET_PT=1; }
    printf '\033Ptmux;'
    printf '%s' "$1" | sed "s/$_LIMPET_ESC/$_LIMPET_ESC$_LIMPET_ESC/g"
    printf '\033\\'
  else
    printf '%s' "$1"
  fi
}

# Display height in terminal rows for an image (~18 px per row). Parses the
# pixel height from PNG/GIF/BMP headers; other formats fall back to 18 rows.
# The limpet app fits the image into the rows preserving aspect, so this only
# sets the scale — but the row count itself must be exact (see peek below).
_limpet_img_rows() {
  h=$(od -An -N32 -tu1 "$1" 2>/dev/null | tr -s ' ' '\n' | grep . | {
    read -r b0; read -r b1; read -r b2; read -r b3; read -r b4; read -r b5
    read -r b6; read -r b7; read -r b8; read -r b9; read -r b10; read -r b11
    read -r b12; read -r b13; read -r b14; read -r b15; read -r b16; read -r b17
    read -r b18; read -r b19; read -r b20; read -r b21; read -r b22; read -r b23
    read -r b24; read -r b25; read -r b26; read -r b27; read -r _rest
    if [ "$b0" = 137 ] && [ "$b1" = 80 ]; then          # PNG: IHDR height, big-endian
      echo $(( b20*16777216 + b21*65536 + b22*256 + b23 ))
    elif [ "$b0" = 71 ] && [ "$b1" = 73 ]; then         # GIF: height, little-endian
      echo $(( b9*256 + b8 ))
    elif [ "$b0" = 66 ] && [ "$b1" = 77 ]; then         # BMP: height, little-endian
      echo $(( b23*256 + b22 ))
    else
      echo 0
    fi
  })
  rows=18
  [ -n "$h" ] && [ "$h" -gt 0 ] 2>/dev/null && rows=$(( (h + 17) / 18 ))
  [ "$rows" -lt 2 ] && rows=2
  [ "$rows" -gt 22 ] && rows=22
  echo "$rows"
}

# Show an image inline in the limpet window. The image is streamed over the
# limpet-private OSC 5379 channel as a header, many small base64 chunks, and a
# finish marker; the app reassembles them and draws the image. Chunking is not
# cosmetic: ConPTY buffers an incomplete OSC until its terminator but drops it
# whole once it grows past an internal limit, and a slow/lossy link delivers a
# big image in fragments that force that buffering — so a single giant OSC would
# vanish for large images. Each chunk stays well under the limit. ConPTY still
# can't know an image occupies screen rows, so peek prints N real newlines to
# reserve blank rows for the app to draw over; otherwise the next prompt would
# overdraw the image.
peek() {
  local f rows i name64 size
  if [ "$#" -eq 0 ]; then echo "usage: peek <image> [...]" >&2; return 1; fi
  for f in "$@"; do
    if [ ! -f "$f" ]; then echo "peek: $f: not found" >&2; continue; fi
    rows=$(_limpet_img_rows "$f")
    name64=$(printf '%s' "${f##*/}" | _limpet_b64)
    size=$(wc -c < "$f" | tr -d ' ')
    _limpet_emit "$(printf '\033]5379;peek;h;%s;%s;%s\007' "$name64" "$size" "$rows")"
    # `|| [ -n "$_chunk" ]` emits fold's final piece, which has no trailing
    # newline and would otherwise be dropped by read (truncating the image).
    _limpet_b64 < "$f" | fold -w 16384 | while IFS= read -r _chunk || [ -n "$_chunk" ]; do
      _limpet_emit "$(printf '\033]5379;peek;d;%s\007' "$_chunk")"
    done
    _limpet_emit "$(printf '\033]5379;peek;f\007')"
    i=0; while [ "$i" -lt "$rows" ]; do printf '\n'; i=$((i+1)); done
  done
}

# Send a remote file to the PC's Downloads folder (limpet catches OSC 5379).
download() {
  local f
  if [ "$#" -eq 0 ]; then echo "usage: download <remote-file> [...]" >&2; return 1; fi
  for f in "$@"; do
    if [ ! -f "$f" ]; then echo "download: $f: not found" >&2; continue; fi
    _limpet_emit "$(printf '\033]5379;download;%s;%s\007' \
      "$(printf '%s' "${f##*/}" | _limpet_b64)" "$(_limpet_b64 < "$f")")"
    echo "download: $f -> PC Downloads"
  done
}

# Ask the limpet app to push a local PC file into the current remote directory.
upload() {
  local p
  if [ "$#" -eq 0 ]; then echo "usage: upload <local-path-on-pc> [...]" >&2; return 1; fi
  for p in "$@"; do
    _limpet_emit "$(printf '\033]5379;upload;%s;%s\007' \
      "$(printf '%s' "$p" | _limpet_b64)" "$(printf '%s' "$PWD" | _limpet_b64)")"
  done
}

# Dock a webpage on the right side of the limpet window. No args toggles the
# Instagram reels feed; pass a URL to open something else.
reels() {
  _limpet_emit "$(printf '\033]5379;reels;%s\007' "$(printf '%s' "${1:-}" | _limpet_b64)")"
}

# Hop to another host WITH the limpet helpers: `xssh gpu19` from a login node
# re-injects this script into the next interactive session, so peek/download/
# upload keep working on multi-hop clusters. Plain `ssh` never carries them.
xssh() {
  if [ -z "$LIMPET_SH" ] || [ ! -f "$LIMPET_SH" ]; then
    echo "xssh: limpet script not available in this session; using plain ssh" >&2
    command ssh "$@"
    return
  fi
  _b64=$(base64 < "$LIMPET_SH" | tr -d '\n')
  command ssh -t "$@" "f=\$(mktemp); printf %s '$_b64' | base64 -d > \$f; export LIMPET_SH=\$f; if command -v bash >/dev/null 2>&1; then bash --rcfile \$f -i; else ENV=\$f sh -i; fi; rm -f \$f"
  unset _b64
}

# In bash, export the functions so they survive child shells on the same
# environment: tmux, a nested `bash`, or `srun --pty bash` (slurm forwards the
# environment, BASH_FUNC_* included, to the compute node).
if [ -n "$BASH_VERSION" ]; then
  export _LIMPET_ESC
  export -f _limpet_b64 _limpet_emit _limpet_img_rows peek download upload reels xssh 2>/dev/null
fi
