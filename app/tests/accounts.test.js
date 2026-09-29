// Unit tests for the agent/account-switch logic (src/accounts.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  accountFor, listAccounts, describeAccounts, signInHints, descendants, findClaudeSession, findCodexSession, findSession,
  findCopilotSession, findAgySession, launchCommand, psQuote, jwtEmail,
} = require('../src/accounts');

const procs = [
  { pid: 0, ppid: 0, name: 'System Idle Process', startedAt: 0 },
  { pid: 4, ppid: 0, name: 'System', startedAt: 0 },
  { pid: 100, ppid: 4, name: 'limpet.exe', startedAt: 1000 },
  { pid: 200, ppid: 100, name: 'powershell.exe', startedAt: 2000 }, // tab A's shell
  { pid: 210, ppid: 200, name: 'cmd.exe', startedAt: 3000 },         // the npm shim
  { pid: 220, ppid: 210, name: 'claude.exe', startedAt: 3100 },
  { pid: 300, ppid: 100, name: 'powershell.exe', startedAt: 2000 }, // tab B's shell
  { pid: 320, ppid: 300, name: 'claude.exe', startedAt: 4000 },
  { pid: 400, ppid: 100, name: 'powershell.exe', startedAt: 2000 }, // tab C's shell: codex
  { pid: 410, ppid: 400, name: 'node.exe', startedAt: 50000 },
  { pid: 420, ppid: 410, name: 'codex.exe', startedAt: 50100 },
];
const SID_A = '11111111-2222-4333-8444-555555555555';
const SID_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const files = [
  { cmd: 'claude1', info: { pid: 220, sessionId: SID_A, cwd: 'C:\\a', status: 'idle', kind: 'interactive', updatedAt: 5 } },
  { cmd: 'claude', info: { pid: 320, sessionId: SID_B, cwd: 'C:\\b', status: 'busy', kind: 'interactive', updatedAt: 9 } },
  // stale: Claude was killed, its pid is gone
  { cmd: 'claude7', info: { pid: 999, sessionId: SID_A, status: 'idle', kind: 'interactive', updatedAt: 99 } },
];
const T_OLD = '01a00000-0000-7000-8000-000000000001';
const T_NEW = '01a00000-0000-7000-8000-000000000002';
const rollouts = [
  { cmd: 'codex', id: T_OLD, path: 'C:\\r\\old.jsonl', cwd: 'C:\\c', mtimeMs: 40000 },   // finished before codex started
  { cmd: 'codex2', id: T_NEW, path: 'C:\\r2\\new.jsonl', cwd: 'C:\\c', mtimeMs: 60000 },
  { cmd: 'codex', id: 'bogus', path: 'C:\\r\\x.jsonl', cwd: 'C:\\c', mtimeMs: 70000 },
];

test('accountFor maps any claudeN / codexN name to its kind and config dir', () => {
  assert.deepStrictEqual(accountFor('claude'), { cmd: 'claude', kind: 'claude', number: 0, dir: '.claude' });
  assert.deepStrictEqual(accountFor('claude3'), { cmd: 'claude3', kind: 'claude', number: 3, dir: '.claude-3' });
  assert.deepStrictEqual(accountFor('codex'), { cmd: 'codex', kind: 'codex', number: 0, dir: '.codex' });
  assert.deepStrictEqual(accountFor('codex12'), { cmd: 'codex12', kind: 'codex', number: 12, dir: '.codex-12' });
  for (const bad of ['claude0', 'claude01', 'claudex', 'Claude1', 'codex-1', 'rm', '', null]) assert.strictEqual(accountFor(bad), null, String(bad));
});

