// Renderer: xterm.js wired to the active session, plus the SSH connect bar and
// drag-drop upload.
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

const statusEl = document.getElementById('status');
const hostEl = document.getElementById('host');
const portEl = document.getElementById('port');
const connectBtn = document.getElementById('connect');
const dropEl = document.getElementById('drop');

let active = { type: 'local', host: null, cwd: null };

// ---- terminal stream ----
window.winux.onData((d) => term.write(d));
window.winux.onReset(() => term.reset());
term.onData((d) => window.winux.sendInput(d));

function syncSize() { fit.fit(); window.winux.resize(term.cols, term.rows); }
window.addEventListener('resize', syncSize);
setTimeout(syncSize, 120);

// ---- session state / status bar ----
function renderStatus() {
  if (active.type === 'ssh') {
    const where = active.cwd ? `${active.host}:${active.cwd}` : `${active.host}`;
    statusEl.textContent = `● ${where}  (drag files to upload)`;
    connectBtn.textContent = 'Disconnect';
  } else {
    statusEl.textContent = 'local';
    connectBtn.textContent = 'Connect';
  }
}
window.winux.onActive((p) => { active = p; renderStatus(); term.focus(); });
window.winux.onCwd((p) => { if (active.type === 'ssh') { active.cwd = p.cwd; renderStatus(); } });
window.winux.onEnded(() => { active = { type: 'local', host: null, cwd: null }; renderStatus(); });

connectBtn.addEventListener('click', () => {
  if (active.type === 'ssh') { window.winux.sshDisconnect(); return; }
  const raw = hostEl.value.trim();
  if (!raw) { hostEl.focus(); return; }
  let username = 'root', host = raw;
  if (raw.includes('@')) { [username, host] = raw.split('@'); }
  const port = parseInt(portEl.value, 10) || 22;
  window.winux.sshConnect({ username, host, port });
});
hostEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') connectBtn.click(); });

// ---- drag-drop upload ----
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (active.type === 'ssh') { dragDepth++; dropEl.classList.add('show'); }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; dropEl.classList.remove('show'); }
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0; dropEl.classList.remove('show');
  const paths = Array.from(e.dataTransfer.files).map((f) => f.path).filter(Boolean);
  if (!paths.length) return;
  if (active.type !== 'ssh') {
    term.write('\r\n\x1b[33m[winux] connect to an SSH host first to upload files.\x1b[0m\r\n');
    return;
  }
  await window.winux.sshUpload(paths);
});
