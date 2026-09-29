// Unit tests for the settings store (app/src/settings.js): defaults, each
// setting's validation, recovery from a broken file, the atomic save and
// keybinding clashes. Runs against a scratch folder; no Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('../src/settings');
const backdrop = require('../src/backdrop');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-settings-'));
  return { dir, file: path.join(dir, 'nested', 'settings.json') };
}

function freshStore() {
  const { dir, file } = scratch();
  const store = settings.createStore(file);
  store.load();
  return { dir, file, store };
}

test('defaults are what limpet did before the settings page', () => {
  const d = settings.defaults();
  assert.deepEqual(d.terminal, {
    fontFamily: "'Cascadia Mono', Consolas, monospace", fontSize: 14, lineHeight: 1,
    cursorStyle: 'block', cursorBlink: true, scrollback: 1000,
  });
  assert.deepEqual(d.behaviour, { predictiveEcho: true, copyOnSelect: false });
  assert.equal(d.reels.defaultUrl, 'https://www.instagram.com/reels/');
  assert.deepEqual(d.backdrop, {
    firstChars: backdrop.MIN_OUTPUT_CHARS,
    updateChars: backdrop.UPDATE_OUTPUT_CHARS,
    minIntervalMinutes: backdrop.MIN_UPDATE_MS / 60000,
  });
  assert.deepEqual(d.keybindings, {
    newTab: 'Ctrl+Shift+T', closeTab: 'Ctrl+Shift+W', nextTab: 'Ctrl+Tab',
    prevTab: 'Ctrl+Shift+Tab', openSettings: 'Ctrl+,',
  });
  assert.equal(d.agents.failoverMode, 'offer');
});

test('a missing file loads the defaults and writes nothing', () => {
  const { file, store } = freshStore();
  assert.deepEqual(store.get(), settings.defaults());
  assert.equal(fs.existsSync(file), false);
});

test('schema metadata is plain data covering every setting', () => {
  const meta = settings.schemaMetadata();
  assert.doesNotThrow(() => JSON.stringify(meta));
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta); // no functions dropped silently
  const d = settings.defaults();
  for (const section of meta) {
    assert.deepEqual(section.fields.map((f) => f.key).sort(), Object.keys(d[section.id]).sort());
    for (const f of section.fields) assert.equal(f.default, d[section.id][f.key]);
  }
});

const BAD = {
  terminal: {
    fontFamily: ['', '   ', 42, 'a'.repeat(201), 'Consolas; color: red', 'x</style>'],
    fontSize: [7, 33, 14.5, '14', null, NaN, Infinity],
    lineHeight: [0.9, 2.1, '1.2', null],
    cursorStyle: ['beam', '', 'Block', 1],
    cursorBlink: ['true', 1, null],
    scrollback: [999, 100001, 5000.5, '5000'],
  },
  behaviour: {
    predictiveEcho: ['on', 0, null],
    copyOnSelect: ['yes', 1],
  },
  reels: {
    defaultUrl: ['', 'instagram.com', 'javascript:alert(1)', 'file:///C:/x.html', 'ftp://example.com', 7],
  },
  backdrop: {
    firstChars: [0, 499, 100001, 3000.5],
    updateChars: [999, 200001, 'lots'],
    minIntervalMinutes: [0, 241, 1.5, -5],
  },
  keybindings: {
    newTab: ['T', 'Shift+T', 'Ctrl+', 'Ctrl+Shift', 'Hyper+T', 'Ctrl+Ctrl+T', 'Ctrl+Escape', 'Ctrl+C', 'ctrl+v', 'Ctrl+Shift+C', 'Ctrl+Shift+v', 5, null],
    closeTab: ['Tab', 'Ctrl+Wheel'],
    nextTab: ['Ctrl+C'],
    prevTab: ['Ctrl+V'],
    openSettings: [','],
  },
  agents: {
    failoverMode: ['always', '', null, 'Offer'],
  },
};

for (const [section, fields] of Object.entries(BAD)) {
  for (const [key, values] of Object.entries(fields)) {
    test(`${section}.${key} refuses bad values with a reason`, () => {
      const { file, store } = freshStore();
      for (const v of values) {
        const r = store.set({ [section]: { [key]: v } });
        assert.equal(r.ok, false, `${JSON.stringify(v)} should be refused`);
        const reason = r.errors[`${section}.${key}`];
        assert.ok(typeof reason === 'string' && reason.length > 3, `no reason for ${JSON.stringify(v)}`);
      }
      assert.deepEqual(store.get(), settings.defaults());
      assert.equal(fs.existsSync(file), false, 'a refused value is never saved');
    });
  }
}

