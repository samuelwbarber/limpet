#!/bin/sh
# A stand-in for `codex app-server`, for the reindex test: newline-delimited
# JSON-RPC over stdio. Answers initialize, serves thread/list in two pages
# (one thread with a blank name), and logs thread/name/set calls to
# $FAKE_APPSERVER_LOG. CODEX_HOME is echoed into the log so the test can see
# which home it was pointed at.
log=${FAKE_APPSERVER_LOG:-/dev/null}
printf 'home=%s\n' "${CODEX_HOME:-}" >> "$log"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{"userAgent":"fake"}}\n' "$id" ;;
    *'"method":"initialized"'*) ;;
    *'"method":"thread/list"'*)
      printf 'list=%s\n' "$line" >> "$log"
      case "$line" in
        *'"cursor":"p2"'*)
          printf '{"id":%s,"result":{"data":[{"id":"01a00000-0000-7000-8000-00000000cccc","name":"already named","cwd":"/x"}],"nextCursor":null}}\n' "$id" ;;
        *'"archived":true'*)
          printf '{"id":%s,"result":{"data":[],"nextCursor":null}}\n' "$id" ;;
        *)
          printf '{"id":%s,"result":{"data":[{"id":"01a00000-0000-7000-8000-00000000aaaa","preview":"hi","name":null,"cwd":"/x"},{"id":"01a00000-0000-7000-8000-00000000bbbb","name":"","cwd":"/y"}],"nextCursor":"p2"}}\n' "$id" ;;
      esac ;;
    *'"method":"thread/name/set"'*)
      printf 'name=%s\n' "$line" >> "$log"
      printf '{"id":%s,"result":{}}\n' "$id" ;;
    *) [ -n "$id" ] && printf '{"id":%s,"error":{"message":"unknown method"}}\n' "$id" ;;
  esac
done
