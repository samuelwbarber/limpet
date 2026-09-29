// Auto-update for the installed app. electron-updater reads the feed that
// electron-builder writes into the install (build.publish in package.json:
// GitHub Releases of samuelwbarber/limpet), checks shortly after startup and
// every 6 hours, and downloads a newer version in the background. Once it's
// down we offer a restart; "Later" leaves it to install when limpet quits.
// Being offline, rate-limited, or having no releases yet is only logged: the
// user is never asked about anything but a ready update.
const { app, dialog, BrowserWindow } = require('electron');

const FIRST_CHECK_MS = 15 * 1000; // let the first window and its shell settle
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let started = false;

function start() {
  // `npm start` runs from source: there's no install to update.
  if (started || !app.isPackaged) return;
  started = true;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.error('[limpet] auto-update unavailable:', e.message);
    return;
  }
  autoUpdater.logger = null; // its per-check chatter; errors are logged below
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (e) => {
    console.error('[limpet] update check failed:', (e && e.message) || e);
  });

  let offered = null; // don't ask twice about the same version
  autoUpdater.on('update-downloaded', async (info) => {
    if (offered === info.version) return;
    offered = info.version;
    const options = {
      type: 'info',
      title: 'limpet update',
      message: `limpet ${info.version} is ready to install.`,
      detail: 'Restarting closes your tabs and their shells. Choose Later and it installs the next time limpet quits.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      // Silent install, then relaunch.
      if (response === 0) autoUpdater.quitAndInstall(true, true);
    } catch (e) {
      console.error('[limpet] update prompt failed:', e.message);
    }
  });

  // A failed check also emits 'error' (logged above); swallow the rejection.
  const check = () => { autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = { start };
