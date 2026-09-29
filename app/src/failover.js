// Account failover: notice that the agent in a tab has hit its usage limit and
// offer to move the chat to another signed-in account (the same move as
// picking one in the tab menu). No Electron dependencies; main.js supplies the
// I/O through createFailover(). Unit tested by tests/failover.test.js.
//
// Two signals:
//   - the agent's own limit message in the tab's output. Only a bounded tail
//     of recent output is kept and scanned, and only when the text "limit"
//     went by, so a busy tab costs next to nothing.
//   - the tab's account showing 0% left for its 5-hour or weekly window when
//     usage is read anyway (the tab menu reads it; nothing extra polls).
//
// The messages, as the agents print them (curly or straight apostrophe):
//   Claude Code 2.1.x: "You've hit your session limit · resets 3pm (Europe/London)",
//     likewise "weekly limit", "Opus limit", "Sonnet limit", "usage limit" and
//     plain "You've hit your limit · resets ..."; its status line "Usage limit
//     reached · continuing automatically at 3pm".
//   Claude Code 1.x/2.0: "5-hour limit reached ∙ resets 3pm", "Weekly limit
//     reached ∙ resets Oct 7, 9am", "Opus weekly limit reached ∙ ...", and
//     "Claude AI usage limit reached|<unix time>" / "Claude usage limit
//     reached. Your limit will reset at 3pm".
//   Codex (codex-rs/protocol/src/error.rs): "You’ve hit your usage limit. ...
//     or try again at 3:02 PM." (also "... for <model>. Switch to another model
//     now, or try again at ...", "Try again later.").
// Not these, which another account doesn't fix: Claude's fast-mode limit,
// context limit and spend caps; Codex's "You hit your spend cap".

const TAIL_CHARS = 4096;
const MUTE_AFTER_SWITCH_MS = 30 * 1000; // a resumed chat may replay the old message
const MAX_REMEMBERED = 32;
const MODES = ['offer', 'auto', 'off'];

// Terminal output as the lines a person would read: OSC and other escapes
// dropped, cursor moves turned into line breaks (a TUI positions each line
// rather than printing a newline) and cursor-forward/erase-chars into a space
// (ConPTY draws runs of blanks that way).
function plainText(raw) {
  return String(raw)
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*([@-~])/g, (_m, fin) => ('HfABEFd'.includes(fin) ? '\n' : 'CX'.includes(fin) ? ' ' : ''))
    .replace(/\x1b[@-_]?/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');
}

// Gutter marks an agent puts before a message (Claude's ⎿, Codex's ■, a
// box's │). Anything else before it on the line, a quote say, means the text
// is being shown or discussed rather than said, and doesn't count.
const LEAD = String.raw`(?:^|\n)[ \t⎿■●•✗✘×⚠│┃|>*·∙-]*`;
const APOS = `['’]`;
const PATTERNS = [
  // Claude Code 2.1: "You've hit your session limit", and Codex's "usage limit".
  { re: new RegExp(`${LEAD}(you${APOS}ve hit your (?:(session|weekly|opus|sonnet|fable) |usage )?limit)\\b`, 'i'), window: (m) => windowOf(m[2]) },
  // Older Claude Code: "5-hour limit reached ∙ resets 3pm".
  { re: new RegExp(`${LEAD}((5-hour|weekly|opus weekly|sonnet weekly|session) limit reached)\\b`, 'i'), window: (m) => windowOf(m[2]) },
  // "Claude AI usage limit reached|1759...", "Usage limit reached · ...".
  { re: new RegExp(`${LEAD}((?:claude (?:ai )?)?usage limit reached)`, 'i'), window: () => null },
];

function windowOf(word) {
  const w = String(word || '').toLowerCase();
  if (w === 'session' || w === '5-hour') return 'fiveHour';
  if (w) return 'weekly'; // weekly, and the per-model weekly ones
  return null;
}

// The first limit message in `text` (already plainText), or null:
// { window: 'fiveHour' | 'weekly' | null, resets: '3pm (Europe/London)' | null,
//   resetsAt: ISO time | null, line: the message line }.
function findLimitMessage(text) {
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    const start = m.index + m[0].length - m[1].length;
    const end = text.indexOf('\n', start);
    const line = text.slice(start, end === -1 ? undefined : end).replace(/\s+/g, ' ').trim();
    const rest = line.slice(m[1].length);
    let resets = null;
    let resetsAt = null;
    const epoch = /^\|(\d{10})\b/.exec(rest);
    if (epoch) resetsAt = new Date(Number(epoch[1]) * 1000).toISOString();
    const when = /\b(?:resets?|try again|continuing automatically)(?: at| in)?\s+(.+?)\s*(?:[·∙•]|\.(?:\s|$)|$)/i.exec(rest);
    if (when && !/^later\b/i.test(when[1])) resets = when[1].slice(0, 48);
    // Still arriving if nothing follows it yet: the reset time may be next.
    return { window: p.window(m), resets, resetsAt, line, complete: end !== -1 };
  }
  return null;
}

