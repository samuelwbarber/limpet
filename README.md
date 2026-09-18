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

## Backgrounds

Right-click a tab and pick a background: the standard limpet colour (the
default), a handful of other dark colours, or **Generative**, which paints each
tab with a small pixel-art scene of whatever that tab is working on. The scene
is made by a local image model, so nothing about your terminal leaves the
machine; it updates as the conversation moves on.

<p align="center"><img src="docs/media/backdrop.gif" width="840" alt="background demo: picking a colour, then the generative backdrop appearing" /></p>

## Any number of Claude and Codex accounts

Keep as many [Claude Code](https://www.claude.com/product/claude-code) and
[Codex](https://github.com/openai/codex) logins as you have subscriptions, each
behind its own command, and share your Claude session history across all of
them.

```powershell
claude         # your usual account       (config in ~/.claude)
claude1        # another Claude login     (~/.claude-1)
claude2        # and another              (~/.claude-2)
claude7        # any number works         (~/.claude-7, created on first run)
codex          # your usual Codex         (~/.codex)
codex1         # another Codex login      (~/.codex-1)
```

`claudeN` runs Claude Code with `CLAUDE_CONFIG_DIR` pointed at `~/.claude-N`;
`codexN` runs Codex with `CODEX_HOME` at `~/.codex-N`. Each holds a separate
login: `/login` once in each and it stays signed in. There is no list to edit.
Type a number that doesn't exist yet and limpet creates the directory and runs
the agent there (a numbered command whose directory already exists is a real
function, so it tab-completes). Any arguments pass straight through
(`claude3 --resume`, `codex2 resume <id>`, `claude1 -p "..."`).

All Claude accounts' session transcripts live in one shared store (limpet
junctions each config's `projects/` folder to `~/.claude-shared/projects`), so
**`/resume` lists the same conversations whichever account you're in**. Start
something on one account, pick it up on another, and back again. Transcripts
are named by a unique id, so the accounts can run side by side without ever
colliding. The wiring is created automatically whenever a numbered `claude`
command runs (or by hand with `Sync-LimpetClaudeHistory`): any pre-existing
`projects/` folder, plain `claude`'s included, is folded into the shared store
file by file, never overwritten. A folder that a running session still has
open is left alone and picked up on the next launch.

Only the transcripts are shared. The up-arrow prompt history stays per account,
because Claude Code refuses to read that file through a link. Codex accounts
share nothing between them; the app copies a thread across when you move it.

### Switch account, or agent, mid-chat

In the limpet app, right-click a tab to see every account that is signed in,
Claude and Codex alike, each with how much of its 5-hour and weekly limit is
left (`5h 88% · wk 70%`, hover for the reset times; green, amber and red as it
runs out). The account the tab's chat is running on is marked. Accounts that
aren't signed in are left out, and the footer names the commands to run to add
one (`Sign in to more: claude3, codex1`). Pick another and limpet exits the
running agent and brings the same conversation up under the pick, in the same
shell:

- **Claude to Claude**: `<account> --resume <session id>`. Nothing is copied;
  the transcript is shared.
- **Codex to Codex**: the thread's rollout file is copied into the other
  account's home, then `<account> resume <thread id>`.
- **Claude to Codex**: Codex's own importer turns the transcript into a thread
  in that Codex account, then `<account> resume <thread id>`.
- **Codex to Claude**: limpet writes the chat out as a Claude transcript and
  resumes it, so Claude remembers it natively.
- If a conversion fails, the chat is rendered to a Markdown handoff file and
  the new agent starts with a one-line "continue from here" prompt pointing at
  it.

<p align="center"><img src="docs/media/switch.gif" width="840" alt="switch demo: the tab menu lists the signed-in accounts with usage left, and a Claude Code chat is moved to Codex, conversation intact" /></p>

Handy when one subscription hits its limit: the usage column shows which one
still has room. With nothing running in the tab, picking an account just
starts it there. Moving to Codex sends the conversation to OpenAI once Codex
replies, so pick with that in mind. Usage is read with each account's own
stored login, from the same endpoints `/usage` (Claude) and `/status` (Codex)
use, and nothing is written back; an expired login shows `usage n/a` until you
run that account again.

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
npm test                   # terminal-protocol + account-switch unit tests (node --test)
npm run test:e2e           # launches the real app: peek, resize survival, reels, download, tab detach, account switch
```
