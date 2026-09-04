// Renderer: tabbed xterm.js sessions (one PTY each, Ctrl+Shift+T / Ctrl+Shift+W
// / Ctrl+Tab like Windows Terminal), plus drag-drop that "pastes" files into
// whatever session is in front (local or an ssh you started with xssh).
/* global Terminal, FitAddon, ImageAddon, WebLinksAddon */

const termsEl = document.getElementById('terms');
const tabstrip = document.getElementById('tabstrip');
const tabs = new Map(); // id -> { term, fit, pane, tabEl, titleEl }
let activeId = null;

const tabOrder = () => Array.from(tabs.keys());

async function newTab(existingId = null, initialTitle = 'limpet') {
  const id = existingId ?? await window.limpet.createSession();

  const pane = document.createElement('div');
  pane.className = 'term-pane';
  termsEl.appendChild(pane);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.draggable = true;
  tabEl.dataset.sessionId = String(id);
  tabEl.title = 'Drag outside this window to detach';
  const titleEl = document.createElement('span');
  titleEl.className = 'title';
  titleEl.textContent = initialTitle || 'limpet';
  const closeEl = document.createElement('button');
  closeEl.className = 'close';
  closeEl.draggable = false;
  closeEl.textContent = '×';
  closeEl.title = 'Close tab (Ctrl+Shift+W)';
  closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
  tabEl.append(titleEl, closeEl);
  tabEl.addEventListener('mousedown', (e) => { if (e.target !== closeEl) activate(id); });
  // Middle-click closes, like every tabbed thing on earth.
  tabEl.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(id); });
  // Right-click: pick which Claude account this tab's chat runs under.
  tabEl.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showAccountMenu(id, tabEl); });
  let dragPoint = null;
  tabEl.addEventListener('dragstart', (e) => {
    if (e.target === closeEl) { e.preventDefault(); return; }
    activate(id);
    dragPoint = pointFromDrag(e);
    tabEl.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-limpet-tab', String(id));
    }
  });
  tabEl.addEventListener('drag', (e) => {
    const p = pointFromDrag(e);
    if (p) dragPoint = p;
  });
  tabEl.addEventListener('dragend', async (e) => {
    tabEl.classList.remove('dragging');
    const point = pointFromDrag(e) || dragPoint;
    dragPoint = null;
    if (!point || !outsideCurrentWindow(point) || !tabs.has(id)) return;
    const moved = await window.limpet.detachSession(id, {
      x: point.x, y: point.y, title: titleEl.textContent || 'limpet',
    });
    if (moved && tabs.has(id)) removeTab(id);
  });
  tabstrip.appendChild(tabEl);

  const term = new Terminal({
    fontFamily: "'Cascadia Mono', Consolas, monospace",
    fontSize: 14,
    cursorBlink: true,
    allowProposedApi: true,
    allowTransparency: true,
    theme: { background: 'rgba(30,30,46,0.25)', foreground: '#ffffff', cursor: '#f5e0dc', selectionBackground: '#585b70' },
    // OSC 8 hyperlinks (used by agent login flows) must leave Electron and use
    // the OS default browser.
    linkHandler: { activate: (_event, uri) => window.limpet.openExternal(uri) },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  try {
    term.loadAddon(new WebLinksAddon.WebLinksAddon((_event, uri) => window.limpet.openExternal(uri)));
  } catch (e) { console.error('[limpet] web links addon failed:', e); }
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

  const tab = {
    term, fit, pane, tabEl, titleEl, img, predict, peeks: [], splitBusy: false,
    splitPending: [], peekTimer: null, backdropTimer: null, backdropVersion: 0,
  };
  tabs.set(id, tab);
  applyBackground(tab, id);
  // A resize makes ConPTY repaint the viewport and wipe peek images; redraw
  // them once the repaint settles.
  term.onResize(() => schedulePeekRedraw(tab));
  activate(id);
  // PTY output is buffered by the main process until the xterm instance exists.
  // This is especially important while a live session moves between windows.
  const attached = await window.limpet.sessionReady(id);
  if (!attached && tabs.has(id)) removeTab(id);
}

function pointFromDrag(e) {
  if (!Number.isFinite(e.screenX) || !Number.isFinite(e.screenY)) return null;
  // Chromium sometimes reports 0,0 on the final drag event; keep the last real
  // point instead so cancelling a drag cannot fling a tab to the primary screen.
  if (e.screenX === 0 && e.screenY === 0) return null;
  return { x: e.screenX, y: e.screenY };
}

function outsideCurrentWindow({ x, y }) {
  return x < window.screenX || y < window.screenY ||
    x >= window.screenX + window.outerWidth || y >= window.screenY + window.outerHeight;
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
  clearTimeout(t.backdropTimer);
  if (t.predict) t.predict.dispose();
  t.term.dispose();
  t.pane.remove();
  t.tabEl.remove();
  if (!tabs.size) { window.close(); return; }
  if (activeId === id) activate(order[idx + 1] ?? order[idx - 1]);
}

window.limpet.onData(({ id, data }) => {
  const t = tabs.get(id);
  if (t) { writeData(t, data); scheduleBackdropCandidate(id, t); }
});
// The shell exited on its own (`exit`, crash): the tab goes with it.
window.limpet.onExit(({ id }) => removeTab(id));

// ---- local conversation backdrops ----
// Once output settles, send only the current xterm text snapshot to the main
// process. It stays local and is reduced to visual topics before generation.
const BACKDROP_IDLE_MS = 12000;
function terminalSnapshot(term) {
  const buf = term.buffer.active;
  const start = Math.max(0, buf.length - 180);
  const lines = [];
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n').slice(-24000);
}

function scheduleBackdropCandidate(id, tab) {
  if (backgroundPref().mode !== 'generative') return;
  clearTimeout(tab.backdropTimer);
  tab.backdropTimer = setTimeout(async () => {
    tab.backdropTimer = null;
    const result = await window.limpet.considerBackdrop(
      id,
      terminalSnapshot(tab.term),
      tab.titleEl.textContent || '',
    );
    if (result && result.status === 'queued') tab.tabEl.classList.add('generating');
  }, BACKDROP_IDLE_MS);
}

const PIXEL_BACKDROP_WIDTH = 160;
const PIXEL_BACKDROP_HEIGHT = 100;
const PIXEL_COLOR_STEP = 32;

function loadBackdropImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('generated backdrop could not be decoded'));
    image.src = dataUrl;
  });
}

