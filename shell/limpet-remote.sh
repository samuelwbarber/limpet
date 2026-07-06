# limpet shell integration. Loaded into a remote session by `xssh` (sent fresh
# each connect; nothing is persisted on the server). Defines peek/download/upload
# which talk back to the limpet app via escape sequences.

[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"

_limpet_b64() { base64 | tr -d '\n'; }

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

# Show an image inline in the limpet window (iTerm2 inline-image protocol, plus
# a limpet-private rows=N field). ConPTY on the PC can't know an image occupies
# screen rows, so peek prints N real newlines to reserve blank rows and the
# limpet app draws the image over them — without this the next prompt would
# overdraw the image.
peek() {
  local f rows i
  if [ "$#" -eq 0 ]; then echo "usage: peek <image> [...]" >&2; return 1; fi
  for f in "$@"; do
    if [ ! -f "$f" ]; then echo "peek: $f: not found" >&2; continue; fi
    rows=$(_limpet_img_rows "$f")
    printf '\033]1337;File=name=%s;size=%s;inline=1;preserveAspectRatio=1;rows=%s:%s\007' \
      "$(printf '%s' "${f##*/}" | _limpet_b64)" "$(wc -c < "$f" | tr -d ' ')" "$rows" "$(_limpet_b64 < "$f")"
    i=0; while [ "$i" -lt "$rows" ]; do printf '\n'; i=$((i+1)); done
  done
}

# Send a remote file to the PC's Downloads folder (limpet catches OSC 5379).
download() {
  local f
  if [ "$#" -eq 0 ]; then echo "usage: download <remote-file> [...]" >&2; return 1; fi
  for f in "$@"; do
    if [ ! -f "$f" ]; then echo "download: $f: not found" >&2; continue; fi
    printf '\033]5379;download;%s;%s\007' \
      "$(printf '%s' "${f##*/}" | _limpet_b64)" "$(_limpet_b64 < "$f")"
    echo "download: $f -> PC Downloads"
  done
}

# Ask the limpet app to push a local PC file into the current remote directory.
upload() {
  local p
  if [ "$#" -eq 0 ]; then echo "usage: upload <local-path-on-pc> [...]" >&2; return 1; fi
  for p in "$@"; do
    printf '\033]5379;upload;%s;%s\007' \
      "$(printf '%s' "$p" | _limpet_b64)" "$(printf '%s' "$PWD" | _limpet_b64)"
  done
}

# Dock a webpage on the right side of the limpet window. No args toggles the
# Instagram reels feed; pass a URL to open something else.
reels() {
  printf '\033]5379;reels;%s\007' "$(printf '%s' "${1:-}" | _limpet_b64)"
}
