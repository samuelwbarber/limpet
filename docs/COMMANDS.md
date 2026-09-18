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

Drag-and-drop: in the limpet app, dropping files onto the window during an
`xssh` session sends them straight to the remote's current directory, so `wput`
is mainly for folders, big files, or plain terminals. The remote *current*
directory can't be detected client-side; pass `-Dest` for a specific folder.

## Agent accounts: `claude` / `claude1` / `claude2` / ... and `codex` / `codex1` / ...

Run the [Claude Code](https://www.claude.com/product/claude-code) and
[Codex](https://github.com/openai/codex) CLIs under any number of separate
accounts, each with its own persistent login, while sharing one Claude
`/resume` history between all of them, plain `claude` included.

```powershell
claude                    # your usual account     (config in ~/.claude)
claude1                   # another Claude login   (config in ~/.claude-1)
claude7                   # any number: the dir    (~/.claude-7) is made on first run
codex                     # your usual Codex       (CODEX_HOME ~/.codex)
codex1                    # another Codex login    (CODEX_HOME ~/.codex-1)
claude1 --resume          # args pass straight through
codex2 resume <thread>    # likewise
Get-LimpetAgentAccounts   # every account with a config dir, and where it is
Sync-LimpetClaudeHistory  # wire the shared history by hand (numbered claude commands do it on launch)
Invoke-LimpetAgent claude3 -Arguments @('-p', 'hi')   # what the numbered commands call
```

There is no account list. A numbered command whose directory exists is defined
as a function when the module loads (so it tab-completes); any other
`claudeN` / `codexN` is caught by PowerShell's command-not-found hook and run
the same way, creating the directory. Each launch points `CLAUDE_CONFIG_DIR` or
`CODEX_HOME` at that directory for that launch only, so plain `claude` and
`codex` keep `~/.claude` and `~/.codex`. `LIMPET_AGENT_HOME` overrides where
the directories live (tests).

Every Claude account's `projects/` folder, `~/.claude`'s included, is
junctioned to a shared `~/.claude-shared/projects`, so they all list the same
sessions in `/resume`. Session files are named by unique id and never collide.
The junctions are set up automatically whenever a numbered `claude` command
runs, folding any existing `projects/` folder into the shared store file by
file without overwriting; a folder held open by a running session is left for
the next launch. The up-arrow prompt history is not shared (Claude Code won't
read it through a link). Codex accounts share nothing between them.

In the limpet app, right-click a tab to see the signed-in accounts with the
5-hour and weekly usage each has left, and to move the tab's chat to another:
the running agent is exited (Ctrl+C, then a kill if it lingers) and the
conversation is resumed under the pick in the same shell. Claude to Claude is
`--resume`; Codex to Codex copies the rollout into the other home; Claude to
Codex uses Codex's session importer; Codex to Claude writes a Claude transcript
and resumes it; if a conversion fails the chat becomes a Markdown handoff file
plus a "continue from here" prompt.

## Restoring the original aliases

`Remove-Module Limpet` restores the built-in `ls/cp/mv/rm/cat` aliases for the
current session.
