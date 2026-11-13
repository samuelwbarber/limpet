# limpet (app)

The limpet terminal app — Electron + xterm.js, running local PowerShell with the
Limpet Linux-shim module preloaded on Windows, or your login shell (zsh or
bash) with `shell/limpet.sh` loaded on macOS and Linux. You connect to remotes
however you like right in the shell (e.g. `xssh user@host`); there's no
separate connection UI.

## Setup

```powershell
npm run setup          # npm install with package scripts skipped, then Electron's download
npm start
```

Needs Node 22.12 or newer. The local shell gets a real pty (line editing,
Ctrl+R, arrows, full-screen TUIs) from Microsoft's `node-pty`, a Node-API
module that ships prebuilt binaries for Windows (x64, arm64; ConPTY), macOS
(arm64, x64) and Linux, so it works with any Electron version and nothing is
compiled on install. If it fails to load the app still runs, but the local
shell falls back to a basic pipe with no line editing.

Electron downloads its own binary the first time it runs (Electron 42 dropped
the install-time download), so the first `npm start` takes a little longer.

On macOS and Linux the app starts `$SHELL` as an interactive login shell, with
limpet's integration added through `ZDOTDIR` (zsh) or `--rcfile` (bash) so your
own dotfiles still run and nothing of yours is edited; `LIMPET_SHELL=/bin/bash`
picks another shell (the tests use it).

## Building an installer

```powershell
npm install
npm run dist
```

This builds a per-user NSIS installer with electron-builder, for x64 and
arm64 in one `limpet-Setup-<version>.exe`, in `app\dist`. It installs under
`%LOCALAPPDATA%\Programs\limpet` without admin rights and adds Start Menu and
desktop shortcuts. The Limpet module ships inside it (`resources\shell`), so
the installed app doesn't need this repo. `dist` never uploads anything
(`--publish never`).

The installer is unsigned unless these are set when you run `npm run dist`, in
which case electron-builder signs the app and installer with that certificate:

- `WIN_CSC_LINK`: path, `file://` URL or base64 of a `.pfx`/`.p12` code-signing certificate
- `WIN_CSC_KEY_PASSWORD`: its password

An unsigned installer works, but SmartScreen warns before running it.

### macOS

```sh
npm run dist:mac
```

This writes `limpet-<version>-arm64.dmg` / `-x64.dmg` (and the `.zip` the
auto-updater uses) to `app/dist`, the shell integration bundled in
`limpet.app/Contents/Resources/shell`. The build is signed and notarized when
these are set, otherwise unsigned (Gatekeeper then needs a right-click →
**Open** the first time, or `xattr -d com.apple.quarantine limpet.app`):

- `CSC_LINK` / `CSC_KEY_PASSWORD`: a Developer ID Application certificate (`.p12`) and its password
- `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`: for notarization (`--config.mac.notarize=true`)

The hardened-runtime entitlements the app needs (JIT and the native pty
module) are in `build/entitlements.mac.plist`; the icon is made from
`build/icon.png`. `npm run dist:linux` builds an AppImage the same way.

## Auto-update

The installed app (not `npm start`) checks the GitHub Releases of
`samuelwbarber/limpet` about 15 seconds after it opens and every 6 hours after
that. When a release for a newer version carries electron-builder's update
files (`latest.yml` plus the installer and its `.blockmap`, all written to
`app\dist` by `npm run dist`), limpet downloads it in the background and then
asks whether to restart now; **Later** installs it the next time limpet quits.
Being offline, or there being no such release yet, is only logged. The feed is
`build.publish` in `package.json`, and the update client is `src/updater.js`.

To release: bump `version` in `package.json` (and `package-lock.json`), commit,
then push a matching tag, e.g. `git tag v0.1.2 && git push origin v0.1.2`. The
Release workflow (`.github/workflows/release.yml`) builds the Windows installer
and the macOS disk images and publishes them, with `latest.yml`,
`latest-mac.yml` and the `.blockmap`s, as one GitHub Release: signed if the
`WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` (Windows) and `CSC_LINK`/`CSC_KEY_PASSWORD`
(macOS, plus `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` for
notarization) repo secrets are set. On macOS the updater only applies an update
to a signed app, so an unsigned build logs the check and leaves it at that.

