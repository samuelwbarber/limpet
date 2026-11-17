// Auto-update for macOS builds that aren't Developer ID signed. electron-updater
// hands a Mac update to Squirrel.Mac, which refuses an ad-hoc signed app (ours,
// when the release has no signing secrets), so such a build would never update.
// This does the same job by hand, with the same feed and the same prompt:
//
//   1. fetch latest-mac.yml from the latest GitHub Release (LIMPET_UPDATE_FEED
//      points it at another folder, for tests), and carry on only if it names a
//      newer version;
//   2. download the zip for this CPU into userData/pending-update and check its
//      sha512 against the yml;
//   3. unpack it with ditto, check the bundle's version, strip quarantine;
//   4. offer a restart. "Restart now", or quitting later, starts a detached
//      shell script that waits for this process to exit, swaps the new bundle in
//      where the running one is, and (for a restart) opens it again.
//
// If the bundle's folder isn't ours to write (e.g. /Applications owned by
// another account, a translocated or disk-image copy), nothing is downloaded:
// the prompt offers the release page instead. Failures are only logged.
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { posixQuote } = require('./platform');

const DEFAULT_FEED = 'https://github.com/samuelwbarber/limpet/releases/latest/download';
const RELEASES_PAGE = 'https://github.com/samuelwbarber/limpet/releases/latest';
const FIRST_CHECK_MS = 15 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// ---- pure helpers (unit tested) --------------------------------------------

// The feed folder: LIMPET_UPDATE_FEED if set (no trailing slash), else GitHub.
function feedBase(env = process.env) {
  const override = String(env.LIMPET_UPDATE_FEED || '').trim();
  return (override || DEFAULT_FEED).replace(/\/+$/, '');
}

// True if `candidate` is a valid semver strictly newer than `current`.
function isNewer(candidate, current) {
  const semver = require('semver');
  const a = semver.valid(String(candidate || '').trim());
  const b = semver.valid(String(current || '').trim());
  return !!a && !!b && semver.gt(a, b);
}

// electron-builder's latest-mac.yml → { version, releaseDate, files: [{ url,
// sha512, size }] }. Older feeds name only one file at the top level (path +
// sha512); that's folded into files. Throws on anything without a version.
function parseUpdateYml(text) {
  const doc = require('js-yaml').load(String(text));
  if (!doc || typeof doc !== 'object' || !doc.version) throw new Error('update feed has no version');
  const files = (Array.isArray(doc.files) ? doc.files : [])
    .filter((f) => f && f.url && f.sha512)
    .map((f) => ({ url: String(f.url), sha512: String(f.sha512), size: Number(f.size) || 0 }));
  if (!files.length && doc.path && doc.sha512) files.push({ url: String(doc.path), sha512: String(doc.sha512), size: 0 });
  return { version: String(doc.version), releaseDate: doc.releaseDate ? String(doc.releaseDate) : '', files };
}

// The zip for this CPU, as electron-updater's MacUpdater picks it: on arm64 the
// file whose name says arm64 (falling back to the others, which run under
// Rosetta); on x64 one whose name doesn't say arm64, preferring an explicit
// "-x64" (electron-builder leaves the suffix off when x64 is the only build).
function pickZip(files, arch) {
  const zips = (files || []).filter((f) => /\.zip$/i.test(f.url));
  const isArm = (f) => /arm64/i.test(f.url);
  const arm = zips.filter(isArm);
  const intel = zips.filter((f) => !isArm(f));
  if (arch === 'arm64' && arm.length) return arm[0];
  return intel.find((f) => /x64/i.test(f.url)) || intel[0] || null;
}

// `codesign -dv --verbose=2` output (it writes to stderr) → whether the app is
// Developer ID signed, i.e. something Squirrel.Mac will accept an update for.
// Ad-hoc builds say "Signature=adhoc" and "TeamIdentifier=not set".
function isDeveloperIdSigned(codesignOutput) {
  const out = String(codesignOutput || '');
  if (!/^Authority=Developer ID Application/m.test(out)) return false;
  const team = out.match(/^TeamIdentifier=(.*)$/m);
  return !!team && team[1].trim() !== '' && team[1].trim() !== 'not set';
}

