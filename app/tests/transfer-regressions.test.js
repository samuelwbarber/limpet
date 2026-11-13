const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const rc = require('../src/remote-copy');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-transfer-regression-'));
const originalHome = os.homedir;
os.homedir = () => home;
const handlers = new Map();
const contents = new Map();
const appEvents = new Map();
let quitCalls = 0;
let showDialog = async () => ({ response: 0 });
const electron = {
  app: { whenReady: () => new Promise(() => {}), getPath: () => home, on: (name, fn) => appEvents.set(name, fn), quit: () => { quitCalls++; } },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null, getAllWindows: () => [] },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
  clipboard: {}, screen: {}, shell: {},
  webContents: { fromId: (id) => contents.get(id) },
  dialog: { showMessageBox: (...args) => showDialog(...args) },
};
function loadMain() {
  const load = Module._load;
  Module._load = function (name, ...args) {
    if (name === 'electron') return electron;
    if (name.includes('node-pty')) throw new Error('No PTY in regression tests');
    return load.call(this, name, ...args);
  };
  const file = path.join(__dirname, '../src/main.js');
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  const error = console.error;
  console.error = () => {};
  try { mod._compile(`${fs.readFileSync(file, 'utf8')}\nmodule.exports = { sessions, dropFiles, stopSession, confirmSessionClose };`, file); }
  finally { Module._load = load; console.error = error; }
  return mod.exports;
}
const main = loadMain();
const source = path.join(home, 'upload.txt');
fs.writeFileSync(source, 'test content');
const session = (id = 1) => ({ id, ownerId: 10, ready: false, uiPending: [], proc: { kill() {} }, remote: { target: 'fixture.invalid', port: '' }, remoteCwd: { cwd: '/fixture', depth: 0 } });
test.after(() => { os.homedir = originalHome; fs.rmSync(home, { recursive: true, force: true }); });

test('application quit resumes after approval and cancellation preserves sessions', async () => {
  const sess = session(99);
  main.sessions.set(sess.id, sess);
  const beforeQuit = appEvents.get('before-quit');
  let prevented = 0;
  showDialog = async () => ({ response: 0 });
  beforeQuit({ preventDefault: () => { prevented++; } });
  await new Promise(setImmediate);
  assert.equal(quitCalls, 0);
  assert.ok(main.sessions.has(99));
  showDialog = async () => ({ response: 1 });
  beforeQuit({ preventDefault: () => { prevented++; } });
  await new Promise(setImmediate);
  assert.equal(prevented, 2);
  assert.equal(quitCalls, 1);
  // Re-entered quit must not ask again or cancel itself.
  beforeQuit({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 2);
  main.sessions.clear();
});

test('confirmation accepted after its session closes cannot start an orphan copy', async () => {
  let resolveDialog;
  showDialog = () => new Promise((resolve) => { resolveDialog = resolve; });
  const sess = session();
  main.sessions.set(sess.id, sess);
  const saved = rc.runScp;
  let copies = 0;
  rc.runScp = async () => { copies++; return true; };
  try {
    const pending = main.dropFiles(sess, [source]);
    assert.equal(typeof resolveDialog, 'function');
    main.stopSession(sess);
    resolveDialog({ response: 0 });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.reason, /exited/);
    assert.equal(copies, 0);
  } finally { rc.runScp = saved; main.sessions.clear(); }
});

test('a late transfer result cannot recreate a card after its tab is closed', async () => {
  const sess = session(77);
  main.sessions.set(sess.id, sess);
  const saved = rc.runScp;
  let finish;
  rc.runScp = () => new Promise((resolve) => { finish = resolve; });
  showDialog = async () => ({ response: 0 });
  try {
    assert.equal((await main.dropFiles(sess, [source])).ok, true);
    const events = sess.uiPending.filter((u) => u.channel === 'transfer:status').length;
    assert.equal(events, 1);
    main.stopSession(sess);
    finish(false);
    await new Promise(setImmediate);
    assert.equal(sess.uiPending.filter((u) => u.channel === 'transfer:status').length, events);
  } finally { rc.runScp = saved; main.sessions.clear(); }
});

