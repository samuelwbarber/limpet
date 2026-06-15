# winux shell integration. Loaded into a remote session by `xssh` (sent fresh
# each connect; nothing is persisted on the server). Defines peek/download/upload
# which talk back to the winux app via escape sequences.

[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"

_winux_b64() { base64 | tr -d '\n'; }

# Show an image inline in the winux window (iTerm2 inline-image protocol).
peek() {
  local f
  if [ "$#" -eq 0 ]; then echo "usage: peek <image> [...]" >&2; return 1; fi
  for f in "$@"; do
    if [ ! -f "$f" ]; then echo "peek: $f: not found" >&2; continue; fi
    printf '\033]1337;File=name=%s;size=%s;inline=1;preserveAspectRatio=1:%s\007' \
      "$(printf '%s' "${f##*/}" | _winux_b64)" "$(wc -c < "$f")" "$(_winux_b64 < "$f")"
    printf '\n'
  done
}

# Send a remote file to the PC's Downloads folder (winux catches OSC 5379).
download() {
  local f
  if [ "$#" -eq 0 ]; then echo "usage: download <remote-file> [...]" >&2; return 1; fi
  for f in "$@"; do
    if [ ! -f "$f" ]; then echo "download: $f: not found" >&2; continue; fi
    printf '\033]5379;download;%s;%s\007' \
      "$(printf '%s' "${f##*/}" | _winux_b64)" "$(_winux_b64 < "$f")"
    echo "download: $f -> PC Downloads"
  done
}

# Ask the winux app to push a local PC file into the current remote directory.
upload() {
  local p
  if [ "$#" -eq 0 ]; then echo "usage: upload <local-path-on-pc> [...]" >&2; return 1; fi
  for p in "$@"; do
    printf '\033]5379;upload;%s;%s\007' \
      "$(printf '%s' "$p" | _winux_b64)" "$(printf '%s' "$PWD" | _winux_b64)"
  done
}

# Dock a webpage on the right side of the winux window. No args toggles the
# Instagram reels feed; pass a URL to open something else.
reels() {
  printf '\033]5379;reels;%s\007' "$(printf '%s' "${1:-}" | _winux_b64)"
}
