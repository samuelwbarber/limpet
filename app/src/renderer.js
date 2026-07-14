// Renderer: tabbed xterm.js sessions (one PTY each, Ctrl+Shift+T / Ctrl+Shift+W
// / Ctrl+Tab like Windows Terminal), plus drag-drop that "pastes" files into
// whatever session is in front (local or an ssh you started with xssh).
/* global Terminal, FitAddon, ImageAddon */

const termsEl = document.getElementById('terms');
const tabstrip = document.getElementById('tabstrip');
const tabs = new Map(); // id -> { term, fit, pane, tabEl, titleEl }
let activeId = null;

const tabOrder = () => Array.from(tabs.keys());

async function newTab() {
  const id = await window.limpet.createSession();

  const pane = document.createElement('div');
  pane.className = 'term-pane';
  termsEl.appendChild(pane);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  const titleEl = document.createElement('span');
  titleEl.className = 'title';
  titleEl.textContent = 'limpet';
  const closeEl = document.createElement('button');
  closeEl.className = 'close';
  closeEl.textContent = '×';
  closeEl.title = 'Close tab (Ctrl+Shift+W)';
  closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
  tabEl.append(titleEl, closeEl);
  tabEl.addEventListener('mousedown', (e) => { if (e.target !== closeEl) activate(id); });
  // Middle-click closes, like every tabbed thing on earth.
  tabEl.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(id); });
  tabstrip.appendChild(tabEl);

  const term = new Terminal({
    fontFamily: "'Cascadia Mono', Consolas, monospace",
    fontSize: 14,
    cursorBlink: true,
    allowProposedApi: true,
    theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b70' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  // Ctrl+C should reliably copy a selection even when a repaint or a burst of
  // fresh output clears it in the split second before the keypress -- which is
  // common in full-screen TUIs and while output streams, and is why Ctrl+C
  // "doesn't always copy". Remember the most recent non-empty selection; Ctrl+C
  // falls back to it for a brief window (see copySelection). Any typed input
  // clears it, so a plain Ctrl+C with nothing freshly selected still interrupts.
  term._selCache = { text: '', at: 0 };
  term.onSelectionChange(() => {
    const s = term.getSelection();
    if (s) term._selCache = { text: s, at: Date.now() };
  });
  let img = null;
  try { img = new ImageAddon.ImageAddon(); term.loadAddon(img); } catch (e) { console.error('[limpet] image addon failed:', e); }

  // Predictive local echo: draw typed characters immediately (in red) and let
  // the server's echo confirm them, so a laggy ssh link stops feeling laggy.
  // Adaptive + self-gating, so on a fast link or a no-echo prompt it does
  // nothing. See predict.js.
  let predict = null;
  try {
    const screenEl = pane.querySelector('.xterm-screen');
    if (window.Predict && screenEl) predict = window.Predict.create(term, screenEl);
  } catch (e) { console.error('[limpet] predictor failed:', e); }

  term.onData((d) => { if (predict) predict.onKey(d); term._selCache = { text: '', at: 0 }; window.limpet.sendInput(id, d); });
  // Server output landed and xterm repainted: confirm/settle predictions.
  if (predict) {
    term.onRender(() => predict.reconcile());
    // Scrolling invalidates the row-based overlay positions; just drop them.
    term.onScroll(() => predict.flush());
  }
  term.onTitleChange((t) => { if (t) { titleEl.textContent = t; titleEl.title = t; } });
  term.attachCustomKeyEventHandler((e) => handleKeys(e, id, term));
  // Right-click: copy if there's a selection, else paste.
  pane.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) copySelection(term);
    else pasteClipboard(id);
  });

  const tab = { term, fit, pane, tabEl, titleEl, img, predict, peeks: [], splitBusy: false, splitPending: [], peekTimer: null };
  tabs.set(id, tab);
  // A resize makes ConPTY repaint the viewport and wipe peek images; redraw
  // them once the repaint settles.
  term.onResize(() => schedulePeekRedraw(tab));
  activate(id);
}

