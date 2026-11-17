// Unit tests for src/mac-updater.js: the pure parts (feed parsing, version
// compare, zip choice, codesign verdict, the swap script) on every platform,
// and the swap script itself run against throwaway bundles where /bin/sh is.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const mu = require('../src/mac-updater');

// latest-mac.yml as the v0.1.2 release has it (digests shortened).
const YML = `version: 0.1.2
files:
  - url: limpet-0.1.2-x64.zip
    sha512: F9NwZvBM7FkDMm4CYkPS1TnH4WVqHVjU==
    size: 134326668
  - url: limpet-0.1.2-arm64.zip
    sha512: jb8eQjXwMbvQt67DhLIX2DacGgA9nbh9==
    size: 130597068
  - url: limpet-0.1.2-x64.dmg
    sha512: 9M38MFgZi5786oo/trZNHqJ1o01KPo+d==
    size: 134779651
  - url: limpet-0.1.2-arm64.dmg
    sha512: RYicsAZEZkLkGlfuLZ6S0u7OzWcro7bC==
    size: 131084202
path: limpet-0.1.2-x64.zip
sha512: F9NwZvBM7FkDMm4CYkPS1TnH4WVqHVjU==
releaseDate: '2026-11-13T22:19:26.459Z'
`;

test('parseUpdateYml reads version, files and release date', () => {
  const info = mu.parseUpdateYml(YML);
  assert.strictEqual(info.version, '0.1.2');
  assert.strictEqual(info.releaseDate, '2026-11-13T22:19:26.459Z');
  assert.strictEqual(info.files.length, 4);
  assert.deepStrictEqual(info.files[1], { url: 'limpet-0.1.2-arm64.zip', sha512: 'jb8eQjXwMbvQt67DhLIX2DacGgA9nbh9==', size: 130597068 });
});

test('parseUpdateYml folds a path-only feed into files and rejects junk', () => {
  const info = mu.parseUpdateYml('version: 1.0.0\npath: limpet-1.0.0-mac.zip\nsha512: abc==\n');
  assert.deepStrictEqual(info.files, [{ url: 'limpet-1.0.0-mac.zip', sha512: 'abc==', size: 0 }]);
  assert.throws(() => mu.parseUpdateYml('files: []\n'), /no version/);
  assert.throws(() => mu.parseUpdateYml(''), /no version/);
  assert.throws(() => mu.parseUpdateYml('<html>rate limited</html>'), /no version/);
});

test('isNewer is a strict semver comparison', () => {
  assert.strictEqual(mu.isNewer('0.1.3', '0.1.2'), true);
  assert.strictEqual(mu.isNewer('0.10.0', '0.9.9'), true);
  assert.strictEqual(mu.isNewer('1.0.0', '1.0.0-beta.2'), true);
  assert.strictEqual(mu.isNewer('0.1.2', '0.1.2'), false);
  assert.strictEqual(mu.isNewer('0.1.1', '0.1.2'), false);
  assert.strictEqual(mu.isNewer('garbage', '0.1.2'), false);
  assert.strictEqual(mu.isNewer('', '0.1.2'), false);
});

test('pickZip takes the zip for this CPU', () => {
  const { files } = mu.parseUpdateYml(YML);
  assert.strictEqual(mu.pickZip(files, 'arm64').url, 'limpet-0.1.2-arm64.zip');
  assert.strictEqual(mu.pickZip(files, 'x64').url, 'limpet-0.1.2-x64.zip');
});

test('pickZip copes with an unsuffixed x64 zip and a missing arm64 one', () => {
  const unsuffixed = [
    { url: 'limpet-0.2.0-arm64.zip' }, { url: 'limpet-0.2.0-mac.zip' }, { url: 'limpet-0.2.0.dmg' },
  ];
  assert.strictEqual(mu.pickZip(unsuffixed, 'x64').url, 'limpet-0.2.0-mac.zip');
  assert.strictEqual(mu.pickZip(unsuffixed, 'arm64').url, 'limpet-0.2.0-arm64.zip');
  // No arm64 build: Apple silicon runs the Intel one under Rosetta.
  assert.strictEqual(mu.pickZip([{ url: 'limpet-0.2.0-mac.zip' }], 'arm64').url, 'limpet-0.2.0-mac.zip');
  // Only an arm64 build: nothing for Intel.
  assert.strictEqual(mu.pickZip([{ url: 'limpet-0.2.0-arm64.zip' }], 'x64'), null);
  assert.strictEqual(mu.pickZip([{ url: 'limpet-0.2.0.dmg' }], 'arm64'), null);
});

test('isDeveloperIdSigned tells an ad-hoc build from a Developer ID one', () => {
  const adhoc = [
    'Executable=/Applications/limpet.app/Contents/MacOS/limpet',
    'Identifier=Electron',
    'CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded',
    'Signature=adhoc',
    'Info.plist=not bound',
    'TeamIdentifier=not set',
  ].join('\n');
  const signed = [
    'Executable=/Applications/limpet.app/Contents/MacOS/limpet',
    'Identifier=io.github.samuelwbarber.limpet',
    'Authority=Developer ID Application: Example Co (ABCDE12345)',
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    'TeamIdentifier=ABCDE12345',
  ].join('\n');
  assert.strictEqual(mu.isDeveloperIdSigned(adhoc), false);
  assert.strictEqual(mu.isDeveloperIdSigned(signed), true);
  assert.strictEqual(mu.isDeveloperIdSigned(signed.replace('TeamIdentifier=ABCDE12345', 'TeamIdentifier=not set')), false);
  assert.strictEqual(mu.isDeveloperIdSigned('/x/limpet.app: code object is not signed at all'), false);
  assert.strictEqual(mu.isDeveloperIdSigned(''), false);
  // An Apple Development certificate can't ship outside the Mac App Store.
  assert.strictEqual(mu.isDeveloperIdSigned(signed.replace(/Developer ID Application/, 'Apple Development')), false);
});

