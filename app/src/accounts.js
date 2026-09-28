// Agent/account switching: the pure logic behind "right-click a tab, pick an
// account, carry the chat across". main.js supplies the filesystem and the
// process list; this file decides. No Electron dependencies -- unit tested by
// tests/accounts.test.js.
//
// Accounts are named by command: plain `claude`, `codex`, `agy` (Antigravity)
// and `copilot`, then any number of `claude1`, `codex2`, `agy1`, `copilot3`,
// ... Each numbered one runs its agent with its own login (shell/Limpet.psm1
// defines the commands and creates the directory on first run): Claude Code,
// Codex and Copilot against their own config directory (~/.claude-N,
// ~/.codex-N, ~/.copilot-N); agy, which has no such setting, with the login
// the shell keeps in ~/.agy-N swapped into Credential Manager. Which accounts
// exist is discovered from the home directory, not from a list.
//
// Claude Code writes <config dir>/sessions/<pid>.json for every live process,
// so the Claude session in a tab is the one whose pid descends from that tab's
// shell. The others' chat is the one the agent process under the shell has
// open: Codex holds a writer lock on its thread, agy its conversation's
// database, Copilot marks the chat's folder with inuse.<pid>.lock (see
// agent-scan.js). Their account is the one the shell's wrapper noted it
// launched: every account of an agent shares one chat store, so the files
// don't tell.
//
// Moving a chat: between accounts of one agent it is resuming the same chat
// by id (the store is shared; a Codex home not wired up yet gets the rollout
// copied in first). Across agents the transcript is converted (see handoff.js
// and codex-import.js) and resumed on the other side, or handed over as a
// Markdown file where there's no native way in.

const path = require('path');

const KINDS = ['claude', 'codex', 'agy', 'copilot'];
// Agents only suggested in the menu's footer once one of their accounts is in use.
const OPTIONAL_KINDS = new Set(['agy', 'copilot']);
const ACCOUNT_RE = /^(claude|codex|agy|copilot)([1-9]\d*)?$/;
const DIR_RE = /^\.(claude|codex|agy|copilot)(?:-([1-9]\d*))?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The account a command name denotes, or null. `claude` -> ~/.claude, `claude3`
// -> ~/.claude-3, `codex2` -> ~/.codex-2, `agy1` -> ~/.agy-1 (where its login
// is kept). Any number is valid: the shell creates the directory the first
// time that command runs.
function accountFor(cmd) {
  const m = ACCOUNT_RE.exec(String(cmd || ''));
  if (!m) return null;
  const kind = m[1];
  const number = m[2] ? Number(m[2]) : 0;
  return { cmd: `${kind}${number || ''}`, kind, number, dir: number ? `.${kind}-${number}` : `.${kind}` };
}

