# limpet: rc file for a bash the app starts (bash --rcfile <this> -i).
# --rcfile skips the user's own files, so run them the way a login shell on
# macOS would (profile first, then .bashrc), then limpet's integration.
if [ -f /etc/profile ]; then . /etc/profile; fi
if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -f "$HOME/.profile" ]; then . "$HOME/.profile"; fi
case "${BASH_SOURCE_BASHRC_DONE:-}" in
  '') if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi ;;
esac
if [ -n "${LIMPET_SHELL_DIR:-}" ] && [ -f "$LIMPET_SHELL_DIR/limpet.sh" ]; then
  . "$LIMPET_SHELL_DIR/limpet.sh"
else
  _limpet_rc_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
  [ -f "$_limpet_rc_dir/limpet.sh" ] && . "$_limpet_rc_dir/limpet.sh"
  unset _limpet_rc_dir
fi
