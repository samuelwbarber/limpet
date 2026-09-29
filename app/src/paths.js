// Where files live once electron-builder has packed the app. src/ then sits
// inside resources/app.asar, which only Electron's own fs can read, so a file
// handed to another process (powershell.exe -File ...) is unpacked beside it
// into app.asar.unpacked (asarUnpack in package.json) and must be named there.
// Plain Node (the unit tests) and `npm start` see the source tree unchanged.
const path = require('path');

const ASAR = /([\\/])app\.asar(?=[\\/])/;
const PACKAGED = ASAR.test(__dirname);

function unpacked(file) {
  return PACKAGED ? file.replace(ASAR, '$1app.asar.unpacked') : file;
}

// Writable per-user data (%APPDATA%\limpet), for what can't go in the install dir.
function userData(...parts) {
  return path.join(require('electron').app.getPath('userData'), ...parts);
}

module.exports = { PACKAGED, unpacked, userData };
