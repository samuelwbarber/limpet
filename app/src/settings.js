// limpet settings: a small JSON store (userData/settings.json) behind the
// settings page. Each setting has a default (what limpet did before there was
// a settings page, so nothing changes until you change it) and a validator
// that says why a value is refused. Only values that differ from the default
// are written, so a later release can move a default for everyone who never
// touched it.
//
// No Electron in here: main.js hands in the file path, and the tests drive the
// store against a scratch folder.
const fs = require('fs');
const path = require('path');
const { MIN_OUTPUT_CHARS, UPDATE_OUTPUT_CHARS, MIN_UPDATE_MS } = require('./backdrop');

// ---- validators: each returns '' for a good value, else the reason ----
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const intIn = (min, max) => (v) => {
  if (!isNum(v) || !Number.isInteger(v)) return 'must be a whole number';
  return v < min || v > max ? `must be between ${min} and ${max}` : '';
};
const numIn = (min, max) => (v) => {
  if (!isNum(v)) return 'must be a number';
  return v < min || v > max ? `must be between ${min} and ${max}` : '';
};
const bool = (v) => (typeof v === 'boolean' ? '' : 'must be on or off');
const oneOf = (options) => (v) => (options.includes(v) ? '' : `must be one of ${options.join(', ')}`);

function fontFamily(v) {
  if (typeof v !== 'string' || !v.trim()) return 'must name at least one font';
  if (v.length > 200) return 'is too long (200 characters at most)';
  if (/[;{}<>\\]/.test(v)) return 'may not contain ; { } < > or \\';
  return '';
}

function webUrl(v) {
  if (typeof v !== 'string' || !v.trim()) return 'must be a web address';
  let url;
  try { url = new URL(v); } catch (_) { return 'is not a valid address'; }
  return url.protocol === 'https:' || url.protocol === 'http:' ? '' : 'must start with https:// or http://';
}

// ---- keybindings ----
// Canonical form: modifiers in the order Ctrl, Alt, Shift, then one key, joined
// by "+" ("Ctrl+Shift+T", "Ctrl+,", "F5"). The renderer builds the same string
// from a keydown, so matching is plain string equality. '' means unbound.
const NAMED_KEYS = [
  'Tab', 'Space', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'Up', 'Down', 'Left', 'Right',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
];
const PUNCTUATION = [',', '.', '/', ';', "'", '[', ']', '-', '=', '`', '\\'];
// Copy and paste belong to the terminal and can't be taken by an action.
const RESERVED = ['Ctrl+C', 'Ctrl+V', 'Ctrl+Shift+C', 'Ctrl+Shift+V'];

function normalizeKey(raw) {
  const k = String(raw).trim();
  if (/^[a-z0-9]$/i.test(k)) return k.toUpperCase();
  if (PUNCTUATION.includes(k)) return k;
  const named = NAMED_KEYS.find((n) => n.toLowerCase() === k.toLowerCase());
  if (named) return named;
  const alias = { esc: null, escape: null, return: 'Enter', del: 'Delete', ins: 'Insert', pgup: 'PageUp', pgdn: 'PageDown', comma: ',', period: '.' };
  return alias[k.toLowerCase()] || null;
}

