# limpet: the user's .zshrc first (so their prompt, aliases and plugins are
# exactly as in any other terminal), then limpet's integration on top.
if [ -f "$LIMPET_USER_ZDOTDIR/.zshrc" ]; then
  ZDOTDIR=$LIMPET_USER_ZDOTDIR
  . "$LIMPET_USER_ZDOTDIR/.zshrc"
fi
ZDOTDIR=$LIMPET_ZDOTDIR
if [ -n "${LIMPET_SHELL_DIR:-}" ] && [ -f "$LIMPET_SHELL_DIR/limpet.sh" ]; then
  . "$LIMPET_SHELL_DIR/limpet.sh"
elif [ -f "$LIMPET_ZDOTDIR/../../limpet.sh" ]; then
  . "$LIMPET_ZDOTDIR/../../limpet.sh"
fi
