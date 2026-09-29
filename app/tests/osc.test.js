// Unit tests for the OSC 5379 handling in src/main.js: requests that act on this
// PC (dl, upload, reels) and the xssh/cwd reports that aim a dropped folder's
// scp need the app's token, upload always asks, and a held
// sequence can neither freeze the tab nor overwrite Downloads. main.js is loaded
// with Electron stubbed out and its internals exported for the test.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { createTopicProfile } = require('../src/backdrop');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-osc-'));
const dialogCalls = [];
function loadMain() {
  const savedHome = os.homedir;
  os.homedir = () => home; // Downloads lands in the temp home
  const electron = {
    app: { whenReady: () => new Promise(() => {}), getPath: () => path.join(home, 'userData'), on() {}, quit() {} },
    BrowserWindow: { fromWebContents: () => null }, ipcMain: { handle() {}, on() {} }, clipboard: {}, screen: {}, shell: {},
    webContents: { fromId: () => null },
    dialog: { showMessageBox: async (o) => { dialogCalls.push(o); return { response: 1 }; } },
  };
  const load = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return electron;
    if (req.includes('node-pty')) throw new Error('not in tests');
    return load.call(this, req, ...rest);
  };
  const file = path.join(__dirname, '..', 'src', 'main.js');
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  const quiet = console.error; console.error = () => {};
  try {
    m._compile(`${fs.readFileSync(file, 'utf8')}\nmodule.exports = { forwardOutput, oscToken, dropFiles };`, file);
  } finally { Module._load = load; console.error = quiet; }
  return { ...m.exports, restoreHome: () => { os.homedir = savedHome; } };
}
const { forwardOutput, oscToken, dropFiles } = loadMain();
const remoteCopy = require('../src/remote-copy');
const tok = oscToken();
const dl = path.join(home, 'Downloads');
const E = '\x1b';
const B = '\x07';
const b64 = (x) => Buffer.from(x).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (fn()) return true;
  return fn();
}
const typed = [];
const mk = () => ({
  id: 1, ready: false, uiPending: [], outPending: '', backdropProfile: createTopicProfile(), backdropAnalysisBuffer: '',
  proc: { write: (d) => typed.push(d) },
});
const screen = (s) => s.uiPending.filter((u) => u.channel === 'term:data').map((u) => u.payload.data).join('');
const reels = (s) => s.uiPending.filter((u) => u.channel === 'reels:toggle').map((u) => u.payload);

test('the token is 32 hex chars and kept across runs', () => {
  assert.match(tok, /^[0-9a-f]{32}$/);
  assert.strictEqual(fs.readFileSync(path.join(home, 'userData', 'osc-token'), 'utf8'), tok);
});

test('plain output passes through untouched', () => {
  const s = mk();
  forwardOutput(s, 'plain output\r\n');
  assert.strictEqual(screen(s), 'plain output\r\n');
});

test('a download needs the token', async () => {
  let s = mk();
  forwardOutput(s, `${E}]5379;dl;h;${b64('evil.exe')};file${B}${E}]5379;dl;d;${b64('x')}${B}${E}]5379;dl;f${B}`);
  assert.ok(!fs.existsSync(path.join(dl, 'evil.exe')));
  assert.match(screen(s), /ignored a download/);
  s = mk();
  forwardOutput(s, `${E}]5379;dl;h;${b64('ok.txt')};file;${tok}${B}${E}]5379;dl;d;${b64('hello')}${B}${E}]5379;dl;f${B}`);
  assert.ok(await waitFor(() => /saved/.test(screen(s))));
  assert.strictEqual(fs.readFileSync(path.join(dl, 'ok.txt'), 'utf8'), 'hello');
});

test('an aborted download leaves no partial file', async () => {
  const s = mk();
  forwardOutput(s, `${E}]5379;dl;h;${b64('part.bin')};file;${tok}${B}${E}]5379;dl;d;${b64('abc')}${B}`);
  forwardOutput(s, `${E}]5379;dl;h;${b64('next.bin')};file;${tok}${B}`);
  await sleep(200);
  assert.ok(!fs.existsSync(path.join(dl, 'part.bin')));
});

test('a folder download unpacks into a fresh folder, never over existing files', async () => {
  const src = fs.mkdtempSync(path.join(home, 'src-'));
  fs.mkdirSync(path.join(src, 'proj'));
  fs.writeFileSync(path.join(src, 'proj', 'setup.exe'), 'NEW');
  fs.mkdirSync(dl, { recursive: true });
  fs.writeFileSync(path.join(dl, 'setup.exe'), 'ORIGINAL');
  const tar = execFileSync('tar', ['cf', '-', '-C', src, 'proj']).toString('base64');
  for (const done of [path.join(dl, 'proj', 'setup.exe'), path.join(dl, 'proj (1)', 'setup.exe')]) {
    const s = mk();
    forwardOutput(s, `${E}]5379;dl;h;${b64('proj')};dir;${tok}${B}${E}]5379;dl;d;${tar}${B}${E}]5379;dl;f${B}`);
    assert.ok(await waitFor(() => /extracted/.test(screen(s)) && fs.existsSync(done)), screen(s));
  }
  assert.strictEqual(fs.readFileSync(path.join(dl, 'setup.exe'), 'utf8'), 'ORIGINAL');
  assert.strictEqual(fs.readFileSync(path.join(dl, 'proj', 'setup.exe'), 'utf8'), 'NEW');
  assert.ok(fs.existsSync(path.join(dl, 'proj (1)', 'setup.exe')));
});

