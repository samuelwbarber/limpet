#!/bin/sh
# ssh runs this (SSH_ASKPASS) to get the key passphrase or the cached login
# password out of LIMPET_ASKPASS, which xssh sets for that one ssh call.
printf '%s' "${LIMPET_ASKPASS:-}"
