// The application menu. On Windows and Linux limpet has none: every window's
// menu is removed, so the stock Ctrl+C/Ctrl+V accelerators can't race xterm's
// handlers (that was the source of double pastes). A Mac app needs a menu bar
// for About / Hide / Quit (Cmd+Q) and the Window menu, so one is set here with
// deliberately NO Edit menu: Cmd+C and Cmd+V then have exactly one path, the
// renderer's key handler, and Cmd+W belongs to close-tab rather than a window
// close role.
//
// The menu is laid out like Terminal.app's (Shell, View, Window) and shows the
// shortcuts beside each item, but the tab and terminal shortcuts are only
// *displayed* here (registerAccelerator: false): the renderer's key handler
// owns those keys (several are rebindable in Settings), so there is still
// exactly one path for each. Picking an item sends the renderer a
// 'menu:action'. installAppMenu is called again when the shortcuts change so
// the labels follow the settings.
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

// A menu item whose shortcut is handled by the renderer: shown, not registered.
function item(label, action, accelerator) {
  const out = { label, click: () => sendToFocused(action) };
  if (accelerator) { out.accelerator = accelerator; out.registerAccelerator = false; }
  return out;
}

// installAppMenu({ keybindings, newWindow }): keybindings is the settings'
// map (canonical "Cmd+Shift+]" form, which Electron accepts as is); newWindow
// opens a fresh window.
function installAppMenu({ keybindings = {}, newWindow = null } = {}) {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; }
  const kb = (action) => keybindings[action] || undefined;
  const template = [
    { role: 'appMenu', submenu: [
      { role: 'about' }, { type: 'separator' },
      item('Settings…', 'settings', kb('openSettings')),
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'Shell', submenu: [
      ...(newWindow ? [{ label: 'New Window', accelerator: 'Cmd+N', click: () => newWindow() }] : []),
      item('New Tab', 'new-tab', kb('newTab')),
      { type: 'separator' },
      item('Close Tab', 'close-tab', kb('closeTab')),
      { label: 'Close Window', accelerator: 'Cmd+Shift+W', click: () => { const w = BrowserWindow.getFocusedWindow(); if (w) w.close(); } },
      { type: 'separator' },
      item('Find…', 'find', kb('findOutput')),
      item('Clear to Start', 'clear', 'Cmd+K'),
      { type: 'separator' },
      item('Accounts…', 'accounts'),
    ] },
    { label: 'View', submenu: [
      item('Default Font Size', 'font-reset', 'Cmd+0'),
      item('Bigger', 'font-bigger', 'Cmd+Plus'),
      item('Smaller', 'font-smaller', 'Cmd+-'),
    ] },
    { role: 'window', label: 'Window', submenu: [
      { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' },
      item('Show Previous Tab', 'prev-tab', kb('prevTab')),
      item('Show Next Tab', 'next-tab', kb('nextTab')),
      { type: 'separator' }, { role: 'front' },
    ] },
    { role: 'help', submenu: [{ label: 'Getting Started…', click: () => sendToFocused('help') }, { label: 'limpet on GitHub', click: () => shell.openExternal(REPO_URL) }] },
  ];
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } catch (error) {
    // A shortcut Electron can't parse must not cost the whole menu bar.
    console.error('[limpet] menu shortcuts not shown:', error.message);
    const plain = (items) => items.map(({ accelerator, registerAccelerator, ...rest }) => (rest.submenu ? { ...rest, submenu: plain(rest.submenu) } : rest));
    Menu.setApplicationMenu(Menu.buildFromTemplate(plain(template)));
  }
}

// macOS: clicking the dock icon with no window open re-opens one; `cb` makes it.
function onActivate(cb) {
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) cb(); });
}

module.exports = { installAppMenu, onActivate };