test('only running jobs trigger a close warning after the shell exits', async () => {
  let dialogs = 0;
  showDialog = async () => { dialogs++; return { response: 0 }; };
  const sess = { exited: true, transfers: new Map([['a', { state: 'done' }], ['b', { state: 'failed' }], ['c', { state: 'cancelled' }]]) };
  assert.equal(await main.confirmSessionClose(null, [sess]), true);
  assert.equal(dialogs, 0);
  sess.transfers.set('d', { state: 'running' });
  assert.equal(await main.confirmSessionClose(null, [sess]), false);
  assert.equal(dialogs, 1);
});

test('cancellation stays pending until scp closes, even when close reports success', async () => {
  const saved = rc.io.spawn;
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  let kills = 0;
  child.kill = () => { kills++; return true; };
  rc.io.spawn = () => child;
  const controller = new AbortController();
  let settled = false;
  const messages = [];
  try {
    const result = rc.runScp({ paths: [source], target: 'fixture.invalid', dir: '/fixture', signal: controller.signal }, (_, message) => messages.push(message));
    result.then(() => { settled = true; });
    controller.abort();
    await new Promise(setImmediate);
    assert.equal(kills, 1);
    assert.equal(settled, false, 'kill is a request, not proof that the writer stopped');
    child.emit('close', 0);
    assert.equal(await result, false);
    assert.match(messages.at(-1), /cancelled.*partial files/);
  } finally { rc.io.spawn = saved; }
});

// Small DOM harness executes the production card renderer and removeTab handler;
// IPC still goes through the production main-process ownership checks.
function ui() {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; }
    setAttribute() {}
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    appendChild(child) { this.append(child); }
    replaceChildren() { this.children = []; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  }
  const body = new Element('body');
  const events = new Map();
  let transfer;
  const window = {
    addEventListener: (name, cb) => events.set(name, cb),
    dispatchEvent: (event) => events.get(event.type)?.(event),
    limpet: { onTransfer: (cb) => { transfer = cb; }, cancelTransfer: (...args) => window.cancel(...args) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/transfers-ui.js'), 'utf8'), { window, document: { body, createElement: (tag) => new Element(tag) } });
  return { window, receive: (job) => transfer(job), cards: () => body.children[0].children };
}

test('detached transfer cards leave the old tab and replay with working cancellation for the new owner', async () => {
  const oldUi = ui();
  const newUi = ui();
  const sess = session(41);
  const controller = new AbortController();
  const job = { id: 'copy-41', paths: [source], state: 'running', destination: 'fixture.invalid:/fixture', controller };
  sess.transfers = new Map([[job.id, job]]);
  main.sessions.set(sess.id, sess);
  contents.set(10, { isDestroyed: () => false, send: (channel, payload) => { if (channel === 'transfer:status') oldUi.receive(payload); } });
  contents.set(20, { isDestroyed: () => false, send: (channel, payload) => { if (channel === 'transfer:status') newUi.receive(payload); } });
  try {
    assert.equal(handlers.get('term:ready')({ sender: { id: 10 } }, sess.id), true);
    assert.equal(oldUi.cards().length, 1);
    // createWindow's detach path reassigns ownership before removeTab runs.
    sess.ownerId = 20;
    sess.ready = false;
    const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
    const removeTab = renderer.slice(renderer.indexOf('function removeTab('), renderer.indexOf('\nwindow.limpet.onData('));
    const removed = { term: { dispose() {} }, pane: { remove() {} }, tabEl: { remove() {} } };
    const tabs = new Map([[sess.id, removed], [42, {}]]);
    vm.runInNewContext(`${removeTab}\nremoveTab(41);`, { tabs, tabOrder: () => [...tabs.keys()], activeId: 42, clearTimeout, window: oldUi.window, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
    assert.equal(oldUi.cards().length, 0);
    assert.equal(handlers.get('term:ready')({ sender: { id: 10 } }, sess.id), false, 'old owner cannot reattach');
    assert.equal(handlers.get('term:ready')({ sender: { id: 20 } }, sess.id), true);
    assert.equal(newUi.cards().length, 1);
    newUi.window.cancel = (sessionId, id) => handlers.get('transfer:cancel')({ sender: { id: 20 } }, { sessionId, id });
    const cancelButton = newUi.cards()[0].children.at(-1).children[0];
    assert.equal(cancelButton.textContent, 'Cancel');
    await cancelButton.onclick();
    assert.equal(controller.signal.aborted, true);
  } finally { main.sessions.clear(); contents.clear(); }
});
