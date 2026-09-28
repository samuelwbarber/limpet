// What the agents on this machine are doing, for the tab menu's "which chat is
// this tab on": the process tree, the Codex threads, Copilot chats and
// Antigravity conversations open right now and which process has each, and
// the notes the shell's account wrappers leave. Pure reads, no Electron;
// main.js supplies where to look and accounts.js decides. Agent homes are
// given as [{ cmd, home }] (codex -> ~/.codex, copilot1 -> ~/.copilot-1, ...).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const realPath = (p) => { try { return fs.realpathSync.native(p); } catch (_) { return null; } };

function readFirstJsonLine(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const s = buf.toString('utf8', 0, n);
    const nl = s.indexOf('\n');
    return JSON.parse(nl === -1 ? s : s.slice(0, nl));
  } catch (_) { return null; }
}

const listDir = (dir) => { try { return fs.readdirSync(dir); } catch (_) { return []; } };

// One of each distinct <codex home>/<name> folder: [{ dir, cmd }]. Homes whose
// folder is the same place (junctioned together) share one entry, with cmd ''
// since the folder no longer says which account is using it.
function codexFolders(homes, name) {
  const folders = new Map(); // real folder -> { dir, cmds }
  for (const { cmd, home } of homes) {
    const folder = path.join(home, name);
    const real = realPath(folder);
    if (!real) continue;
    const key = real.toLowerCase();
    if (folders.has(key)) folders.get(key).cmds.push(cmd);
    else folders.set(key, { dir: folder, cmds: [cmd] });
  }
  return [...folders.values()].map(({ dir, cmds }) => ({ dir, cmd: cmds.length === 1 ? cmds[0] : '' }));
}

// Every rollout file under the homes' sessions folders
// (<folder>/YYYY/MM/DD/rollout-*.jsonl), as { cmd, path, name }.
function codexRolloutFiles(homes) {
  const out = [];
  const walk = (cmd, dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(cmd, p, depth + 1); continue; }
      if (/^rollout-.*\.jsonl$/i.test(e.name)) out.push({ cmd, path: p, name: e.name });
    }
  };
  for (const { dir, cmd } of codexFolders(homes, 'sessions')) walk(cmd, dir, 0);
  return out;
}

// What a rollout's first line (its session_meta) says: { cmd, id, path, cwd,
// mtimeMs, subagent }. A sub-agent's thread is one a Codex chat spawned for
// itself; it runs inside its parent's process and is never what a tab is on.
function codexRollout({ cmd, path: p, name }, st) {
  const fromName = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name);
  const meta = readFirstJsonLine(p);
  const payload = meta && meta.type === 'session_meta' && meta.payload ? meta.payload : {};
  const subagent = payload.thread_source === 'subagent' || !!(payload.source && typeof payload.source === 'object' && payload.source.subagent);
  return { cmd, id: payload.id || (fromName ? fromName[1] : ''), path: p, cwd: payload.cwd || '', mtimeMs: st ? st.mtimeMs : 0, subagent };
}

// Codex rollouts written since `sinceMs` (see codexRollout). Only files
// touched recently are read.
function listCodexRollouts(homes, sinceMs) {
  const out = [];
  for (const file of codexRolloutFiles(homes)) {
    let st;
    try { st = fs.statSync(file.path); } catch (_) { continue; }
    if (st.mtimeMs >= sinceMs) out.push(codexRollout(file, st));
  }
  return out;
}

