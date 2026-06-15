# Supported commands

Each command parses the listed flags and forwards to the cmdlet shown. Flags can
be clustered (`-rf`), long (`--force`), or take values (`-n 5`, `-n5`, `--lines=5`).
Anything after `--` is treated as a path.

| Command | Flags handled | Maps to | Notes |
|---------|---------------|---------|-------|
| `ls`    | `-a -l -R -t -S -r` | `Get-ChildItem` | `-a`=hidden, `-l`=long table, `-t/-S`=sort by time/size, `-r`=reverse |
| `rm`    | `-r -f` | `Remove-Item` | `-f` also silences errors |
| `cp`    | `-r -f` | `Copy-Item` | last path = destination |
| `mv`    | `-f` | `Move-Item` | last path = destination |
| `mkdir` | `-p` | `New-Item -ItemType Directory` | `-p` creates parents / no error if exists |
| `touch` | — | `New-Item` / set `LastWriteTime` | creates file or bumps timestamp |
| `cat`   | `-n` | `Get-Content` | `-n` numbers lines; reads pipeline too |
| `head`  | `-n N` / `-N` | `Select-Object -First` | default 10; pipeline or file |
| `tail`  | `-n N` / `-N`, `-f` | `Get-Content -Tail` / `-Wait` | `-f` follows; pipeline or file |
| `grep`  | `-i -v -r` | `Select-String` | case-sensitive by default; `-i` ignore case, `-v` invert, `-r` recurse files |
| `find`  | `-name`, `-iname`, `-type f\|d` | `Get-ChildItem -Recurse` | subset of GNU find |
| `which` | — | `Get-Command` | prints path / alias target |
| `du`    | — | `Get-ChildItem -Recurse` + sum | human-readable totals |
| `df`    | — | `Get-PSDrive` | free/used per filesystem |
| `chmod` | — | (warns) | no-op on Windows; use `icacls` |

## Notes & limits

- `cp`/`mv` use Unix order: `cp a b c dest` copies `a b c` into `dest`.
- `grep` is regex-based (like real grep). For literal matches, escape regex chars.
- `find` covers `-name`/`-type` only; complex predicates aren't translated.
- `chmod` intentionally does nothing — NTFS permissions are ACL-based.
- The full PowerShell language and every cmdlet remain available unchanged; this
  only shadows the listed names.

## Resilient SSH: `xssh`

A drop-in replacement for `ssh` — same arguments, plus it auto-reconnects
(silently, via your key) when the link drops and injects keepalives so drops are
detected fast.

```powershell
xssh user@host
xssh -p 2222 root@1.2.3.4
xssh user@host -t "tmux attach -t main || tmux new -s main"   # survive drops via tmux
```

It stops cleanly when you log out/detach, and won't loop on a bad host or auth
failure (a near-instant ssh failure is treated as fatal, not a drop). Reconnect
is fully client-side; surviving a drop with your programs intact needs `tmux` (or
similar) on the remote — see the `-t` example.

## Uploading files: `wput`

Client-side-only upload over `scp` (passwordless via your key; needs only `sshd`
on the server). Defaults `-To` to your last `xssh` host.

```powershell
wput report.pdf                 # -> last xssh host, remote home (~)
wput .\build -Dest /var/www     # specific remote directory
wput a.txt b.txt -To me@host -Port 2222 -Key C:\path\id_ed25519
```

Drag-and-drop: at a **local** prompt type `wput `, drag the files (WezTerm pastes
the paths), Enter. The drop must land in a local pane (WezTerm has no drop event,
and a drop on a live SSH pane goes to the remote shell). The remote *current*
directory can't be detected client-side — pass `-Dest` for a specific folder.

## Restoring the original aliases

`Remove-Module Winux` restores the built-in `ls/cp/mv/rm/cat` aliases for the
current session.
