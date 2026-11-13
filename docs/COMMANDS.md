# Supported commands

Each command parses the listed flags and forwards to the cmdlet shown. Flags can
be clustered (`-rf`), long (`--force`), or take values (`-n 5`, `-n5`, `--lines=5`).
Anything after `--` is treated as a path.

| Command | Flags handled | Maps to | Notes |
|---------|---------------|---------|-------|
| `ls`    | `-a -l -R -t -S -r` | `Get-ChildItem` | `-a`=hidden, `-l`=long table, `-t/-S`=sort by time/size, `-r`=reverse |
| `rm`    | `-r -f -i -I` | own tree walk (`FileSystemInfo.Delete`) | never follows junctions/symlinks (removes the link only); a directory needs `-r`; `-f` only silences "not found"; `-i` asks per file, `-I` once |
| `cp`    | `-r -f -n -i` | `Copy-Item` | last path = destination; `-n` never overwrites, `-i` asks first |
| `mv`    | `-f` | `Move-Item` | last path = destination |
| `mkdir` | `-p` | `New-Item -ItemType Directory` | `-p` creates parents / no error if exists |
| `touch` | — | `New-Item` / set `LastWriteTime` | creates file or bumps timestamp |
| `cat`   | `-n` | `Get-Content` | `-n` numbers lines; reads pipeline too |
| `head`  | `-n N` / `-N`, `-n -N` | `Select-Object -First` / `-SkipLast` | default 10; `-n -N` = all but the last N; pipeline or file |
| `tail`  | `-n N` / `-N`, `-n +N`, `-f` | `Get-Content -Tail` / `-Wait` | `-n +N` = from line N on; `-f` follows; pipeline or file |
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
`xssh` session sends them straight to the remote's current directory (folders
and files of every size via `scp`, which needs key auth), so `wput` is mainly for
password-only hosts, hosts past an `xssh` hop, or plain terminals. `wput`
itself can't see the remote *current* directory; pass `-Dest` for a specific
folder.

## Agent accounts: `claude` / `claude1` / ..., `codex` / `codex1` / ..., `agy` / `agy1` / ..., `copilot` / `copilot1` / ...

