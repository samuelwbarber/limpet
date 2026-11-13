const fs = require('fs');
const path = require('path');

// Presence checks only: do not execute CLIs, read credentials, or install tools.
function setupInfo({ env = process.env, platform = process.platform, stat = fs.statSync } = {}) {
  const win = platform === 'win32';
  const paths = String(env.PATH || env.Path || '').split(win ? ';' : ':').filter(Boolean);
  const extensions = win ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  const join = win ? path.win32.join : path.posix.join;
  const present = (name) => paths.some((dir) => extensions.some((ext) => {
    try { const entry = stat(join(dir.replace(/^"|"$/g, ''), name + ext)); return entry.isFile() && (win || !!(entry.mode & 0o111)); }
    catch (_) { return false; }
  }));
  return {
    platform,
    tools: ['ssh', 'scp', 'claude', 'codex', 'copilot', 'agy', 'opencode'].map((name) => ({ name, present: present(name) })),
  };
}

module.exports = { setupInfo };
