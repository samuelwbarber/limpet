// Agent/account switching: the pure logic behind "right-click a tab, pick an
// account, carry the chat across". main.js supplies the filesystem and the
// process list; this file decides. No Electron dependencies -- unit tested by
// tests/accounts.test.js.
//
// A tab's shell may be running Claude Code under one of the limpet accounts
// (plain `claude`, `claude1`, `claude2`; see $script:LimpetClaudeConfigDirs in
// shell/Limpet.psm1 -- the two lists must match) or the OpenAI Codex CLI.
//
// Claude Code writes <config dir>/sessions/<pid>.json for every live process,
// so the Claude session in a tab is the one whose pid descends from that tab's
// shell. Codex keeps no such file: its session is the rollout file
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) most recently written since
// the codex process under the shell started.
//
// Moving a chat: between Claude accounts it is `--resume <id>` (their
// projects/ folders are one shared store). Across agents the transcript is
// converted (see handoff.js and codex-import.js) and resumed on the other side.

const path = require('path');

const ACCOUNTS = [
  { cmd: 'claude', kind: 'claude', dir: '.claude' },
  { cmd: 'claude1', kind: 'claude', dir: '.claude-1' },
  { cmd: 'claude2', kind: 'claude', dir: '.claude-2' },
  { cmd: 'codex', kind: 'codex', dir: '.codex' },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const accountFor = (cmd) => ACCOUNTS.find((a) => a.cmd === cmd) || null;

// The email inside an OpenAI id_token (a JWT); '' if it can't be read.
function jwtEmail(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : '';
  } catch (_) { return ''; }
}

// Describe each account for the menu: signed in? which email? `io.exists(path)`
// is a boolean, `io.readJson(path)` the parsed file or null.
function describeAccounts(home, io) {
  return ACCOUNTS.map(({ cmd, kind, dir }) => {
    const configDir = path.join(home, dir);
    if (kind === 'codex') {
      const auth = io.readJson(path.join(configDir, 'auth.json'));
      const tokens = auth && auth.tokens;
      const email = tokens ? jwtEmail(tokens.id_token) : '';
      return {
        cmd, kind, dir, configDir,
        loggedIn: !!auth,
        email: email || (auth && auth.OPENAI_API_KEY ? 'API key' : ''),
      };
    }
    // Plain `claude` keeps its config at ~/.claude.json; the others inside their dir.
    const config = io.readJson(path.join(configDir, '.claude.json')) || (dir === '.claude' ? io.readJson(path.join(home, '.claude.json')) : null);
    const oauth = config && config.oauthAccount;
    return {
      cmd, kind, dir, configDir,
      loggedIn: io.exists(path.join(configDir, '.credentials.json')),
      email: oauth && typeof oauth.emailAddress === 'string' ? oauth.emailAddress : '',
    };
  });
}

// Every pid under `rootPid` in a process list of { pid, ppid } rows.
function descendants(procs, rootPid) {
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const out = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    for (const child of children.get(pid) || []) {
      // pid 0 lists itself as its own parent; guard that and any pid reuse.
      if (child !== rootPid && !out.has(child)) { out.add(child); stack.push(child); }
    }
  }
  return out;
}

const rank = (s) => (s.kind === 'interactive' ? 1e15 : 0) + s.updatedAt;

// The Claude Code session running under a tab's shell. `sessionFiles` is
// [{ cmd, info }] with info the parsed sessions/<pid>.json. A file whose pid is
// gone is stale (Claude was killed) and ignored. If more than one qualifies
// (nested shells), the most recently updated interactive one wins.
function findClaudeSession(sessionFiles, procs, shellPid) {
  const under = descendants(procs, shellPid);
  const alive = new Set(procs.map((p) => p.pid));
  let best = null;
  for (const { cmd, info } of sessionFiles) {
    if (!info || !Number.isInteger(info.pid) || !UUID_RE.test(String(info.sessionId || ''))) continue;
    if (!under.has(info.pid) || !alive.has(info.pid)) continue;
    const candidate = {
      kind: 'claude', cmd, pid: info.pid, sessionId: info.sessionId, cwd: info.cwd || '',
      status: typeof info.status === 'string' ? info.status : '',
      sessionKind: typeof info.kind === 'string' ? info.kind : '',
      updatedAt: Number(info.updatedAt) || 0,
    };
    if (!best || rank({ kind: candidate.sessionKind, updatedAt: candidate.updatedAt }) >
                 rank({ kind: best.sessionKind, updatedAt: best.updatedAt })) best = candidate;
  }
  return best;
}

// The Codex session running under a tab's shell: a codex process under the
// shell (procs carry { pid, ppid, name, startedAt }) plus the rollout written
// most recently since it started. `rollouts` is [{ id, path, cwd, mtimeMs }].
function findCodexSession(rollouts, procs, shellPid) {
  const under = descendants(procs, shellPid);
  const proc = procs
    .filter((p) => under.has(p.pid) && /^codex(\.exe)?$/i.test(String(p.name || '')))
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))[0];
  if (!proc) return null;
  const since = (proc.startedAt || 0) - 5000;
  const rollout = rollouts
    .filter((r) => UUID_RE.test(String(r.id || '')) && (r.mtimeMs || 0) >= since)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return {
    kind: 'codex', cmd: 'codex', pid: proc.pid, status: '',
    sessionId: rollout ? rollout.id : null, cwd: rollout ? rollout.cwd || '' : '',
    rolloutPath: rollout ? rollout.path : null,
  };
}

// Whatever agent is running under the tab's shell, Claude first (a Claude
// launched from inside Codex, or vice versa, is rare; prefer the one with a
// session id we can act on).
function findSession({ sessionFiles = [], rollouts = [] }, procs, shellPid) {
  return findClaudeSession(sessionFiles, procs, shellPid) || findCodexSession(rollouts, procs, shellPid);
}

// A PowerShell single-quoted literal: only the quote itself needs escaping and
// nothing inside is interpolated, so a prompt is safe to type at the prompt.
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// The line typed into the shell to bring a chat up under `cmd`:
//   resume:  `claude1 --resume <id>` / `codex resume <id>`
//   prompt:  `<cmd> '<single-line prompt>'` (a handoff), Claude additionally
//            granted `--add-dir` so it can read the handoff file unprompted
//   neither: just `<cmd>`, a fresh start.
function launchCommand(cmd, { resume = '', prompt = '', addDir = '' } = {}) {
  const account = accountFor(cmd);
  if (!account) throw new Error(`unknown account: ${cmd}`);
  if (resume && !UUID_RE.test(String(resume))) throw new Error(`not a session id: ${resume}`);
  if (/[\r\n]/.test(String(prompt))) throw new Error('prompt must be a single line');
  let line = cmd;
  if (resume) line += account.kind === 'codex' ? ` resume ${resume}` : ` --resume ${resume}`;
  if (addDir && account.kind === 'claude') line += ` --add-dir ${psQuote(addDir)}`;
  if (prompt) line += ` ${psQuote(prompt)}`;
  return line;
}

module.exports = {
  ACCOUNTS, UUID_RE, accountFor, jwtEmail, describeAccounts, descendants,
  findClaudeSession, findCodexSession, findSession, psQuote, launchCommand,
};