// Every account with a config directory under `home`, plus each plain one
// whether or not its directory exists. `io.listDir(dir)` is the names inside
// a directory ([] if unreadable). Order: claude, claude1, claude2, ..., codex,
// codex1, ..., agy, agy1, ..., copilot, copilot1, ...
function listAccounts(home, io) {
  const numbers = Object.fromEntries(KINDS.map((k) => [k, new Set()]));
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
    if (kind === 'agy') {
      // The shell keeps an agy account's login in login.dat (encrypted) and its
      // email in account.json. Plain agy's login normally sits in Credential
      // Manager, out of the app's sight: if agy has been used here, count it in.
      const account = io.readJson(path.join(configDir, 'account.json'));
      const kept = io.exists(path.join(configDir, 'login.dat'));
      const loggedIn = number ? kept : kept || !!account || io.exists(path.join(home, '.gemini', 'antigravity-cli'));
      return { cmd, kind, number, dir, configDir, loggedIn, present: loggedIn || io.exists(configDir), email: (account && typeof account.email === 'string' && account.email) || '' };
    }
    if (kind === 'copilot') {
      // Copilot keeps its token in the system credential store; an account
      // counts once Copilot has run in its home.
      const loggedIn = io.exists(path.join(configDir, 'config.json'));
      return { cmd, kind, number, dir, configDir, loggedIn, present: loggedIn || io.exists(configDir), email: '' };
    }
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
// (the shell makes its directory on first run). agy and Copilot only once one
// of their accounts is in use.
function signInHints(described) {
  const out = [];
  for (const kind of KINDS) {
    const mine = described.filter((a) => a.kind === kind);
    if (OPTIONAL_KINDS.has(kind) && !mine.some((a) => a.loggedIn || a.present)) continue;
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

// The Codex account that launched `proc`: the nearest shell above it (up to
// the tab's) that noted launching an account of `kind`. `launches` is [{ pid,
// cmd, startedAt }] with pid the noting shell's. A note must predate the
// process and postdate its shell, so one left by a shell that was killed
// mid-launch can't be picked up by a later shell that got the same pid.
const LAUNCH_SLACK_MS = 2000;
function agentLauncher(kind, proc, procs, shellPid, launches) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const seen = new Set();
  for (let p = byPid.get(proc.ppid); p && !seen.has(p.pid); p = p.pid === shellPid ? null : byPid.get(p.ppid)) {
    seen.add(p.pid);
    const hit = launches.find((l) => l.pid === p.pid && accountFor(l.cmd) && accountFor(l.cmd).kind === kind &&
      l.startedAt <= (proc.startedAt || 0) + LAUNCH_SLACK_MS && l.startedAt >= (p.startedAt || 0));
    if (hit) return hit.cmd;
  }
  return '';
}
const codexLauncher = (proc, procs, shellPid, launches) => agentLauncher('codex', proc, procs, shellPid, launches);

// The processes of an agent's CLI under the tab's shell, oldest first.
const isAgentProc = (kind) => (p) => new RegExp(`^${kind}(\\.exe)?$`, 'i').test(String(p.name || ''));
function agentProcs(kind, procs, shellPid) {
  const under = descendants(procs, shellPid);
  return procs.filter((p) => under.has(p.pid) && isAgentProc(kind)(p)).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}
const newestChat = (list) => list.filter((r) => UUID_RE.test(String(r.id || '')) && !r.subagent).sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))[0];
const heldBy = (chats, procs) => {
  const pids = new Set(procs.map((p) => p.pid));
  return chats.filter((c) => (c.pids || []).some((pid) => pids.has(pid)));
};

// The Codex session running under a tab's shell: a codex process under the
// shell (procs carry { pid, ppid, name, startedAt }) and the thread it has
// open. Codex holds a writer lock on the thread it has loaded; `writers` is
// [{ cmd, id, path, cwd, mtimeMs, pids }], each thread whose lock is held and
// the pids holding it (null when that couldn't be found out). With any to go
// on, the tab's thread is the one a codex under the tab holds, or none (a
// Codex that hasn't started a chat). Without, it is the rollout written most
// recently since the codex started (`rollouts`, [{ cmd, id, path, cwd,
// mtimeMs, subagent }]). Sub-agent threads never count: they run inside
// another chat's process. A thread's cmd is the codex account whose home
// alone holds it, or '' when homes share it. The account is the launch noted
// for it (codexLauncher), else the thread's home, else plain `codex`.
const chatSession = (kind, cmd, proc, chat) => ({
  kind, cmd, pid: proc.pid, status: '',
  sessionId: chat ? chat.id : null, cwd: chat ? chat.cwd || '' : '', rolloutPath: chat ? chat.path : null,
});

function findCodexSession(rollouts, procs, shellPid, launches = [], writers = null) {
  const mine = agentProcs('codex', procs, shellPid);
  const proc = mine[0];
  if (!proc) return null;
  const since = (proc.startedAt || 0) - 5000;
  const rollout = writers && writers.length
    ? newestChat(heldBy(writers, mine))
    : newestChat(rollouts.filter((r) => (r.mtimeMs || 0) >= since));
  return chatSession('codex', codexLauncher(proc, procs, shellPid, launches) || (rollout && rollout.cmd) || 'codex', proc, rollout);
}

