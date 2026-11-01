// The application menu. On Windows and Linux limpet has none: every window's
// menu is removed, so the stock Ctrl+C/Ctrl+V accelerators can't race xterm's
// handlers (that was the source of double pastes). A Mac app needs a menu bar
// for About / Hide / Quit (Cmd+Q) and the Window menu, so one is set here with
// deliberately NO Edit menu: Cmd+C and Cmd+V then have exactly one path, the
// renderer's key handler, and Cmd+W belongs to close-tab rather than a window
// close role. "New Tab" carries no accelerator for the same reason (the
// renderer's rebindable shortcut handles the keys); picking it sends the
// renderer a 'menu:action'.
const { app, BrowserWindow, Menu, shell } = require('electron');

const REPO_URL = 'https://github.com/samuelwbarber/limpet';

function sendToFocused(action) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send('menu:action', action);
}

function installAppMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'Shell', submenu: [{ label: 'New Tab', click: () => sendToFocused('new-tab') }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
    { role: 'help', submenu: [{ label: 'limpet on GitHub', click: () => shell.openExternal(REPO_URL) }] },
  ]));
}

// macOS: clicking the dock icon with no window open re-opens one; `cb` makes it.
function onActivate(cb) {
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) cb(); });
}

module.exports = { installAppMenu, onActivate };
