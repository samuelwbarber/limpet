# limpet on macOS (and Linux): the port design

This is the contract every piece of the port is built against. The Windows
product stays exactly as it is; the port adds a second platform beside it with
the same features and the same user-facing behaviour, done the native way for
each platform. Where a feature has no honest macOS equivalent it is said so in
the README rather than stubbed silently.

## What runs where

| Piece | Windows (unchanged) | macOS / Linux (new) |
|---|---|---|
| Shell the app spawns | `powershell.exe -NoExit -Command Import-Module Limpet.psd1` | the user's login shell (`$SHELL`, else `dscl`/`getent`, else `/bin/zsh`), started as an interactive **login** shell with limpet's integration loaded through `ZDOTDIR` (zsh) or `--rcfile` (bash), never by editing the user's dotfiles |
| Shell integration | `shell/Limpet.psm1` (+ hello, aliases) | `shell/limpet.sh`, one file sourced by zsh **and** bash |
| Linux-command shims (`ls -la` ...) | yes | not needed: the shell is Unix already |
| `xssh` | PowerShell function | same behaviour in `limpet.sh` (same flags `-Raw`, `-NoResume`, `-Resume`; also `--raw`, `--no-resume`, `--resume`) |
| Remote helpers (`peek`, `download`, ...) | `shell/limpet-remote.sh`, unchanged | identical bytes; `limpet.sh` reuses it locally too |
| Password cache for reconnects | askpass `.exe` compiled on first use | `shell/limpet-askpass.sh` (prints `$LIMPET_ASKPASS`) with `SSH_ASKPASS_REQUIRE=force` |
| Windows Hello for SSH | `Enable-LimpetHello` (TPM-sealed key passphrase) | `limpet-enroll user@host`: a dedicated `~/.ssh/limpet_ed25519` with a random passphrase kept in the **login Keychain** (`security add-generic-password -s limpet-ssh-key`), unsealed by the askpass helper; `limpet-forget`, `limpet-status` |
| Agent accounts `claudeN` ... | functions + `CommandNotFoundAction` | functions + `command_not_found_handler` (zsh) / `command_not_found_handle` (bash) |
| History sharing | junctions, hard links | symlinks (`ln -s`), hard links (`ln`) |
| Launch notes (which account a tab's agent is on) | `%APPDATA%\limpet\agents\<shell pid>.json` | `~/Library/Application Support/limpet/agents/<shell pid>.json` on macOS, `${XDG_CONFIG_HOME:-~/.config}/limpet/agents/` on Linux (= Electron's `app.getPath('appData')/limpet/agents`); `LIMPET_AGENT_RUN` overrides |
| Who holds a lock file | Restart Manager (`lock-holders.ps1`) | `lsof -F pn -- <files>` |
| Process tree | `Get-CimInstance Win32_Process` | `ps -axo pid=,ppid=,etime=,args=` |
| Kill an agent that ignores Ctrl+C | `taskkill /T /F` | SIGTERM then SIGKILL to the pid and its descendants |
| agy login swap | Credential Manager `gemini:antigravity` + DPAPI | macOS: Keychain generic password (service configurable, `LIMPET_AGY_KEYCHAIN_SERVICE`, default tries `gemini:antigravity` then service `gemini`/account `antigravity`); Linux: the token file `~/.gemini/antigravity-cli/antigravity-oauth-token`. Per-account copies live in the Keychain as `limpet:agy:<cmd>` (macOS) or `~/.agy-N/login.dat` 0600 (Linux). **Best effort: not verified against a real agy on macOS.** |
| Claude login detection / usage | `<config>/.credentials.json` | that file if present, else Keychain item service `Claude Code-credentials` (plain `claude`) or `Claude Code-credentials-<h>` where `h` = first 8 hex chars of sha256 of the config dir path (NFC), account `claude-code-user` (`security find-generic-password -a claude-code-user -w -s <service>`) |
| Codex thread index refresh | `codex app-server` JSON-RPC from PowerShell | same protocol from `limpet.sh` (zsh `coproc` / bash `coproc`), regex-parsed |
| Generative backdrop | `sd-cli.exe` CPU build via `setup-local-backdrop.ps1` | `sd-cli` from the same pinned release: macOS **arm64 only** (`sd-master-6b3edaa-bin-Darwin-macOS-26.5.2-arm64.zip`), Linux x86_64 CPU; via `app/scripts/setup-local-backdrop.sh`. Intel Macs: the picker says it isn't available |
| Keyboard | Ctrl+Shift+T/W, Ctrl+Tab, Ctrl+, ; Ctrl+C/V | defaults on macOS: Cmd+T, Cmd+W, Cmd+Shift+], Cmd+Shift+[, Cmd+, ; Cmd+C copies the selection (never interrupts), Cmd+V pastes; Ctrl+C stays the interrupt. `Cmd` is a modifier in settings (`Meta`), shown as ⌘ |
| App menu | removed | macOS keeps an app menu (About / Hide / Quit, Window: Minimize/Zoom) with **no** Edit roles, so Cmd+C/V have one path (the renderer) |
| Installer | NSIS, auto-update via GitHub Releases | `.dmg` + `.zip` (arm64 + x64), auto-update via `latest-mac.yml`; signing/notarization when `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` secrets exist, otherwise unsigned (README says how to open it) |
| Install script | `install.ps1` | `install.sh`: adds the `source .../shell/limpet.sh` block to `~/.zshrc` (and `~/.bashrc`), runs `npm run setup` in `app/` |

## Contracts between the pieces

### `app/src/platform.js` (owned by the app-platform agent)

```js
module.exports = {
  isWindows, isMac, isLinux,
  shellSpawn({ resourcesShellDir, token }) -> { file, args, env, cwd }   // how to start the tab's shell
  listProcesses() -> Promise<[{ pid, ppid, name, args, startedAt }]>     // name = basename of argv[0]
  fileHolders(paths) -> Promise<{ [path]: [pid] } | null>
  killTree(pid) -> void
  agentRunDir() -> string                 // launch notes (see table)
  shellQuote(s) -> string                 // PowerShell single quotes on Windows, POSIX '...' elsewhere
  backdrop: { exeName, setupScript, setupCommand(script, localRoot) -> { file, args } }
  codexAppServerCommand -> { file, args }
  readClaudeCredentials(configDir, { plain }) -> object | null   // file first, then Keychain on macOS
}
```

`accounts.launchCommand(cmd, opts, shell)` takes `shell = 'powershell' | 'posix'`
(default `'powershell'` so existing tests hold); `main.js` passes the platform's.
`accounts.isAgentProc(kind)` matches `name === kind`, `name === kind + '.exe'`, or
`args` containing `/kind` as a path component followed by a space or end
(agents run through `node` on Unix).

### `app/src/menu.js` (owned by the renderer agent)

`installAppMenu()` sets the macOS application menu described above and is a
no-op elsewhere; `main.js` calls it once at startup and no longer calls
`browserWin.removeMenu()` on macOS (still does on Windows/Linux).

### `shell/limpet.sh` (owned by the shell agent)

Sourced by zsh or bash. Defines: `limpet` (banner), `xssh`, `wput`, `peek`
(and `peak`), `reels`, `download`, `upload` (from `limpet-remote.sh`),
`limpet-enroll`, `limpet-forget`, `limpet-status`, `agy` (wrapped), every
`claudeN`/`codexN`/`agyN`/`copilotN` whose directory exists, the
command-not-found hook for the rest, and the helpers
`limpet_agent_accounts`, `limpet_invoke_agent <cmd> [args...]`,
`limpet_sync_claude_history`, `limpet_sync_codex_history`,
`limpet_sync_copilot_history`. Env hooks identical to the PowerShell module:
`LIMPET_AGENT_HOME`, `LIMPET_AGENT_RUN`, `LIMPET_TOKEN`, `LIMPET_NO_PWCACHE`,
`LIMPET_AGY_PROCESS`, `--limpet-plan` (prints `kind=... configDir=... envName=...
exe=... args=...` one per line, launches nothing). Sets the window title to the
current folder's name before each prompt (OSC 2) so the tab shows it.

### `shell/rc/` (shell agent)

`zsh/.zshenv`, `zsh/.zprofile`, `zsh/.zshrc`, `zsh/.zlogin` for the `ZDOTDIR`
trick (each sources the user's own file from `LIMPET_USER_ZDOTDIR`, then
`.zshrc` sources `limpet.sh` and restores `ZDOTDIR`), and `bash/limpet-rc.bash`
(sources `~/.bash_profile`/`~/.bashrc` as a login shell would, then
`limpet.sh`). The app sets `LIMPET_SHELL_DIR` (the `shell/` folder) and
`LIMPET_TOKEN`.

### Tests

- `tests/test-limpet-sh.sh`: the shell suite, run as `zsh tests/test-limpet-sh.sh`
  and `bash tests/test-limpet-sh.sh`; mirrors `Test-Limpet.ps1` + `Test-Xssh.ps1`
  (accounts, hook, `--limpet-plan`, env routing, launch notes, history sync for
  the three agents, xssh bootstrap variants + reconnect policy with a stubbed
  `ssh`, pwcache, peek/reels protocol, wput errors, banner). Keychain parts run
  only on macOS against a throwaway service name.
- `app/tests/*.test.js`: platform-neutral; new `platform.test.js` for the
  Unix process/lsof parsers and `shellQuote`.
- e2e (`e2e.js`, `ctrlc.js`, `tabs-links.js`, `accounts.js`): platform-aware
  through `app/tests/platform.js` (prompt regex, echo/sleep/clear commands,
  stand-in agents as copies of `/bin/sh` under the agent's name, lock holding
  via `exec 3<>file`, in-use marks). They set `LIMPET_SHELL` to pin the shell.
- CI: `macos-latest` jobs for the shell suite (zsh and bash), app unit tests and
  the e2e; `ubuntu-latest` shell suite too. Release: a macOS job building
  dmg+zip and publishing beside the Windows installer.

## Not ported (said in the README)

Windows Hello TPM sealing (Keychain instead), the Linux-command shims (native),
the Start Menu shortcut (the .app is the launcher), ConPTY-specific notes.