function activate(id) {
  if (!tabs.has(id)) return;
  activeId = id;
  for (const [tid, t] of tabs) {
    t.pane.classList.toggle('active', tid === id);
    t.tabEl.classList.toggle('active', tid === id);
  }
  // Fit only once the pane is display:block — a hidden terminal measures 0x0.
  requestAnimationFrame(() => { syncSize(); const t = tabs.get(id); if (t) t.term.focus(); });
}

// Close from the UI: kill the PTY, then tear down the tab.
function closeTab(id) {
  if (!tabs.has(id)) return;
  window.limpet.closeSession(id);
  removeTab(id);
}

function removeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  const order = tabOrder();
  const idx = order.indexOf(id);
  tabs.delete(id);
  if (t.predict) t.predict.dispose();
  t.term.dispose();
  t.pane.remove();
  t.tabEl.remove();
  if (!tabs.size) { window.close(); return; }
  if (activeId === id) activate(order[idx + 1] ?? order[idx - 1]);
}

window.limpet.onData(({ id, data }) => { const t = tabs.get(id); if (t) writeData(t, data); });
// The shell exited on its own (`exit`, crash): the tab goes with it.
window.limpet.onExit(({ id }) => removeTab(id));

// ---- peek images vs. window resize ----
// Resizing makes ConPTY repaint the viewport from its own buffer, which holds
// only the blank rows peek reserved -- the repaint blanks the image cells and
// the addon drops the image. So remember each peek sequence with a marker at
// the row it was drawn on, and once a resize's repaint settles, redraw any
// image whose reserved rows are back to blank.
const PEEK_PREFIX = '\x1b]1337;File=inline=1;size=';
const MAX_PEEKS = 8;

function writeData(t, data) {
  if (t.splitBusy) { t.splitPending.push(data); return; }
  if (t.peekTimer) schedulePeekRedraw(t); // repaint still streaming: re-arm the timer
  const i = data.indexOf(PEEK_PREFIX);
  const end = i === -1 ? -1 : data.indexOf('\x07', i);
  if (end === -1) { t.term.write(data); return; }
  // main.js emits a peek sequence whole, so BEL is always in the same chunk.
  const seq = data.slice(i, end + 1);
  t.splitBusy = true;
  t.term.write(data.slice(0, i), () => {
    const marker = t.term.registerMarker(0);
    if (marker) {
      t.peeks.push({ marker, seq, rows: parseInt((/;height=(\d+)/.exec(seq) || [])[1], 10) || 1 });
      while (t.peeks.length > MAX_PEEKS) t.peeks.shift().marker.dispose();
    }
    t.term.write(seq, () => {
      t.splitBusy = false;
      const q = t.splitPending.splice(0);
      const rest = data.slice(end + 1);
      if (rest) q.unshift(rest);
      for (const d of q) writeData(t, d);
    });
  });
}

function schedulePeekRedraw(t) {
  clearTimeout(t.peekTimer);
  t.peekTimer = setTimeout(() => { t.peekTimer = null; redrawPeeks(t); }, 350);
}

function redrawPeeks(t) {
  t.peeks = t.peeks.filter((p) => !p.marker.isDisposed);
  if (!t.peeks.length || !t.img || t.term.buffer.active.type === 'alternate') return;
  const buf = t.term.buffer.active;
  let out = '';
  for (const p of t.peeks) {
    const row = p.marker.line - buf.baseY; // 0-based row on the addressable screen
    if (row < 0 || row + p.rows > t.term.rows) continue; // in scrollback (survived) or no room
    if (t.img.getImageAtBufferCell(0, p.marker.line) &&
        t.img.getImageAtBufferCell(0, p.marker.line + p.rows - 1)) continue; // still intact
    if (!rowsBlank(buf, p.marker.line, p.rows)) continue; // something else drew there
    out += `\x1b[${row + 1};1H${p.seq}`;
  }
  if (out) t.term.write(`\x1b[?25l${out}\x1b[${buf.cursorY + 1};${buf.cursorX + 1}H\x1b[?25h`);
}

function rowsBlank(buf, line, rows) {
  for (let i = 0; i < rows; i++) {
    const l = buf.getLine(line + i);
    if (!l || l.translateToString(true).trim() !== '') return false;
  }
  return true;
}