test('listAccounts discovers numbered config dirs, plain ones always first', () => {
  const io = { listDir: (p) => (p === 'C:\\h' ? ['.claude', '.claude-10', '.claude-2', '.codex-1', '.codex-01', '.claude-x', 'Documents', '.claude.json'] : []) };
  assert.deepStrictEqual(listAccounts('C:\\h', io).map((a) => a.cmd), ['claude', 'claude2', 'claude10', 'codex', 'codex1', 'agy', 'copilot']);
  assert.deepStrictEqual(listAccounts('C:\\h', { listDir: () => [] }).map((a) => a.cmd), ['claude', 'codex', 'agy', 'copilot']);
  const more = { listDir: () => ['.agy-2', '.copilot-1', '.copilot-12', '.agy-02', '.gemini'] };
  assert.deepStrictEqual(listAccounts('C:\\h', more).map((a) => a.cmd), ['claude', 'codex', 'agy', 'agy2', 'copilot', 'copilot1', 'copilot12']);
  assert.deepStrictEqual(accountFor('agy3'), { cmd: 'agy3', kind: 'agy', number: 3, dir: '.agy-3' });
  assert.deepStrictEqual(accountFor('copilot'), { cmd: 'copilot', kind: 'copilot', number: 0, dir: '.copilot' });
});

test('describeAccounts: agy accounts by their kept login, Copilot ones once Copilot has run in their home', () => {
  const home = 'C:\\h';
  const files = new Set([
    path.join(home, '.gemini', 'antigravity-cli'),          // plain agy has been used here
    path.join(home, '.agy-1'), path.join(home, '.agy-1', 'login.dat'),
    path.join(home, '.agy-2'),                               // made, never signed in
    path.join(home, '.copilot-1'), path.join(home, '.copilot-1', 'config.json'),
    path.join(home, '.copilot-2'),
  ]);
  const io = {
    listDir: (p) => (p === home ? ['.agy-1', '.agy-2', '.copilot-1', '.copilot-2'] : []),
    exists: (p) => files.has(p),
    readJson: (p) => (p === path.join(home, '.agy-1', 'account.json') ? { email: 'one@example.com' } : null),
  };
  const by = Object.fromEntries(describeAccounts(home, io).map((a) => [a.cmd, a]));
  assert.deepStrictEqual([by.agy.loggedIn, by.agy1.loggedIn, by.agy1.email, by.agy2.loggedIn, by.agy2.present], [true, true, 'one@example.com', false, true]);
  assert.deepStrictEqual([by.copilot.loggedIn, by.copilot.present, by.copilot1.loggedIn, by.copilot2.loggedIn], [false, false, true, false]);
  assert.deepStrictEqual(signInHints(Object.values(by)), ['claude', 'claude1', 'codex', 'codex1', 'agy2', 'agy3', 'copilot', 'copilot2', 'copilot3']);
  // agy and Copilot aren't suggested until one of their accounts is in use.
  const bare = describeAccounts(home, { listDir: () => [], exists: () => false, readJson: () => null });
  assert.deepStrictEqual(signInHints(bare), ['claude', 'claude1', 'codex', 'codex1']);
});

test('descendants walks the whole subtree and survives the pid-0 self-parent', () => {
  assert.deepStrictEqual([...descendants(procs, 200)].sort(), [210, 220]);
  assert.deepStrictEqual([...descendants(procs, 300)], [320]);
  assert.strictEqual(descendants(procs, 0).size, 10);
  assert.strictEqual(descendants(procs, 220).size, 0);
});

test('findClaudeSession picks the session under this tab, not another tab or a stale file', () => {
  const a = findClaudeSession(files, procs, 200);
  assert.deepStrictEqual({ kind: a.kind, cmd: a.cmd, pid: a.pid, sessionId: a.sessionId, status: a.status }, { kind: 'claude', cmd: 'claude1', pid: 220, sessionId: SID_A, status: 'idle' });
  const b = findClaudeSession(files, procs, 300);
  assert.deepStrictEqual({ cmd: b.cmd, pid: b.pid, status: b.status }, { cmd: 'claude', pid: 320, status: 'busy' });
  assert.strictEqual(findClaudeSession(files, procs, 999), null);
  assert.strictEqual(findClaudeSession([], procs, 200), null);
});

