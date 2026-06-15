// winux - Electron main process.
// Milestone 1: a window running PowerShell (with the Winux Linux-shim module
// preloaded) through a real PTY. Uses a prebuilt node-pty so no compiler is
// needed; falls back to pipe mode if the native binary can't load, so the app
// always launches.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let ptyLib = null;
let shellMode = 'pty';
try {
  ptyLib = require('@homebridge/node-pty-prebuilt-multiarch');
} catch (e) {
  shellMode = 'pipe';
  console.error('[winux] node-pty unavailable, using pipe fallback:', e.message);
}

// The Winux PowerShell module lives one level up from app/.
const WINUX_MODULE = path.join(__dirname, '..', '..', 'shell', 'Winux.psd1');
const SHELL_EXE = 'powershell.exe';
const SHELL_ARGS = ['-NoExit', '-NoLogo', '-Command', `Import-Module "${WINUX_MODULE}"`];

function createSession(win) {
  if (shellMode === 'pty' && ptyLib) {
    try {
      const p = ptyLib.spawn(SHELL_EXE, SHELL_ARGS, {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: process.env.USERPROFILE || process.cwd(),
        env: process.env,
      });
      p.onData((d) => win.webContents.send('term:data', d));
      p.onExit(() => win.webContents.send('term:exit'));
      return {
        write: (d) => p.write(d),
        resize: (c, r) => { try { p.resize(c, r); } catch (_) { /* ignore */ } },
        kill: () => { try { p.kill(); } catch (_) { /* ignore */ } },
      };
    } catch (e) {
      shellMode = 'pipe';
      console.error('[winux] pty spawn failed, using pipe fallback:', e.message);
    }
  }

  const cp = spawn(SHELL_EXE, SHELL_ARGS, { windowsHide: true });
  cp.stdout.on('data', (d) => win.webContents.send('term:data', d.toString()));
  cp.stderr.on('data', (d) => win.webContents.send('term:data', d.toString()));
  cp.on('exit', () => win.webContents.send('term:exit'));
  return {
    write: (d) => cp.stdin.write(d),
    resize: () => { /* pipes can't resize */ },
    kill: () => { try { cp.kill(); } catch (_) { /* ignore */ } },
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 640,
    backgroundColor: '#1e1e2e',
    title: 'winux',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));

  let session = null;
  win.webContents.on('did-finish-load', () => {
    session = createSession(win);
    win.webContents.send('term:mode', shellMode);
  });

  ipcMain.on('term:input', (_e, d) => { if (session) session.write(d); });
  ipcMain.on('term:resize', (_e, { cols, rows }) => { if (session) session.resize(cols, rows); });
  win.on('closed', () => { if (session) session.kill(); });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
