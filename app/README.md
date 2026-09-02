# limpet (app)

The limpet terminal app — Electron + xterm.js, running local PowerShell with the
Limpet Linux-shim module preloaded. You connect to remotes however you like right
in the shell (e.g. `xssh user@host`); there's no separate connection UI.

## Setup

```powershell
npm install
npm run fetch-pty   # downloads the ConPTY binary matching this Electron's ABI
npm start
```

`fetch-pty` is needed because the upstream node-pty package's own installer
fails on recent Node/Windows; this script fetches the correct prebuilt binary so
the local shell gets a real ConPTY (line editing, Ctrl+R, arrows, full-screen
TUIs). Without it the app still runs, but the local shell falls back to a basic
pipe with no line editing.

Electron is pinned to 29.x because that's the newest ABI the prebuilt PTY ships
a Windows binary for.

## Tabs, clipboard, and links

Use `Ctrl+Shift+T` for a new tab, `Ctrl+Shift+W` to close one, and `Ctrl+Tab`
to cycle. Drag a tab beyond the current window to move its live shell into a
new limpet window; the PTY is handed over rather than restarted.

`Ctrl+V` and `Ctrl+Shift+V` paste once, while `Ctrl+C` copies selected terminal
text and remains the normal interrupt when nothing is selected. Plain web URLs
and OSC 8 hyperlinks open in the Windows default browser, including agent login
links.

## Local conversation backdrops

After a terminal has accumulated enough useful content and then goes idle,
limpet creates a session-specific background locally. A clear stylized scene
depicts that terminal's actual subject in the app's indigo/blue/pastel
palette—for example, work on a slot-machine app produces a prominent,
recognizable slot machine. Each tab has its own scene, and a detached tab keeps
its scene.

Setup is a one-time 2.0 GB model download:

```powershell
npm run setup:backdrop
```

Generation uses a repo-local `stable-diffusion.cpp` CPU build and an eight-step
LCM model. When Claude Code or another terminal program provides a meaningful
chat/window title, that title is the primary image subject. Generic titles such
as `PowerShell` are ignored. Otherwise terminal text is cleaned and continuously
reduced into a rolling, recency-weighted profile capped at 64 topic scores. This
lets the subject survive very long agent conversations without retaining the
transcript; only a small temporary text chunk exists while its scores are being
calculated. Ambiguous fallback topic changes keep the existing scene until the
new subject is clear. Neither terminal text, the title, nor the generated prompt
is sent to an API. The first background is made after roughly 3,000 characters
of output. Updates require another 9,000 characters and are limited to one every
ten minutes, so the generator does not continually compete with the shell.

## Drag-and-drop upload

Drop files onto the window and limpet "pastes" them into the current session: it
types a `base64 -d` here-doc that reconstructs each file in the shell's current
directory. So inside an `xssh`/`ssh` session the file lands in your remote cwd,
with nothing installed on the remote but coreutils. Limits: files only (folders
skipped) and up to 20 MB per file — use `scp`/`wput` for anything larger.

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
