// The application menu. On Windows and Linux limpet has none: every window's
// menu is removed, so the stock Ctrl+C/Ctrl+V accelerators can't race xterm's
// handlers (that was the source of double pastes). A Mac app needs a menu bar
// for About / Hide / Quit (Cmd+Q) and the Window menu, so one is set here with
// deliberately NO Edit menu: Cmd+C and Cmd+V then have exactly one path, the
// renderer's key handler, and Cmd+W belongs to close-tab rather than a window
// close role. "New Tab" carries no accelerator for the same reason (the
// renderer's rebindable shortcut handles the keys); picking it sends the
// renderer a 'menu:action'.
//
// The Window menu carries role 'window' so Electron registers it as the app's
// real Window menu (NSApp.windowsMenu). macOS only attaches its window tiling
// (Fill, Centre, Move & Resize and their Fn+Ctrl+arrow shortcuts) and the open
// window list to that menu; a submenu that is merely labelled "Window" gets
// neither. The role is 'window' rather than 'windowMenu' because the stock
// menu would bring a Cmd+W close-window item with it.
const { app, BrowserWindow, Menu, shell } = require('electron');

const REPO_URL = 'https://github.com/samuelwbarber/limpet';

function sendToFocused(action) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send('menu:action', action);
}

function installAppMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Settings…', click: () => sendToFocused('settings') },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'Shell', submenu: [
      { label: 'New Tab', click: () => sendToFocused('new-tab') },
      { type: 'separator' },
      { label: 'Find in Output…', click: () => sendToFocused('find') },
      { label: 'Accounts…', click: () => sendToFocused('accounts') },
    ] },
    { role: 'window', label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
    { role: 'help', submenu: [{ label: 'Getting Started…', click: () => sendToFocused('help') }, { label: 'limpet on GitHub', click: () => shell.openExternal(REPO_URL) }] },
  ]));
}

// macOS: clicking the dock icon with no window open re-opens one; `cb` makes it.
function onActivate(cb) {
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) cb(); });
}

module.exports = { installAppMenu, onActivate };
