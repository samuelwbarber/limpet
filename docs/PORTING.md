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
| Claude login detection / usage | `<config>/.credentials.json` | that file if present, else Keychain item service `Claude Code-credentials` (plain `claude`) or `Claude Code-credentials-<h>` where `h` = first 8 hex chars of sha256 of the config dir path exactly as `CLAUDE_CONFIG_DIR` gives it (NFC, no trailing slash). The item's account is the macOS user name (`$USER`), so it is looked up by service alone: `security find-generic-password -w -s <service>` (output may be hex if non-printable). **Verified on a real Mac 2026-11-17** (`~/.claude` and `~/.claude-1` items). Plan label: `oauthAccount.planDisplayName` from the profile JSON, else the item's `subscriptionType` + `rateLimitTier` multiplier |
| Agent CLIs on PATH for the app itself | the user's PATH | launchd gives a Dock/Finder-started app `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so `opencode`, `codex`, ... were invisible to presence checks (`setup-info.js`, OpenCode's account row) and to spawns like `codex app-server`. `platform.fixGuiPath()` (macOS only) appends existing `~/.local/bin`, `~/.opencode/bin`, `~/.npm-global/bin`, `~/.bun/bin`, `~/.volta/bin`, `~/bin`, `/opt/homebrew/{bin,sbin}`, `/usr/local/bin` at startup, then the login shell's own PATH (`$SHELL -ilc`, 8 s cap). Tabs are unaffected (their login shell builds PATH). Linux: unchanged |
| Codex / Copilot / agy logins on macOS | n/a | Codex: `<CODEX_HOME>/auth.json` as elsewhere (default `cli_auth_credentials_store = "file"`; a keyring-stored Codex login is not read). Copilot CLI: config under `~/.copilot` (`COPILOT_HOME`), token in the Keychain; `gh`'s `gh:github.com` item is a GitHub login, not a Copilot one, and is not counted. agy: see the agy row |
| Codex thread index refresh | `codex app-server` JSON-RPC from PowerShell | same protocol from `limpet.sh` (zsh `coproc` / bash `coproc`), regex-parsed |
| Generative backdrop | `sd-cli.exe` CPU build via `setup-local-backdrop.ps1` | `sd-cli` from the same pinned release: macOS **arm64 only** (`sd-master-6b3edaa-bin-Darwin-macOS-26.5.2-arm64.zip`), Linux x86_64 CPU; via `app/scripts/setup-local-backdrop.sh`. Intel Macs: the picker says it isn't available |
| Keyboard | Ctrl+Shift+T/W, Ctrl+Tab, Ctrl+, ; Ctrl+C/V | defaults on macOS: Cmd+T, Cmd+W, Cmd+Shift+], Cmd+Shift+[, Cmd+, , Cmd+F; Cmd+C copies the selection (never interrupts), Cmd+V pastes; Ctrl+C stays the interrupt. Fixed Terminal.app keys (renderer `macShortcut`, macOS only): Cmd+1..9 pick a tab, Cmd+K clears to start (screen and scrollback), Cmd+Plus / Cmd+Minus / Cmd+0 step the font-size setting. `Cmd` is a modifier in settings (`Meta`), shown as ⌘. Ctrl+Home/End/PageUp/PageDown (what Fn+Ctrl+arrow sends) are left to the app menu for macOS window tiling instead of going to the shell |
| App menu | removed | macOS keeps native menus laid out like Terminal's (app: About / Settings / Hide / Quit; Shell: New Window ⌘N / New Tab / Close Tab / Close Window ⇧⌘W / Find / Clear to Start / Accounts; View: Default Font Size / Bigger / Smaller / Full Screen; Window: Minimize / Zoom / Show Previous/Next Tab, registered with role `window` so macOS adds its window tiling items and Fn+Ctrl+arrow shortcuts; Help: Getting Started) with **no** Edit roles, so Cmd+C/V have one path (the renderer). Renderer-owned shortcuts are shown beside their items with `registerAccelerator: false` (displayed, not registered), and the menu is rebuilt when Settings changes a binding |
| Window chrome | standard title bar + limpet's tab bar | the tab bar *is* the title bar: `titleBarStyle: 'hidden'` with the native buttons at `MAC_TRAFFIC_LIGHTS`, centred in one 38px row that holds limpet's tab strip (always shown, same tab shapes, palette, close ×, drag-out and right-click account menu as on Windows) and +. The row is inset past the buttons, its empty space drags the window (`-webkit-app-region`), tabs and + don't; it dims when the window is not key (`window:key` IPC). The window's own title (Window menu, Mission Control) reads "folder — 80×24". Rules live in `macos.css` under `body.macos`, so Windows/Linux styling is unchanged |
| Terminal look | Cascadia Mono 14, limpet palette | SF Mono 12 on 15pt rows (`'SF Mono'` is an `@font-face` over the system's SF Mono files, Terminal's own cut first, since Chromium can't see it by name; Menlo if missing), grey block cursor, system selection blue, the system overlay scrollbar, 10px left padding. Background picker adds **Basic**, which follows Light/Dark Mode (white with Terminal's ANSI palette, or near-black) |
| Panels and Settings | limpet palette, monospace | system font and macOS shapes: the tab menu is drawn like an NSMenu (accent highlight, ✓ for the current account), banners/prompts/transfers are translucent panels with push buttons, Find is a full-width find bar above the terminal (‹ › Done), Settings is a settings window: one section at a time from a toolbar row, grouped rows, switches for on/off |
| Window buttons in full screen | n/a (the title bar stays; limpet has no full-screen mode there) | macOS hides the title bar, and the close/minimise/zoom buttons with it, while a window is full screen. The tab bar then shows its own three (`#window-controls`): close, minimise (leaves full screen first, since macOS cannot minimise a full-screen window) and exit full screen. They disappear again when the window leaves full screen |
| Installer | NSIS, auto-update via GitHub Releases | `.dmg` + `.zip` (arm64 + x64), auto-update via `latest-mac.yml`: electron-updater (Squirrel.Mac) for a Developer ID signed app, otherwise `src/mac-updater.js` (download the arch's zip, check sha512, `ditto` it out, swap the bundle in from a detached script after quit; release page if the bundle's folder isn't writable); signing/notarization when `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` secrets exist, otherwise unsigned (README says how to open it) |
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
  readClaudeCredentials(configDir, { plain }) -> object | null   // Keychain on macOS (by service); accounts.js/usage.js read the file first
  fixGuiPath() -> Promise<PATH>           // macOS: widen a Dock-launched PATH; no-op elsewhere
}
```

`accounts.launchCommand(cmd, opts, shell)` takes `shell = 'powershell' | 'posix'`
(default `'powershell'` so existing tests hold); `main.js` passes the platform's.
`accounts.isAgentProc(kind)` matches `name === kind`, `name === kind + '.exe'`, or
`args` containing `/kind` as a path component followed by a space or end
(agents run through `node` on Unix).

### `app/src/menu.js` (owned by the renderer agent)

`installAppMenu({ keybindings, newWindow })` sets the macOS application menu
described above (keybindings: the settings map, shown beside the items;
newWindow: opens a window) and removes the menu elsewhere; `main.js` calls it
at startup and again whenever the settings change, and no longer calls
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
