// Ask the Codex CLI to import one Claude Code transcript as a Codex thread,
// using Codex's own external-agent importer over its app-server JSON-RPC
// (newline-delimited over stdio): initialize -> externalAgentConfig/detect,
// narrow the SESSIONS item to the one transcript, externalAgentConfig/import,
// then wait for the .../import/completed notification carrying the new thread
// id. A transcript Codex has already imported unchanged is not detected
// again; then the thread id comes from Codex's own import record
// (~/.codex/external_agent_session_imports.json), provided that thread still
// exists. No Electron dependencies; unit tested against a fake app-server in
// tests/codex-import.test.js.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_COMMAND = { file: 'cmd.exe', args: ['/c', 'codex', 'app-server'] };

const sameFile = (a, b) => path.basename(String(a || '')).toLowerCase() === path.basename(String(b || '')).toLowerCase();

// Is there a rollout for this thread under <codexHome>/sessions/YYYY/MM/DD?
function rolloutExists(codexHome, threadId) {
  const needle = String(threadId).toLowerCase();
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return false; }
    for (const e of entries) {
      if (e.isDirectory()) { if (depth < 3 && walk(path.join(dir, e.name), depth + 1)) return true; }
      else if (e.name.toLowerCase().includes(needle)) return true;
    }
    return false;
  };
  return walk(path.join(codexHome, 'sessions'), 0);
}

// The thread Codex recorded for this transcript on an earlier import, if that
// thread is still around. Newest record first.
function recordedThread(transcriptPath, codexHome) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(codexHome, 'external_agent_session_imports.json'), 'utf8')); } catch (_) { return null; }
  const hits = (doc.records || [])
    .filter((r) => r && r.imported_thread_id && sameFile(r.source_path, transcriptPath))
    .sort((a, b) => (Number(b.imported_at) || 0) - (Number(a.imported_at) || 0));
  for (const r of hits) if (rolloutExists(codexHome, r.imported_thread_id)) return r.imported_thread_id;
  return null;
}

// Resolve with the thread id to `codex resume`, or reject with why it could not be done.
function importClaudeSession(transcriptPath, {
  command = DEFAULT_COMMAND, timeoutMs = 60000, spawnImpl = spawn, codexHome = path.join(os.homedir(), '.codex'),
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(command.file, command.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { reject(new Error(`codex app-server could not start: ${e.message}`)); return; }
    let settled = false;
    let buf = '';
    let nextId = 1;
    const pending = new Map();
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (_) { /* gone */ }
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('codex app-server timed out')), timeoutMs);
    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    const notify = (method, params) => child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    let completed = null;
    let importId = null;
    child.on('error', (e) => finish(new Error(`codex app-server could not start: ${e.message}`)));
    child.on('exit', (code) => { if (!settled) finish(new Error(`codex app-server exited (${code}) before the import completed`)); });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch (_) { continue; }
        if (m.id !== undefined && pending.has(m.id)) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          if (m.error) p.rej(new Error(typeof m.error === 'string' ? m.error : (m.error.message || JSON.stringify(m.error))));
          else p.res(m.result);
        } else if (m.method === 'externalAgentConfig/import/completed') {
          completed = m.params;
          onCompleted();
        }
      }
    });
    function onCompleted() {
      if (!completed || !importId || completed.importId !== importId) return;
      const sessions = (completed.itemTypeResults || []).find((r) => r.itemType === 'SESSIONS') || { successes: [], failures: [] };
      const hit = (sessions.successes || []).find((s) => sameFile(s.source, transcriptPath));
      if (hit && hit.target) { finish(null, hit.target); return; }
      const failure = (sessions.failures || [])[0];
      finish(new Error(failure ? `codex import failed: ${failure.message}` : 'codex import finished without this session'));
    }
    (async () => {
      await request('initialize', { clientInfo: { name: 'limpet', version: '0.1.0' } });
      notify('initialized', {});
      const det = await request('externalAgentConfig/detect', { migrationSource: 'claude-code', includeHome: true, maxSessions: 1000, maxSessionAgeDays: 3650 });
      const item = (det.items || []).find((it) => it.itemType === 'SESSIONS');
      const sessions = item && item.details ? (item.details.sessions || []) : [];
      const one = sessions.filter((s) => sameFile(s.path, transcriptPath));
      if (!one.length) {
        const prior = recordedThread(transcriptPath, codexHome);
        if (prior) { finish(null, prior); return; }
        throw new Error('codex did not detect this session (is ~/.claude/projects where it looks?)');
      }
      const res = await request('externalAgentConfig/import', {
        migrationItems: [{ ...item, details: { ...item.details, sessions: one } }],
        migrationSource: 'claude-code', source: 'limpet',
      });
      importId = res && res.importId;
      if (!importId) throw new Error('codex import was not accepted');
      onCompleted(); // the notification may already have arrived
    })().catch((e) => finish(e));
  });
}

module.exports = { importClaudeSession, recordedThread, rolloutExists, DEFAULT_COMMAND };
