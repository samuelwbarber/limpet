# winux (app)

The winux terminal app — Electron + xterm.js, running local PowerShell with the
Winux Linux-shim module preloaded. You connect to remotes however you like right
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

## Drag-and-drop upload

Drop files onto the window and winux "pastes" them into the current session: it
types a `base64 -d` here-doc that reconstructs each file in the shell's current
directory. So inside an `xssh`/`ssh` session the file lands in your remote cwd,
with nothing installed on the remote but coreutils. Limits: files only (folders
skipped) and up to 20 MB per file — use `scp`/`wput` for anything larger.