test('findClaudeSession prefers the freshest interactive session and skips malformed files', () => {
  const both = findClaudeSession(files, procs, 100); // the app itself: both tabs are underneath
  assert.strictEqual(both.sessionId, SID_B);
  const noisy = [
    { cmd: 'claude', info: null },
    { cmd: 'claude', info: { pid: '220', sessionId: SID_A } },
    { cmd: 'claude', info: { pid: 220, sessionId: 'not-a-uuid' } },
    { cmd: 'claude2', info: { pid: 220, sessionId: SID_B, kind: 'print', updatedAt: 500 } },
    { cmd: 'claude1', info: { pid: 210, sessionId: SID_A, kind: 'interactive', updatedAt: 1 } },
  ];
  const picked = findClaudeSession(noisy, procs, 200);
  assert.deepStrictEqual({ cmd: picked.cmd, pid: picked.pid }, { cmd: 'claude1', pid: 210 });
});

test('findCodexSession pairs the codex process under the tab with the rollout written since it started, and names its account', () => {
  const c = findCodexSession(rollouts, procs, 400);
  assert.deepStrictEqual({ kind: c.kind, cmd: c.cmd, pid: c.pid, sessionId: c.sessionId, rolloutPath: c.rolloutPath, cwd: c.cwd },
    { kind: 'codex', cmd: 'codex2', pid: 420, sessionId: T_NEW, rolloutPath: 'C:\\r2\\new.jsonl', cwd: 'C:\\c' });
  assert.strictEqual(findCodexSession(rollouts, procs, 200), null); // no codex under tab A
  const noRollout = findCodexSession([], procs, 400);
  assert.deepStrictEqual({ cmd: noRollout.cmd, pid: noRollout.pid, sessionId: noRollout.sessionId }, { cmd: 'codex', pid: 420, sessionId: null });
});

test('findCodexSession takes the account from the launch the shell noted, since shared homes hide it', () => {
  const shared = rollouts.map((r) => ({ ...r, cmd: '' })); // every home junctioned to one sessions folder
  assert.strictEqual(findCodexSession(shared, procs, 400).cmd, 'codex'); // no note: plain codex
  const noted = [{ pid: 400, cmd: 'codex3', startedAt: 49000 }];
  const c = findCodexSession(shared, procs, 400, noted);
  assert.deepStrictEqual({ cmd: c.cmd, sessionId: c.sessionId }, { cmd: 'codex3', sessionId: T_NEW });
  assert.strictEqual(findCodexSession(rollouts, procs, 400, noted).cmd, 'codex3'); // the note beats the rollout's home
  // A note from a nested shell counts too; the nearest one wins.
  const nested = [...procs.slice(0, -2),
    { pid: 405, ppid: 400, name: 'powershell.exe', startedAt: 30000 },
    { pid: 410, ppid: 405, name: 'node.exe', startedAt: 50000 },
    { pid: 420, ppid: 410, name: 'codex.exe', startedAt: 50100 }];
  assert.strictEqual(findCodexSession(shared, nested, 400, [{ pid: 400, cmd: 'codex3', startedAt: 20000 }, { pid: 405, cmd: 'codex1', startedAt: 49000 }]).cmd, 'codex1');
});

test('findCodexSession ignores notes that cannot be about this codex', () => {
  const shared = rollouts.map((r) => ({ ...r, cmd: '' }));
  const pick = (launches) => findCodexSession(shared, procs, 400, launches).cmd;
  assert.strictEqual(pick([{ pid: 400, cmd: 'codex3', startedAt: 90000 }]), 'codex');   // written after codex started
  assert.strictEqual(pick([{ pid: 400, cmd: 'codex3', startedAt: 1000 }]), 'codex');    // before its shell existed: an old shell's pid
  assert.strictEqual(pick([{ pid: 300, cmd: 'codex3', startedAt: 49000 }]), 'codex');   // another tab's shell
  assert.strictEqual(pick([{ pid: 400, cmd: 'claude3', startedAt: 49000 }]), 'codex');  // not a codex account
  assert.strictEqual(pick([{ pid: 400, cmd: 'codex01', startedAt: 49000 }]), 'codex');  // not an account at all
});