async function pixelateBackdrop(dataUrl) {
  const image = await loadBackdropImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = PIXEL_BACKDROP_WIDTH;
  canvas.height = PIXEL_BACKDROP_HEIGHT;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return dataUrl;

  // Center-crop into the terminal's 16:10 aspect ratio, then reduce both the
  // spatial resolution and palette. The browser enlarges these real source
  // pixels with nearest-neighbour rendering; this is not a blur/filter effect.
  const sourceAspect = image.naturalWidth / image.naturalHeight;
  const targetAspect = PIXEL_BACKDROP_WIDTH / PIXEL_BACKDROP_HEIGHT;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = image.naturalWidth;
  let sourceHeight = image.naturalHeight;
  if (sourceAspect > targetAspect) {
    sourceWidth = image.naturalHeight * targetAspect;
    sourceX = (image.naturalWidth - sourceWidth) / 2;
  } else if (sourceAspect < targetAspect) {
    sourceHeight = image.naturalWidth / targetAspect;
    sourceY = (image.naturalHeight - sourceHeight) / 2;
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    image, sourceX, sourceY, sourceWidth, sourceHeight,
    0, 0, PIXEL_BACKDROP_WIDTH, PIXEL_BACKDROP_HEIGHT,
  );
  const pixels = context.getImageData(0, 0, PIXEL_BACKDROP_WIDTH, PIXEL_BACKDROP_HEIGHT);
  for (let i = 0; i < pixels.data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      pixels.data[i + channel] = Math.min(
        255,
        Math.round(pixels.data[i + channel] / PIXEL_COLOR_STEP) * PIXEL_COLOR_STEP,
      );
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

window.limpet.onBackdrop(async ({ id, dataUrl }) => {
  const tab = tabs.get(id);
  if (!tab || !dataUrl) return;
  const version = ++tab.backdropVersion;
  let displayedDataUrl = dataUrl;
  try { displayedDataUrl = await pixelateBackdrop(dataUrl); } catch (_) { /* raw image fallback */ }
  if (!tabs.has(id) || tab.backdropVersion !== version) return;
  tab.tabEl.classList.remove('generating');
  tab.backdropUrl = displayedDataUrl;
  if (backgroundPref().mode === 'generative') {
    tab.pane.style.backgroundImage = `url("${displayedDataUrl}")`;
    tab.pane.classList.add('has-backdrop');
  }
  tab.tabEl.title = 'Drag outside this window to detach';
});

window.limpet.onBackdropStatus(({ id, state, message }) => {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.tabEl.classList.toggle('generating', state === 'generating');
  if (state === 'error') tab.tabEl.title = `Local backdrop failed: ${message}`;
});

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
  window.limpet.clipboardPaste().then((text) => {
    const tab = tabs.get(id);
    // Let xterm normalize newlines and apply bracketed-paste mode. term.paste()
    // emits exactly one onData event, which is the sole path into the PTY.
    if (tab && text) tab.term.paste(text);
  });
}

function consumeKey(e) {
  // attachCustomKeyEventHandler's `false` only tells xterm not to handle the
  // key; it does not cancel Chromium's native copy/paste action.
  e.preventDefault();
  e.stopPropagation();
  return false;
}

// Ctrl+Shift+C / Ctrl+Shift+V, Ctrl+C copies when there's a selection
// (otherwise it falls through as the usual interrupt), and the tab shortcuts.
function handleKeys(e, id, term) {
  if (e.type !== 'keydown') return true;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && e.shiftKey && k === 't') { newTab(); return consumeKey(e); }
  if (e.ctrlKey && e.shiftKey && k === 'w') { closeTab(id); return consumeKey(e); }
  if (e.ctrlKey && k === 'tab') { cycleTabs(e.shiftKey ? -1 : 1); return consumeKey(e); }
  if (e.ctrlKey && e.shiftKey && k === 'c') { copySelection(term); return consumeKey(e); }
  if (e.ctrlKey && k === 'v') { pasteClipboard(id); return consumeKey(e); }
  // Ctrl+C: copy if something is (or was just) selected, otherwise let it through
  // as the usual interrupt.
  if (e.ctrlKey && !e.shiftKey && k === 'c') { if (copySelection(term)) return consumeKey(e); }
  return true;
}

