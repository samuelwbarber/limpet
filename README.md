```
█   █ ███ █   █ █   █ █   █
█   █  █  ██  █ █   █  █ █
█ █ █  █  █ █ █ █   █   █
██ ██  █  █  ██ █   █  █ █
█   █ ███ █   █  ███  █   █
```

# winux

**PowerShell + the Linux commands you actually type, with SSH that doesn't drop.**

A Windows terminal setup that gives you **full PowerShell plus the common Linux
commands** (`cp`, `rm`, `ls -la`, `grep`…), **SSH that auto-reconnects without
re-authenticating when your connection drops**, and **good TUI rendering**
(Claude Code, vim, etc.).

It is not a from-scratch terminal emulator. It composes three layers, and the
only new code is the PowerShell module:

| Layer | Job | What provides it |
|-------|-----|------------------|
| Emulator | GPU rendering, tabs, splits | **WezTerm** (config in `wezterm/`) |
| Session  | Survive bad links, no re-auth | **WezTerm mux** / **mosh** / **`xssh`** |
| Shell    | `cp`, `rm`, `ls -la`, `grep`… | **Winux** module (`shell/`) — *the code* |

## Install

```powershell
# from the repo root
.\install.ps1
```

The installer:
- adds `Import-Module shell/Winux.psd1` to your PowerShell profile,
- sets `WINUX_HOME` and (if WezTerm is installed) `WEZTERM_CONFIG_FILE`,
- tells you how to install WezTerm / PowerShell 7 if missing.

Open a new terminal afterward (or run `. $PROFILE`). Type `winux` any time to see
the banner and command list.

### Installing WezTerm

Either via winget (needs admin):
```powershell
winget install wez.wezterm
```
…or portable (no admin): download the `WezTerm-windows-*.zip` from
<https://github.com/wezterm/wezterm/releases>, extract it, and add that folder to
your PATH. Then re-run `.\install.ps1` so it sets `WEZTERM_CONFIG_FILE`.

## Layer 1 — Linux commands (the Winux module)

`Winux` defines flag-aware functions for the most-used Unix tools and routes them
to native cmdlets. The five that collide with built-in PowerShell aliases
(`ls cp mv rm cat`) are surfaced via global aliases so they win command
resolution. See [`docs/COMMANDS.md`](docs/COMMANDS.md) for the full list.

```powershell
ls -la                 # Get-ChildItem -Force, long format
rm -rf build           # Remove-Item -Recurse -Force
cp -r src dst          # Copy-Item -Recurse
grep -i error log.txt  # Select-String (case-insensitive)
cat -n file | head -5  # numbered lines, first five
```

To extend it, add a function in `shell/Winux.psm1` (use `$args` + the
`ConvertFrom-UnixArgs` helper) and list it in `Export-ModuleMember`.

## Layer 2 — Resilient SSH

The easiest way is **`xssh`** — a drop-in for `ssh` (loaded with the Winux
module, so it's available in every session). Use it exactly like `ssh`; it just
auto-reconnects via your key when the link drops:

```powershell
xssh user@host
xssh -p 2222 root@1.2.3.4
xssh user@host -t "tmux attach -t main || tmux new -s main"   # also survive drops
```

For a more opinionated launcher (tmux session by default, used by the WezTerm
menu entry), `ssh-resilient.ps1` does the same with structured parameters:

```powershell
.\ssh-resilient.ps1 -Target root@1.2.3.4          # reconnect + remote tmux session
.\ssh-resilient.ps1 -Target me@host -Port 2222     # custom port
.\ssh-resilient.ps1 -Target me@host -NoTmux        # pure reconnect, zero server-side
```

What's client-side vs not: the **reconnect** is fully client-side. **Surviving a
drop with your programs intact** needs *something* on the server to hold the
session — `tmux` works (just a command, usually preinstalled; no daemon/config).
mosh and the WezTerm mux are *not* client-only — they need server-side software.

Set up key auth with the helper:

```powershell
.\setup-ssh.ps1                          # generate key (if needed) + load ssh-agent
.\setup-ssh.ps1 -RemoteHost me@host.com  # also install the key on a host
```

Enabling `ssh-agent` on Windows is a one-time admin step (the helper prints it if
it can't do it itself). A passphrase-less key works without the agent.

## Drag-and-drop file upload

Drag a file or folder onto the window while connected and it uploads to the
remote's **current directory**. This rides on **trzsz** — WezTerm has no drop
event to hook and dropping just pastes the path, so a purpose-built transfer tool
is what makes it work.

```powershell
.\install-trzsz.ps1          # installs the client (tssh) into winux\bin
```

Then install trzsz on the **remote** once (`sudo apt install trzsz` or
`python3 -m pip install trzsz`). After that, `xssh user@host` automatically routes
through `tssh`, and dragging files/folders onto the window uploads them to the
remote cwd. Force the plain client with `xssh -Plain user@host`. Without trzsz,
`xssh` behaves exactly as before (plain ssh + reconnect).

## Layer 3 — Rendering

WezTerm renders on the GPU (`front_end = 'WebGpu'`), which is what fixes the
flicker/redraw problems you get in the legacy console. The config also sets a
readable font, color scheme, generous scrollback, and tmux-style splits under a
`Ctrl+a` leader.

## Repo layout

```
shell/        Winux module (.psm1 + .psd1) + logo   <- the only real code
wezterm/      wezterm.lua host config
install.ps1   wires everything together (idempotent)
setup-ssh.ps1 generates an SSH key + loads ssh-agent + installs key on a host
ssh-resilient.ps1 client-side auto-reconnecting SSH (no server software needed)
install-trzsz.ps1 installs the trzsz client (tssh) for drag-and-drop upload
tests/        Test-Winux.ps1 smoke test
docs/         COMMANDS.md reference
```

## Test

```powershell
.\tests\Test-Winux.ps1
```