function syncSize() {
  const t = tabs.get(activeId);
  if (!t) return;
  if (t.predict) t.predict.flush();  // reflow moves cells -> drop stale overlay glyphs
  t.fit.fit();
  window.limpet.resize(activeId, t.term.cols, t.term.rows);
}
window.addEventListener('resize', syncSize);

// ---- reels: dock a webpage (default: Instagram reels) on the right ----
const DEFAULT_REELS = 'https://www.instagram.com/reels/';
const reelsView = document.getElementById('reels-view');

// The page is tidied by the main process (see REELS_TIDY in main.js), injected
// via executeJavaScript on the webview after each load.

window.limpet.onReels((url) => {
  const panel = document.getElementById('reels');
  const view = reelsView;
  if (url) {
    // explicit `reels <url>` -> always show and navigate there
    if (view.getAttribute('src') !== url) view.setAttribute('src', url);
    panel.classList.add('show');
  } else {
    // bare `reels` -> toggle; lazy-load the default feed the first time
    panel.classList.toggle('show');
    if (panel.classList.contains('show') && !view.getAttribute('src')) {
      view.setAttribute('src', DEFAULT_REELS);
    }
  }
  // the terminal's width just changed; re-fit so nothing gets clipped
  setTimeout(() => { syncSize(); const t = tabs.get(activeId); if (t) t.term.focus(); }, 60);
});

// ---- copy / paste ----
// Copy the current selection, or -- if it was just cleared by a repaint/output
// in the moment before the keypress -- the cached one (nobody selects text a
// fraction of a second before deliberately hitting Ctrl+C to interrupt, so this
// window is short enough not to swallow a real SIGINT). Returns whether it
// copied, so Ctrl+C knows whether to still send the interrupt.
const SEL_FALLBACK_MS = 500;
function copySelection(term) {
  let sel = term.getSelection();
  const cache = term._selCache;
  if (!sel && cache && cache.text && Date.now() - cache.at < SEL_FALLBACK_MS) sel = cache.text;
  if (sel) {
    window.limpet.clipboardCopy(sel);
    term.clearSelection();
    term._selCache = { text: '', at: 0 };
    return true;
  }
  return false;
}
function pasteClipboard(id) {
  window.limpet.clipboardPaste().then((t) => { if (t) window.limpet.sendInput(id, t); });
}

// Ctrl+Shift+C / Ctrl+Shift+V, Ctrl+C copies when there's a selection
// (otherwise it falls through as the usual interrupt), and the tab shortcuts.
function handleKeys(e, id, term) {
  if (e.type !== 'keydown') return true;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && e.shiftKey && k === 't') { newTab(); return false; }
  if (e.ctrlKey && e.shiftKey && k === 'w') { closeTab(id); return false; }
  if (e.ctrlKey && k === 'tab') { cycleTabs(e.shiftKey ? -1 : 1); return false; }
  if (e.ctrlKey && e.shiftKey && k === 'c') { copySelection(term); return false; }
  if (e.ctrlKey && e.shiftKey && k === 'v') { pasteClipboard(id); return false; }
  // Ctrl+C: copy if something is (or was just) selected, otherwise let it through
  // as the usual interrupt.
  if (e.ctrlKey && !e.shiftKey && k === 'c') { if (copySelection(term)) return false; }
  return true;
}

function cycleTabs(dir) {
  const order = tabOrder();
  if (order.length < 2) return;
  const i = order.indexOf(activeId);
  activate(order[(i + dir + order.length) % order.length]);
}

document.getElementById('newtab').addEventListener('click', () => newTab());

// ---- drag-drop: paste files into the current session ----
const dropEl = document.getElementById('drop');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropEl.classList.add('show'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; dropEl.classList.remove('show'); } });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropEl.classList.remove('show');
  const paths = Array.from(e.dataTransfer.files).map((f) => f.path).filter(Boolean);
  if (paths.length && activeId !== null) await window.limpet.dropFiles(activeId, paths);
  const t = tabs.get(activeId);
  if (t) t.term.focus();
});

newTab();
setTimeout(syncSize, 120);
