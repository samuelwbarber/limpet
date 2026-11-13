// Persist only local directories and labels, never terminal output or commands.
const fs = require('fs');
const path = require('path');
function cleanTabs(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).filter((t) => t && typeof t.cwd === 'string' && path.isAbsolute(t.cwd) && !t.cwd.includes('\0'))
    .map((t) => ({ cwd: t.cwd, title: typeof t.title === 'string' ? t.title.slice(0, 200) : 'limpet' }));
}
function read(file) {
  try { return cleanTabs(JSON.parse(fs.readFileSync(file, 'utf8')).tabs); } catch (_) { return []; }
}
function write(file, tabs) {
  const temporary = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, tabs: cleanTabs(tabs) }), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function directory(cwd, fallback) {
  try { if (typeof cwd === 'string' && path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory()) return cwd; } catch (_) {}
  return fallback;
}
module.exports = { cleanTabs, read, write, directory };