test('findCodexSession takes the thread whose writer lock the tab\'s codex holds, not the busiest file', () => {
  const T_MINE = '01a00000-0000-7000-8000-00000000000a';
  const T_OTHER = '01a00000-0000-7000-8000-00000000000b';
  const writers = [
    { cmd: '', id: T_OTHER, path: 'C:\\s\\other.jsonl', cwd: 'C:\\o', mtimeMs: 90000, pids: [320] },   // another tab, written later
    { cmd: '', id: T_MINE, path: 'C:\\s\\mine.jsonl', cwd: 'C:\\m', mtimeMs: 55000, pids: [420] },
  ];
  const c = findCodexSession(rollouts, procs, 400, [], writers);
  assert.deepStrictEqual({ sessionId: c.sessionId, rolloutPath: c.rolloutPath, cwd: c.cwd }, { sessionId: T_MINE, rolloutPath: 'C:\\s\\mine.jsonl', cwd: 'C:\\m' });
  // A codex that holds no lock hasn't started a chat, even with fresher files about.
  assert.strictEqual(findCodexSession(rollouts, procs, 400, [], [writers[0]]).sessionId, null);
  // No lock information at all: the newest file since it started.
  assert.strictEqual(findCodexSession(rollouts, procs, 400, [], null).sessionId, T_NEW);
  assert.strictEqual(findCodexSession(rollouts, procs, 400, [], []).sessionId, T_NEW);
});

test('findCodexSession never lands on a sub-agent thread', () => {
  const T_SUB = '01a00000-0000-7000-8000-00000000000c';
  const withSub = [...rollouts, { cmd: '', id: T_SUB, path: 'C:\\s\\sub.jsonl', cwd: 'C:\\c', mtimeMs: 95000, subagent: true }];
  assert.strictEqual(findCodexSession(withSub, procs, 400).sessionId, T_NEW);
  const heldSub = [{ cmd: '', id: T_SUB, path: 'C:\\s\\sub.jsonl', mtimeMs: 95000, subagent: true, pids: [420] },
    { cmd: '', id: T_NEW, path: 'C:\\r2\\new.jsonl', mtimeMs: 60000, pids: [420] }];
  assert.strictEqual(findCodexSession(withSub, procs, 400, [], heldSub).sessionId, T_NEW);
});

test('findSession reports whichever agent runs under the shell, Claude first', () => {
  const input = { sessionFiles: files, rollouts };
  assert.strictEqual(findSession(input, procs, 200).kind, 'claude');
  assert.strictEqual(findSession(input, procs, 400).kind, 'codex');
  assert.strictEqual(findSession(input, procs, 999), null);
});

test('launchCommand builds resume, handoff-prompt and fresh-start lines per agent, for any account number', () => {
  assert.strictEqual(launchCommand('claude2', { resume: SID_A }), `claude2 --resume ${SID_A}`);
  assert.strictEqual(launchCommand('claude14', { resume: SID_A }), `claude14 --resume ${SID_A}`);
  assert.strictEqual(launchCommand('codex', { resume: T_NEW }), `codex resume ${T_NEW}`);
  assert.strictEqual(launchCommand('codex3', { resume: T_NEW }), `codex3 resume ${T_NEW}`);
  assert.strictEqual(launchCommand('claude', {}), 'claude');
  assert.strictEqual(launchCommand('codex'), 'codex');
  assert.strictEqual(launchCommand('codex', { prompt: "it's here", addDir: 'C:\\h' }), "codex 'it''s here'");
  assert.strictEqual(launchCommand('claude1', { prompt: 'go on', addDir: 'C:\\h o' }), "claude1 --add-dir 'C:\\h o' 'go on'");
  assert.throws(() => launchCommand('claude2', { resume: 'x; Remove-Item -Recurse C:\\' }), /not a session id/);
  assert.throws(() => launchCommand('claude9x', { resume: SID_A }), /unknown account/);
  assert.throws(() => launchCommand('claude01'), /unknown account/);
  assert.throws(() => launchCommand('Remove-Item'), /unknown account/);
  assert.throws(() => launchCommand('codex', { prompt: 'two\nlines' }), /single line/);
  assert.strictEqual(psQuote("a'b"), "'a''b'");
});

