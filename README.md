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

<p align="center">Windows (PowerShell) and, since the macOS port, macOS and Linux
(zsh or bash): see <a href="#macos-and-linux">macOS and Linux</a>.</p>

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

Drop files or folders onto an `xssh` tab to copy them to its reported remote
working directory. Limpet previews the host, directory and filenames before
sending, and explains that existing names will be replaced. Every size uses a
separate `scp` process, so dropping a file never types its contents into a
running command or coding agent.

A transfer card shows the destination and result, with **Cancel**, **Retry** and
**Dismiss**. Byte progress is not available from this copy process. Cancellation
can leave partial files remotely; retry confirms the current destination again.
Copies need key or SSH-agent authentication. Unsupported paths, nested hops,
and tabs without a known `xssh` destination explain the limitation; use `wput`
from the client for those cases.

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

## Settings

`Ctrl+,` in the app (or **Settings…** in a tab's right-click menu) opens a
settings page: font, size, line height, cursor, scrollback, predictive echo,
copy on select, the reels page, the backdrop pace and the keyboard shortcuts.
Changes apply live to every tab. Details in [`app/README.md`](app/README.md#settings).

## Finding your way around

The toolbar exposes **Accounts**, **Find**, **Settings** and **?** help. Search
terminal output with **Ctrl+Shift+F** (or **Cmd+F** on macOS), move between
matches, or jump to the bottom. Tabs scroll when there are too many to fit;
keyboard users can navigate tabs and account choices with arrow keys.

Closing live sessions asks first. When a shell exits, its output and exit code
stay visible with **Restart shell**, **Copy output** and **Close** controls.
On the next launch, Limpet offers to restore saved tab labels and local
working directories. This starts fresh shells: it does not restore running
programs, SSH connections or terminal output.

## Backgrounds

Right-click a tab and pick a background: the standard limpet colour (the
default), a handful of other dark colours, or **Generative**, which paints each
tab with a small pixel-art scene of whatever that tab is working on. The scene
is made by a local image model, so nothing about your terminal leaves the
machine; it updates as the conversation moves on. The first time you pick
Generative, limpet offers to download that model (about 675 MB, once) and shows
the progress; `npm run setup:backdrop` in `app/` does the same from a prompt.

<p align="center"><img src="docs/media/backdrop.gif" width="840" alt="background demo: picking a colour, then the generative backdrop appearing" /></p>

## Any number of Claude, Codex, Antigravity and Copilot accounts

Keep as many [Claude Code](https://www.claude.com/product/claude-code),
[Codex](https://github.com/openai/codex), Antigravity (`agy`) and
[GitHub Copilot CLI](https://github.com/github/copilot-cli) logins as you have
subscriptions, each behind its own command, and share each agent's session
history across all of its accounts.

```powershell
claude         # your usual account       (config in ~/.claude)
claude1        # another Claude login     (~/.claude-1)
claude2        # and another              (~/.claude-2)
claude7        # any number works         (~/.claude-7, created on first run)
codex          # your usual Codex         (~/.codex)
codex1         # another Codex login      (~/.codex-1)
agy1           # another Antigravity login (kept in ~/.agy-1)
copilot1       # another Copilot login    (~/.copilot-1)
```

`claudeN` runs Claude Code with `CLAUDE_CONFIG_DIR` pointed at `~/.claude-N`;
`codexN` runs Codex with `CODEX_HOME` at `~/.codex-N`; `copilotN` runs Copilot
with `COPILOT_HOME` at `~/.copilot-N`. Each holds a separate login: `/login`
once in each and it stays signed in. There is no list to edit.

Antigravity has no such setting: `agy` keeps a single login in Windows
Credential Manager. So limpet keeps each `agyN` account's login in `~/.agy-N`
(encrypted for your Windows user) and swaps it in for the length of the
launch, setting plain `agy`'s own login aside in `~/.agy` and putting it back
when `agyN` exits. Sign in once inside `agy1` and it stays signed in. Because
Credential Manager holds one login at a time, a second `agy` account is refused
while one is running (the same account in two tabs is fine), and plain `agy`
goes through limpet too, so it always gets its own login back. If a tab is
closed while `agyN` runs, plain `agy`'s login is put back the next time a tab
opens or `agy` starts. Every `agy` account already shares one chat history,
since agy keeps all of it in `~/.gemini`.
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
because Claude Code refuses to read that file through a link.

Codex accounts share plain `codex`'s history the same way: every `~/.codex-N`
gets its `sessions/`, `archived_sessions/` and `thread-writer-locks/` junctioned
to `~/.codex`'s, its `session_index.jsonl` (the thread names) hard-linked to
`~/.codex`'s, and `sqlite_home` in its `config.toml` pointed at `~/.codex`
(Codex's thread index, which `/resume` lists from), so `/resume` in `codex1`
lists the same threads, names included, as plain `codex`. Sharing the writer
locks keeps Codex's own guard working across accounts: a thread that is open
in one account can't be opened for writing in another at the same time.
`~/.codex` stays where it is (the Codex app and editor extensions keep using it
directly); a numbered home's own threads are folded into it on the first sync
and indexed there, and a thread copied to another account and continued there
keeps the longer copy. The wiring happens whenever a numbered `codex` command
runs (or by hand with `Sync-LimpetCodexHistory`); a home with a chat open is
left until a later launch. Logins, the rest of the config and the up-arrow
history stay per account.

Copilot accounts share plain `copilot`'s the same way: each `~/.copilot-N` gets
its `session-state/` (one folder per chat, which Copilot's resume list is built
from) junctioned to `~/.copilot`'s.

### Switch account, or agent, mid-chat

In the limpet app, choose **Accounts** (or right-click a tab) to see every account that is signed in,
of every agent, Claude and Codex ones with how much of their 5-hour and weekly
limit is left (`5h 88% · wk 70%`, hover for the reset times; green, amber and
red as it runs out; agy and Copilot show `usage n/a`). The account the tab's
chat is running on is marked. Accounts that aren't signed in are left out, and
the footer names the commands to run to add one (`Sign in to more: claude3,
codex1`). An `agy` account counts once its login is kept (plain `agy` once agy
has been used) and a Copilot one once Copilot has run in its home, since both
keep their tokens where limpet can't look. Pick another and limpet exits the
running agent and brings the same conversation up under the pick, in the same
shell:

- **Between accounts of one agent**: the same chat, resumed by id
  (`claude1 --resume`, `codex2 resume`, `agy1 --conversation`,
  `copilot2 --resume`). Nothing is copied; the history is shared (into a Codex
  home that isn't wired up yet, the rollout file is copied first).
- **Claude to Codex**: Codex's own importer turns the transcript into a thread
  in that Codex account, then `<account> resume <thread id>`.
- **Anything to Claude**: limpet writes the chat out as a Claude transcript and
  resumes it, so Claude remembers it natively.
- **Anything else** (to agy or Copilot, or from them to Codex), or a
  conversion that fails: the chat is rendered to a Markdown handoff file and
  the new agent starts with a one-line "continue from here" prompt pointing at
  it.

<p align="center"><img src="docs/media/switch.gif" width="840" alt="switch demo: the tab menu lists the signed-in accounts with usage left, and a Claude Code chat is moved to Codex, conversation intact" /></p>

Handy when one subscription hits its limit: the usage column shows which one
still has room. With nothing running in the tab, picking an account just
starts it there. Moving to Codex sends the conversation to OpenAI once Codex
replies, so pick with that in mind. Usage is read with each account's own
stored login, from the same endpoints `/usage` (Claude) and `/status` (Codex)
use, and nothing is written back; an expired login shows **Sign in required** until you
run that account again.

limpet also notices on its own. When the agent in a tab prints its limit
message (Claude Code's `You've hit your session limit · resets 3pm`, Codex's
`You've hit your usage limit`), or the tab's account shows 0% left when usage
is read, a small banner in the tab's corner offers the best other account:
`claude1 hit its 5-hour limit (resets 3:00 pm). Move this chat to claude2 (5h
88% left)?` **Move** is the same move as picking it in the menu; **Not now**
or Esc hides it until the next limit. It prefers another account of the same
agent with the most left on the window that ran out, then another agent's,
and only then one whose usage limit can't be read (agy, Copilot: `usage
unknown`). The banner never takes the keyboard from the terminal. In the
settings page (Ctrl+,), **When an account runs out** switches between this
offer, moving the chat automatically, or doing nothing. Automatic moves stay with the
same provider by default; settings can restrict them to named accounts. A move
to another provider always explains where the conversation goes and asks first.
An unverified launch stays visibly unverified; it is not reported as a resumed chat.

## Install

**Windows:** [Download the installer from the latest release](https://github.com/samuelwbarber/limpet/releases/latest). Choose the `limpet-Setup-<version>.exe` asset, run it, then open **limpet** from the Start Menu. The app includes its shell integration; Git and Node.js are not needed to use the installer.

The published v0.1.1 release currently contains a Windows installer only. macOS and Linux are supported by the source tree and build configuration, but do not yet have downloadable assets in that release. Use the [source instructions below](#macos-and-linux) on those platforms. Features on the main branch may be newer than the published installer.

### Your first session

1. Open **?** in the tab bar for getting-started help and read-only setup checks. These report SSH, SCP and optional coding-agent tools on the app's PATH; they do not install anything or read your logins.
2. Try a local command, then connect with `xssh user@host` using your own SSH login. You need an SSH client locally and access to the host. Run `tmux -V` on the remote host to check session protection: reconnecting without remote tmux starts a new shell.
3. Inside xssh, try `peek image.png` or `download report.txt` using a file on that host. Use **Settings** to adjust text size and shortcuts.
4. To use coding agents, install the desired agent CLI separately and sign in once for each account. Other terminal features work without any agent installed.

Installed builds check GitHub Releases for updates; source checkouts do not auto-update. See [update behaviour and platform restrictions](app/README.md#auto-update). Updating the app is separate from preserving running local processes.

### Windows source setup

For development or integration in other terminals:

```powershell
git clone https://github.com/samuelwbarber/limpet
cd limpet
.\install.ps1          # wires the module into your PowerShell profile

cd app                 # the limpet terminal app (peek/download/drop live here)
npm run setup
npm start              # or launch "limpet" from the Start Menu after install.ps1
```

- To get a normal Windows installer instead, run `npm run dist` in `app/`: it
  writes a per-user `limpet-Setup-<version>.exe` (with the module bundled) to
  `app\dist`, and the installed app keeps itself up to date from GitHub
  Releases. See [app/README.md](app/README.md#building-an-installer).
- The shell module (`shell/`) works in any terminal: Windows Terminal,
  WezTerm, VS Code. `install.ps1` adds it to your profile and creates a Start
  Menu entry for the app.
- The limpet app (`app/`) is the tabbed Electron terminal that renders inline
  images and catches `download`, `upload` and drag and drop.
- SSH keys: `.\setup-ssh.ps1` generates a key, loads `ssh-agent`, and can
  install it on a host (`-RemoteHost user@host`).

## macOS and Linux

The source tree supports Mac (Apple silicon or Intel) and Linux with platform-specific limitations: the app runs your login shell (zsh, or bash) with limpet's
integration loaded, so `xssh`, `peek`, `reels`, `wput`, drag and drop, the
agent accounts and the account menu all behave as on Windows. The Linux
command shims aren't needed (the shell is Unix already), Windows Hello becomes
the login Keychain on macOS, and junctions become symlinks. On Linux, SSH enrollment keeps the key passphrase in a local mode-0600 file; it is not sealed by a system keychain.

```sh
git clone https://github.com/samuelwbarber/limpet
cd limpet
./install.sh           # adds limpet to ~/.zshrc (and ~/.bashrc), installs the app
open app               # or: cd app && npm start
```

- **The app.** The current published v0.1.1 release has no macOS or Linux installers. Build with `npm run dist:mac` or `npm run dist:linux` in `app/`, or use `npm start` after source setup. Future macOS assets use `limpet-<version>-arm64.dmg` (Apple silicon) or `limpet-<version>-x64.dmg` (Intel); Linux uses AppImage. See [packaging instructions](app/README.md#building-an-installer) for signing and platform requirements. The bundled shell integration works inside the app; `install.sh` also makes it available in other terminals.
- **The shell integration** (`shell/limpet.sh`) is one file that zsh and bash
  both source. It adds `xssh` (same flags, `-NoResume`/`--no-resume`,
  `-Raw`/`--raw`), `peek`, `reels`, `wput`, `download`/`upload` (the same
  helpers `xssh` sends to remote hosts), the `limpet` banner, and every
  `claudeN`/`codexN`/`agyN`/`copilotN` account command.
- **Password once, then local enrollment.** Instead of `Enable-LimpetHello`, run
  `limpet-enroll user@host`: limpet makes a dedicated `~/.ssh/limpet_ed25519`
  key with a random passphrase kept in your login Keychain on macOS (a
  mode-0600 local file on Linux), installs it on
  the host (you type that host's password this one time) and from then on
  `xssh user@host` connects, and reconnects, without asking. `limpet-forget`
  and `limpet-status` go with it. Hosts that only take a password still get
  the reconnect cache: `xssh` asks once per session and replays it.
- **Agent accounts are identical**: `claude1` runs Claude Code with
  `CLAUDE_CONFIG_DIR=~/.claude-1`, `codex2` with `CODEX_HOME=~/.codex-2`, and so
  on, with the shared `/resume` history wired by symlinks. One macOS detail:
  Claude Code keeps its login in the Keychain there (item `Claude
  Code-credentials`, suffixed per config directory), which is where the
  account menu reads the signed-in state and usage from. Antigravity's login
  swap is best effort on macOS: it moves the `agy` Keychain item and hasn't
  been verified against a real Antigravity install yet.
- **Shortcuts** follow the platform: ⌘T new tab, ⌘W close tab, ⌘⇧] / ⌘⇧[ next
  and previous tab, ⌘, settings, ⌘C / ⌘V copy and paste (Ctrl+C stays the
  interrupt). All rebindable in Settings.
- **Generative backgrounds** need the local image model, which the pinned
  generator only ships for Apple silicon Macs (and x86_64 Linux); on an Intel
  Mac the picker says so. `npm run setup:backdrop:unix` in `app/` is the
  command-line install.

## How it fits together

| Layer | Job | What provides it |
|-------|-----|------------------|
| Terminal | tabs, rendering, inline images, drop target | limpet app (`app/`) |
| Session | survive bad links without re-auth | `xssh` (client-side) plus optional remote `tmux` |
| Shell | `ls -la`, `grep`, `wput`, `peek` | Limpet module (`shell/Limpet.psm1`) on Windows; `shell/limpet.sh` in zsh/bash on macOS and Linux |

In-session `peek`, `download` and `upload` talk to the app over private
terminal escape sequences, so they tunnel through SSH with no server-side
setup. Anything printed to the terminal could contain those sequences (a
`cat`-ed file, a hostile host), so the app only acts on `download`, `upload`
and `reels` requests that carry a per-install secret, which `xssh` hands to
the helpers it injects. `upload` also asks you to confirm each file before
it leaves your PC, and a downloaded folder always unpacks into a new folder
in Downloads, never over existing files.

## Repo layout

```
shell/       Limpet PowerShell module + limpet-remote.sh (in-session helpers) + Hello auth
             limpet.sh (the zsh/bash integration) + rc/ (how the app loads it into your shell)
app/         tabbed Electron terminal (xterm.js + node-pty: ConPTY on Windows, a pty elsewhere)
install.ps1  idempotent setup on Windows (profile, Start Menu shortcut)
install.sh   idempotent setup on macOS/Linux (~/.zshrc, ~/.bashrc, the app)
setup-ssh.ps1  SSH key setup helper
tests/       Test-Limpet.ps1 / Test-Xssh.ps1 (PowerShell), test-limpet-sh.sh (zsh + bash), test-remote-sh.sh
tools/demo/  scripts that record the README GIFs
docs/        COMMANDS.md reference, PORTING.md (how the macOS port is built), demo media
```

## Test

CI runs all of these on every push (see `.github/workflows/ci.yml`):

```powershell
.\tests\Test-Limpet.ps1    # every shell command + peek/reels protocol + Hello helpers
.\tests\Test-Xssh.ps1      # xssh bootstrap variants + reconnect policy (ssh stubbed)
bash tests/test-remote-sh.sh   # remote helpers + the real xssh bootstrap templates (Linux/WSL)
zsh tests/test-limpet-sh.sh    # the zsh/bash integration: accounts, history sync, xssh, peek (macOS/Linux)
bash tests/test-limpet-sh.sh   # the same suite under bash

cd app
npm test                   # terminal-protocol + account-switch unit tests (node --test)
npm run test:e2e           # launches the real app: peek, resize survival, reels, download, tab detach, account switch
```

The e2e drivers run on Windows and macOS (CI runs both); set
`LIMPET_E2E_USER_DATA=<folder>` to keep a local run off your real limpet
profile.