function cycleTabs(dir) {
  const order = tabOrder();
  if (order.length < 2) return;
  const i = order.indexOf(activeId);
  activate(order[(i + dir + order.length) % order.length]);
}

document.getElementById('newtab').addEventListener('click', () => newTab());

// ---- terminal background ----
// A plain colour (the standard limpet one by default) or the generative
// backdrop drawn from what each tab is working on. Picked from the tab menu,
// applied to every tab, remembered across launches.
const BACKGROUNDS = [
  { name: 'Limpet', color: '#1e1e2e' },
  { name: 'Blue', color: '#16294d' },
  { name: 'Black', color: '#000000' },
  { name: 'Slate', color: '#2a2d3a' },
  { name: 'Forest', color: '#14291f' },
  { name: 'Plum', color: '#2b1b36' },
  { name: 'Ocean', color: '#0f2a33' },
];
const DEFAULT_BACKGROUND = { mode: 'color', color: BACKGROUNDS[0].color };
let backgroundCache = null;

function backgroundPref() {
  if (backgroundCache) return backgroundCache;
  try {
    const saved = JSON.parse(localStorage.getItem('limpet.background') || 'null');
    if (saved && saved.mode === 'generative') backgroundCache = { mode: 'generative' };
    else if (saved && saved.mode === 'color' && BACKGROUNDS.some((b) => b.color === saved.color)) backgroundCache = { mode: 'color', color: saved.color };
  } catch (_) { /* storage unavailable: use the default */ }
  if (!backgroundCache) backgroundCache = { ...DEFAULT_BACKGROUND };
  return backgroundCache;
}

function setBackground(pref) {
  backgroundCache = pref;
  try { localStorage.setItem('limpet.background', JSON.stringify(pref)); } catch (_) { /* not remembered, still applied */ }
  for (const [id, t] of tabs) applyBackground(t, id);
}

function applyBackground(tab, id) {
  const pref = backgroundPref();
  if (pref.mode === 'color') {
    clearTimeout(tab.backdropTimer);
    tab.backdropTimer = null;
    tab.pane.style.backgroundImage = '';
    tab.pane.style.backgroundColor = pref.color;
    tab.pane.classList.remove('has-backdrop');
    tab.tabEl.classList.remove('generating');
    return;
  }
  tab.pane.style.backgroundColor = '';
  if (tab.backdropUrl) {
    tab.pane.style.backgroundImage = `url("${tab.backdropUrl}")`;
    tab.pane.classList.add('has-backdrop');
  } else if (id !== undefined) {
    scheduleBackdropCandidate(id, tab);
  }
}

// ---- Claude account menu: right-click a tab ----
// Lists the limpet Claude accounts (claude / claude1 / claude2), marks the one
// whose Claude Code is running under this tab's shell, and on a pick asks the
// main process to move the chat: exit that Claude and `--resume` the same
// session under the other login. Session history is shared between the
// accounts (see README), so the whole conversation comes across.
let accountMenu = null;