// Watches one tab's output. feed(chunk) returns a limit message the first
// time it is seen, then null for the same message (a TUI redraws it; a resumed
// chat replays it) and for anything within a while of mute().
function createLimitWatcher({ tail = TAIL_CHARS, now = Date.now } = {}) {
  let buf = '';
  let pending = false;
  let mutedUntil = 0;
  const seen = new Set();
  return {
    feed(chunk) {
      const data = String(chunk || '');
      if (!data) return null;
      buf = (buf + data).slice(-tail);
      // Cheap gate: only parse when "limit" is in what just arrived (with a few
      // chars before it, for a word split across chunks), or while a message
      // found earlier waits for the rest of its line.
      if (!pending && !/limit/i.test(buf.slice(-(data.length + 8)))) return null;
      const hit = findLimitMessage(plainText(buf));
      pending = !!hit && !hit.complete;
      if (!hit || pending) return null;
      buf = '';
      const key = keyOf(hit.line);
      if (now() < mutedUntil || seen.has(key)) { seen.add(key); return null; }
      remember(seen, key);
      return { ...hit, key };
    },
    // Once an event has been dealt with elsewhere (the usage signal).
    remember: (key) => remember(seen, key),
    seen: (key) => seen.has(key),
    mute(ms = MUTE_AFTER_SWITCH_MS) { mutedUntil = now() + ms; buf = ''; pending = false; },
  };
}

const keyOf = (line) => String(line).toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ').trim();

function remember(set, key) {
  set.add(key);
  while (set.size > MAX_REMEMBERED) set.delete(set.values().next().value);
}

// Which window of a usage.js result is used up: 'fiveHour', 'weekly' or null.
// Both at once: the weekly one, which lasts longer.
function exhaustedWindow(u) {
  if (!u || u.error) return null;
  if (u.weekly && u.weekly.left <= 0) return 'weekly';
  if (u.fiveHour && u.fiveHour.left <= 0) return 'fiveHour';
  return null;
}

const hasNumbers = (u) => !!(u && !u.error && (u.fiveHour || u.weekly));

// The best account to move to, or null. `accounts` are describeAccounts() rows
// ({ cmd, kind, loggedIn }), `usage` is { cmd: usage.js result }, `window` the
// one that ran out ('fiveHour' | 'weekly' | null). In order: the same agent's
// accounts with room, most left on that window first (either window counts
// when it's not known which); then other agents' with room; then accounts
// whose usage can't be read (the same agent first; agy and Copilot, which
// never report any, last). Accounts at 0% on any window are skipped.
function chooseTarget({ current, accounts, usage = {}, window = null }) {
  const kind = current && current.kind;
  const score = (u) => {
    const lefts = [u.fiveHour, u.weekly].filter(Boolean).map((w) => w.left);
    const binding = window && u[window] ? u[window].left : Math.min(...lefts);
    return [binding, Math.min(...lefts)];
  };
  const known = [];
  const unknown = [];
  for (const a of accounts) {
    if (!a.loggedIn || (current && a.cmd === current.cmd)) continue;
    const u = usage[a.cmd];
    if (hasNumbers(u)) {
      if (exhaustedWindow(u)) continue;
      known.push({ a, u, s: score(u) });
    } else {
      unknown.push({ a, u });
    }
  }
  known.sort((x, y) => (Number(y.a.kind === kind) - Number(x.a.kind === kind)) || (y.s[0] - x.s[0]) || (y.s[1] - x.s[1]));
  const rank = (a) => (a.kind === kind ? 0 : a.kind === 'claude' || a.kind === 'codex' ? 1 : 2);
  unknown.sort((x, y) => rank(x.a) - rank(y.a));
  const pick = known[0] || unknown[0];
  if (!pick) return null;
  return { cmd: pick.a.cmd, kind: pick.a.kind, usage: hasNumbers(pick.u) ? pick.u : null, label: usageLabel(pick.u, window) };
}

// "5h 88% left", "5h 88% · wk 70% left" when the window isn't known, "usage unknown".
function usageLabel(u, window) {
  if (!hasNumbers(u)) return 'usage unknown';
  const short = { fiveHour: '5h', weekly: 'wk' };
  if (window && u[window]) return `${short[window]} ${u[window].left}% left`;
  return `${['fiveHour', 'weekly'].filter((w) => u[w]).map((w) => `${short[w]} ${u[w].left}%`).join(' · ')} left`;
}

// "3:00 pm" today, "Oct 7, 3:00 pm" another day (local time).
function formatReset(iso, now = new Date()) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  const time = `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}, ${time}`;
}

const WINDOW_NAMES = { fiveHour: '5-hour limit', weekly: 'weekly limit' };

