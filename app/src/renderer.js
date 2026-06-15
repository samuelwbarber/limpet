// Renderer: xterm.js wired to the shell, plus drag-drop that "pastes" files
// into whatever session is in front (local or an ssh you started with xssh).
/* global Terminal, FitAddon */

const term = new Terminal({
  fontFamily: "'Cascadia Mono', Consolas, monospace",
  fontSize: 14,
  cursorBlink: true,
  allowProposedApi: true,
  theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b70' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
try { term.loadAddon(new ImageAddon.ImageAddon()); } catch (e) { console.error('[winux] image addon failed:', e); }
fit.fit();
term.focus();

window.winux.onData((d) => term.write(d));
term.onData((d) => window.winux.sendInput(d));

function syncSize() { fit.fit(); window.winux.resize(term.cols, term.rows); }
window.addEventListener('resize', syncSize);
setTimeout(syncSize, 120);

// ---- copy / paste ----
function copySelection() {
  const sel = term.getSelection();
  if (sel) { window.winux.clipboardCopy(sel); term.clearSelection(); }
}
function pasteClipboard() {
  window.winux.clipboardPaste().then((t) => { if (t) window.winux.sendInput(t); });
}

// Ctrl+Shift+C / Ctrl+Shift+V, and Ctrl+C copies when there's a selection
// (otherwise it falls through as the usual interrupt).
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && e.shiftKey && k === 'c') { copySelection(); return false; }
  if (e.ctrlKey && e.shiftKey && k === 'v') { pasteClipboard(); return false; }
  if (e.ctrlKey && !e.shiftKey && k === 'c' && term.hasSelection()) { copySelection(); return false; }
  return true;
});

// Right-click: copy if there's a selection, else paste.
document.getElementById('term').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (term.hasSelection()) copySelection();
  else pasteClipboard();
});

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
  if (paths.length) await window.winux.dropFiles(paths);
  term.focus();
});
