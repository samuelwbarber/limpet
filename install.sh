#!/bin/sh
# limpet installer for macOS and Linux. Wires everything up without copying
# anything around:
#   * adds `source .../shell/limpet.sh` to ~/.zshrc (and ~/.bashrc when bash
#     is your login shell), inside a marked block it can update later
#   * installs the app's dependencies in app/ (npm run setup, or npm install)
# Re-running is safe (idempotent).
set -e
repo=$(cd "$(dirname "$0")" && pwd -P)
module="$repo/shell/limpet.sh"
marker_start='# >>> limpet >>>'
marker_end='# <<< limpet <<<'
line="source \"$module\""

printf 'limpet repo: %s\n' "$repo"

wire() {
  rc=$1
  if [ -f "$rc" ] && grep -qF "$marker_start" "$rc"; then
    if grep -qF "$line" "$rc"; then
      printf '%s already loads limpet; left unchanged.\n' "$rc"
    else
      tmp=$(mktemp)
      awk -v start="$marker_start" -v end="$marker_end" -v line="$line" '
        $0 == start { print; print line; skip = 1; next }
        $0 == end { skip = 0 }
        !skip { print }
      ' "$rc" > "$tmp" && cat "$tmp" > "$rc" && rm -f "$tmp"
      printf 'Updated the limpet path in %s\n' "$rc"
    fi
  else
    printf '\n%s\n%s\n%s\n' "$marker_start" "$line" "$marker_end" >> "$rc"
    printf 'Added limpet to %s\n' "$rc"
  fi
}

wire "$HOME/.zshrc"
case "${SHELL:-}" in */bash) wire "$HOME/.bashrc" ;; esac

if [ "${LIMPET_SKIP_NPM:-}" = 1 ]; then
  :
elif command -v npm >/dev/null 2>&1; then
  if [ -d "$repo/app" ]; then
    cd "$repo/app"
    if grep -q '"setup"' package.json 2>/dev/null; then npm run setup; else npm install; fi
    cd "$repo"
  fi
else
  printf 'npm not found: install Node 22+ and run "npm install" in %s/app for the limpet app.\n' "$repo"
fi

printf '\nDone. Open a new terminal (or run: source "%s") to get xssh, peek, limpet-enroll and the agent accounts.\n' "$module"
printf 'The limpet app: cd "%s/app" && npm start   (or install the .dmg from the GitHub release)\n' "$repo"
