// Fetch the node-pty native binary matching this project's Electron ABI and
// extract it into the package. Works around @homebridge/node-pty-prebuilt-
// multiarch's own install script failing on newer Node/Windows.
//
//   npm run fetch-pty
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const PKG = '@homebridge/node-pty-prebuilt-multiarch';
const PKG_VER = '0.12.0';

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'winux' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(download(res.headers.location));
        return;
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

(async () => {
  const electronExe = require('electron'); // resolves to the electron binary path
  const abi = execFileSync(
    electronExe,
    ['-e', 'process.stdout.write(String(process.versions.modules))'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  ).toString().trim();

  const file = `node-pty-prebuilt-multiarch-v${PKG_VER}-electron-v${abi}-${process.platform}-${process.arch}.tar.gz`;
  const url = `https://github.com/homebridge/node-pty-prebuilt-multiarch/releases/download/v${PKG_VER}/${file}`;
  console.log(`Electron ABI ${abi} -> ${file}`);

  const pkgDir = path.dirname(require.resolve(PKG + '/package.json'));
  const tmp = path.join(os.tmpdir(), file);
  console.log('Downloading', url);
  fs.writeFileSync(tmp, await download(url));
  execFileSync('tar', ['-xzf', tmp, '-C', pkgDir], { stdio: 'inherit' });
  fs.unlinkSync(tmp);
  console.log('Installed PTY binary into', path.join(pkgDir, 'build', 'Release'));
})().catch((e) => { console.error('fetch-pty failed:', e.message); process.exit(1); });
