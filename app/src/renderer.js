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
fit.fit();
term.focus();

window.winux.onData((d) => term.write(d));
term.onData((d) => window.winux.sendInput(d));

function syncSize() { fit.fit(); window.winux.resize(term.cols, term.rows); }
window.addEventListener('resize', syncSize);
setTimeout(syncSize, 120);

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