// The .app bundle the running executable sits in: <bundle>/Contents/MacOS/<exe>.
function bundlePath(execPath = process.execPath) {
  return path.posix.resolve(execPath, '../../..');
}

// The swap, as a /bin/sh script. It waits (up to 10 minutes) for `pid` to exit,
// renames the running bundle aside, moves the new one into its place, and only
// then deletes the old one; if the move fails the old bundle is put back. With
// `relaunch` it opens the app again. Everything it says goes to `logFile`.
function buildSwapScript({ pid, appPath, newAppPath, stagingDir, logFile, relaunch, stamp = Date.now() }) {
  const q = posixQuote;
  return [
    '#!/bin/sh',
    '# limpet update: swap in the new bundle once the running app has quit.',
    `exec >>${q(logFile)} 2>&1`,
    `pid=${Number(pid)}`,
    `app=${q(appPath)}`,
    `new=${q(newAppPath)}`,
    `old=${q(`${appPath}.old-${stamp}`)}`,
    `staging=${q(stagingDir)}`,
    'echo "$(date): waiting for $pid to quit"',
    'i=0',
    'while kill -0 "$pid" 2>/dev/null; do',
    '  i=$((i + 1))',
    '  if [ "$i" -gt 1200 ]; then echo "$(date): still running, update skipped"; exit 1; fi',
    '  sleep 0.5',
    'done',
    'if ! mv "$app" "$old"; then echo "$(date): could not move the old app aside"; exit 1; fi',
    'if ! mv "$new" "$app"; then',
    '  echo "$(date): could not move the new app in; restoring the old one"',
    '  mv "$old" "$app"',
    '  exit 1',
    'fi',
    'rm -rf "$old" "$staging"',
    'echo "$(date): updated $app"',
    relaunch ? 'open "$app"' : '# no relaunch: limpet was quit, not restarted',
    '',
  ].join('\n');
}

