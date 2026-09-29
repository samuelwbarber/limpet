// Unit tests for account failover (src/failover.js): spotting an agent's limit
// message in raw terminal output, the debounce, and picking an account.
const test = require('node:test');
const assert = require('node:assert');
const {
  plainText, findLimitMessage, createLimitWatcher, exhaustedWindow, chooseTarget, usageLabel,
  formatReset, offerText, createFailover,
} = require('../src/failover');

const ESC = '\x1b';
const u = (five, week, at = {}) => ({ fiveHour: five == null ? null : { left: five, resetsAt: at.five || null }, weekly: week == null ? null : { left: week, resetsAt: at.week || null }, plan: '' });

test('plainText drops escapes and turns cursor moves into line breaks and blanks', () => {
  const raw = `${ESC}]0;title${ESC}\\${ESC}[12;3H${ESC}[38;5;174m⎿${ESC}[1C${ESC}[1CYou've${ESC}[1Chit your${ESC}[0m${ESC}[K\r\nnext`;
  assert.strictEqual(plainText(raw), "\n⎿  You've hit your\nnext");
});

test('findLimitMessage knows Claude Code\'s and Codex\'s limit messages and what they say about the window and reset', () => {
  const cases = [
    ["  ⎿  You've hit your session limit · resets 3pm (Europe/London)", 'fiveHour', '3pm (Europe/London)'],
    ["  ⎿  You’ve hit your weekly limit · resets Oct 7, 9am (Europe/London) · progress saved", 'weekly', 'Oct 7, 9am (Europe/London)'],
    ["⎿ You've hit your Opus limit · resets Oct 7, 9am", 'weekly', 'Oct 7, 9am'],
    ["You've hit your limit · resets 3pm", null, '3pm'],
    ['  ⎿  5-hour limit reached ∙ resets 3pm', 'fiveHour', '3pm'],
    ['Weekly limit reached ∙ resets Oct 7, 9am', 'weekly', 'Oct 7, 9am'],
    ['Claude usage limit reached. Your limit will reset at 3pm (America/New_York).', null, '3pm (America/New_York)'],
    ['Usage limit reached · continuing automatically at 3pm · esc to cancel', null, '3pm'],
    ['■ You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:02 PM.', null, '3:02 PM'],
    ['■ You’ve hit your usage limit. Try again later.', null, null],
    ['You’ve hit your usage limit for codex_other. Switch to another model now, or try again at Oct 7th, 2026 3:02 PM.', null, 'Oct 7th, 2026 3:02 PM'],
  ];
  for (const [line, window, resets] of cases) {
    const hit = findLimitMessage(`some output\n${line}\n> `);
    assert.ok(hit, line);
    assert.strictEqual(hit.window, window, line);
    assert.strictEqual(hit.resets, resets, line);
  }
  assert.strictEqual(findLimitMessage('Claude AI usage limit reached|1790000000').resetsAt, new Date(1790000000000).toISOString());
});

test('findLimitMessage ignores limits another account doesn\'t fix, and the text quoted or discussed', () => {
  for (const line of [
    "You've hit your fast limit · resets in 20m",
    'Fast limit reached and temporarily disabled · resets in 5m',
    'Context limit reached · /compact or /clear to continue',
    "You've hit your monthly spend limit · your session limit resets 3pm",
    "You've hit your team's shared budget",
    'You hit your spend cap set in your workspace. Increase your spend cap to continue.',
    'Goal paused · usage limit reached · send a message after it resets to continue',
    `  const msg = "You've hit your session limit";`,
    'grep: matched "usage limit reached" in 3 files',
  ]) assert.strictEqual(findLimitMessage(`x\n${line}\n`), null, line);
});

test('the watcher finds a message split across chunks and wrapped in colour and cursor moves', () => {
  const w = createLimitWatcher();
  const stream = `${ESC}[?25l${ESC}[41;1H${ESC}[38;2;215;119;87m  ⎿  ${ESC}[39mYou've hit y` + `our ses` + `sion li` + `mit${ESC}[1C·${ESC}[1Cresets 3pm (Europe/London)${ESC}[K${ESC}[42;1H> `;
  const hits = [];
  for (let i = 0; i < stream.length; i += 7) {
    const hit = w.feed(stream.slice(i, i + 7));
    if (hit) hits.push(hit);
  }
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].window, 'fiveHour');
  assert.strictEqual(hits[0].resets, '3pm (Europe/London)');
});