Run the [Claude Code](https://www.claude.com/product/claude-code),
[Codex](https://github.com/openai/codex), Antigravity (`agy`) and
[GitHub Copilot](https://github.com/github/copilot-cli) CLIs under any number
of separate accounts, each with its own persistent login, while each agent
keeps one `/resume` history shared by all of its accounts, the plain command's
included.

```powershell
claude                    # your usual account     (config in ~/.claude)
claude1                   # another Claude login   (config in ~/.claude-1)
claude7                   # any number: the dir    (~/.claude-7) is made on first run
codex                     # your usual Codex       (CODEX_HOME ~/.codex)
codex1                    # another Codex login    (CODEX_HOME ~/.codex-1)
copilot1                  # another Copilot login  (COPILOT_HOME ~/.copilot-1)
agy1                      # another agy login      (kept in ~/.agy-1, swapped in per launch)
claude1 --resume          # args pass straight through
codex2 resume <thread>    # likewise
Get-LimpetAgentAccounts   # every account with a config dir, and where it is
Sync-LimpetClaudeHistory  # wire the shared history by hand (numbered claude commands do it on launch)
Sync-LimpetCodexHistory   # likewise for Codex (numbered codex commands do it on launch)
Sync-LimpetCopilotHistory # likewise for Copilot
Invoke-LimpetAgent claude3 -Arguments @('-p', 'hi')   # what the numbered commands call
```

There is no account list. A numbered command whose directory exists is defined
as a function when the module loads (so it tab-completes); any other
`claudeN` / `codexN` / `agyN` / `copilotN` is caught by PowerShell's
command-not-found hook and run the same way, creating the directory. Each
launch points `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `COPILOT_HOME` at that
directory for that launch only, so plain `claude`, `codex` and `copilot` keep
`~/.claude`, `~/.codex` and `~/.copilot`. `LIMPET_AGENT_HOME` overrides where
the directories live (tests).

Antigravity has no directory setting and keeps its one login in Windows
Credential Manager (generic credential `gemini:antigravity`). `agyN` saves the
login there as the account that had it (plain `agy`'s in `~/.agy`), puts
`~/.agy-N/login.dat` in its place (DPAPI, this Windows user only; none yet
means agy asks you to sign in), runs agy, then keeps the possibly refreshed
login and puts plain `agy`'s back. `~/.agy/active` notes whose login is in
Credential Manager meanwhile; another agy account is refused while one is
running. Plain `agy` is wrapped as well so it always runs on its own login, and
a launch cut short (its tab closed) is finished off when the module next loads
or agy next starts. Each account's email is kept in `account.json` for the
app's menu. `LIMPET_AGY_CRED_TARGET` and `LIMPET_AGY_PROCESS` stand in for the
credential name and agy's process name (tests).

Every Claude account's `projects/` folder, `~/.claude`'s included, is
junctioned to a shared `~/.claude-shared/projects`, so they all list the same
sessions in `/resume`. Session files are named by unique id and never collide.
The junctions are set up automatically whenever a numbered `claude` command
runs, folding any existing `projects/` folder into the shared store file by
file without overwriting; a folder held open by a running session is left for
the next launch. The up-arrow prompt history is not shared (Claude Code won't
read it through a link).

Every numbered Codex home shares plain `~/.codex`'s history: its `sessions/`,
`archived_sessions/` and `thread-writer-locks/` are junctioned to `~/.codex`'s,
its `session_index.jsonl` (thread names) is hard-linked to `~/.codex`'s, and its
`config.toml` gets `sqlite_home` pointed at `~/.codex`, where Codex keeps the
thread index `/resume` lists from. The shared locks keep one thread from being
written by two accounts at once. A home's own threads are folded in on first
sync (a thread that was copied across and continued keeps the longer copy) and
then indexed in `~/.codex` through `codex app-server`, names included; a home
with a chat open is skipped until a later launch. While a `codexN` runs, the
shell notes it in `%APPDATA%\limpet\agents\<shell pid>.json`
(`LIMPET_AGENT_RUN` overrides the folder) so the app can tell which account a
tab's Codex is on. Which thread it is on comes from Codex's writer lock: the
app asks Windows (Restart Manager) which process holds each
`thread-writer-locks/<thread>.lock` and takes the one held by the Codex under
that tab, ignoring sub-agent threads.

Every numbered Copilot home's `session-state/` (one folder per chat; Copilot's
resume list is built from it) is junctioned to `~/.copilot`'s. agy accounts
share chats already: agy keeps all of them in `~/.gemini`. The app tells a
Copilot tab's chat by the `inuse.<pid>.lock` mark Copilot leaves in the chat's
folder, and an agy tab's by which process holds
`~/.gemini/antigravity-cli/conversations/<id>.db` open.

In the limpet app, right-click a tab to see the signed-in accounts with the
5-hour and weekly usage each has left (Claude and Codex), and to move the
tab's chat to another: the running agent is exited (Ctrl+C, then a kill if it
lingers) and the conversation is resumed under the pick in the same shell.
Between accounts of one agent it is resumed by id (`--resume`, `resume`,
`--conversation`), copying a Codex rollout first only into a home that isn't
wired up yet; Claude to Codex uses Codex's session importer; any agent to
Claude writes a Claude transcript and resumes it; any other pair, or a
conversion that fails, becomes a Markdown handoff file plus a "continue from
here" prompt.

## Restoring the original aliases

`Remove-Module Limpet` restores the built-in `ls/cp/mv/rm/cat` aliases for the
current session.

## macOS and Linux (zsh / bash)

`shell/limpet.sh`, sourced by `~/.zshrc` or `~/.bashrc` (`install.sh` adds the
line) and by the limpet app itself, provides the same commands without the
Linux shims (the shell already has `ls -la` and friends):

| Command | Same as on Windows | Notes |
|---------|--------------------|-------|
| `xssh user@host` | yes | `-Raw`/`--raw`, `-NoResume`/`--no-resume`, `-Resume`/`--resume`; the password cache uses `shell/limpet-askpass.sh` with `SSH_ASKPASS_REQUIRE=force`; `LIMPET_NO_PWCACHE=1` turns it off |
| `wput <files> [-To user@host] [-Dest dir] [-Port N] [-Key path]` | yes | `--to`, `--dest`, `--port`, `--key` work too; the last `xssh` host is remembered in `${TMPDIR:-/tmp}/limpet-last-ssh.txt` |
| `peek`, `peak`, `reels`, `download`, `upload` | yes | the same helpers `xssh` sends to remote hosts, loaded locally |
| `limpet` | yes | the banner |
| `limpet-enroll user@host [-p port]` | replaces `Enable-LimpetHello` | makes `~/.ssh/limpet_ed25519` with a random passphrase kept in the login Keychain (`security add-generic-password -s limpet-ssh-key`), installs it on the host (password typed once), remembers the host in `~/.config/limpet/hello/hosts.txt`; `xssh` then unlocks the key from the Keychain. On Linux there is no Keychain: the passphrase is kept in a 0600 file under `~/.config/limpet/hello/` and `limpet-enroll` says so |
| `limpet-forget user@host [--remove-remote]` | replaces `Disable-LimpetHello` | |
| `limpet-status` | replaces `Get-LimpetHelloStatus` | |
| `claude1`, `codex2`, `agy1`, `copilot3`, ... | yes | functions for the directories that exist, `command_not_found_handler` (zsh) / `command_not_found_handle` (bash) for any other number; `--limpet-plan` prints the plan instead of launching |
| `limpet_agent_accounts`, `limpet_invoke_agent <cmd> [args]`, `limpet_sync_claude_history`, `limpet_sync_codex_history`, `limpet_sync_copilot_history` | `Get-LimpetAgentAccounts`, `Invoke-LimpetAgent`, `Sync-Limpet*History` | |

Differences worth knowing:

- Shared history is wired with symlinks (`~/.claude-N/projects ->
  ~/.claude-shared/projects`, `~/.codex-N/sessions -> ~/.codex/sessions`, ...)
  and a hard link for Codex's `session_index.jsonl`, same layout as the
  junctions on Windows. A folder in use is never a problem on Unix: a rename
  keeps a running agent's open file, so the fold-in completes in one go.
- The launch note a `codexN`/`agyN`/`copilotN` shell leaves for the app is
  `~/Library/Application Support/limpet/agents/<shell pid>.json` on macOS and
  `${XDG_CONFIG_HOME:-~/.config}/limpet/agents/` on Linux (`LIMPET_AGENT_RUN`
  overrides). Which process holds a Codex thread lock or an agy conversation
  is asked with `lsof`.
- Claude Code on macOS keeps its login in the Keychain: item `Claude
  Code-credentials` for plain `claude`, `Claude Code-credentials-<h>` for
  `claudeN` where `h` is the first 8 hex characters of the SHA-256 of the
  config directory path, account `claude-code-user`. The app reads
  `.credentials.json` when it exists and the Keychain otherwise.
- Antigravity: `agyN` moves the `agy` Keychain item (service
  `gemini:antigravity`, or `gemini`/`antigravity`; `LIMPET_AGY_KEYCHAIN_SERVICE`
  overrides) and keeps each account's copy as `limpet:agy:<cmd>`; on Linux it
  swaps the token file `~/.gemini/antigravity-cli/antigravity-oauth-token`.
  This is best effort and not yet verified against a real agy on macOS.
- Not ported: the TPM-sealed Windows Hello flow (the Keychain stands in), the
  Linux command shims, the Start Menu shortcut.
