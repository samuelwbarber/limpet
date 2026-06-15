// Renderer: xterm.js wired to the PTY in the main process.
/* global Terminal, FitAddon */

const term = new Terminal({
  fontFamily: "'Cascadia Mono', Consolas, monospace",
  fontSize: 14,
  cursorBlink: true,
  allowProposedApi: true,
  theme: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selectionBackground: '#585b70',
  },
});

const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
fit.fit();
term.focus();

window.winux.onData((d) => term.write(d));
window.winux.onExit(() => term.write('\r\n\x1b[90m[winux] session ended.\x1b[0m\r\n'));
window.winux.onMode((m) => {
  document.getElementById('badge').textContent = 'winux • ' + m;
});

term.onData((d) => window.winux.sendInput(d));

function syncSize() {
  fit.fit();
  window.winux.resize(term.cols, term.rows);
}
window.addEventListener('resize', syncSize);
// Fit once the webview has settled.
setTimeout(syncSize, 120);
