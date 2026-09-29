// Renderer side of the settings page. Loaded before renderer.js, which asks it
// for the terminal options, the predictor and which action a key is bound to.
// The values live in the main process (settings.js, userData/settings.json);
// every change there is broadcast to every window and applied live here: font,
// size, line height, cursor and scrollback on every open terminal, predictive
// echo on or off, the shortcut map.
//
// The page is an overlay opened with Ctrl+, (rebindable) or "Settings…" in a
// tab's right-click menu. Each field saves as you go; a refused value keeps the
// old one and says why under the field. Esc closes and gives the keyboard back
// to the terminal.
/* global tabs, activeId, newTab, closeTab, cycleTabs, syncSize, closeAccountMenu */
(function () {
  const TERMINAL_KEYS = ['fontFamily', 'fontSize', 'lineHeight', 'cursorStyle', 'cursorBlink', 'scrollback'];
  const FONT_KEYS = ['fontFamily', 'fontSize', 'lineHeight'];

  // Fetched synchronously once so the first tab opens with the chosen font.
  let state = { values: null, schema: [] };
  try { state = window.limpet.getSettingsSync(); } catch (e) { console.error('[limpet] settings unavailable:', e); }
  // Fall back to the schema defaults (or nothing) if the main process had no answer.
  if (!state.values) {
    state.values = {};
    for (const s of state.schema || []) {
      state.values[s.id] = {};
      for (const f of s.fields) state.values[s.id][f.key] = f.default;
    }
  }

  const get = (section, key) => (state.values[section] || {})[key];

  function termOptions() {
    const out = {};
    for (const k of TERMINAL_KEYS) if (get('terminal', k) !== undefined) out[k] = get('terminal', k);
    return out;
  }

  // ---- keys ----
  // The same canonical form settings.js stores: Ctrl, Alt, Shift, then the key.
  const CODE_KEYS = {
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
    Minus: '-', Equal: '=', Backquote: '`', Backslash: '\\', Tab: 'Tab', Space: 'Space', Enter: 'Enter',
    Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  };
  function keyName(e) {
    const code = e.code || '';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-2])$/.test(code)) return code;
    if (CODE_KEYS[code]) return CODE_KEYS[code];
    return '';
  }
  function accelerator(e) {
    const key = keyName(e);
    if (!key) return '';
    return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
  }
  // Which action a keydown is bound to, or null.
  function actionFor(e) {
    const acc = accelerator(e);
    if (!acc) return null;
    const kb = state.values.keybindings || {};
    return Object.keys(kb).find((a) => kb[a] === acc) || null;
  }
  // Run the action a keydown is bound to; true if there was one.
  function runAction(e, id) {
    const action = actionFor(e);
    if (action === 'newTab') newTab();
    else if (action === 'closeTab') closeTab(id);
    else if (action === 'nextTab') cycleTabs(1);
    else if (action === 'prevTab') cycleTabs(-1);
    else if (action === 'openSettings') toggle();
    else return false;
    return true;
  }

  // ---- behaviour ----
  function makePredictor(term, pane) {
    if (!get('behaviour', 'predictiveEcho') || !window.Predict) return null;
    try {
      const screenEl = pane.querySelector('.xterm-screen');
      return screenEl ? window.Predict.create(term, screenEl) : null;
    } catch (e) {
      console.error('[limpet] predictor failed:', e);
      return null;
    }
  }

  // Copy on select: once the selection stops changing (the drag ends).
  function selectionChanged(term) {
    if (!get('behaviour', 'copyOnSelect')) return;
    clearTimeout(term._copyOnSelectTimer);
    term._copyOnSelectTimer = setTimeout(() => {
      const s = term.getSelection();
      if (s) window.limpet.clipboardCopy(s);
    }, 150);
  }

  // ---- applying a change ----
  function apply(values) {
    const before = state.values;
    state.values = values;
    const changed = (section, key) => JSON.stringify((before[section] || {})[key]) !== JSON.stringify((values[section] || {})[key]);
    const fontChanged = FONT_KEYS.some((k) => changed('terminal', k));
    const predictChanged = changed('behaviour', 'predictiveEcho');
    for (const tab of (typeof tabs !== 'undefined' ? tabs.values() : [])) {
      for (const k of TERMINAL_KEYS) {
        if (changed('terminal', k)) {
          try { tab.term.options[k] = values.terminal[k]; } catch (e) { console.error(`[limpet] can't set ${k}:`, e); }
        }
      }
      // The predictor's overlay is sized to the font it was made with.
      if (predictChanged || fontChanged) {
        if (tab.predict) { tab.predict.dispose(); tab.predict = null; }
        tab.predict = makePredictor(tab.term, tab.pane);
      }
    }
    if (fontChanged && typeof syncSize === 'function') requestAnimationFrame(() => syncSize()); // hidden tabs fit when shown
    labelShortcuts();
    if (panel) refreshFields();
  }
  window.limpet.onSettingsChanged(apply);

  const shortcut = (action) => get('keybindings', action);
  function labelShortcuts() {
    const btn = document.getElementById('newtab');
    if (btn) btn.title = shortcut('newTab') ? `New tab (${shortcut('newTab')})` : 'New tab';
  }
  labelShortcuts();

  // ---- the page ----
  let panel = null;      // the overlay while open
  let returnFocus = null;
  const fields = new Map(); // 'section.key' -> { field, input, error }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
  }

  async function save(sectionId, partial) {
    let result;
    try { result = await window.limpet.setSettings({ [sectionId]: partial }); } catch (e) { result = { ok: false, errors: { '': e.message } }; }
    for (const key of Object.keys(partial)) showError(`${sectionId}.${key}`, (result.errors || {})[`${sectionId}.${key}`] || '');
    const general = (result.errors || {})[''];
    if (panel) panel.querySelector('.settings-status').textContent = general || '';
    return result;
  }

  function showError(id, message) {
    const f = fields.get(id);
    if (!f) return;
    f.error.textContent = message;
    f.input.setAttribute('aria-invalid', message ? 'true' : 'false');
    f.row.classList.toggle('invalid', !!message);
  }

  function setInput(f, value) {
    const { field, input } = f;
    if (field.type === 'boolean') input.checked = !!value;
    else if (field.type === 'keybinding') input.value = value || '';
    else input.value = value === undefined || value === null ? '' : String(value);
  }

  // Show the stored values (a change may come from another window), except in
  // the field being typed in, which keeps its text and its message.
  function refreshFields() {
    for (const [id, f] of fields) {
      if (document.activeElement === f.input) continue;
      const [section, key] = id.split('.');
      setInput(f, get(section, key));
      showError(id, '');
    }
  }

  function buildField(section, field) {
    const id = `${section.id}.${field.key}`;
    const domId = `setting-${section.id}-${field.key}`;
    const row = el('div', `settings-row type-${field.type}`);
    const label = el('label', '', field.label);
    label.htmlFor = domId;
    let input;
    const commit = (value) => save(section.id, { [field.key]: value });
    let timer = null;
    const debounced = (fn) => { clearTimeout(timer); timer = setTimeout(fn, 350); };

    if (field.type === 'boolean') {
      input = el('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => commit(input.checked));
    } else if (field.type === 'enum') {
      input = el('select');
      for (const o of field.options) {
        const opt = el('option', '', o);
        opt.value = o;
        input.append(opt);
      }
      input.addEventListener('change', () => commit(input.value));
    } else if (field.type === 'number') {
      input = el('input');
      input.type = 'number';
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      if (field.step !== undefined) input.step = String(field.step);
      const send = () => {
        if (input.value.trim() === '') { showError(id, 'must be a number'); return; }
        commit(Number(input.value));
      };
      input.addEventListener('input', () => debounced(send));
      input.addEventListener('change', () => { clearTimeout(timer); send(); });
    } else if (field.type === 'keybinding') {
      input = el('input', 'keybinding');
      input.type = 'text';
      input.readOnly = true;
      input.placeholder = 'unbound';
      input.setAttribute('aria-description', 'Press a key combination to bind it; Backspace or Delete unbinds');
      // Record the next combination. Plain Tab / Shift+Tab still move focus and
      // Esc still closes the page, so the recorder never traps the keyboard.
      input.addEventListener('keydown', (e) => {
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
        const mods = e.ctrlKey || e.altKey;
        if (!mods && (e.key === 'Tab' || e.key === 'Escape')) return;
        e.preventDefault();
        e.stopPropagation();
        if (!mods && !e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete')) { input.value = ''; commit(''); return; }
        const acc = accelerator(e);
        if (!acc) { showError(id, `${e.key} can't be bound`); return; }
        input.value = acc;
        commit(acc);
      });
    } else {
      input = el('input');
      input.type = field.type === 'url' ? 'url' : 'text';
      input.spellcheck = false;
      input.addEventListener('input', () => debounced(() => commit(input.value)));
      input.addEventListener('change', () => { clearTimeout(timer); commit(input.value); });
    }
    input.id = domId;
    input.name = id;
    const help = field.help || (field.type === 'keybinding' ? 'Focus and press keys · Backspace unbinds' : '');
    const error = el('div', 'settings-error');
    error.id = `${domId}-error`;
    error.setAttribute('aria-live', 'polite');
    const describedBy = [error.id];
    const control = el('div', 'settings-control');
    control.append(input);
    if (help) {
      const h = el('div', 'settings-help', help);
      h.id = `${domId}-help`;
      describedBy.unshift(h.id);
      control.append(h);
    }
    control.append(error);
    input.setAttribute('aria-describedby', describedBy.join(' '));
    row.append(label, control);
    const f = { field, input, error, row };
    fields.set(id, f);
    setInput(f, get(section.id, field.key));
    return row;
  }

  function buildSection(section) {
    const box = el('section', 'settings-section');
    box.setAttribute('aria-labelledby', `settings-h-${section.id}`);
    const head = el('div', 'settings-section-head');
    const h = el('h2', '', section.label);
    h.id = `settings-h-${section.id}`;
    const reset = el('button', 'settings-reset', 'Reset to defaults');
    reset.type = 'button';
    reset.setAttribute('aria-label', `Reset ${section.label} to defaults`);
    reset.addEventListener('click', async () => {
      const defaults = {};
      for (const f of section.fields) defaults[f.key] = f.default;
      await save(section.id, defaults);
      for (const f of section.fields) setInput(fields.get(`${section.id}.${f.key}`), get(section.id, f.key));
    });
    head.append(h, reset);
    box.append(head);
    for (const field of section.fields) box.append(buildField(section, field));
    return box;
  }

  const focusable = () => Array.from(panel.querySelectorAll('button, input, select')).filter((e) => !e.disabled);

  function open() {
    if (panel) { focusable()[0].focus(); return; }
    if (typeof closeAccountMenu === 'function') closeAccountMenu();
    returnFocus = typeof activeId !== 'undefined' ? activeId : null;
    fields.clear();
    const overlay = el('div', 'settings-overlay');
    const dialog = el('div', 'settings-panel');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'settings-title');
    const head = el('div', 'settings-head');
    const title = el('h1', '', 'Settings');
    title.id = 'settings-title';
    const where = el('span', 'settings-status');
    where.setAttribute('role', 'status');
    const close = el('button', 'settings-close', '×');
    close.type = 'button';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close settings');
    close.addEventListener('click', () => closePanel());
    head.append(title, where, close);
    const body = el('div', 'settings-body');
    for (const section of state.schema || []) body.append(buildSection(section));
    dialog.append(head, body);
    overlay.append(dialog);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closePanel(); });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePanel(); return; }
      if (e.key === 'Tab') { // keep focus inside the page
        const items = focusable();
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      if (actionFor(e) === 'openSettings') { e.preventDefault(); closePanel(); }
    });
    document.body.appendChild(overlay);
    panel = overlay;
    const firstField = body.querySelector('input, select');
    (firstField || close).focus();
  }

  function closePanel() {
    if (!panel) return;
    panel.remove();
    panel = null;
    fields.clear();
    const t = typeof tabs !== 'undefined' ? (tabs.get(returnFocus) || tabs.get(activeId)) : null;
    if (t) t.term.focus();
  }

  function toggle() { if (panel) closePanel(); else open(); }

  // Focus outside a terminal (the tab bar, say): the shortcut still opens it.
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || panel) return;
    if (actionFor(e) === 'openSettings') { e.preventDefault(); open(); }
  });

  // The "Settings…" row at the foot of the tab's right-click menu.
  function menuItem(onPick) {
    const row = el('div', 'open-settings');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.append(el('span', '', 'Settings…'), el('span', 'keys', shortcut('openSettings') || ''));
    const pick = () => { if (onPick) onPick(); open(); };
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    return row;
  }

  window.LimpetSettings = {
    get, termOptions, actionFor, runAction, makePredictor, selectionChanged, menuItem,
    open, close: closePanel, isOpen: () => !!panel,
  };
})();