test('psQuote doubles the typographic single quotes PowerShell also honours', () => {
  assert.strictEqual(psQuote('it\u2019s'), "'it\u2019\u2019s'");
  assert.strictEqual(psQuote('\u2018x\u201a\u201b'), "'\u2018\u2018x\u201a\u201a\u201b\u201b'");
  assert.strictEqual(psQuote("\u2019; Remove-Item C:\\ '"), "'\u2019\u2019; Remove-Item C:\\ '''");
  assert.strictEqual(psQuote('\u201c"ok"\u201d'), "'\u201c\"ok\"\u201d'", 'double quotes are literal inside single quotes');
});

test('launchCommand speaks agy and Copilot too: their resume flags, -i for a first prompt, --add-dir', () => {
  assert.strictEqual(launchCommand('agy2', { resume: SID_A }), `agy2 --conversation ${SID_A}`);
  assert.strictEqual(launchCommand('copilot', { resume: SID_A }), `copilot --resume ${SID_A}`);
  assert.strictEqual(launchCommand('agy', { prompt: "it's here", addDir: 'C:\\h o' }), "agy --add-dir 'C:\\h o' -i 'it''s here'");
  assert.strictEqual(launchCommand('copilot3', { prompt: 'go on', addDir: 'C:\\h' }), "copilot3 --add-dir 'C:\\h' -i 'go on'");
  assert.strictEqual(launchCommand('copilot1'), 'copilot1');
});

test('findCopilotSession takes the chat marked in use by the tab\'s copilot; findAgySession the conversation its agy holds', () => {
  const tree = [...procs,
    { pid: 500, ppid: 100, name: 'powershell.exe', startedAt: 2000 },   // tab D: copilot
    { pid: 510, ppid: 500, name: 'node.exe', startedAt: 60000 },
    { pid: 520, ppid: 510, name: 'copilot.exe', startedAt: 60100 },
    { pid: 600, ppid: 100, name: 'powershell.exe', startedAt: 2000 },   // tab E: agy
    { pid: 610, ppid: 600, name: 'agy.EXE', startedAt: 70000 },
    { pid: 620, ppid: 610, name: 'agy.EXE', startedAt: 70100 }];
  const chats = [
    { cmd: '', id: SID_A, path: 'C:\\s\\a\\events.jsonl', cwd: 'C:\\a', mtimeMs: 90000, pids: [999] },   // another process
    { cmd: '', id: SID_B, path: 'C:\\s\\b\\events.jsonl', cwd: 'C:\\b', mtimeMs: 61000, pids: [520] },
  ];
  const c = findCopilotSession(chats, tree, 500, [{ pid: 500, cmd: 'copilot2', startedAt: 59000 }]);
  assert.deepStrictEqual({ kind: c.kind, cmd: c.cmd, pid: c.pid, sessionId: c.sessionId, cwd: c.cwd, rolloutPath: c.rolloutPath },
    { kind: 'copilot', cmd: 'copilot2', pid: 520, sessionId: SID_B, cwd: 'C:\\b', rolloutPath: 'C:\\s\\b\\events.jsonl' });
  assert.strictEqual(findCopilotSession(chats, tree, 500).cmd, 'copilot');
  assert.strictEqual(findCopilotSession(chats, tree, 400), null);   // tab C runs codex, not copilot
  const convs = [
    { cmd: '', id: SID_A, path: 'C:\\g\\a.jsonl', cwd: 'C:\\a', mtimeMs: 99000, pids: [] },            // left open by nobody
    { cmd: '', id: SID_B, path: 'C:\\g\\b.jsonl', cwd: 'C:\\b', mtimeMs: 71000, pids: [620] },         // agy's worker holds it
  ];
  const a = findAgySession(convs, tree, 600, [], 'agy1');
  assert.deepStrictEqual({ kind: a.kind, cmd: a.cmd, pid: a.pid, sessionId: a.sessionId }, { kind: 'agy', cmd: 'agy1', pid: 610, sessionId: SID_B });
  assert.strictEqual(findAgySession(convs.map(({ pids, ...rest }) => rest), tree, 600).sessionId, SID_A);   // holders unknown: newest
  const all = findSession({ copilotChats: chats, agyConversations: convs }, tree, 600);
  assert.strictEqual(all.kind, 'agy');
});

