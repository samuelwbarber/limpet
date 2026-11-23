const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readClipboard, preparePaste, MAX_IMAGE_BYTES } = require('../src/clipboard-paste');
const platform = require('../src/platform');

const png = fs.readFileSync(path.join(__dirname, '../../tools/demo/test.png'));
const nativeImage = { createFromBuffer: (bytes) => ({ isEmpty: () => !bytes.equals(png), toPNG: () => bytes }) };
const clipboardFor = (values) => ({ read: async () => [{ types: Object.keys(values), getType: async (type) => new Blob([values[type]]) }] });
const imageClipboard = () => clipboardFor({ 'text/plain': 'image URL must not win', 'image/png': png });
const remote = { target: 'fixture.invalid', port: '2222' };
const remoteCwd = { cwd: '/workspace', depth: 0 };

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-paste-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { clipboard: imageClipboard(), nativeImage, directory: path.join(root, 'with spaces'), ...extra };
}

test('text, multiline text and empty clipboard remain text without creating files', async (t) => {
  for (const text of ['hello', 'first\r\nsecond', '']) {
    const opts = fixture(t, { clipboard: clipboardFor({ 'text/plain': text }) });
    assert.deepEqual(await preparePaste(opts), { kind: 'text', text });
    assert.equal(fs.existsSync(opts.directory), false);
  }
  assert.deepEqual(await readClipboard({ read: async () => [] }, nativeImage), { kind: 'text', text: '' });
});

test('image wins over text, has a unique private PNG path, and stays available after paste', async (t) => {
  const opts = fixture(t);
  const first = await preparePaste(opts);
  const second = await preparePaste(opts);
  assert.equal(first.kind, 'image');
  assert.notEqual(first.path, second.path);
  assert.deepEqual(fs.readFileSync(first.path), png);
  assert.equal(first.text, platform.shellQuote(first.path));
  assert.doesNotMatch(first.text, /[\r\n]/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(opts.directory).mode & 0o777, 0o700);
  }
});

test('invalid, empty and oversized image payloads fail instead of falling back to text', async () => {
  for (const data of [Buffer.from('bad image'), Buffer.alloc(0), Buffer.alloc(MAX_IMAGE_BYTES + 1)]) {
    await assert.rejects(readClipboard(clipboardFor({ 'image/png': data, 'text/plain': 'ignored' }), nativeImage), /image/i);
  }
});

test('remote path is returned only after a successful upload, with local staging removed', async (t) => {
  let finish;
  let uploaded;
  const opts = fixture(t, { remote, remoteCwd, copyImage: (file) => {
    uploaded = file;
    assert.deepEqual(fs.readFileSync(file), png);
    return new Promise((resolve) => { finish = resolve; });
  } });
  let settled = false;
  const pending = preparePaste(opts).then((result) => { settled = true; return result; });
  while (!finish) await new Promise(setImmediate);
  assert.equal(settled, false);
  finish({ ok: true });
  const result = await pending;
  assert.equal(result.text, `/workspace/${path.basename(uploaded)}`);
  assert.equal(fs.existsSync(uploaded), false);
});

test('failed and cancelled uploads never return a path and remove staging files', async (t) => {
  for (const result of [{ ok: false, reason: 'connection lost' }, { ok: false, cancelled: true }]) {
    const opts = fixture(t, { remote, remoteCwd, copyImage: async () => result });
    if (result.cancelled) assert.deepEqual(await preparePaste(opts), { kind: 'cancelled' });
    else await assert.rejects(preparePaste(opts), /connection lost/);
    assert.deepEqual(fs.readdirSync(opts.directory), []);
  }
});

test('nested hops, unknown directories and unsupported local transports cannot paste local paths remotely', async (t) => {
  for (const cwd of [null, { cwd: '/workspace', depth: 1 }, { cwd: '/with space', depth: 0 }]) {
    const opts = fixture(t, { remote, remoteCwd: cwd, copyImage: () => assert.fail('must not copy') });
    await assert.rejects(preparePaste(opts), /Can't paste an image/);
    assert.equal(fs.existsSync(opts.directory), false);
  }
  await assert.rejects(preparePaste(fixture(t, { checkLocal: async () => { throw new Error('plain ssh'); } })), /plain ssh/);
});

test('closing, restarting, detaching or changing destinations during upload discards the paste', async (t) => {
  let current = true;
  const opts = fixture(t, {
    remote, remoteCwd,
    ensureCurrent: () => { if (!current) throw new Error('session changed'); },
    copyImage: async () => { current = false; return { ok: true }; },
  });
  await assert.rejects(preparePaste(opts), /session changed/);
  assert.deepEqual(fs.readdirSync(opts.directory), []);
});

test('clipboard read failures and unwritable storage surface errors', async (t) => {
  await assert.rejects(preparePaste(fixture(t, { clipboard: { read: async () => { throw new Error('clipboard unavailable'); } } })), /clipboard unavailable/);
  const opts = fixture(t);
  fs.writeFileSync(opts.directory, 'a file, not a directory');
  await assert.rejects(preparePaste(opts), /EEXIST/);
});
