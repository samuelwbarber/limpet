// Usage limits per account: how much of the 5-hour and weekly windows is left,
// the way `/usage` in Claude Code and `/status` in Codex show it. Read with the
// account's own stored login, nothing is refreshed or written back: an expired
// token is reported as such (running the agent refreshes it). No Electron
// dependencies; unit tested with a fake fetch in tests/usage.test.js.
//
//   Claude: GET https://api.anthropic.com/api/oauth/usage with the OAuth access
//           token from <config dir>/.credentials.json (macOS: the login
//           Keychain, see platform.readClaudeCredentials) -> five_hour / seven_day,
//           each { utilization (0-100), resets_at }.
//   Codex:  GET https://chatgpt.com/backend-api/wham/usage with the ChatGPT
//           access token from <codex home>/auth.json -> rate_limit.primary_window
//           / secondary_window, each { used_percent, limit_window_seconds,
//           reset_at (unix seconds) }; which is the 5-hour one depends on the
//           plan, so they are told apart by length.
//
// Result shape: { fiveHour: { left, resetsAt } | null, weekly: { ... } | null,
// plan: '' } or { error: 'why' }. `left` is whole percent remaining.

const path = require('path');

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const SIX_HOURS = 6 * 3600;

const left = (usedPercent) => Math.max(0, Math.min(100, Math.round(100 - Number(usedPercent))));

function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch (_) { return null; }
}

function parseClaudeUsage(doc, plan = '') {
  const win = (w) => (w && typeof w.utilization === 'number' ? { left: left(w.utilization), resetsAt: w.resets_at || null } : null);
  if (!doc || typeof doc !== 'object') return { error: 'unexpected reply' };
  return { fiveHour: win(doc.five_hour), weekly: win(doc.seven_day), plan };
}

const titleCase = (s) => String(s).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

// A Claude plan for people: the name Claude Code shows (oauthAccount's
// planDisplayName, passed in as `display`), else the stored login's
// subscriptionType with the multiplier from rateLimitTier ("Max 20x").
function claudePlanLabel(oauth, display = '') {
  if (display) return String(display);
  const type = oauth && typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : '';
  if (!type) return '';
  const x = /_(\d+x)$/.exec(String((oauth && oauth.rateLimitTier) || ''));
  return `${titleCase(type)}${x ? ` ${x[1]}` : ''}`;
}

// ChatGPT's plan_type for people: prolite -> Pro Lite, plus -> Plus, ...
const CODEX_PLANS = { prolite: 'Pro Lite', pro: 'Pro', plus: 'Plus', free: 'Free', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', go: 'Go' };
const codexPlanLabel = (type) => (typeof type === 'string' && type ? CODEX_PLANS[type.toLowerCase()] || titleCase(type) : '');

function parseCodexUsage(doc) {
  const rl = doc && doc.rate_limit;
  if (!rl || typeof rl !== 'object') return { error: 'unexpected reply' };
  const windows = [rl.primary_window, rl.secondary_window].filter((w) => w && typeof w.used_percent === 'number');
  const win = (w) => (w ? { left: left(w.used_percent), resetsAt: w.reset_at ? new Date(Number(w.reset_at) * 1000).toISOString() : null } : null);
  return {
    fiveHour: win(windows.find((w) => Number(w.limit_window_seconds) <= SIX_HOURS)),
    weekly: win(windows.find((w) => Number(w.limit_window_seconds) > SIX_HOURS)),
    plan: codexPlanLabel(doc.plan_type),
  };
}

async function get(fetchImpl, url, headers, timeoutMs) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl(url, { headers: { 'User-Agent': 'limpet', ...headers }, signal: ctl ? ctl.signal : undefined });
    if (r.status === 401 || r.status === 403) return { error: 'sign-in expired' };
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return { doc: await r.json() };
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? 'timed out' : 'offline' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// `account` is one of describeAccounts()'s rows (kind, cmd, configDir).
async function readUsage(account, io, { fetchImpl = globalThis.fetch, timeoutMs = 8000, now = Date.now() } = {}) {
  if (account.kind === 'agy' || account.kind === 'copilot' || account.kind === 'opencode') return { error: 'limpet has no way to read this agent\'s limits' };
  if (account.kind === 'codex') {
    const auth = io.readJson(path.join(account.configDir, 'auth.json'));
    const tokens = auth && auth.tokens;
    if (!tokens || !tokens.access_token) return { error: auth && auth.OPENAI_API_KEY ? 'API key: no limits' : 'not signed in' };
    const claims = jwtClaims(tokens.access_token);
    if (claims && claims.exp && claims.exp * 1000 < now) return { error: `sign-in expired; run ${account.cmd} to refresh` };
    const res = await get(fetchImpl, CODEX_USAGE_URL, {
      Authorization: `Bearer ${tokens.access_token}`, 'ChatGPT-Account-Id': tokens.account_id || '',
    }, timeoutMs);
    return res.error ? res : parseCodexUsage(res.doc);
  }
  // .credentials.json, or on macOS the Keychain item (io.claudeCredentials, platform.js).
  const creds = io.readJson(path.join(account.configDir, '.credentials.json'))
    || (io.claudeCredentials ? io.claudeCredentials(account.configDir, account.number === 0) : null);
  const oauth = creds && creds.claudeAiOauth;
  if (!oauth || !oauth.accessToken) return { error: 'not signed in' };
  if (oauth.expiresAt && Number(oauth.expiresAt) < now) return { error: `sign-in expired; run ${account.cmd} to refresh` };
  const res = await get(fetchImpl, CLAUDE_USAGE_URL, {
    Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20',
  }, timeoutMs);
  return res.error ? res : parseClaudeUsage(res.doc, claudePlanLabel(oauth, account.plan));
}

module.exports = { CLAUDE_USAGE_URL, CODEX_USAGE_URL, parseClaudeUsage, parseCodexUsage, readUsage, jwtClaims, claudePlanLabel, codexPlanLabel };