// "ctrl + shift + t" -> "Ctrl+Shift+T"; null if it isn't a key combination.
function normalizeAccelerator(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return '';
  // The last part is the key, and may itself be "+"-free punctuation such as ",".
  const parts = text.split('+').map((p) => p.trim());
  if (parts.some((p) => !p)) return null;
  const key = normalizeKey(parts.pop());
  if (!key) return null;
  const mods = new Set();
  for (const p of parts) {
    const m = { ctrl: 'Ctrl', control: 'Ctrl', ctl: 'Ctrl', alt: 'Alt', shift: 'Shift' }[p.toLowerCase()];
    if (!m || mods.has(m)) return null;
    mods.add(m);
  }
  return [...['Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m)), key].join('+');
}

function keybinding(v) {
  if (typeof v !== 'string') return 'must be a key combination such as Ctrl+Shift+T';
  const acc = normalizeAccelerator(v);
  if (acc === null) return 'must be a key combination such as Ctrl+Shift+T';
  if (acc === '') return '';
  if (RESERVED.includes(acc)) return `${acc} is copy/paste and can't be rebound`;
  const key = acc.split('+').pop();
  const hasMod = /^(Ctrl|Alt)\+/.test(acc);
  if (!hasMod && !/^F\d+$/.test(key)) return 'needs Ctrl or Alt (or an F key), or it would swallow typing';
  return '';
}

// ---- the schema ----
// Grouped the way the settings page shows them. `default` is what limpet did
// before; `validate` returns the reason a value is refused.
const SECTIONS = [
  {
    id: 'terminal', label: 'Terminal',
    fields: {
      fontFamily: { label: 'Font family', type: 'string', default: "'Cascadia Mono', Consolas, monospace", validate: fontFamily, help: 'CSS font list, first one installed wins' },
      fontSize: { label: 'Font size', type: 'number', min: 8, max: 32, step: 1, default: 14, validate: intIn(8, 32) },
      lineHeight: { label: 'Line height', type: 'number', min: 1, max: 2, step: 0.05, default: 1, validate: numIn(1, 2) },
      cursorStyle: { label: 'Cursor style', type: 'enum', options: ['block', 'underline', 'bar'], default: 'block', validate: oneOf(['block', 'underline', 'bar']) },
      cursorBlink: { label: 'Blinking cursor', type: 'boolean', default: true, validate: bool },
      scrollback: { label: 'Scrollback lines', type: 'number', min: 1000, max: 100000, step: 1000, default: 1000, validate: intIn(1000, 100000) },
    },
  },
  {
    id: 'behaviour', label: 'Behaviour',
    fields: {
      predictiveEcho: { label: 'Predictive echo', type: 'boolean', default: true, validate: bool, help: 'Draw typed characters at once (in red) on laggy links' },
      copyOnSelect: { label: 'Copy on select', type: 'boolean', default: false, validate: bool, help: 'Selecting text copies it to the clipboard' },
    },
  },
  {
    id: 'reels', label: 'Reels',
    fields: {
      defaultUrl: { label: 'Default page', type: 'url', default: 'https://www.instagram.com/reels/', validate: webUrl, help: 'What a bare `reels` opens' },
    },
  },
  {
    id: 'backdrop', label: 'Generative backdrop',
    fields: {
      firstChars: { label: 'First picture after (characters of output)', type: 'number', min: 500, max: 100000, step: 500, default: MIN_OUTPUT_CHARS, validate: intIn(500, 100000) },
      updateChars: { label: 'New picture after (more characters)', type: 'number', min: 1000, max: 200000, step: 1000, default: UPDATE_OUTPUT_CHARS, validate: intIn(1000, 200000) },
      minIntervalMinutes: { label: 'At most one new picture every (minutes)', type: 'number', min: 1, max: 240, step: 1, default: MIN_UPDATE_MS / 60000, validate: intIn(1, 240) },
    },
  },
  {
    id: 'keybindings', label: 'Keyboard shortcuts',
    fields: {
      newTab: { label: 'New tab', type: 'keybinding', default: 'Ctrl+Shift+T', validate: keybinding },
      closeTab: { label: 'Close tab', type: 'keybinding', default: 'Ctrl+Shift+W', validate: keybinding },
      nextTab: { label: 'Next tab', type: 'keybinding', default: 'Ctrl+Tab', validate: keybinding },
      prevTab: { label: 'Previous tab', type: 'keybinding', default: 'Ctrl+Shift+Tab', validate: keybinding },
      openSettings: { label: 'Open settings', type: 'keybinding', default: 'Ctrl+,', validate: keybinding },
    },
  },
  {
    id: 'agents', label: 'Agents',
    fields: {
      failoverMode: { label: 'When an account runs out', type: 'enum', options: ['offer', 'auto', 'off'], default: 'offer', validate: oneOf(['offer', 'auto', 'off']), help: 'offer: ask to move the chat to another account; auto: move it; off: do nothing' },
    },
  },
];
const SECTION = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));

function defaults() {
  const out = {};
  for (const s of SECTIONS) {
    out[s.id] = {};
    for (const [key, f] of Object.entries(s.fields)) out[s.id][key] = f.default;
  }
  return out;
}

// The schema without its functions, for the renderer to build the form from.
function schemaMetadata() {
  return SECTIONS.map((s) => ({
    id: s.id, label: s.label,
    fields: Object.entries(s.fields).map(([key, f]) => {
      const { validate, ...rest } = f;
      return { key, ...rest };
    }),
  }));
}

const clone = (v) => JSON.parse(JSON.stringify(v));

// Canonicalise a value that passed validation (keybindings to "Ctrl+Shift+T").
const canonical = (field, v) => (field.type === 'keybinding' ? normalizeAccelerator(v) : v);

// Two actions may not share a binding. Returns { action: reason } for each
// action in `changed` that collides with another.
function bindingClashes(bindings, changed) {
  const errors = {};
  const labels = SECTION.keybindings.fields;
  for (const action of changed) {
    const acc = bindings[action];
    if (!acc) continue;
    const other = Object.keys(bindings).find((a) => a !== action && bindings[a] === acc);
    if (other) errors[action] = `${acc} is already ${labels[other].label}`;
  }
  return errors;
}

