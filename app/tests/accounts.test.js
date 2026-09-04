// Unit tests for the agent/account-switch logic (src/accounts.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  ACCOUNTS, describeAccounts, descendants, findClaudeSession, findCodexSession, findSession, launchCommand, psQuote, jwtEmail,
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
  { cmd: 'claude2', info: { pid: 999, sessionId: SID_A, status: 'idle', kind: 'interactive', updatedAt: 99 } },
];
const T_OLD = '01a00000-0000-7000-8000-000000000001';
const T_NEW = '01a00000-0000-7000-8000-000000000002';
const rollouts = [
  { id: T_OLD, path: 'C:\\r\\old.jsonl', cwd: 'C:\\c', mtimeMs: 40000 },   // finished before codex started
  { id: T_NEW, path: 'C:\\r\\new.jsonl', cwd: 'C:\\c', mtimeMs: 60000 },
  { id: 'bogus', path: 'C:\\r\\x.jsonl', cwd: 'C:\\c', mtimeMs: 70000 },
];

test('the account list has the three Claude logins and codex, with kinds', () => {
  assert.deepStrictEqual(ACCOUNTS.map((a) => `${a.cmd}:${a.kind}`), ['claude:claude', 'claude1:claude', 'claude2:claude', 'codex:codex']);
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

test('findCodexSession pairs the codex process under the tab with the rollout written since it started', () => {
  const c = findCodexSession(rollouts, procs, 400);
  assert.deepStrictEqual({ kind: c.kind, cmd: c.cmd, pid: c.pid, sessionId: c.sessionId, rolloutPath: c.rolloutPath, cwd: c.cwd },
    { kind: 'codex', cmd: 'codex', pid: 420, sessionId: T_NEW, rolloutPath: 'C:\\r\\new.jsonl', cwd: 'C:\\c' });
  assert.strictEqual(findCodexSession(rollouts, procs, 200), null); // no codex under tab A
  const noRollout = findCodexSession([], procs, 400);
  assert.deepStrictEqual({ pid: noRollout.pid, sessionId: noRollout.sessionId }, { pid: 420, sessionId: null });
});

test('findSession reports whichever agent runs under the shell, Claude first', () => {
  const input = { sessionFiles: files, rollouts };
  assert.strictEqual(findSession(input, procs, 200).kind, 'claude');
  assert.strictEqual(findSession(input, procs, 400).kind, 'codex');
  assert.strictEqual(findSession(input, procs, 999), null);
});

test('launchCommand builds resume, handoff-prompt and fresh-start lines per agent', () => {
  assert.strictEqual(launchCommand('claude2', { resume: SID_A }), `claude2 --resume ${SID_A}`);
  assert.strictEqual(launchCommand('codex', { resume: T_NEW }), `codex resume ${T_NEW}`);
  assert.strictEqual(launchCommand('claude', {}), 'claude');
  assert.strictEqual(launchCommand('codex'), 'codex');
  assert.strictEqual(launchCommand('codex', { prompt: "it's here", addDir: 'C:\\h' }), "codex 'it''s here'");
  assert.strictEqual(launchCommand('claude1', { prompt: 'go on', addDir: 'C:\\h o' }), "claude1 --add-dir 'C:\\h o' 'go on'");
  assert.throws(() => launchCommand('claude2', { resume: 'x; Remove-Item -Recurse C:\\' }), /not a session id/);
  assert.throws(() => launchCommand('claude9', { resume: SID_A }), /unknown account/);
  assert.throws(() => launchCommand('codex', { prompt: 'two\nlines' }), /single line/);
  assert.strictEqual(psQuote("a'b"), "'a''b'");
});

test('describeAccounts reports login state and email per config dir, including codex', () => {
  const home = 'C:\\h';
  const token = `x.${Buffer.from(JSON.stringify({ email: 'codex@example.com' })).toString('base64url')}.y`;
  const io = {
    exists: (p) => p === path.join(home, '.claude-1', '.credentials.json'),
    readJson: (p) => {
      if (p === path.join(home, '.claude-1', '.claude.json')) return { oauthAccount: { emailAddress: 'one@example.com' } };
      if (p === path.join(home, '.claude.json')) return { oauthAccount: { emailAddress: 'plain@example.com' } };
      if (p === path.join(home, '.codex', 'auth.json')) return { tokens: { id_token: token } };
      return null;
    },
  };
  const list = describeAccounts(home, io);
  assert.deepStrictEqual(list.map((a) => a.cmd), ACCOUNTS.map((a) => a.cmd));
  const one = list.find((a) => a.cmd === 'claude1');
  assert.deepStrictEqual({ loggedIn: one.loggedIn, email: one.email, configDir: one.configDir },
    { loggedIn: true, email: 'one@example.com', configDir: path.join(home, '.claude-1') });
  const two = list.find((a) => a.cmd === 'claude2');
  assert.deepStrictEqual({ loggedIn: two.loggedIn, email: two.email }, { loggedIn: false, email: '' });
  const plain = list.find((a) => a.cmd === 'claude');
  assert.deepStrictEqual({ loggedIn: plain.loggedIn, email: plain.email }, { loggedIn: false, email: 'plain@example.com' });
  const codex = list.find((a) => a.cmd === 'codex');
  assert.deepStrictEqual({ loggedIn: codex.loggedIn, email: codex.email, kind: codex.kind }, { loggedIn: true, email: 'codex@example.com', kind: 'codex' });
  const apiKey = describeAccounts(home, { exists: () => false, readJson: (p) => (p.endsWith('auth.json') ? { OPENAI_API_KEY: 'sk' } : null) }).find((a) => a.cmd === 'codex');
  assert.deepStrictEqual({ loggedIn: apiKey.loggedIn, email: apiKey.email }, { loggedIn: true, email: 'API key' });
  assert.strictEqual(jwtEmail('garbage'), '');
});
