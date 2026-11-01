# limpet: the user's .zlogin, then leave ZDOTDIR as the user has it so a
# `zsh` typed in this shell behaves like any other.
if [ -f "$LIMPET_USER_ZDOTDIR/.zlogin" ]; then
  ZDOTDIR=$LIMPET_USER_ZDOTDIR
  . "$LIMPET_USER_ZDOTDIR/.zlogin"
fi
if [ "$LIMPET_USER_ZDOTDIR" = "$HOME" ]; then unset ZDOTDIR; else ZDOTDIR=$LIMPET_USER_ZDOTDIR; fi
unset LIMPET_ZDOTDIR
