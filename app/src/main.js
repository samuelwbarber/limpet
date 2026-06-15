// winux - Electron main process.
// A terminal running local PowerShell (with the Winux Linux-shim module). You
// connect to remote hosts however you like (e.g. `xssh user@host`) right in the
// shell. Dropping files onto the window "pastes" them into whatever shell is in
// front, reconstructing each file in the current directory from base64 — so it
// works inside your SSH session with nothing installed on the remote but
// coreutils (base64). Real ConPTY via node-pty; pipe fallback if unavailable.

const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let ptyLib = null;
try {
  ptyLib = require('@homebridge/node-pty-prebuilt-multiarch');
} catch (e) {
  console.error('[winux] node-pty unavailable, using pipe fallback:', e.message);
}

const WINUX_MODULE = path.join(__dirname, '..', '..', 'shell', 'Winux.psd1');
const MAX_DROP_BYTES = 20 * 1024 * 1024; // pasting more than this through a PTY is impractical
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
let term = null;
let lastCols = 80;
let lastRows = 24;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startShell() {
  const args = ['-NoExit', '-NoLogo', '-Command', `Import-Module "${WINUX_MODULE}"`];

  if (ptyLib) {
    try {
      const p = ptyLib.spawn('powershell.exe', args, {
        name: 'xterm-256color', cols: lastCols, rows: lastRows,
        cwd: process.env.USERPROFILE || process.cwd(), env: process.env,
      });
      p.onData((d) => send('term:data', d));
      p.onExit(() => send('term:data', '\r\n\x1b[90m[winux] shell exited.\x1b[0m\r\n'));
      return {
        write: (d) => { try { p.write(d); } catch (_) { /* ignore */ } },
        resize: (c, r) => { try { p.resize(c, r); } catch (_) { /* ignore */ } },
        kill: () => { try { p.kill(); } catch (_) { /* ignore */ } },
      };
    } catch (e) {
      console.error('[winux] pty spawn failed, pipe fallback:', e.message);
    }
  }

  const cp = spawn('powershell.exe', args, { windowsHide: true });
  cp.stdout.on('data', (d) => send('term:data', d.toString()));
  cp.stderr.on('data', (d) => send('term:data', d.toString()));
  cp.on('exit', () => send('term:data', '\r\n\x1b[90m[winux] shell exited.\x1b[0m\r\n'));
  return {
    write: (d) => { try { cp.stdin.write(d); } catch (_) { /* ignore */ } },
    resize: () => { /* pipes can't resize */ },
    kill: () => { try { cp.kill(); } catch (_) { /* ignore */ } },
  };
}

// Decode base64 into a file in the shell's *current* directory. We feed the
// data straight into `base64 -d` reading stdin and end it with EOT (Ctrl+D, the
// \x04). No here-doc means bash prints no "> " continuation prompts, so with
// echo off nothing scrolls past — just the confirmation line at the end.
function buildDropPayload(localPath) {
  const buf = fs.readFileSync(localPath);
  const name = path.basename(localPath).replace(/'/g, `'\\''`);
  const b64 = buf.toString('base64').replace(/(.{120})/g, '$1\n');
  return `base64 -d > '${name}'\n${b64}\n\x04printf '[winux] received %s\\n' '${name}'\n`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 660, backgroundColor: '#1e1e2e', title: 'winux',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.on('did-finish-load', () => { term = startShell(); });

  ipcMain.handle('clip:write', (_e, text) => { clipboard.writeText(String(text || '')); });
  ipcMain.handle('clip:read', () => clipboard.readText());

  ipcMain.on('term:input', (_e, d) => { if (term) term.write(d); });
  ipcMain.on('term:resize', (_e, { cols, rows }) => { lastCols = cols; lastRows = rows; if (term) term.resize(cols, rows); });

  ipcMain.handle('term:drop-files', async (_e, paths) => {
    if (!term) return { ok: false };

    // Validate up front.
    const files = [];
    for (const p of paths) {
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      const base = path.basename(p);
      if (st.isDirectory()) {
        send('term:data', `\r\n\x1b[33m[winux] skipping folder (files only): ${base}\x1b[0m\r\n`);
        continue;
      }
      if (st.size > MAX_DROP_BYTES) {
        send('term:data', `\r\n\x1b[31m[winux] ${base} is ${(st.size / 1048576).toFixed(0)} MB — too big to paste; use scp/wput.\x1b[0m\r\n`);
        continue;
      }
      files.push(p);
    }
    if (!files.length) return { ok: true, sent: [] };

    // Silence the remote terminal's echo so the base64 doesn't flood the screen,
    // and erase the command line it was typed on. stty echo is restored after.
    // The base64 echo is done by the remote tty, so wait for stty to take effect
    // before streaming the data.
    term.write("stty -echo 2>/dev/null; printf '\\033[1A\\r\\033[2K'\n");
    await sleep(250);
    const sent = [];
    for (const p of files) {
      term.write(buildDropPayload(p));
      sent.push(path.basename(p));
    }
    term.write('stty echo 2>/dev/null\n');
    return { ok: true, sent };
  });

  win.on('closed', () => { if (term) term.kill(); term = null; win = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
