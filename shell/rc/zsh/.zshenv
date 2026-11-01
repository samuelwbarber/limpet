# limpet: loaded first by every zsh the app starts (ZDOTDIR points here).
# The user's own .zshenv runs as usual from LIMPET_USER_ZDOTDIR; limpet's
# ZDOTDIR is put back after, so .zprofile/.zshrc/.zlogin come from here too.
LIMPET_ZDOTDIR=${ZDOTDIR}
LIMPET_USER_ZDOTDIR=${LIMPET_USER_ZDOTDIR:-$HOME}
export LIMPET_ZDOTDIR LIMPET_USER_ZDOTDIR
if [ -f "$LIMPET_USER_ZDOTDIR/.zshenv" ]; then
  ZDOTDIR=$LIMPET_USER_ZDOTDIR
  . "$LIMPET_USER_ZDOTDIR/.zshenv"
  ZDOTDIR=$LIMPET_ZDOTDIR
fi