// The threads some Codex has open right now, sub-agents left out: Codex holds
// thread-writer-locks/<thread>.lock open while a thread is loaded and deletes
// it after. [{ ...codexRollout, lock }], cmd being the account whose lock
// folder it is ('' when the homes share one).
function listCodexWriters(homes) {
  const locks = [];
  for (const { dir, cmd } of codexFolders(homes, 'thread-writer-locks')) {
    for (const name of listDir(dir)) {
      const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i.exec(name);
      if (m) locks.push({ id: m[1].toLowerCase(), cmd, lock: path.join(dir, name) });
    }
  }
  if (!locks.length) return [];
  const files = new Map();
  for (const file of codexRolloutFiles(homes)) {
    const m = /([0-9a-f-]{36})\.jsonl$/i.exec(file.name);
    if (m) files.set(m[1].toLowerCase(), file);
  }
  const out = [];
  for (const { id, cmd, lock } of locks) {
    const file = files.get(id);
    if (!file) continue;
    let st = null;
    try { st = fs.statSync(file.path); } catch (_) { /* gone */ }
    const rollout = codexRollout(file, st);
    if (!rollout.subagent) out.push({ ...rollout, cmd, lock });
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; } };

// The Copilot chats some process has open right now: Copilot marks a chat's
// folder (<home>/session-state/<id>) with inuse.<pid>.lock while a process
// has it. [{ cmd, id, path, cwd, mtimeMs, pids }], path being its
// events.jsonl and cmd the account whose folder it is ('' when shared).
function listCopilotChats(homes) {
  const out = [];
  for (const { dir, cmd } of codexFolders(homes, 'session-state')) {
    for (const id of listDir(dir)) {
      if (!UUID.test(id)) continue;
      const chatDir = path.join(dir, id);
      const pids = listDir(chatDir).map((n) => /^inuse\.(\d+)\.lock$/.exec(n)).filter(Boolean).map((m) => Number(m[1]));
      if (!pids.length) continue;
      let cwd = '';
      try { const m = /^cwd:\s*(.+)$/m.exec(fs.readFileSync(path.join(chatDir, 'workspace.yaml'), 'utf8')); if (m) cwd = m[1].trim().replace(/^(['"])(.*)\1$/, '$2'); } catch (_) { /* none */ }
      const events = path.join(chatDir, 'events.jsonl');
      out.push({ cmd, id, path: events, cwd, mtimeMs: mtime(events), pids });
    }
  }
  return out;
}

// The Antigravity conversations that may be open right now: agy keeps each in
// <gemini>/antigravity-cli/conversations/<id>.db and holds it open (with a
// -wal beside it) while loaded; which process holds it is asked separately
// (fileHolders on `lock`). [{ id, lock, path, cwd, mtimeMs }], path being the
// readable transcript and cwd the workspace its prompts were typed in.
function listAgyConversations(geminiDir) {
  const root = path.join(geminiDir, 'antigravity-cli');
  const convDir = path.join(root, 'conversations');
  const ids = new Set();
  for (const name of listDir(convDir)) {
    const m = /^([0-9a-f-]{36})\.db-(wal|shm)$/i.exec(name);
    if (m && UUID.test(m[1])) ids.add(m[1]);
  }
  if (!ids.size) return [];
  const workspace = {};
  try {
    for (const line of fs.readFileSync(path.join(root, 'history.jsonl'), 'utf8').split('\n')) {
      try { const h = JSON.parse(line); if (h && ids.has(h.conversationId) && h.workspace) workspace[h.conversationId] = h.workspace; } catch (_) { /* skip */ }
    }
  } catch (_) { /* no history */ }
  return [...ids].map((id) => {
    const transcript = path.join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    const lock = path.join(convDir, `${id}.db`);
    return { cmd: '', id, lock, path: transcript, cwd: workspace[id] || '', mtimeMs: Math.max(mtime(`${lock}-wal`), mtime(transcript)) };
  });
}

// Which account's login agy has in Credential Manager now, as the shell notes
// it in ~/.agy/active (plain agy when there's no note).
function readAgyActive(agyActiveFile) {
  try { const cmd = fs.readFileSync(agyActiveFile, 'utf8').trim(); return /^agy([1-9]\d*)?$/.test(cmd) ? cmd : 'agy'; } catch (_) { return 'agy'; }
}

// Run a hidden PowerShell and hand back its stdout, or null if it couldn't
// start or took longer than `timeoutMs`. The exit code is left to the caller
// to judge by the output: a process that exits mid-listing makes
// Get-CimInstance report an error, and PowerShell exit 1, after a complete list.
function powershell(args, { env = process.env, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let ps;
    try { ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], { windowsHide: true, env }); }
    catch (_) { resolve(null); return; }
    const timer = setTimeout(() => { try { ps.kill(); } catch (_) { /* gone */ } finish(null); }, timeoutMs);
    let out = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('error', () => finish(null));
    ps.on('close', () => finish(out));
  });
}

// Which pids hold each of these files open: { path: [pid, ...] }, or null if
// that couldn't be found out. Asks the Windows Restart Manager through
// lock-holders.ps1 (about a second, the files asked about side by side).
async function fileHolders(paths) {
  if (!paths.length) return {};
  const out = await powershell(['-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'lock-holders.ps1')],
    { env: { ...process.env, LIMPET_LOCKS: JSON.stringify(paths) }, timeoutMs: 20000 });
  try {
    const map = JSON.parse(out);
    const holders = {};
    for (const p of paths) holders[p] = [].concat(map[p] || []).map(Number).filter(Number.isInteger);
    return holders;
  } catch (_) { return null; }
}

// pid, parent pid, name and start time of every process. Node has no
// parent-pid API on Windows, so ask CIM (about a second), fine for a right-click.
async function listProcesses() {
  const out = await powershell(['-Command',
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{n='Start';e={ if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 } }} | ConvertTo-Json -Compress"]);
  try {
    const rows = JSON.parse(out);
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, startedAt: Number(r.Start) || 0 }));
  } catch (_) { return []; }
}

