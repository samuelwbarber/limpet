<p align="center">
  <img src="app/build/limpet-256.png" width="90" alt="limpet logo" />
</p>

<h1 align="center">limpet</h1>

<p align="center">
  <b>PowerShell with Linux commands, SSH that reconnects itself,<br/>
  and a terminal that can show images.</b>
</p>

<p align="center"><i>Named after the mollusc that stays stuck to its rock no matter
how hard the waves hit, which is basically what xssh does. Type
<code>limpet</code> in the shell to meet the mascot.</i></p>

---

## Linux muscle memory, PowerShell underneath

Type the Unix commands your hands already know (`ls -la`, `rm -rf`, `cp -r`,
`grep -i`, `head`, `tail`, `find`, `du`) and limpet translates the flags to
the native PowerShell cmdlets. It's still real PowerShell, so pipelines,
objects and every normal cmdlet keep working.

<p align="center"><img src="docs/media/shell.gif" width="840" alt="limpet shell demo: Linux commands inside PowerShell" /></p>

Full command list: [`docs/COMMANDS.md`](docs/COMMANDS.md)

## Tabs

Multiple shells in one window, like Windows Terminal. `Ctrl+Shift+T` opens a
tab, `Ctrl+Tab` cycles, `Ctrl+Shift+W` (or `exit`, or middle-click) closes one.
Each tab is its own ConPTY session, so an `xssh` reconnecting in one tab never
touches the build running in another. Tab titles follow the shell's current
folder.

<p align="center"><img src="docs/media/tabs.gif" width="840" alt="tabs demo: two shells in one window, switching with Ctrl+Tab" /></p>

## xssh

A drop-in for `ssh` that reconnects with your key when the link drops. British train Wi-Fi, a sleeping laptop, a flaky VPN: instead of a dead terminal you
get a short pause and then your session back. Pair it with remote `tmux` and
your programs survive too.

<p align="center"><img src="docs/media/xssh.gif" width="840" alt="xssh demo: connection dropped and auto-reconnected" /></p>

```powershell
xssh user@host             # use it exactly like ssh
xssh -NoResume user@host   # reconnect to a fresh shell instead of the live one
```

The reconnect is entirely client-side, nothing to install on the server. If
your machine itself goes offline (lid closed, network change), `xssh` waits
for the network to come back and drops you into the exact shell you left,
running processes and scrollback intact. That relies on tmux existing on the
host; without it, or with `-NoResume`, you get a plain fresh shell.

## peek

`peek <file>` renders an image inline in the terminal. It scrolls away like
text and doesn't break your prompt. Works at the local prompt and inside an
`xssh` session, where the remote only needs `base64`.

<p align="center"><img src="docs/media/peek.gif" width="840" alt="peek demo: image rendered inline in the terminal" /></p>

## download and upload

Inside any `xssh` session you also get `download` and `upload`. `download
file` sends the file to your PC's Downloads folder through the connection
you're already typing over; `download folder` sends a whole folder (streamed
as a tar and unpacked on arrival). It streams in chunks, so a big file or a
10 GB folder goes through fine without holding anything whole in memory.
There's no agent and no rsync, and nothing is left on the server; the helpers
are injected fresh on each connect.

They only exist in `xssh` sessions, plain `ssh` won't have them. They survive
`tmux`, nested `bash` and `srun`. To reach a second machine (say login node to
compute node), hop with `xssh next-host` instead of `ssh next-host` and they
come along.

<p align="center"><img src="docs/media/remote.gif" width="840" alt="remote demo: peek and download inside an ssh session" /></p>

## Drag and drop

Drop a file onto the limpet window while you're in an SSH session and it lands
in the remote's current directory, reconstructed over the wire via `base64`,
so it works on any box with coreutils. For folders and big files use
`wput <files>`, a client-side `scp` that defaults to your last `xssh` host.

<p align="center"><img src="docs/media/drop.gif" width="840" alt="drag and drop demo: file dropped onto the window arrives in the remote directory" /></p>

## Windows Hello for SSH

Type a host's password once:

```powershell
Enable-LimpetHello user@host
```

limpet installs a dedicated key whose passphrase is sealed by the TPM behind
Windows Hello. From then on `xssh user@host` is a face, fingerprint or PIN
prompt, reconnects included. No password again.

## reels

Because sometimes the build takes a while. `reels` docks a vertical feed
(Instagram Reels by default, or any URL you pass) on the right side of the
terminal. `reels` again to dismiss.

## Install

```powershell
git clone https://github.com/samuelwbarber/limpet
cd limpet
.\install.ps1          # wires the module into your PowerShell profile

cd app                 # the limpet terminal app (peek/download/drop live here)
npm install
npm start              # or launch "limpet" from the Start Menu after install.ps1
```

- The shell module (`shell/`) works in any terminal: Windows Terminal,
  WezTerm, VS Code. `install.ps1` adds it to your profile and creates a Start
  Menu entry for the app.
- The limpet app (`app/`) is the tabbed Electron terminal that renders inline
  images and catches `download`, `upload` and drag and drop.
- SSH keys: `.\setup-ssh.ps1` generates a key, loads `ssh-agent`, and can
  install it on a host (`-RemoteHost user@host`).

## How it fits together

| Layer | Job | What provides it |
|-------|-----|------------------|
| Terminal | tabs, rendering, inline images, drop target | limpet app (`app/`) |
| Session | survive bad links without re-auth | `xssh` (client-side) plus optional remote `tmux` |
| Shell | `ls -la`, `grep`, `wput`, `peek` | Limpet module (`shell/`) |

In-session `peek`, `download` and `upload` talk to the app over private
terminal escape sequences, so they tunnel through SSH with no server-side
setup.

## Repo layout

```
shell/       Limpet PowerShell module + limpet-remote.sh (in-session helpers) + Hello auth
app/         tabbed Electron terminal (xterm.js + ConPTY)
install.ps1  idempotent setup (profile, Start Menu shortcut)
setup-ssh.ps1  SSH key setup helper
tests/       Test-Limpet.ps1 smoke test
tools/demo/  scripts that record the README GIFs
docs/        COMMANDS.md reference, demo media
```

## Test

CI runs all of these on every push (see `.github/workflows/ci.yml`):

```powershell
.\tests\Test-Limpet.ps1    # every shell command + peek/reels protocol + Hello helpers
.\tests\Test-Xssh.ps1      # xssh bootstrap variants + reconnect policy (ssh stubbed)
bash tests/test-remote-sh.sh   # remote helpers + the real xssh bootstrap templates (Linux/WSL)

cd app
npm test                   # terminal-protocol unit tests (node --test)
npm run test:e2e           # launches the real app: peek, resize survival, reels, download
```