test('upload needs the token, refuses network paths, and always asks', async () => {
  const target = path.join(home, 'secret.txt');
  fs.writeFileSync(target, 'secret');
  let s = mk();
  forwardOutput(s, `${E}]5379;upload;${b64(target)};${b64('/')}${B}`);
  assert.match(screen(s), /ignored a upload/);
  s = mk();
  forwardOutput(s, `${E}]5379;upload;${b64('\\\\attacker\\share\\x')};${b64('/')};${tok}${B}`);
  await sleep(50);
  assert.match(screen(s), /network paths/);
  assert.strictEqual(dialogCalls.length, 0);
  s = mk();
  forwardOutput(s, `${E}]5379;upload;${b64(target)};${b64('/')};${tok}${B}`);
  await sleep(50);
  assert.strictEqual(dialogCalls.length, 1);
  assert.match(screen(s), /upload cancelled/);
  assert.strictEqual(typed.length, 0);
});

test('reels needs the token and an http(s) URL', () => {
  let s = mk();
  forwardOutput(s, `${E}]5379;reels;${b64('https://example.com')}${B}`);
  assert.deepStrictEqual(reels(s), []);
  s = mk();
  forwardOutput(s, `${E}]5379;reels;${b64('file:///C:/Users/me/x.html')};${tok}${B}`);
  assert.deepStrictEqual(reels(s), []);
  s = mk();
  forwardOutput(s, `${E}]5379;reels;${b64('https://example.com')};${tok}${B}`);
  forwardOutput(s, `${E}]5379;reels;;${tok}${B}`);
  assert.deepStrictEqual(reels(s), ['https://example.com', '']);
});

test('a large held sequence is cheap, and an endless one is dropped', () => {
  let s = mk();
  const t0 = Date.now();
  forwardOutput(s, `${E}]5379;peek;h;${b64('a.png')};10;2${B}${E}]5379;peek;d;`);
  const chunk = 'A'.repeat(65536);
  for (let i = 0; i < 400; i++) forwardOutput(s, chunk);
  forwardOutput(s, `${B}${E}]5379;peek;f${B}after`);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
  assert.match(screen(s), /after$/);
  s = mk();
  forwardOutput(s, `${E}]5379;dl;h;${b64('big')};file;${tok}${B}${E}]5379;dl;d;`);
  const mb = 'A'.repeat(1 << 20);
  for (let i = 0; i < 50; i++) forwardOutput(s, mb);
  forwardOutput(s, 'visible-again');
  assert.match(screen(s), /dropped an unfinished/);
  assert.match(screen(s), /visible-again/);
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test("xssh/cwd reports need the token, and aim a dropped folder's scp", async () => {
  const saved = remoteCopy.io.spawn;
  const calls = [];
  remoteCopy.io.spawn = (cmd, args) => {
    const c = new EventEmitter();
    c.stderr = new EventEmitter();
    calls.push({ cmd, args });
    setImmediate(() => c.emit('close', 0));
    return c;
  };
  try {
    const folder = fs.mkdtempSync(path.join(home, 'drop-'));
    // untokened reports are ignored, quietly
    let s = mk();
    forwardOutput(s, `${E}]5379;xssh;${b64('evil@box')};22${B}${E}]5379;cwd;${b64('/tmp')};0${B}`);
    assert.strictEqual(screen(s), '');
    assert.ok(!s.remote && !s.remoteCwd);
    await dropFiles(s, [folder]);
    assert.match(screen(s), /isn't in an xssh session.*wput/);
    // a real xssh session: host + prompt directory -> scp there
    s = mk();
    forwardOutput(s, `${E}]5379;xssh;${b64('me@box')};2222;${tok}${B}${E}]5379;cwd;${b64('/srv/in')};0;${tok}${B}$ `);
    assert.strictEqual(screen(s), '$ ');
    await dropFiles(s, [folder]);
    assert.ok(await waitFor(() => /done: 1 item in me@box:\/srv\/in/.test(screen(s))), screen(s));
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].args.slice(-3), ['--', folder, 'me@box:/srv/in/']);
    assert.ok(calls[0].args.includes('BatchMode=yes') && calls[0].args.join(' ').includes('-P 2222'));
    // a prompt one xssh hop further in: refused
    forwardOutput(s, `${E}]5379;cwd;${b64('/scratch')};1;${tok}${B}`);
    await dropFiles(s, [folder]);
    assert.match(screen(s), /1 xssh hop/);
    // ssh ended: back to the local shell, nothing to scp to
    forwardOutput(s, `${E}]5379;xssh;;;${tok}${B}`);
    assert.strictEqual(s.remote, null);
    await dropFiles(s, [folder]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(typed.length, 0); // nothing was typed into the shell
  } finally { remoteCopy.io.spawn = saved; }
});
