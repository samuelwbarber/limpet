// Unit tests for the usage-limit reader (src/usage.js), against a fake fetch.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { parseClaudeUsage, parseCodexUsage, readUsage, CLAUDE_USAGE_URL, CODEX_USAGE_URL } = require('../src/usage');

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('parseClaudeUsage turns utilisation into percent left per window', () => {
  const r = parseClaudeUsage({ five_hour: { utilization: 12.0, resets_at: '2026-09-18T18:50:00+00:00' }, seven_day: { utilization: 100.0, resets_at: '2026-09-25T00:00:00+00:00' }, seven_day_opus: null });
  assert.deepStrictEqual(r, { fiveHour: { left: 88, resetsAt: '2026-09-18T18:50:00+00:00' }, weekly: { left: 0, resetsAt: '2026-09-25T00:00:00+00:00' }, plan: '' });
  assert.deepStrictEqual(parseClaudeUsage({ five_hour: { utilization: 0.0, resets_at: null }, seven_day: null }), { fiveHour: { left: 100, resetsAt: null }, weekly: null, plan: '' });
  assert.deepStrictEqual(parseClaudeUsage('nope'), { error: 'unexpected reply' });
});

test('parseCodexUsage tells the 5-hour and weekly windows apart by length, whichever is primary', () => {
  const plus = parseCodexUsage({ plan_type: 'plus', rate_limit: {
    primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: 1790000000 },
    secondary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: 1790500000 },
  } });
  assert.deepStrictEqual(plus, { fiveHour: { left: 60, resetsAt: new Date(1790000000000).toISOString() }, weekly: { left: 95, resetsAt: new Date(1790500000000).toISOString() }, plan: 'plus' });
  // A plan with a single weekly window and nothing else.
  const lite = parseCodexUsage({ plan_type: 'prolite', rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1790081311 }, secondary_window: null } });
  assert.deepStrictEqual(lite, { fiveHour: null, weekly: { left: 0, resetsAt: new Date(1790081311000).toISOString() }, plan: 'prolite' });
  assert.deepStrictEqual(parseCodexUsage({}), { error: 'unexpected reply' });
});

test('readUsage sends each account its own stored token and reports expiry without going online', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization, acct: opts.headers['ChatGPT-Account-Id'], beta: opts.headers['anthropic-beta'] });
    if (url === CLAUDE_USAGE_URL) return reply(200, { five_hour: { utilization: 30, resets_at: null }, seven_day: { utilization: 10, resets_at: null } });
    if (url === CODEX_USAGE_URL) return reply(200, { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 0 }, secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 0 } } });
    return reply(404, {});
  };
  const now = 1_000_000_000_000;
  const files = {
    [path.join('C:\\h', '.claude-1', '.credentials.json')]: { claudeAiOauth: { accessToken: 'tokA', expiresAt: now + 1000 } },
    [path.join('C:\\h', '.claude-2', '.credentials.json')]: { claudeAiOauth: { accessToken: 'tokB', expiresAt: now - 1 } },
    [path.join('C:\\h', '.codex', 'auth.json')]: { tokens: { access_token: jwt({ exp: now / 1000 + 60 }), account_id: 'acct-1' } },
    [path.join('C:\\h', '.codex-1', 'auth.json')]: { tokens: { access_token: jwt({ exp: now / 1000 - 60 }), account_id: 'acct-2' } },
    [path.join('C:\\h', '.codex-2', 'auth.json')]: { OPENAI_API_KEY: 'sk' },
  };
  const io = { readJson: (p) => files[p] || null };
  const opts = { fetchImpl, now };
  const acct = (kind, cmd, dir) => ({ kind, cmd, configDir: path.join('C:\\h', dir) });

  assert.deepStrictEqual(await readUsage(acct('claude', 'claude1', '.claude-1'), io, opts), { fiveHour: { left: 70, resetsAt: null }, weekly: { left: 90, resetsAt: null }, plan: '' });
  assert.deepStrictEqual(await readUsage(acct('claude', 'claude2', '.claude-2'), io, opts), { error: 'sign-in expired; run claude2 to refresh' });
  assert.deepStrictEqual(await readUsage(acct('claude', 'claude3', '.claude-3'), io, opts), { error: 'not signed in' });
  assert.deepStrictEqual(await readUsage(acct('codex', 'codex', '.codex'), io, opts), { fiveHour: { left: 99, resetsAt: null }, weekly: { left: 98, resetsAt: null }, plan: 'pro' });
  assert.deepStrictEqual(await readUsage(acct('codex', 'codex1', '.codex-1'), io, opts), { error: 'sign-in expired; run codex1 to refresh' });
  assert.deepStrictEqual(await readUsage(acct('codex', 'codex2', '.codex-2'), io, opts), { error: 'API key: no limits' });
  assert.deepStrictEqual(calls, [
    { url: CLAUDE_USAGE_URL, auth: 'Bearer tokA', acct: undefined, beta: 'oauth-2025-04-20' },
    { url: CODEX_USAGE_URL, auth: `Bearer ${files[path.join('C:\\h', '.codex', 'auth.json')].tokens.access_token}`, acct: 'acct-1', beta: undefined },
  ]);
});

test('readUsage reports a rejected token, an HTTP error and an outage as errors, never throws', async () => {
  const io = { readJson: () => ({ claudeAiOauth: { accessToken: 't' } }) };
  const a = { kind: 'claude', cmd: 'claude', configDir: 'C:\\h\\.claude' };
  assert.deepStrictEqual(await readUsage(a, io, { fetchImpl: async () => reply(401, {}) }), { error: 'sign-in expired' });
  assert.deepStrictEqual(await readUsage(a, io, { fetchImpl: async () => reply(500, {}) }), { error: 'HTTP 500' });
  assert.deepStrictEqual(await readUsage(a, io, { fetchImpl: async () => { throw new Error('ENOTFOUND'); } }), { error: 'offline' });
  assert.deepStrictEqual(await readUsage(a, io, { fetchImpl: async () => reply(200, null) }), { error: 'unexpected reply' });
});