// Whether we can do the swap at all: the bundle's folder must be writable (to
// rename in it), and the bundle mustn't be a read-only translocated copy.
function canReplaceBundle(appPath, access = fs.accessSync) {
  if (/\/AppTranslocation\//.test(appPath) || appPath.startsWith('/Volumes/')) return false;
  try {
    access(path.dirname(appPath), fs.constants.W_OK);
    access(appPath, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

// Stream `file` through sha512 and compare with the yml's base64 digest.
async function sha512Matches(file, expectedBase64) {
  const hash = crypto.createHash('sha512');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('base64') === String(expectedBase64).trim();
}

// ---- side effects ----------------------------------------------------------

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
}

// The codesign verdict for the running bundle. codesign failing (e.g. "not
// signed at all") counts as unsigned.
async function runningAppIsDeveloperIdSigned(appPath = bundlePath()) {
  try {
    const { stdout, stderr } = await run('/usr/bin/codesign', ['-dv', '--verbose=2', appPath]);
    return isDeveloperIdSigned(`${stdout}\n${stderr}`);
  } catch (e) {
    return isDeveloperIdSigned(e.stderr || '');
  }
}

async function fetchOk(fetchImpl, url) {
  const res = await fetchImpl(url, { cache: 'no-store', redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

// Download `url` to `dest`, following redirects (GitHub sends release assets on
// to its object store).
async function download(fetchImpl, url, dest) {
  const res = await fetchOk(fetchImpl, url);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

async function bundleVersion(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
  return stdout.trim();
}

function start({ app, dialog, BrowserWindow, shell, net }) {
  const fetchImpl = (net && net.fetch) ? net.fetch.bind(net) : fetch;
  const current = bundlePath();
  const pendingRoot = path.join(app.getPath('userData'), 'pending-update');
  const logFile = path.join(app.getPath('userData'), 'update.log');
  const writable = canReplaceBundle(current);

  let checking = false;
  let staged = null; // { version, appPath, stagingDir } once an update is unpacked
  let relaunch = false;
  let swapStarted = false;
  const offered = new Set(); // versions already asked about

  const ask = async (options) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return response;
  };

  // Not ours to replace: point at the release instead, once per version.
  async function offerReleasePage(version) {
    if (offered.has(version)) return;
    offered.add(version);
    console.error(`[limpet] update ${version} available, but ${current} can't be replaced from here`);
    const response = await ask({
      type: 'info',
      title: 'limpet update',
      message: `limpet ${version} is available.`,
      detail: `limpet can't replace itself at ${current}. Download the new version from the release page and install it by hand.`,
      buttons: ['Open release page', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) shell.openExternal(RELEASES_PAGE);
  }

  async function stage(info, zip) {
    // One pending update at a time: clear whatever an older run left behind.
    fs.rmSync(pendingRoot, { recursive: true, force: true });
    const stagingDir = path.join(pendingRoot, info.version);
    const unpacked = path.join(stagingDir, 'app');
    fs.mkdirSync(unpacked, { recursive: true });
    const zipFile = path.join(stagingDir, path.basename(zip.url));
    await download(fetchImpl, `${feedBase()}/${zip.url}`, zipFile);
    if (zip.size && fs.statSync(zipFile).size !== zip.size) throw new Error(`${zip.url}: size mismatch`);
    if (!(await sha512Matches(zipFile, zip.sha512))) throw new Error(`${zip.url}: sha512 mismatch`);
    await run('/usr/bin/ditto', ['-x', '-k', zipFile, unpacked]);
    fs.rmSync(zipFile, { force: true });
    const name = fs.readdirSync(unpacked).find((n) => n.endsWith('.app'));
    if (!name) throw new Error(`${zip.url}: no .app inside`);
    const appPath = path.join(unpacked, name);
    const version = await bundleVersion(appPath);
    if (version !== info.version) throw new Error(`${zip.url}: bundle says ${version}, feed says ${info.version}`);
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', appPath]).catch(() => {});
    return { version: info.version, appPath, stagingDir };
  }

  async function check() {
    if (checking || staged) return;
    checking = true;
    try {
      const res = await fetchOk(fetchImpl, `${feedBase()}/latest-mac.yml`);
      const info = parseUpdateYml(await res.text());
      if (!isNewer(info.version, app.getVersion())) return;
      if (!writable) { await offerReleasePage(info.version); return; }
      const zip = pickZip(info.files, process.arch);
      if (!zip) throw new Error(`no ${process.arch} zip in latest-mac.yml`);
      staged = await stage(info, zip);
      await offerRestart();
    } catch (e) {
      console.error('[limpet] update check failed:', (e && e.message) || e);
    } finally {
      checking = false;
    }
  }

  async function offerRestart() {
    if (offered.has(staged.version)) return;
    offered.add(staged.version);
    const response = await ask({
      type: 'info',
      title: 'limpet update',
      message: `limpet ${staged.version} is ready to install.`,
      detail: 'Restarting closes your tabs and their shells. Choose Later and it installs the next time limpet quits.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      relaunch = true;
      app.quit(); // the usual quit path; the swap starts in will-quit
    }
  }

  // will-quit only fires once nothing cancelled the quit, so the script never
  // waits on a process that stays up.
  app.on('will-quit', () => {
    if (!staged || swapStarted) return;
    swapStarted = true;
    try {
      const script = buildSwapScript({
        pid: process.pid, appPath: current, newAppPath: staged.appPath,
        stagingDir: pendingRoot, logFile, relaunch,
      });
      const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (e) {
      console.error('[limpet] update install failed:', e.message);
    }
  });

  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = {
  start, runningAppIsDeveloperIdSigned,
  feedBase, isNewer, parseUpdateYml, pickZip, isDeveloperIdSigned, bundlePath,
  buildSwapScript, canReplaceBundle, sha512Matches,
  DEFAULT_FEED,
};