test('the watcher reports each limit event once, ignores what follows a switch, and keeps only a bounded tail', () => {
  let t = 1000;
  const w = createLimitWatcher({ tail: 256, now: () => t });
  const msg = "\n⎿  You've hit your session limit · resets 3pm\n";
  assert.ok(w.feed(msg));
  assert.strictEqual(w.feed(`${ESC}[2J${ESC}[H${msg}`), null, 'a redraw of the same message');
  assert.ok(w.feed("\n⎿  You've hit your weekly limit · resets Oct 7, 9am\n"), 'another event');
  w.mute(30000);
  assert.strictEqual(w.feed("\n⎿  You've hit your session limit · resets 8pm\n"), null, 'the resumed chat replaying');
  t += 31000;
  assert.strictEqual(w.feed("\n⎿  You've hit your session limit · resets 8pm\n"), null, 'still the same event after the mute');
  assert.ok(w.feed("\n■ You’ve hit your usage limit. Try again at 9:15 PM.\n"));
  // A message pushed out of the tail by later output is never seen.
  const late = createLimitWatcher({ tail: 256 });
  assert.strictEqual(late.feed("\nYou've hit your session limit · res"), null, 'waits for the end of the line');
  assert.strictEqual(late.feed(`ets 3pm${'x'.repeat(400)}`), null);
});

test('exhaustedWindow names the used-up window, weekly first', () => {
  assert.strictEqual(exhaustedWindow(u(0, 50)), 'fiveHour');
  assert.strictEqual(exhaustedWindow(u(0, 0)), 'weekly');
  assert.strictEqual(exhaustedWindow(u(3, 50)), null);
  assert.strictEqual(exhaustedWindow({ error: 'offline' }), null);
});

const acct = (cmd, kind, loggedIn = true) => ({ cmd, kind, loggedIn });
const ACCOUNTS = [acct('claude', 'claude'), acct('claude1', 'claude'), acct('claude2', 'claude'), acct('claude3', 'claude', false), acct('codex', 'codex'), acct('agy', 'agy'), acct('copilot1', 'copilot')];

test('chooseTarget prefers the same agent with the most left on the window that ran out', () => {
  const usage = { claude: u(0, 40), claude1: u(20, 90), claude2: u(88, 30), codex: u(100, 100) };
  const t = chooseTarget({ current: { cmd: 'claude', kind: 'claude' }, accounts: ACCOUNTS, usage, window: 'fiveHour' });
  assert.deepStrictEqual({ cmd: t.cmd, label: t.label }, { cmd: 'claude2', label: '5h 88% left' });
  // The weekly window ran out instead: claude1 has more of that.
  assert.strictEqual(chooseTarget({ current: { cmd: 'claude', kind: 'claude' }, accounts: ACCOUNTS, usage, window: 'weekly' }).cmd, 'claude1');
  // Window unknown: the tighter of the two decides.
  const w = chooseTarget({ current: { cmd: 'claude', kind: 'claude' }, accounts: ACCOUNTS, usage, window: null });
  assert.deepStrictEqual({ cmd: w.cmd, label: w.label }, { cmd: 'claude2', label: '5h 88% · wk 30% left' });
});

test('chooseTarget skips used-up and signed-out accounts, then falls back to other agents, then to unknown usage', () => {
  const cur = { cmd: 'claude', kind: 'claude' };
  let usage = { claude: u(0, 40), claude1: u(0, 90), claude2: u(50, 0), claude3: u(100, 100), codex: u(70, 60) };
  assert.strictEqual(chooseTarget({ current: cur, accounts: ACCOUNTS, usage, window: 'fiveHour' }).cmd, 'codex');
  usage = { ...usage, codex: u(0, 60) };
  const t = chooseTarget({ current: cur, accounts: ACCOUNTS, usage, window: 'fiveHour' });
  assert.deepStrictEqual({ cmd: t.cmd, label: t.label }, { cmd: 'agy', label: 'usage unknown' });
  // A same-agent account whose usage can't be read goes before agy and Copilot.
  usage = { ...usage, claude2: { error: 'sign-in expired; run claude2 to refresh' } };
  assert.strictEqual(chooseTarget({ current: cur, accounts: ACCOUNTS, usage, window: 'fiveHour' }).cmd, 'claude2');
  assert.strictEqual(chooseTarget({ current: cur, accounts: [acct('claude', 'claude')], usage, window: 'fiveHour' }), null);
  // Codex's own accounts first for a Codex chat.
  const c = chooseTarget({ current: { cmd: 'codex', kind: 'codex' }, accounts: [...ACCOUNTS, acct('codex1', 'codex')], usage: { codex: u(0, 5), codex1: u(10, 10), claude1: u(90, 90) }, window: 'fiveHour' });
  assert.strictEqual(c.cmd, 'codex1');
});