test('good values are accepted, canonicalised and applied', () => {
  const { store } = freshStore();
  const r = store.set({
    terminal: { fontFamily: 'Fira Code, monospace', fontSize: 18, lineHeight: 1.25, cursorStyle: 'bar', cursorBlink: false, scrollback: 20000 },
    behaviour: { predictiveEcho: false, copyOnSelect: true },
    reels: { defaultUrl: 'http://localhost:8080/feed' },
    backdrop: { firstChars: 500, updateChars: 200000, minIntervalMinutes: 1 },
    keybindings: { newTab: 'ctrl + alt + n', closeTab: 'alt+f4', nextTab: 'Ctrl+PgDn', prevTab: 'ctrl+pageup', openSettings: 'F1' },
    agents: { failoverMode: 'auto' },
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const v = store.get();
  assert.equal(v.terminal.fontSize, 18);
  assert.equal(v.terminal.cursorStyle, 'bar');
  assert.equal(v.keybindings.newTab, 'Ctrl+Alt+N');
  assert.equal(v.keybindings.closeTab, 'Alt+F4');
  assert.equal(v.keybindings.nextTab, 'Ctrl+PageDown');
  assert.equal(v.keybindings.prevTab, 'Ctrl+PageUp');
  assert.equal(v.keybindings.openSettings, 'F1');
  assert.equal(v.agents.failoverMode, 'auto');
});

test('an empty keybinding unbinds the action', () => {
  const { store } = freshStore();
  assert.equal(store.set({ keybindings: { openSettings: '' } }).ok, true);
  assert.equal(store.get().keybindings.openSettings, '');
});

test('one bad value refuses the whole change', () => {
  const { store } = freshStore();
  const r = store.set({ terminal: { fontSize: 20, scrollback: 5 } });
  assert.equal(r.ok, false);
  assert.ok(r.errors['terminal.scrollback']);
  assert.equal(r.errors['terminal.fontSize'], undefined);
  assert.equal(store.get().terminal.fontSize, 14);
});

test('unknown sections and keys are refused', () => {
  const { store } = freshStore();
  assert.ok(store.set({ nope: { a: 1 } }).errors.nope);
  assert.ok(store.set({ terminal: { fontWeight: 'bold' } }).errors['terminal.fontWeight']);
  assert.equal(store.set(null).ok, false);
  assert.equal(store.set([1]).ok, false);
});

test('two actions may not share a key', () => {
  const { store } = freshStore();
  let r = store.set({ keybindings: { newTab: 'Ctrl+Shift+W' } });
  assert.equal(r.ok, false);
  assert.match(r.errors['keybindings.newTab'], /Close tab/);
  // Same combination written differently is still a clash.
  r = store.set({ keybindings: { openSettings: 'shift+ctrl+tab' } });
  assert.equal(r.ok, false);
  assert.match(r.errors['keybindings.openSettings'], /Previous tab/);
  // Swapping two bindings in one change is fine.
  r = store.set({ keybindings: { newTab: 'Ctrl+Shift+W', closeTab: 'Ctrl+Shift+T' } });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  // Two actions given the same new key in one change: both are named.
  r = store.set({ keybindings: { newTab: 'Ctrl+Alt+X', closeTab: 'Ctrl+Alt+X' } });
  assert.equal(r.ok, false);
  assert.ok(r.errors['keybindings.newTab'] && r.errors['keybindings.closeTab']);
  // Unbound actions don't clash with each other.
  assert.equal(store.set({ keybindings: { newTab: '', closeTab: '' } }).ok, true);
});

test('saves atomically and only what differs from the defaults', () => {
  const { dir, file, store } = freshStore();
  assert.equal(store.set({ terminal: { fontSize: 16 }, agents: { failoverMode: 'off' } }).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { terminal: { fontSize: 16 }, agents: { failoverMode: 'off' } });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'], 'no temp file left behind');

  // The write goes to a temp file first, then a rename replaces the real one.
  const calls = [];
  const io = {
    ...fs,
    writeFileSync: (p, ...rest) => { calls.push(['write', p]); return fs.writeFileSync(p, ...rest); },
    renameSync: (a, b) => { calls.push(['rename', a, b]); return fs.renameSync(a, b); },
  };
  const spied = settings.createStore(file, io);
  spied.load();
  assert.equal(spied.get().terminal.fontSize, 16, 'reloads what was saved');
  spied.set({ terminal: { fontSize: 17 } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'write');
  assert.notEqual(calls[0][1], file);
  assert.deepEqual(calls[1], ['rename', calls[0][1], file]);

  // A failed write leaves the old file whole and no temp file.
  const failing = settings.createStore(file, { ...fs, renameSync: () => { throw new Error('disk full'); } });
  failing.load();
  assert.throws(() => failing.set({ terminal: { fontSize: 20 } }), /disk full/);
  assert.equal(failing.get().terminal.fontSize, 17, 'an unsaved change is not applied');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).terminal.fontSize, 17);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt file falls back to defaults and is kept aside', () => {
  const { file } = scratch();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ "terminal": { "fontSize": 20, ');
  const store = settings.createStore(file);
  const errors = console.error;
  console.error = () => {};
  try { assert.deepEqual(store.load(), settings.defaults()); } finally { console.error = errors; }
  assert.equal(fs.readFileSync(`${file}.bad`, 'utf8'), '{ "terminal": { "fontSize": 20, ');
  // and it still saves over the broken file
  assert.equal(store.set({ terminal: { fontSize: 12 } }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).terminal.fontSize, 12);
});

test('a file of the wrong shape, bad values or unknown keys keeps only the good parts', () => {
  const { file } = scratch();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const junk of ['null', '[]', '"text"', '42']) {
    fs.writeFileSync(file, junk);
    assert.deepEqual(settings.createStore(file).load(), settings.defaults(), junk);
  }
  fs.writeFileSync(file, JSON.stringify({
    terminal: { fontSize: 99, cursorStyle: 'bar', secret: 'x' },
    reels: 'https://example.com',
    extra: { a: 1 },
    keybindings: { newTab: 'ctrl+shift+w', closeTab: 'Ctrl+Shift+W', openSettings: 'Ctrl+C' },
  }));
  const v = settings.createStore(file).load();
  assert.equal(v.terminal.fontSize, 14);
  assert.equal(v.terminal.cursorStyle, 'bar');
  assert.equal(v.terminal.secret, undefined);
  assert.equal(v.extra, undefined);
  assert.equal(v.reels.defaultUrl, 'https://www.instagram.com/reels/');
  // newTab took Ctrl+Shift+W first, so closeTab can't have it: it would fall
  // back to its default, which is that same key, so it ends up unbound.
  assert.equal(v.keybindings.newTab, 'Ctrl+Shift+W');
  assert.equal(v.keybindings.closeTab, '');
  assert.equal(v.keybindings.openSettings, 'Ctrl+,');
});

test('subscribers hear each applied change once, and not refused ones', () => {
  const { store } = freshStore();
  const heard = [];
  const off = store.subscribe((values, changed) => heard.push({ size: values.terminal.fontSize, changed }));
  store.set({ terminal: { fontSize: 22 } });
  store.set({ terminal: { fontSize: 22 } }); // no change: no event
  store.set({ terminal: { fontSize: 2 } });  // refused: no event
  assert.deepEqual(heard, [{ size: 22, changed: ['terminal.fontSize'] }]);
  off();
  store.set({ terminal: { fontSize: 12 } });
  assert.equal(heard.length, 1);
});

test('get() hands out copies', () => {
  const { store } = freshStore();
  store.get().terminal.fontSize = 30;
  assert.equal(store.get().terminal.fontSize, 14);
});

test('normalizeAccelerator', () => {
  const n = settings.normalizeAccelerator;
  assert.equal(n('shift+CTRL+t'), 'Ctrl+Shift+T');
  assert.equal(n('Control+,'), 'Ctrl+,');
  assert.equal(n('alt+shift+f12'), 'Alt+Shift+F12');
  assert.equal(n(''), '');
  assert.equal(n('Ctrl++'), null);
  assert.equal(n('Ctrl+Nope'), null);
  assert.equal(n(null), null);
});
