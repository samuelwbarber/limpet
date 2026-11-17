'use strict';

// node-pty 1.1.0 finds its spawn-helper next to the loaded pty.node, which in a
// packaged app already sits in app.asar.unpacked, then swaps 'app.asar' for
// 'app.asar.unpacked' once more. The helper path becomes
// app.asar.unpacked.unpacked/..., every pty spawn fails with "posix_spawnp
// failed", and limpet drops to its pipe fallback: the shell prints a prompt but
// never echoes or runs what is typed (macOS/Linux; Windows has no
// spawn-helper). Only rewrite a bare app.asar / node_modules.asar.
//
// Runs as electron-builder's beforePack hook, so every build (CI's clean
// `npm ci` included) packages the fixed file, and from `npm run setup` for the
// unpackaged app. Idempotent.

const fs = require('node:fs');
const path = require('node:path');

const FIXES = [
  ["helperPath.replace('app.asar', 'app.asar.unpacked')", "helperPath.replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked')"],
  ["helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked')", "helperPath.replace(/node_modules\\.asar(?!\\.unpacked)/, 'node_modules.asar.unpacked')"],
];

// Patch lib/unixTerminal.js under `ptyDir`. Returns 'patched', 'ok' (already
// fixed or upstream fixed it) or throws if the file looks unfamiliar.
function patchNodePty(ptyDir = path.join(__dirname, '..', 'node_modules', 'node-pty')) {
  const file = path.join(ptyDir, 'lib', 'unixTerminal.js');
  const src = fs.readFileSync(file, 'utf8');
  let out = src;
  for (const [from, to] of FIXES) out = out.split(from).join(to);
  if (!/helperPath\.replace\(\/app\\\.asar\(\?!\\\.unpacked\)\//.test(out) && /helperPath\.replace\(/.test(out)) {
    throw new Error(`node-pty: unexpected spawn-helper path code in ${file}; check the asar.unpacked fix still applies`);
  }
  if (out === src) return 'ok';
  fs.writeFileSync(file, out);
  return 'patched';
}

module.exports = async function beforePack() {
  const r = patchNodePty();
  if (r === 'patched') console.log('[limpet] patched node-pty spawn-helper path (asar.unpacked)');
};
module.exports.patchNodePty = patchNodePty;

if (require.main === module) {
  const r = patchNodePty();
  console.log(`node-pty spawn-helper path: ${r}`);
}