## Tabs, clipboard, and links

Use `Ctrl+Shift+T` for a new tab, `Ctrl+Shift+W` to close one, and `Ctrl+Tab`
to cycle (all rebindable in [Settings](#settings)). Drag a tab beyond the current window to move its live shell into a
new limpet window; the PTY is handed over rather than restarted.

`Ctrl+V` and `Ctrl+Shift+V` paste once, while `Ctrl+C` copies selected terminal
text and remains the normal interrupt when nothing is selected. Plain web URLs
and OSC 8 hyperlinks open in the system default browser, including agent login
links.

On macOS the defaults are the Mac ones: `⌘T` new tab, `⌘W` close tab, `⌘⇧]` /
`⌘⇧[` next and previous tab, `⌘,` settings, `⌘C` copies the selection (and
never interrupts), `⌘V` pastes; `Ctrl+C` stays the interrupt and
`Ctrl+Shift+V` still pastes. The app keeps a minimal menu bar (limpet, Window)
with no Edit menu, so each shortcut has exactly one path into the terminal.

## Settings

`Ctrl+,` (or **Settings** in the toolbar) opens the
settings page over the terminal. Changes apply as you make them, in every
window: the font, size, line height, cursor and scrollback of every open tab
change live, and a new tab opens with them. A value limpet can't use (a font
size of 40, a reels page that isn't `https:`/`http:`, a shortcut another action
already has) is refused with the reason under the field and the old value
stays. Each section has **Reset to defaults**; `Esc` closes the page and hands
the keyboard back to the terminal.

| Section | Setting | Default |
| --- | --- | --- |
| Terminal | Font family | `'Cascadia Mono', Consolas, monospace` |
| | Font size | 14 (8–32) |
| | Line height | 1 (1–2) |
| | Cursor style | block (block, underline, bar) |
| | Blinking cursor | on |
| | Scrollback lines | 10000 (1000 to 100000) |
| Behaviour | Predictive echo | on |
| | Copy on select | off |
| Reels | Default page | `https://www.instagram.com/reels/` |
| Generative backdrop | First picture after | 3000 characters of output |
| | New picture after | 9000 more characters |
| | At most one new picture every | 10 minutes |
| Keyboard shortcuts | New tab / Close tab | `Ctrl+Shift+T` / `Ctrl+Shift+W` |
| | Next / Previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| | Open settings | `Ctrl+,` |
| | Find in output | `Ctrl+Shift+F` (`Cmd+F` on macOS), rebindable |
| Agents | When an account runs out | offer (offer, auto, off) |

To rebind a shortcut, focus its field and press the new combination
(Backspace unbinds it). It needs Ctrl or Alt (or Cmd on macOS), or an F key, so
it can't swallow typing, and `Ctrl+C`, `Ctrl+V`, `Ctrl+Shift+C` and
`Ctrl+Shift+V` (`⌘C` / `⌘V` on macOS) stay copy and paste. The defaults are
what limpet did before there was a settings page; on macOS the keyboard
defaults are `Cmd+T`, `Cmd+W`, `Cmd+Shift+]`, `Cmd+Shift+[` and `Cmd+,`.

The settings live in `%APPDATA%\limpet\settings.json` (`~/Library/Application
Support/limpet/settings.json` on macOS, `~/.config/limpet/` on Linux), which holds only what
differs from the defaults and is replaced whole on each save (written beside it,
then renamed over it). A file that isn't valid JSON is set aside as
`settings.json.bad` and the defaults are used; a value in it that limpet
wouldn't accept from the page falls back to its default. The store is
`src/settings.js` (unit-tested in `tests/settings.test.js`), the page
`src/settings-ui.js` and `src/settings.css`.

## Local conversation backdrops

After a terminal has accumulated enough useful content and then goes idle,
limpet creates a session-specific background locally. A clear stylized scene
depicts that terminal's actual subject in the app's indigo/blue/pastel
palette—for example, work on a slot-machine app produces a prominent,
recognizable slot machine. Each tab has its own scene, and a detached tab keeps
its scene.

Setup is a one-time download of about 675 MB (the generator plus the 651 MB
model) into `app\local-ai` (the installed app uses `%APPDATA%\limpet\local-ai`). Picking **Generative** from the tab menu before it
is installed asks whether to install it, then shows progress with a Cancel
button (a cancelled download resumes next time). The same setup from a prompt:

```powershell
npm run setup:backdrop         # Windows
npm run setup:backdrop:unix    # macOS (Apple silicon) and Linux x86_64
```

The pinned generator release has no Intel Mac build, so on those the picker
says the Generative background isn't available. On macOS the model lives in
`~/Library/Application Support/limpet/local-ai` for the installed app.

Generation uses a repo-local `stable-diffusion.cpp` CPU build and the one-step,
Q8-quantized SDXS-512 model. Its output is reduced locally to a 160x100 limited
palette and enlarged with hard pixel edges, producing actual crisp pixel blocks
rather than a soft pixel-art imitation. When Claude Code or another terminal
program provides a meaningful chat/window title, that title is the primary image
subject. Generic titles such as `PowerShell` are ignored. Otherwise terminal
text is cleaned and continuously
reduced into a rolling, recency-weighted profile capped at 64 topic scores. This
lets the subject survive very long agent conversations without retaining the
transcript; only a small temporary text chunk exists while its scores are being
calculated. Ambiguous fallback topic changes keep the existing scene until the
new subject is clear. Neither terminal text, the title, nor the generated prompt
is sent to an API. The first background is made after roughly 3,000 characters
of output. Updates require another 9,000 characters and are limited to one every
ten minutes, so the generator does not continually compete with the shell (all
three are adjustable in [Settings](#settings)).

## Drag-and-drop upload

Files and folders of every size are copied over `scp` to the directory last
reported by the remote prompt in an `xssh` tab. A confirmation previews the
host, directory, filenames and overwrite behaviour. The destination stays fixed
for that operation even if the terminal subsequently changes directory.

Copies run outside the live terminal, with a transfer card for status,
cancellation and retry. Byte progress is unavailable; cancellation may leave a
partial remote file. Retry rechecks and confirms the current destination.
Authentication uses SSH keys or an agent. Unknown destinations, nested hops and
paths unsafe for older scp versions are refused with an explanation; use `wput`
from the client in those cases. Dropping into a local shell never injects Unix
transfer commands into PowerShell or a running program.

## Predictive echo (laggy links)

On a slow ssh link, every keystroke normally has to round-trip to the server
before you see it. limpet predicts printable characters locally and draws them
**in red** the instant you type, then hands each one off to the terminal's real
(normal-coloured) text once the server's echo confirms it — the Mosh trick, done
client-side in `predict.js`. Predictions are a DOM overlay *on top of* xterm and
never touch its buffer, so a wrong guess is just a cleared overlay, never
corruption. It's adaptive (invisible on a fast link, because the echo beats the
reveal) and self-gating (a no-echo prompt like a password is never shown, and
Enter forgets the echo context so a following `sudo` prompt stays dark). Only
plain typing is predicted; Enter/Tab/arrows/escapes/pastes clear predictions.

## Session recovery and agent moves

A stopped shell keeps its output, exit status and restart controls. Closing a
live tab or window asks first. On startup, saved tab labels and local directories
can be restored into fresh shells; commands, remote connections and output are
not replayed. Workspace metadata is kept in `userData/workspace.json`.

Agent moves prepare the destination before stopping the source. Missing sessions
fail visibly rather than silently creating a new conversation. Native resume is
marked ready only after the expected account and session are detected. Imported
or Markdown handoffs explain the method; a detected process alone cannot prove
that context was loaded. Failures retain a recovery command for copying, never
execute it automatically, and moving across providers asks before preparation.
Automatic failover defaults to the same provider and supports a comma-separated
account allowlist in Settings.

**Find** searches scrollback (Ctrl+Shift+F / Cmd+F); **?** opens getting-started
help and read-only checks for SSH and optional agent CLIs on the app's PATH.