test('bundlePath climbs from the executable to the .app', () => {
  assert.strictEqual(mu.bundlePath('/Applications/limpet.app/Contents/MacOS/limpet'), '/Applications/limpet.app');
});

test('feedBase defaults to the latest GitHub release and honours the override', () => {
  assert.strictEqual(mu.feedBase({}), mu.DEFAULT_FEED);
  assert.strictEqual(mu.feedBase({ LIMPET_UPDATE_FEED: 'http://127.0.0.1:8123/feed/' }), 'http://127.0.0.1:8123/feed');
  assert.strictEqual(mu.feedBase({ LIMPET_UPDATE_FEED: '  ' }), mu.DEFAULT_FEED);
});

test('canReplaceBundle refuses translocated, disk-image and unwritable bundles', () => {
  const ok = () => {};
  const denied = () => { throw new Error('EACCES'); };
  assert.strictEqual(mu.canReplaceBundle('/Users/someone/Applications/limpet.app', ok), true);
  assert.strictEqual(mu.canReplaceBundle('/Applications/limpet.app', denied), false);
  assert.strictEqual(mu.canReplaceBundle('/private/var/folders/x/AppTranslocation/ABC/d/limpet.app', ok), false);
  assert.strictEqual(mu.canReplaceBundle('/Volumes/limpet 0.1.2/limpet.app', ok), false);
});

test('sha512Matches checks a file against the yml base64 digest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-upd-'));
  try {
    const file = path.join(dir, 'a.zip');
    fs.writeFileSync(file, 'not really a zip');
    const digest = crypto.createHash('sha512').update('not really a zip').digest('base64');
    assert.strictEqual(await mu.sha512Matches(file, digest), true);
    assert.strictEqual(await mu.sha512Matches(file, `${digest}\n`), true);
    assert.strictEqual(await mu.sha512Matches(file, digest.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSwapScript waits, swaps, restores on failure, and quotes paths', () => {
  const opts = {
    pid: 4242, appPath: "/Users/someone/Apps/it's limpet.app", newAppPath: '/tmp/pending/0.2.0/app/limpet.app',
    stagingDir: '/tmp/pending', logFile: '/tmp/update.log', relaunch: true, stamp: 99,
  };
  const s = mu.buildSwapScript(opts);
  assert.match(s, /^#!\/bin\/sh\n/);
  assert.match(s, /^pid=4242$/m);
  assert.match(s, /^app='\/Users\/someone\/Apps\/it'\\''s limpet\.app'$/m);
  assert.match(s, /^old='\/Users\/someone\/Apps\/it'\\''s limpet\.app\.old-99'$/m);
  assert.match(s, /while kill -0 "\$pid"/);
  assert.match(s, /mv "\$app" "\$old"/);
  assert.match(s, /mv "\$new" "\$app"/);
  assert.match(s, /mv "\$old" "\$app"/); // the restore
  assert.match(s, /^open "\$app"$/m);
  assert.ok(!/sudo/.test(s));
  assert.ok(!/^open /m.test(mu.buildSwapScript({ ...opts, relaunch: false })));
  // Order: the old bundle is only deleted after the new one is in place.
  assert.ok(s.indexOf('mv "$new" "$app"') < s.indexOf('rm -rf "$old"'));
});

test('the swap script replaces a bundle once the process is gone', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-swap-'));
  try {
    const appPath = path.join(dir, 'Apps', 'limpet.app');
    const staging = path.join(dir, 'pending');
    const newApp = path.join(staging, '0.2.0', 'app', 'limpet.app');
    fs.mkdirSync(path.join(appPath, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(appPath, 'Contents', 'v'), 'old');
    fs.mkdirSync(path.join(newApp, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(newApp, 'Contents', 'v'), 'new');
    // A pid that has already exited.
    const gone = spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' });
    const pid = Number(gone.stdout.trim());
    const logFile = path.join(dir, 'update.log');
    const script = mu.buildSwapScript({ pid, appPath, newAppPath: newApp, stagingDir: staging, logFile, relaunch: false, stamp: 1 });
    execFileSync('/bin/sh', ['-c', script]);
    assert.strictEqual(fs.readFileSync(path.join(appPath, 'Contents', 'v'), 'utf8'), 'new');
    assert.strictEqual(fs.existsSync(`${appPath}.old-1`), false);
    assert.strictEqual(fs.existsSync(staging), false);
    assert.match(fs.readFileSync(logFile, 'utf8'), /updated/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the swap script puts the old bundle back if the new one is missing', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-swap-'));
  try {
    const appPath = path.join(dir, 'limpet.app');
    fs.mkdirSync(appPath);
    fs.writeFileSync(path.join(appPath, 'v'), 'old');
    const gone = spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' });
    const script = mu.buildSwapScript({
      pid: Number(gone.stdout.trim()), appPath, newAppPath: path.join(dir, 'nope.app'),
      stagingDir: path.join(dir, 'pending'), logFile: path.join(dir, 'log'), relaunch: false, stamp: 1,
    });
    const r = spawnSync('/bin/sh', ['-c', script]);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(fs.readFileSync(path.join(appPath, 'v'), 'utf8'), 'old');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
