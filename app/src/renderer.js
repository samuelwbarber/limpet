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
  try { term.loadAddon(new ImageAddon.ImageAddon()); } catch (e) { console.error('[limpet] image addon failed:', e); }

  term.onData((d) => window.limpet.sendInput(id, d));
  term.onTitleChange((t) => { if (t) { titleEl.textContent = t; titleEl.title = t; } });
  term.attachCustomKeyEventHandler((e) => handleKeys(e, id, term));
  // Right-click: copy if there's a selection, else paste.
  pane.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) copySelection(term);
    else pasteClipboard(id);
  });

  tabs.set(id, { term, fit, pane, tabEl, titleEl });
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
  t.term.dispose();
  t.pane.remove();
  t.tabEl.remove();
  if (!tabs.size) { window.close(); return; }
  if (activeId === id) activate(order[idx + 1] ?? order[idx - 1]);
}

window.limpet.onData(({ id, data }) => { const t = tabs.get(id); if (t) t.term.write(data); });
// The shell exited on its own (`exit`, crash): the tab goes with it.
window.limpet.onExit(({ id }) => removeTab(id));

function syncSize() {
  const t = tabs.get(activeId);
  if (!t) return;
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
function copySelection(term) {
  const sel = term.getSelection();
  if (sel) { window.limpet.clipboardCopy(sel); term.clearSelection(); }
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
  if (e.ctrlKey && !e.shiftKey && k === 'c' && term.hasSelection()) { copySelection(term); return false; }
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