test('describeAccounts reports login state and email per discovered config dir, including codex ones', () => {
  const home = 'C:\\h';
  const token = `x.${Buffer.from(JSON.stringify({ email: 'codex@example.com' })).toString('base64url')}.y`;
  const io = {
    listDir: (p) => (p === home ? ['.claude-1', '.claude-2', '.codex', '.codex-3'] : []),
    exists: (p) => p === path.join(home, '.claude-1', '.credentials.json'),
    readJson: (p) => {
      if (p === path.join(home, '.claude-1', '.claude.json')) return { oauthAccount: { emailAddress: 'one@example.com' } };
      if (p === path.join(home, '.claude.json')) return { oauthAccount: { emailAddress: 'plain@example.com' } };
      if (p === path.join(home, '.codex', 'auth.json')) return { tokens: { id_token: token } };
      return null;
    },
  };
  const list = describeAccounts(home, io);
  assert.deepStrictEqual(list.map((a) => a.cmd), ['claude', 'claude1', 'claude2', 'codex', 'codex3', 'agy', 'copilot']);
  const one = list.find((a) => a.cmd === 'claude1');
  assert.deepStrictEqual({ loggedIn: one.loggedIn, email: one.email, configDir: one.configDir },
    { loggedIn: true, email: 'one@example.com', configDir: path.join(home, '.claude-1') });
  const two = list.find((a) => a.cmd === 'claude2');
  assert.deepStrictEqual({ loggedIn: two.loggedIn, email: two.email }, { loggedIn: false, email: '' });
  const plain = list.find((a) => a.cmd === 'claude');
  assert.deepStrictEqual({ loggedIn: plain.loggedIn, email: plain.email }, { loggedIn: false, email: 'plain@example.com' });
  const codex = list.find((a) => a.cmd === 'codex');
  assert.deepStrictEqual({ loggedIn: codex.loggedIn, email: codex.email, kind: codex.kind, configDir: codex.configDir },
    { loggedIn: true, email: 'codex@example.com', kind: 'codex', configDir: path.join(home, '.codex') });
  const three = list.find((a) => a.cmd === 'codex3');
  assert.deepStrictEqual({ loggedIn: three.loggedIn, email: three.email }, { loggedIn: false, email: '' });
  const apiKey = describeAccounts(home, { listDir: () => [], exists: () => false, readJson: (p) => (p.endsWith('auth.json') ? { OPENAI_API_KEY: 'sk' } : null) }).find((a) => a.cmd === 'codex');
  assert.deepStrictEqual({ loggedIn: apiKey.loggedIn, email: apiKey.email }, { loggedIn: true, email: 'API key' });
  const emptyAuth = describeAccounts(home, { listDir: () => [], exists: () => false, readJson: (p) => (p.endsWith('auth.json') ? {} : null) }).find((a) => a.cmd === 'codex');
  assert.strictEqual(emptyAuth.loggedIn, false);
  assert.strictEqual(jwtEmail('garbage'), '');
});

test('signInHints names the accounts not yet signed in plus one new number per kind', () => {
  const described = [
    { cmd: 'claude', kind: 'claude', number: 0, loggedIn: true },
    { cmd: 'claude1', kind: 'claude', number: 1, loggedIn: true },
    { cmd: 'claude2', kind: 'claude', number: 2, loggedIn: false },
    { cmd: 'claude5', kind: 'claude', number: 5, loggedIn: true },
    { cmd: 'codex', kind: 'codex', number: 0, loggedIn: false },
  ];
  assert.deepStrictEqual(signInHints(described), ['claude2', 'claude6', 'codex', 'codex1']);
  assert.deepStrictEqual(signInHints([{ cmd: 'claude', kind: 'claude', number: 0, loggedIn: true }, { cmd: 'codex', kind: 'codex', number: 0, loggedIn: true }]), ['claude1', 'codex1']);
});