// "claude1 hit its 5-hour limit (resets 3:00 pm)." `resets` is the agent's own
// wording, used when usage gave no time.
function limitText({ from, window, resetsAt, resets, now = new Date() }) {
  const when = formatReset(resetsAt, now) || resets || '';
  return `${from} hit its ${WINDOW_NAMES[window] || 'usage limit'}${when ? ` (resets ${when})` : ''}.`;
}

// The banner's text: "claude1 hit its 5-hour limit (resets 3:00 pm). Move this
// chat to claude2 (5h 88% left)?"
function offerText({ target, ...limit }) {
  const head = limitText(limit);
  if (!target) return `${head} No other signed-in account has room left.`;
  return `${head} Move this chat to ${target.cmd} (${target.label})?`;
}

// The wiring, with main.js's I/O passed in:
//   mode()           'offer' | 'auto' | 'off', asked at every event
//   detect(sess)     Promise<{ cmd, kind } | null>: the agent running in the tab
//   accounts()       describeAccounts() rows
//   usage(freshCmd)  Promise<[{ cmd, usage }]>, re-reading freshCmd's
//   offer(sess, p)   show the banner: { text, to } (to null: nothing to move to),
//                    or { clear: true } to take it down
//   note(sess, text) a line in the terminal
//   switchTo(sess, cmd) Promise<{ ok }>: the tab menu's move
function createFailover(deps) {
  const state = new WeakMap(); // sess -> { watcher, current, busy }
  const now = deps.now || Date.now;
  const of = (sess) => {
    let s = state.get(sess);
    if (!s) { s = { watcher: createLimitWatcher({ now }), current: null, busy: false }; state.set(sess, s); }
    return s;
  };
  const mode = () => {
    const m = deps.mode();
    return MODES.includes(m) ? m : 'offer';
  };

  async function limitHit(sess, s, { window, resets, resetsAt, current }) {
    if (s.busy) return;
    s.busy = true;
    try {
      const cur = current || await deps.detect(sess);
      if (!cur) return; // the agent is gone: nothing to move
      s.current = cur;
      const rows = await deps.usage(cur.cmd);
      const usage = Object.fromEntries((rows || []).map((r) => [r.cmd, r.usage]));
      const mine = usage[cur.cmd];
      const win = window || exhaustedWindow(mine);
      const at = resetsAt || (win && mine && mine[win] && mine[win].resetsAt) || null;
      const target = chooseTarget({ current: cur, accounts: deps.accounts(), usage, window: win });
      const limit = { from: cur.cmd, window: win, resetsAt: at, resets, now: new Date(now()) };
      const m = mode();
      if (m === 'off') return;
      if (m === 'auto' && target) {
        deps.note(sess, `${limitText(limit)} Moving this chat to ${target.cmd} (${target.label}).`);
        const r = await deps.switchTo(sess, target.cmd);
        if (r && r.ok) switched(sess);
        return;
      }
      deps.offer(sess, { text: offerText({ ...limit, target }), to: target ? target.cmd : null });
    } finally {
      s.busy = false;
    }
  }

  // Every chunk of output the tab shows.
  function output(sess, data) {
    if (mode() === 'off') return;
    const s = of(sess);
    const hit = s.watcher.feed(data);
    if (hit) limitHit(sess, s, hit).catch(() => {});
  }

  // The tab menu found which account the tab's agent is on. It reads usage at
  // the same time, and either may land first.
  function sessionSeen(sess, found) {
    const s = of(sess);
    s.current = found ? { cmd: found.cmd, kind: found.kind } : null;
    checkUsage(sess, s);
  }

  // Usage was read (the tab menu): is the tab's own account used up?
  function usageSeen(sess, rows) {
    const s = of(sess);
    s.rows = rows || [];
    checkUsage(sess, s);
  }

  function checkUsage(sess, s) {
    if (mode() === 'off') return;
    const cur = s.current;
    const row = cur && (s.rows || []).find((r) => r.cmd === cur.cmd);
    const win = row && exhaustedWindow(row.usage);
    if (!win) return;
    const key = `usage:${cur.cmd}:${win}:${row.usage[win].resetsAt || ''}`;
    if (s.watcher.seen(key)) return;
    s.watcher.remember(key);
    limitHit(sess, s, { window: win, current: cur }).catch(() => {});
  }

  // The chat moved (from the banner, the menu or auto): drop the banner and
  // ignore the resumed chat replaying the old message.
  function switched(sess) {
    const s = of(sess);
    s.current = null;
    s.watcher.mute();
    deps.offer(sess, { clear: true });
  }

  return { output, sessionSeen, usageSeen, switched };
}

module.exports = {
  TAIL_CHARS, MODES, plainText, findLimitMessage, createLimitWatcher, exhaustedWindow,
  chooseTarget, usageLabel, formatReset, limitText, offerText, createFailover,
};
