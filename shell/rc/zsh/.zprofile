# limpet: the user's .zprofile, from their own ZDOTDIR.
if [ -f "$LIMPET_USER_ZDOTDIR/.zprofile" ]; then
  ZDOTDIR=$LIMPET_USER_ZDOTDIR
  . "$LIMPET_USER_ZDOTDIR/.zprofile"
  ZDOTDIR=$LIMPET_ZDOTDIR
fi