// The Copilot chat under a tab's shell: the one whose folder carries the
// in-use mark of a copilot process under the tab. `chats` is [{ cmd, id, path,
// cwd, mtimeMs, pids }] for every chat marked in use (path: its events.jsonl).
function findCopilotSession(chats, procs, shellPid, launches = []) {
  const mine = agentProcs('copilot', procs, shellPid);
  if (!mine.length) return null;
  const chat = newestChat(heldBy(chats, mine));
  return chatSession('copilot', agentLauncher('copilot', mine[0], procs, shellPid, launches) || (chat && chat.cmd) || 'copilot', mine[0], chat);
}

// The Antigravity conversation under a tab's shell: the one whose database
// an agy process under the tab holds open. `conversations` is [{ id, path,
// cwd, mtimeMs, pids }] (path: its transcript.jsonl), with pids null when the
// holders couldn't be found out, in which case the newest is taken. Without a
// launch note the account is whichever holds agy's login now (`active`).
function findAgySession(conversations, procs, shellPid, launches = [], active = 'agy') {
  const mine = agentProcs('agy', procs, shellPid);
  if (!mine.length) return null;
  const known = conversations.every((c) => Array.isArray(c.pids));
  const chat = newestChat(known ? heldBy(conversations, mine) : conversations);
  return chatSession('agy', agentLauncher('agy', mine[0], procs, shellPid, launches) || active || 'agy', mine[0], chat);
}

// Whatever agent is running under the tab's shell, Claude first (one agent
// launched from inside another is rare; prefer the one with a session id we
// can act on).
function findSession({ sessionFiles = [], rollouts = [], launches = [], writers = null, copilotChats = [], agyConversations = [], agyActive = 'agy' }, procs, shellPid) {
  return findClaudeSession(sessionFiles, procs, shellPid)
    || findCodexSession(rollouts, procs, shellPid, launches, writers)
    || findCopilotSession(copilotChats, procs, shellPid, launches)
    || findAgySession(agyConversations, procs, shellPid, launches, agyActive);
}

// A PowerShell single-quoted literal: only the quote itself needs escaping and
// nothing inside is interpolated, so a prompt is safe to type at the prompt.
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// How each agent's CLI takes a chat to resume, a first prompt, and an extra
// directory it may read (for the handoff file; Codex has no such flag).
const CLI_FLAGS = {
  claude: { resume: '--resume', prompt: '', addDir: '--add-dir' },
  codex: { resume: 'resume', prompt: '', addDir: '' },
  agy: { resume: '--conversation', prompt: '-i', addDir: '--add-dir' },
  copilot: { resume: '--resume', prompt: '-i', addDir: '--add-dir' },
};

// The line typed into the shell to bring a chat up under `cmd`:
//   resume:  `claude1 --resume <id>` / `codex2 resume <id>` /
//            `agy1 --conversation <id>` / `copilot2 --resume <id>`
//   prompt:  `<cmd> '<single-line prompt>'` (a handoff; agy and Copilot take
//            it after -i), and where the CLI allows, `--add-dir` so it can
//            read the handoff file unprompted
//   neither: just `<cmd>`, a fresh start.
function launchCommand(cmd, { resume = '', prompt = '', addDir = '' } = {}) {
  const account = accountFor(cmd);
  if (!account) throw new Error(`unknown account: ${cmd}`);
  if (resume && !UUID_RE.test(String(resume))) throw new Error(`not a session id: ${resume}`);
  if (/[\r\n]/.test(String(prompt))) throw new Error('prompt must be a single line');
  const flags = CLI_FLAGS[account.kind];
  let line = account.cmd;
  if (resume) line += ` ${flags.resume} ${resume}`;
  if (addDir && flags.addDir) line += ` ${flags.addDir} ${psQuote(addDir)}`;
  if (prompt) line += ` ${flags.prompt ? `${flags.prompt} ` : ''}${psQuote(prompt)}`;
  return line;
}

module.exports = {
  KINDS, ACCOUNT_RE, DIR_RE, UUID_RE, accountFor, listAccounts, jwtEmail, describeAccounts, signInHints,
  descendants, findClaudeSession, findCodexSession, findCopilotSession, findAgySession, findSession, psQuote, launchCommand,
};