function closeAccountMenu() {
  if (!accountMenu) return;
  accountMenu.remove();
  accountMenu = null;
}
document.addEventListener('mousedown', (e) => { if (accountMenu && !accountMenu.contains(e.target)) closeAccountMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAccountMenu(); }, true);
window.addEventListener('blur', closeAccountMenu);

async function showAccountMenu(id, tabEl) {
  closeAccountMenu();
  const menu = document.createElement('div');
  menu.className = 'account-menu';
  menu.dataset.sessionId = String(id);
  const r = tabEl.getBoundingClientRect();
  menu.style.left = `${Math.round(r.left)}px`;
  menu.style.top = `${Math.round(r.bottom + 2)}px`;
  const head = document.createElement('div');
  head.className = 'head';
  head.textContent = 'Claude account · looking for a session…';
  menu.appendChild(head);
  document.body.appendChild(menu);
  accountMenu = menu;

  const items = new Map();
  for (const a of await window.limpet.claudeAccounts(id)) {
    if (accountMenu !== menu) return;
    const item = document.createElement('div');
    item.className = 'item';
    item.dataset.cmd = a.cmd;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = a.cmd;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = a.email || (a.loggedIn ? 'signed in' : 'not signed in');
    item.append(name, who);
    item.addEventListener('click', () => pickAccount(id, a.cmd, menu));
    menu.appendChild(item);
    items.set(a.cmd, item);
  }

  // Background: colour swatches, or the generative backdrop.
  const bg = document.createElement('div');
  bg.className = 'bg';
  const bgLabel = document.createElement('span');
  bgLabel.className = 'label';
  bgLabel.textContent = 'Background';
  bg.appendChild(bgLabel);
  const pref = backgroundPref();
  for (const b of BACKGROUNDS) {
    const swatch = document.createElement('button');
    swatch.className = 'swatch';
    swatch.style.backgroundColor = b.color;
    swatch.title = b.name;
    swatch.dataset.color = b.color;
    if (pref.mode === 'color' && pref.color === b.color) swatch.classList.add('selected');
    swatch.addEventListener('click', () => { setBackground({ mode: 'color', color: b.color }); closeAccountMenu(); });
    bg.appendChild(swatch);
  }
  const gen = document.createElement('button');
  gen.className = 'gen';
  gen.textContent = 'Generative';
  gen.title = 'A local AI image of whatever each tab is working on';
  if (pref.mode === 'generative') gen.classList.add('selected');
  gen.addEventListener('click', () => { setBackground({ mode: 'generative' }); closeAccountMenu(); });
  bg.appendChild(gen);
  menu.appendChild(bg);

  // Finding the session walks the process tree (about a second); the list is
  // usable meanwhile.
  const current = await window.limpet.claudeSession(id);
  if (accountMenu !== menu) return;
  menu.dataset.current = current ? current.cmd : '';
  if (current) {
    head.textContent = `Chat is on ${current.cmd}${current.status ? ` (${current.status})` : ''} · pick another to move it`;
    const item = items.get(current.cmd);
    if (item) item.classList.add('current');
  } else {
    head.textContent = 'No Claude session in this tab · pick an account to start one';
  }
}

async function pickAccount(id, cmd, menu) {
  if (menu.classList.contains('busy')) return;
  if (menu.dataset.current === cmd) { closeAccountMenu(); return; }
  menu.classList.add('busy');
  menu.querySelector('.head').textContent = `Moving this chat to ${cmd}…`;
  try {
    await window.limpet.claudeSwitch(id, cmd); // problems are reported in the terminal
  } finally {
    if (accountMenu === menu) closeAccountMenu();
    const t = tabs.get(id);
    if (t) t.term.focus();
  }
}

// ---- drag-drop: paste files into the current session ----
const dropEl = document.getElementById('drop');
let dragDepth = 0;
const isFileDrag = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault(); dragDepth++; dropEl.classList.add('show');
});
window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; dropEl.classList.remove('show'); }
});
window.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropEl.classList.remove('show');
  const paths = Array.from(e.dataTransfer.files).map((f) => f.path).filter(Boolean);
  if (paths.length && activeId !== null) await window.limpet.dropFiles(activeId, paths);
  const t = tabs.get(activeId);
  if (t) t.term.focus();
});

const launchParams = new URLSearchParams(window.location.search);
const detachedId = Number(launchParams.get('session'));
if (Number.isInteger(detachedId) && detachedId > 0) {
  newTab(detachedId, launchParams.get('title') || 'limpet');
} else {
  newTab();
}
setTimeout(syncSize, 120);