// Which codex account each shell launched: the shell's codexN wrapper
// (Invoke-LimpetAgent in shell/Limpet.psm1) leaves <dir>/<shell pid>.json
// while it runs.
function readCodexLaunches(dir) {
  const out = [];
  for (const name of listDir(dir)) {
    if (!/^\d+\.json$/.test(name)) continue;
    let l = null;
    try { l = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (_) { continue; }
    if (l && Number.isInteger(l.pid) && typeof l.cmd === 'string') out.push({ pid: l.pid, cmd: l.cmd, startedAt: Number(l.startedAt) || 0 });
  }
  return out;
}

// Everything accounts.findSession needs to tell what runs under `shellPid`.
// The process list and the lock holders (Codex threads, agy conversations)
// are fetched side by side, since each takes about a second.
async function scanAgents({ shellPid, claudeSessionFiles = [], codexHomes = [], copilotHomes = [], geminiDir = '', agyActiveFile = '', runDir }) {
  const writers = listCodexWriters(codexHomes);
  const conversations = geminiDir ? listAgyConversations(geminiDir) : [];
  // A process list without the tab's own shell in it is a failed listing
  // (CIM does fail now and then); one more try before concluding anything.
  const processes = async () => {
    const first = await listProcesses();
    return first.some((p) => p.pid === shellPid) ? first : listProcesses();
  };
  const [procs, holders] = await Promise.all([processes(), fileHolders([...writers, ...conversations].map((w) => w.lock))]);
  const shell = procs.find((p) => p.pid === shellPid);
  const since = shell && shell.startedAt ? shell.startedAt - 5000 : Date.now() - 7 * 24 * 3600 * 1000;
  const withHolders = (list) => (holders ? list.map((w) => ({ ...w, pids: holders[w.lock] || [] })) : null);
  return {
    procs,
    input: {
      sessionFiles: claudeSessionFiles,
      rollouts: listCodexRollouts(codexHomes, since),
      launches: readCodexLaunches(runDir),
      writers: withHolders(writers),
      copilotChats: listCopilotChats(copilotHomes),
      agyConversations: withHolders(conversations) || conversations,
      agyActive: agyActiveFile ? readAgyActive(agyActiveFile) : 'agy',
    },
  };
}

module.exports = {
  realPath, readFirstJsonLine, codexFolders, codexRolloutFiles, codexRollout, listCodexRollouts, listCodexWriters,
  listCopilotChats, listAgyConversations, readAgyActive, fileHolders, listProcesses, readCodexLaunches, scanAgents,
};
