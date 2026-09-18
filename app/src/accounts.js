// Agent/account switching: the pure logic behind "right-click a tab, pick an
// account, carry the chat across". main.js supplies the filesystem and the
// process list; this file decides. No Electron dependencies -- unit tested by
// tests/accounts.test.js.
//
// Accounts are named by command: plain `claude` and `codex`, then any number
// of `claude1`, `claude2`, ... and `codex1`, `codex2`, ... Each numbered one
// runs its agent against its own config directory (~/.claude-N, ~/.codex-N;
// shell/Limpet.psm1 defines the commands and creates the directory on first
// run), so each holds its own login. Which accounts exist is discovered from
// the home directory, not from a list.
//
// Claude Code writes <config dir>/sessions/<pid>.json for every live process,
// so the Claude session in a tab is the one whose pid descends from that tab's
// shell. Codex keeps no such file: its session is the rollout file
// (<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl) most recently written
// since the codex process under the shell started.
//
// Moving a chat: between Claude accounts it is `--resume <id>` (their
// projects/ folders are one shared store). Between Codex accounts the rollout
// is copied into the other home and resumed. Across agents the transcript is
// converted (see handoff.js and codex-import.js) and resumed on the other side.

const path = require('path');

const KINDS = ['claude', 'codex'];
const ACCOUNT_RE = /^(claude|codex)([1-9]\d*)?$/;
const DIR_RE = /^\.(claude|codex)(?:-([1-9]\d*))?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The account a command name denotes, or null. `claude` -> ~/.claude, `claude3`
// -> ~/.claude-3, `codex2` -> ~/.codex-2. Any number is valid: the shell
// creates the directory the first time that command runs.
function accountFor(cmd) {
  const m = ACCOUNT_RE.exec(String(cmd || ''));
  if (!m) return null;
  const kind = m[1];
  const number = m[2] ? Number(m[2]) : 0;
  return { cmd: `${kind}${number || ''}`, kind, number, dir: number ? `.${kind}-${number}` : `.${kind}` };
}

// Every account with a config directory under `home`, plus plain `claude` and
// `codex` whether or not theirs exist. `io.listDir(dir)` is the names inside a
// directory ([] if unreadable). Order: claude, claude1, claude2, ..., codex,
// codex1, ...
function listAccounts(home, io) {
  const numbers = { claude: new Set(), codex: new Set() };
  for (const name of io.listDir(home)) {
    const m = DIR_RE.exec(name);
    if (m && m[2]) numbers[m[1]].add(Number(m[2]));
  }
  const out = [];
  for (const kind of KINDS) {
    out.push(accountFor(kind));
    for (const n of [...numbers[kind]].sort((a, b) => a - b)) out.push(accountFor(`${kind}${n}`));
  }
  return out;
}

// The email inside an OpenAI id_token (a JWT); '' if it can't be read.
function jwtEmail(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : '';
  } catch (_) { return ''; }
}

// Describe each account for the menu: signed in? which email? `io.exists(path)`
// is a boolean, `io.readJson(path)` the parsed file or null, `io.listDir(dir)`
// the names in a directory.
function describeAccounts(home, io) {
  return listAccounts(home, io).map(({ cmd, kind, number, dir }) => {
    const configDir = path.join(home, dir);
    if (kind === 'codex') {
      const auth = io.readJson(path.join(configDir, 'auth.json'));
      const tokens = auth && auth.tokens;
      const email = tokens ? jwtEmail(tokens.id_token) : '';
      return {
        cmd, kind, number, dir, configDir,
        loggedIn: !!auth && !!(tokens || auth.OPENAI_API_KEY),
        email: email || (auth && auth.OPENAI_API_KEY ? 'API key' : ''),
      };
    }
    // Plain `claude` keeps its config at ~/.claude.json; the others inside their dir.
    const config = io.readJson(path.join(configDir, '.claude.json')) || (number === 0 ? io.readJson(path.join(home, '.claude.json')) : null);
    const oauth = config && config.oauthAccount;
    return {
      cmd, kind, number, dir, configDir,
      loggedIn: io.exists(path.join(configDir, '.credentials.json')),
      email: oauth && typeof oauth.emailAddress === 'string' ? oauth.emailAddress : '',
    };
  });
}

// Commands the user could sign in to next, for the menu's footer: every
// account that exists but isn't signed in, then one brand-new number per kind
// (the shell makes its directory on first run).
function signInHints(described) {
  const out = [];
  for (const kind of KINDS) {
    const mine = described.filter((a) => a.kind === kind);
    for (const a of mine) if (!a.loggedIn) out.push(a.cmd);
    const next = mine.reduce((m, a) => Math.max(m, a.number), 0) + 1;
    out.push(`${kind}${next}`);
  }
  return out;
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
// most recently since it started. `rollouts` is [{ cmd, id, path, cwd,
// mtimeMs }], cmd being the codex account whose home holds the file. With no
// rollout the account can't be told apart, so plain `codex` is assumed.
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
    kind: 'codex', cmd: (rollout && rollout.cmd) || 'codex', pid: proc.pid, status: '',
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
//   resume:  `claude1 --resume <id>` / `codex2 resume <id>`
//   prompt:  `<cmd> '<single-line prompt>'` (a handoff), Claude additionally
//            granted `--add-dir` so it can read the handoff file unprompted
//   neither: just `<cmd>`, a fresh start.
function launchCommand(cmd, { resume = '', prompt = '', addDir = '' } = {}) {
  const account = accountFor(cmd);
  if (!account) throw new Error(`unknown account: ${cmd}`);
  if (resume && !UUID_RE.test(String(resume))) throw new Error(`not a session id: ${resume}`);
  if (/[\r\n]/.test(String(prompt))) throw new Error('prompt must be a single line');
  let line = account.cmd;
  if (resume) line += account.kind === 'codex' ? ` resume ${resume}` : ` --resume ${resume}`;
  if (addDir && account.kind === 'claude') line += ` --add-dir ${psQuote(addDir)}`;
  if (prompt) line += ` ${psQuote(prompt)}`;
  return line;
}

module.exports = {
  KINDS, ACCOUNT_RE, DIR_RE, UUID_RE, accountFor, listAccounts, jwtEmail, describeAccounts, signInHints,
  descendants, findClaudeSession, findCodexSession, findSession, psQuote, launchCommand,
};