test('the banner text names the limit, when it resets and where the chat would go', () => {
  const now = new Date(2026, 8, 29, 10, 0);
  assert.strictEqual(formatReset(new Date(2026, 8, 29, 15, 0).toISOString(), now), '3:00 pm');
  assert.strictEqual(formatReset(new Date(2026, 9, 7, 9, 5).toISOString(), now), 'Oct 7, 9:05 am');
  assert.strictEqual(formatReset(null, now), '');
  assert.strictEqual(usageLabel({ error: 'x' }, 'weekly'), 'usage unknown');
  assert.strictEqual(
    offerText({ from: 'claude1', window: 'fiveHour', resetsAt: new Date(2026, 8, 29, 15, 0).toISOString(), target: { cmd: 'claude2', label: '5h 88% left' }, now }),
    'claude1 hit its 5-hour limit (resets 3:00 pm). Move this chat to claude2 (5h 88% left)?',
  );
  assert.strictEqual(offerText({ from: 'codex', window: null, resets: '3:02 PM', target: null, now }), 'codex hit its usage limit (resets 3:02 PM). No other signed-in account has room left.');
});

function harness(mode) {
  const calls = [];
  const deps = {
    mode: () => mode,
    detect: async () => ({ cmd: 'claude1', kind: 'claude' }),
    accounts: () => [acct('claude1', 'claude'), acct('claude2', 'claude')],
    usage: async (fresh) => { calls.push(['usage', fresh]); return [{ cmd: 'claude1', usage: u(0, 50) }, { cmd: 'claude2', usage: u(88, 70) }]; },
    offer: (_s, p) => calls.push(['offer', p]),
    note: (_s, text) => calls.push(['note', text]),
    switchTo: async (_s, cmd) => { calls.push(['switch', cmd]); return { ok: true }; },
  };
  return { calls, f: createFailover(deps) };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test('offer mode puts up the banner once per event; the move and a switch take it down', async () => {
  const { calls, f } = harness('offer');
  const sess = {};
  f.output(sess, "\n⎿  You've hit your session limit · resets 3pm\n");
  await settle();
  f.output(sess, "\n⎿  You've hit your session limit · resets 3pm\n");
  await settle();
  assert.deepStrictEqual(calls, [
    ['usage', 'claude1'],
    ['offer', { text: 'claude1 hit its 5-hour limit (resets 3pm). Move this chat to claude2 (5h 88% left)?', to: 'claude2' }],
  ]);
  f.switched(sess);
  assert.deepStrictEqual(calls.at(-1), ['offer', { clear: true }]);
});

test('the usage signal offers when the tab\'s own account is at 0%, once per reset', async () => {
  const { calls, f } = harness('offer');
  const sess = {};
  f.sessionSeen(sess, { cmd: 'claude1', kind: 'claude' });
  const rows = [{ cmd: 'claude1', usage: u(0, 50) }, { cmd: 'claude2', usage: u(88, 70) }];
  f.usageSeen(sess, rows);
  await settle();
  f.usageSeen(sess, rows);
  await settle();
  assert.strictEqual(calls.filter((c) => c[0] === 'offer').length, 1);
  // Another tab: usage lands before the session is found.
  const other = harness('offer');
  const tab = {};
  other.f.usageSeen(tab, rows);
  await settle();
  assert.deepStrictEqual(other.calls, []);
  other.f.sessionSeen(tab, { cmd: 'claude1', kind: 'claude' });
  await settle();
  assert.deepStrictEqual(other.calls.at(-1), ['offer', { text: 'claude1 hit its 5-hour limit. Move this chat to claude2 (5h 88% left)?', to: 'claude2' }]);
});

test('auto mode moves the chat with a note; off does nothing', async () => {
  const auto = harness('auto');
  auto.f.output({}, "\n⎿  You've hit your session limit · resets 3pm\n");
  await settle();
  assert.deepStrictEqual(auto.calls.filter((c) => c[0] !== 'usage'), [
    ['note', 'claude1 hit its 5-hour limit (resets 3pm). Moving this chat to claude2 (5h 88% left).'],
    ['switch', 'claude2'],
    ['offer', { clear: true }],
  ]);
  const off = harness('off');
  off.f.output({}, "\n⎿  You've hit your session limit · resets 3pm\n");
  off.f.sessionSeen({}, { cmd: 'claude1', kind: 'claude' });
  await settle();
  assert.deepStrictEqual(off.calls, []);
});
