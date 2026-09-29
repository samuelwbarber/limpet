# limpet (app)

The limpet terminal app — Electron + xterm.js, running local PowerShell with the
Limpet Linux-shim module preloaded. You connect to remotes however you like right
in the shell (e.g. `xssh user@host`); there's no separate connection UI.

## Setup

```powershell
npm install
npm start
```

Needs Node 22.12 or newer. The local shell gets a real ConPTY (line editing,
Ctrl+R, arrows, full-screen TUIs) from Microsoft's `node-pty`, a Node-API module
that ships prebuilt Windows x64 and arm64 binaries, so it works with any
Electron version and nothing is compiled on install. If it fails to load the
app still runs, but the local shell falls back to a basic pipe with no line
editing.

Electron downloads its own binary the first time it runs (Electron 42 dropped
the install-time download), so the first `npm start` takes a little longer.

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
Release workflow (`.github/workflows/release.yml`) builds the installer and
publishes it with `latest.yml` and the `.blockmap` as a GitHub Release, signed
if the `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` repo secrets are set.

## Tabs, clipboard, and links

Use `Ctrl+Shift+T` for a new tab, `Ctrl+Shift+W` to close one, and `Ctrl+Tab`
to cycle (all rebindable in [Settings](#settings)). Drag a tab beyond the current window to move its live shell into a
new limpet window; the PTY is handed over rather than restarted.

`Ctrl+V` and `Ctrl+Shift+V` paste once, while `Ctrl+C` copies selected terminal
text and remains the normal interrupt when nothing is selected. Plain web URLs
and OSC 8 hyperlinks open in the Windows default browser, including agent login
links.

## Settings

`Ctrl+,` (or **Settings…** at the foot of a tab's right-click menu) opens the
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
| | Scrollback lines | 1000 (1000–100000) |
| Behaviour | Predictive echo | on |
| | Copy on select | off |
| Reels | Default page | `https://www.instagram.com/reels/` |
| Generative backdrop | First picture after | 3000 characters of output |
| | New picture after | 9000 more characters |
| | At most one new picture every | 10 minutes |
| Keyboard shortcuts | New tab / Close tab | `Ctrl+Shift+T` / `Ctrl+Shift+W` |
| | Next / Previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| | Open settings | `Ctrl+,` |
| Agents | When an account runs out | offer (offer, auto, off) |

To rebind a shortcut, focus its field and press the new combination
(Backspace unbinds it). It needs Ctrl or Alt, or an F key, so it can't swallow
typing, and `Ctrl+C`, `Ctrl+V`, `Ctrl+Shift+C` and `Ctrl+Shift+V` stay copy and
paste. The defaults are what limpet did before there was a settings page.

The settings live in `%APPDATA%\limpet\settings.json`, which holds only what
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
npm run setup:backdrop
```

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

Drop files onto the window and limpet "pastes" them into the current session: it
types a `base64 -d` here-doc that reconstructs each file in the shell's current
directory. So inside an `xssh`/`ssh` session the file lands in your remote cwd,
with nothing installed on the remote but coreutils. Pasting is for files up to
20 MB. Folders and bigger files are copied with `scp` (`-r`, `BatchMode=yes`,
your `~/.ssh/id_ed25519` if present) to `host:<remote cwd>/`, running beside
the shell with a status line when it starts and ends. That needs an `xssh`
session in the tab: xssh reports the host and port (`5379;xssh`), and the
injected helpers report each bash prompt's `$PWD` and hop depth (`5379;cwd`),
both carrying the app's token. limpet refuses, saying why, when there's no
xssh connection, the prompt is past an `xssh` hop (scp can't reach it), the
directory has spaces or shell characters (older scp would mangle them), or
the helpers run under plain `sh`; `wput` covers those.

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