// Keep the known keys that validate, default the rest, drop unknown ones.
function sanitize(raw) {
  const out = defaults();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const s of SECTIONS) {
    const section = raw[s.id];
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
    for (const [key, f] of Object.entries(s.fields)) {
      if (Object.prototype.hasOwnProperty.call(section, key) && !f.validate(section[key])) {
        out[s.id][key] = canonical(f, section[key]);
      }
    }
  }
  // A hand-edited file may give two actions one key: the later one goes back
  // to its default, or to unbound if that is taken too.
  const kb = out.keybindings;
  const seen = new Set();
  for (const action of Object.keys(SECTION.keybindings.fields)) {
    if (kb[action] && seen.has(kb[action])) {
      const d = SECTION.keybindings.fields[action].default;
      kb[action] = seen.has(d) ? '' : d;
    }
    if (kb[action]) seen.add(kb[action]);
  }
  return out;
}

// Only what differs from the default is written.
function overrides(values) {
  const d = defaults();
  const out = {};
  for (const s of SECTIONS) {
    for (const key of Object.keys(s.fields)) {
      if (values[s.id][key] !== d[s.id][key]) (out[s.id] = out[s.id] || {})[key] = values[s.id][key];
    }
  }
  return out;
}

function createStore(filePath, io = fs) {
  let values = defaults();
  const subscribers = new Set();

  // Missing file: defaults. Unreadable or not JSON: defaults, and the bad file
  // is kept beside it as settings.json.bad so a hand edit isn't lost.
  function load() {
    let text = null;
    try { text = io.readFileSync(filePath, 'utf8'); } catch (_) { /* first run */ }
    let raw = null;
    if (text !== null) {
      try { raw = JSON.parse(text); } catch (e) {
        console.error(`[limpet] ${filePath} is not valid JSON (${e.message}); using defaults`);
        try { io.writeFileSync(`${filePath}.bad`, text); } catch (_) { /* best effort */ }
      }
    }
    values = sanitize(raw);
    return get();
  }

  // Write a temp file beside the real one and rename it over, so a crash or a
  // full disk mid-write leaves the old settings intact rather than half a file.
  function save(next) {
    io.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    try {
      io.writeFileSync(tmp, `${JSON.stringify(overrides(next), null, 2)}\n`);
      io.renameSync(tmp, filePath);
    } catch (e) {
      try { io.unlinkSync(tmp); } catch (_) { /* never written */ }
      throw e;
    }
  }

  function get() { return clone(values); }

  // partial: { section: { key: value } }. All or nothing: any refused value
  // leaves every setting as it was. errors: { 'section.key': reason }.
  function set(partial) {
    const errors = {};
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      return { ok: false, errors: { '': 'expected { section: { key: value } }' }, values: get() };
    }
    const next = clone(values);
    const changed = [];
    for (const [sid, section] of Object.entries(partial)) {
      const s = SECTION[sid];
      if (!s) { errors[sid] = 'unknown section'; continue; }
      if (!section || typeof section !== 'object' || Array.isArray(section)) { errors[sid] = 'expected { key: value }'; continue; }
      for (const [key, v] of Object.entries(section)) {
        const f = s.fields[key];
        if (!f) { errors[`${sid}.${key}`] = 'unknown setting'; continue; }
        const reason = f.validate(v);
        if (reason) { errors[`${sid}.${key}`] = reason; continue; }
        const value = canonical(f, v);
        if (next[sid][key] !== value) { next[sid][key] = value; changed.push(`${sid}.${key}`); }
      }
    }
    const kbChanged = changed.filter((c) => c.startsWith('keybindings.')).map((c) => c.slice('keybindings.'.length));
    for (const [action, reason] of Object.entries(bindingClashes(next.keybindings, kbChanged))) {
      errors[`keybindings.${action}`] = reason;
    }
    if (Object.keys(errors).length) return { ok: false, errors, values: get() };
    if (!changed.length) return { ok: true, errors: {}, values: get() };
    save(next); // throws before anything changes if the disk refuses
    values = next;
    const snapshot = get();
    for (const fn of subscribers) {
      try { fn(snapshot, changed); } catch (e) { console.error('[limpet] settings subscriber failed:', e); }
    }
    return { ok: true, errors: {}, values: get() };
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  return { load, get, set, subscribe, schema: schemaMetadata, defaults, path: filePath };
}

module.exports = {
  createStore, defaults, schemaMetadata, normalizeAccelerator, sanitize, RESERVED,
};
