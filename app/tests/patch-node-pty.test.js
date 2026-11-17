'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { patchNodePty } = require('../scripts/patch-node-pty');

const STOCK = [
  "var helperPath = native.dir + '/spawn-helper';",
  'helperPath = path.resolve(__dirname, helperPath);',
  "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
  "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
  '',
].join('\n');

function fakePty(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-pty-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'unixTerminal.js'), src);
  return dir;
}

test('stock node-pty 1.1.0 is patched so an unpacked helper path is left alone', () => {
  const dir = fakePty(STOCK);
  assert.strictEqual(patchNodePty(dir), 'patched');
  const out = fs.readFileSync(path.join(dir, 'lib', 'unixTerminal.js'), 'utf8');
  // Run the patched lines on the path a packaged app really has.
  let helperPath = '/Applications/limpet.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper';
  for (const line of out.split('\n').filter((l) => l.startsWith('helperPath = helperPath.replace'))) helperPath = eval(line.replace('helperPath = ', '')); // eslint-disable-line no-eval
  assert.match(helperPath, /app\.asar\.unpacked\/node_modules/);
  assert.doesNotMatch(helperPath, /unpacked\.unpacked/);
  assert.strictEqual(patchNodePty(dir), 'ok'); // idempotent
});

