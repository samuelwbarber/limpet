// Focused e2e: right-clicking a tab lists the signed-in accounts (any number
// of claudeN / codexN, discovered from the home dir) with their usage left,
// spots the agent running under that tab's shell, and moving the chat exits it
// and brings the same conversation up under the pick, in the same shell:
//   claude1 -> claude3   resume by session id
//   claude1 -> codex1    Codex's importer (stubbed here), pointed at ~/.codex-1
//   claude1 -> codex     importer fails, so a handoff file
//   codex   -> claude1   a synthesized Claude transcript, resumed
//   codex   -> codex1    the rollout copied into the other home, resumed
// The agents are stood in for by nested PowerShells (detection needs a live
// pid under the tab's shell plus the files the real agents leave behind), the
// launch line is captured instead of run, and usage comes from a fixture.
const { _electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(name, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) failures++;
}
async function waitFor(fn, timeout, every = 250) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}
const screenText = (page) => page.evaluate(() => {
  const el = document.querySelector('.term-pane.active .xterm-rows');
  return el ? el.innerText : '';
});
async function type(page, text) {
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press('Enter');
}
const pidGone = (pid) => { try { process.kill(pid, 0); return false; } catch (_) { return true; } };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

(async () => {
  // A private "home": claude, claude1 and claude3 signed in, claude2's dir
  // there but not signed in; codex and codex1 signed in, codex2's dir empty.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-claude-'));
  const claudeDir = (n) => path.join(home, n ? `.claude-${n}` : '.claude');
  const codexHome = (n) => path.join(home, n ? `.codex-${n}` : '.codex');
  const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;
  for (const [n, email] of [[0, 'plain@example.com'], [1, 'one@example.com'], [3, 'three@example.com']]) {
    fs.mkdirSync(path.join(claudeDir(n), 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir(n), '.credentials.json'), '{}');
    fs.writeFileSync(n ? path.join(claudeDir(n), '.claude.json') : path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  }
  fs.mkdirSync(path.join(claudeDir(2), 'sessions'), { recursive: true });
  for (const [n, email] of [[0, 'codex@example.com'], [1, 'codex1@example.com']]) {
    fs.mkdirSync(path.join(codexHome(n), 'sessions', '2026', '09', '04'), { recursive: true });
    fs.writeFileSync(path.join(codexHome(n), 'auth.json'), JSON.stringify({ tokens: { id_token: idToken(email) } }));
  }
  fs.mkdirSync(codexHome(2), { recursive: true });
  const c1 = claudeDir(1);
  const codexDir = codexHome(0);
  // Usage limits, as usage.js would report them, without going online.
  const fixture = path.join(home, 'usage.json');
  fs.writeFileSync(fixture, JSON.stringify({
    claude1: { fiveHour: { left: 88, resetsAt: new Date(Date.now() + 2 * 3600e3).toISOString() }, weekly: { left: 70, resetsAt: null }, plan: '' },
    claude3: { error: 'sign-in expired; run claude3 to refresh' },
    codex: { fiveHour: null, weekly: { left: 0, resetsAt: null }, plan: 'prolite' },
    codex1: { fiveHour: { left: 25, resetsAt: null }, weekly: { left: 90, resetsAt: null }, plan: 'plus' },
  }));
  // A stand-in "codex.exe": PowerShell under another name, so the process tree looks right.
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), path.join(bin, 'codex.exe'));

  const electronApp = await _electron.launch({
    executablePath: path.join(APP, 'node_modules/electron/dist/electron.exe'),
    args: [APP], timeout: 60000,
    env: { ...process.env, LIMPET_DISABLE_BACKDROPS: '1', LIMPET_CLAUDE_HOME: home, LIMPET_USAGE_FIXTURE: fixture },
  });
  const page = await electronApp.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  check('prompt appears', !!(await waitFor(async () => /PS [A-Z]:/.test(await screenText(page)), 30000)));

  // Capture the launch line instead of starting an agent.
  await electronApp.evaluate(() => {
    global.__limpetClaudeLaunch = (cmd, opts = {}) => `Write-Output "SWAPPED_${cmd}_${opts.resume || (opts.prompt ? 'PROMPT' : 'FRESH')}"`;
  });
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'));

  // Stand in for an agent: a nested process under the tab's shell that prints its pid.
  async function standIn(exe) {
    await page.locator('.term-pane.active').click();
    await type(page, `& '${exe}' -NoProfile -Command 'Write-Output SESSPID_$PID; Start-Sleep 120'`);
    const seen = new Set();
    for (const m of (await screenText(page)).matchAll(/SESSPID_(\d+)/g)) seen.add(m[1]);
    return waitFor(async () => {
      for (const m of (await screenText(page)).matchAll(/SESSPID_(\d+)/g)) if (!seen.has(m[1]) && !pidGone(Number(m[1]))) return Number(m[1]);
      return null;
    }, 15000);
  }
  async function claudeStandIn(sid, dir = c1) {
    const pid = await standIn('powershell.exe');
    fs.writeFileSync(path.join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd: home, kind: 'interactive', status: 'idle', updatedAt: Date.now() }));
    return pid;
  }
  const openMenu = async () => { await page.locator('.tab.active').click({ button: 'right' }); return page.locator('.account-menu'); };
  const menuSettled = (menu) => waitFor(() => menu.locator('.head').textContent().then((t) => /Chat is on|No agent session/.test(t)), 15000);
  const swapTo = async (cmd) => {
    const menu = await openMenu();
    await menuSettled(menu);
    await menu.locator(`.item[data-cmd="${cmd}"]`).click();
    return waitFor(() => page.locator('.account-menu').count().then((n) => n === 0), 30000);
  };
  const seenOnScreen = (needle) => waitFor(async () => (await screenText(page)).includes(needle), 15000);
  const itemText = (menu, cmd, sel) => menu.locator(`.item[data-cmd="${cmd}"] ${sel}`).textContent();

  // ---- no agent in the tab yet: only signed-in accounts, with usage ----
  let menu = await openMenu();
  check('right-click opens the account menu', !!(await waitFor(() => menu.count().then((n) => n === 1), 5000)));
  check('menu lists exactly the signed-in accounts', !!(await waitFor(() => menu.locator('.item').count().then((n) => n === 5), 5000)));
  check('accounts are ordered claude, claude1, claude3, codex, codex1', (await menu.locator('.item').allTextContents()).length === 5 &&
    JSON.stringify(await menu.locator('.item').evaluateAll((els) => els.map((e) => e.dataset.cmd))) === JSON.stringify(['claude', 'claude1', 'claude3', 'codex', 'codex1']));
  check('an account that exists but is not signed in is left out', (await menu.locator('.item[data-cmd="claude2"], .item[data-cmd="codex2"]').count()) === 0);
  check('signed-in Claude account shows its email', (await itemText(menu, 'claude1', '.who')) === 'one@example.com');
  check('a third Claude account is discovered and shown', (await itemText(menu, 'claude3', '.who')) === 'three@example.com');
  check('codex shows the email from its token', (await itemText(menu, 'codex', '.who')) === 'codex@example.com');
  check('a second codex account is discovered and shown', (await itemText(menu, 'codex1', '.who')) === 'codex1@example.com');
  check('plain claude shows its email from ~/.claude.json', (await itemText(menu, 'claude', '.who')) === 'plain@example.com');
  check('usage left is shown per account: 5-hour and weekly', !!(await waitFor(() => itemText(menu, 'claude1', '.usage').then((t) => t === '5h 88% · wk 70%'), 10000)));
  check('a healthy account reads as ok', (await menu.locator('.item[data-cmd="claude1"] .usage.ok').count()) === 1);
  check('the usage tooltip carries the reset time', /5-hour window: 88% left, resets in (2h 0m|1h 59m)\nWeekly: 70% left/.test(await menu.locator('.item[data-cmd="claude1"] .usage').getAttribute('title')));
  check('a plan with only a weekly window shows a dash for the 5-hour one', (await itemText(menu, 'codex', '.usage')) === '5h – · wk 0%');
  check('an exhausted limit reads as low', (await menu.locator('.item[data-cmd="codex"] .usage.low').count()) === 1);
  check('a tight 5-hour limit reads as mid', (await itemText(menu, 'codex1', '.usage')) === '5h 25% · wk 90%' && (await menu.locator('.item[data-cmd="codex1"] .usage.mid').count()) === 1);
  check('an account whose usage could not be read says so', (await itemText(menu, 'claude3', '.usage')) === 'usage n/a' && /expired/.test(await menu.locator('.item[data-cmd="claude3"] .usage').getAttribute('title')));
  check('an account with no usage fixture is left blank, not broken', (await itemText(menu, 'claude', '.usage')) === 'usage n/a');
  check('footer names the accounts to sign in to next', (await menu.locator('.more').textContent()) === 'Sign in to more: claude2, claude4, codex2, codex3');
  check('menu reports no session in the tab', !!(await menuSettled(menu)) && /No agent session/.test(await menu.locator('.head').textContent()));
  await page.keyboard.press('Escape');
  check('Escape closes the menu', !!(await waitFor(() => menu.count().then((n) => n === 0), 3000)));

  // ---- the account a chat is on is listed even when it isn't signed in ----
  const sid = '11111111-2222-4333-8444-555555555555';
  const projectDir = path.join(c1, 'projects', home.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sid}.jsonl`), [
    JSON.stringify({ type: 'user', isSidechain: false, uuid: 'u1', parentUuid: null, sessionId: sid, message: { role: 'user', content: 'HANDOFF_ASK make the widget blue' } }),
    JSON.stringify({ type: 'assistant', isSidechain: false, uuid: 'a1', parentUuid: 'u1', sessionId: sid, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'HANDOFF_REPLY done, it is blue now' }] } }),
  ].join('\n') + '\n');
  let pid = await claudeStandIn(sid, claudeDir(2));
  check('stand-in Claude on the unsigned account runs under the tab', !!pid);
  menu = await openMenu();
  check('menu adds and marks the unsigned account the chat is on', !!(await waitFor(() => page.locator('.account-menu .item.current[data-cmd="claude2"]').count().then((n) => n === 1), 15000)));
  check('menu head names the current account', /on claude2/.test(await page.locator('.account-menu .head').textContent()));
  check('the other accounts are still the signed-in ones only', (await page.locator('.account-menu .item').count()) === 6);
  await page.keyboard.press('Escape');
  check('claude2 -> claude3: menu closes once the move is done', !!(await swapTo('claude3')));
  check('claude2 -> claude3: the running agent was stopped', !!(await waitFor(() => pidGone(pid), 10000)));
  check('claude2 -> claude3: the same session resumes in the same shell', !!(await seenOnScreen(`SWAPPED_claude3_${sid}`)));

  // ---- claude1 -> claude3: resume by id ----
  pid = await claudeStandIn(sid);
  check('stand-in Claude runs under the tab', !!pid);
  menu = await openMenu();
  check('menu marks the account the chat is on', !!(await waitFor(() => page.locator('.account-menu .item.current[data-cmd="claude1"]').count().then((n) => n === 1), 15000)));
  await page.keyboard.press('Escape');
  check('claude1 -> claude3: menu closes once the move is done', !!(await swapTo('claude3')));
  check('claude1 -> claude3: the running agent was stopped', !!(await waitFor(() => pidGone(pid), 10000)));
  check('claude1 -> claude3: the same session resumes in the same shell', !!(await seenOnScreen(`SWAPPED_claude3_${sid}`)));

  // ---- claude1 -> codex1: native import (stubbed), aimed at codex1's home ----
  await electronApp.evaluate(() => {
    global.__limpetCodexImport = async (transcript, opts) => { global.__limpetImportedInto = opts && opts.codexHome; return '01a00000-0000-7000-8000-00000000abcd'; };
  });
  pid = await claudeStandIn(sid);
  check('claude1 -> codex1: move completes', !!(await swapTo('codex1')));
  check('claude1 -> codex1: the imported thread is resumed under codex1', !!(await seenOnScreen('SWAPPED_codex1_01a00000-0000-7000-8000-00000000abcd')));
  check('claude1 -> codex1: the importer was pointed at ~/.codex-1', (await electronApp.evaluate(() => global.__limpetImportedInto)) === codexHome(1));

  // ---- claude1 -> codex: importer fails, so a handoff file and prompt ----
  await electronApp.evaluate(() => { global.__limpetCodexImport = async () => { throw new Error('importer unavailable'); }; });
  pid = await claudeStandIn(sid);
  check('claude1 -> codex (fallback): move completes', !!(await swapTo('codex')));
  check('claude1 -> codex (fallback): codex starts with a continue prompt', !!(await seenOnScreen('SWAPPED_codex_PROMPT')));
  const handoffs = fs.existsSync(path.join(userData, 'handoff')) ? fs.readdirSync(path.join(userData, 'handoff')).filter((n) => n.includes('claude1-to-codex')) : [];
  check('claude1 -> codex (fallback): a handoff file was written', handoffs.length >= 1);
  if (handoffs.length) {
    const md = fs.readFileSync(path.join(userData, 'handoff', handoffs[handoffs.length - 1]), 'utf8');
    check('claude1 -> codex (fallback): the handoff carries the chat', md.includes('HANDOFF_ASK make the widget blue') && md.includes('HANDOFF_REPLY done'));
    for (const n of handoffs) fs.unlinkSync(path.join(userData, 'handoff', n));
  }

  // ---- codex -> claude1: a synthesized Claude transcript ----
  const rolloutName = (thread) => `rollout-2026-09-04T12-00-00-${thread}.jsonl`;
  const writeRollout = (dir, thread) => fs.writeFileSync(path.join(dir, 'sessions', '2026', '09', '04', rolloutName(thread)), [
    JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: home, timestamp: new Date().toISOString() } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>x</cwd>\n</environment_context>' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CODEX_ASK rename the helper' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'rg helper' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'src/a.js' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CODEX_REPLY renamed it' }] } }),
  ].join('\n') + '\n');
  const thread = '01a00000-0000-7000-8000-0000000000aa';
  pid = await standIn(path.join(bin, 'codex.exe'));
  check('stand-in codex runs under the tab', !!pid);
  writeRollout(codexDir, thread);
  menu = await openMenu();
  check('menu marks codex as the agent the chat is on', !!(await waitFor(() => page.locator('.account-menu .item.current[data-cmd="codex"]').count().then((n) => n === 1), 15000)));
  await page.keyboard.press('Escape');
  check('codex -> claude1: move completes', !!(await swapTo('claude1')));
  check('codex -> claude1: the stand-in codex was stopped', !!(await waitFor(() => pidGone(pid), 10000)));
  const swapped = await waitFor(async () => { const m = /SWAPPED_claude1_([0-9a-f-]{36})/.exec(await screenText(page)); return m ? m[1] : null; }, 15000);
  check('codex -> claude1: a new Claude session is resumed', !!swapped && UUID.test(swapped));
  if (swapped) {
    const file = path.join(projectDir, `${swapped}.jsonl`);
    check('codex -> claude1: the transcript was written to the account\'s project folder', fs.existsSync(file));
    if (fs.existsSync(file)) {
      const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      check('codex -> claude1: the transcript carries the chat, tools included',
        rows[0].type === 'user' && rows[0].message.content === 'CODEX_ASK rename the helper' &&
        rows[1].type === 'assistant' && rows[1].message.content[0].text.includes('CODEX_REPLY renamed it') && rows[1].message.content[0].text.includes('[tool: exec] rg helper') &&
        rows.every((r) => !r.cwd || r.cwd === home));
    }
  }

  // ---- codex -> codex1: the rollout is copied into the other home ----
  const thread2 = '01a00000-0000-7000-8000-0000000000bb';
  pid = await standIn(path.join(bin, 'codex.exe'));
  writeRollout(codexDir, thread2);
  menu = await openMenu();
  check('menu tells which codex account the chat is on from the rollout\'s home', !!(await waitFor(() => page.locator('.account-menu .item.current[data-cmd="codex"]').count().then((n) => n === 1), 15000)));
  await page.keyboard.press('Escape');
  check('codex -> codex1: move completes', !!(await swapTo('codex1')));
  check('codex -> codex1: the stand-in codex was stopped', !!(await waitFor(() => pidGone(pid), 10000)));
  check('codex -> codex1: the same thread is resumed under codex1', !!(await seenOnScreen(`SWAPPED_codex1_${thread2}`)));
  const copied = path.join(codexHome(1), 'sessions', '2026', '09', '04', rolloutName(thread2));
  check('codex -> codex1: the rollout was copied into ~/.codex-1 at the same dated path', fs.existsSync(copied) && fs.readFileSync(copied, 'utf8') === fs.readFileSync(path.join(codexDir, 'sessions', '2026', '09', '04', rolloutName(thread2)), 'utf8'));

  // ---- background picker: standard limpet colour by default, swatches, generative ----
  const paneColor = () => page.evaluate(() => getComputedStyle(document.querySelector('.term-pane.active')).backgroundColor);
  menu = await openMenu();
  check('menu offers the background swatches', !!(await waitFor(() => menu.locator('.bg .swatch').count().then((n) => n === 7), 5000)));
  check('the standard limpet colour is selected by default', (await menu.locator('.bg .swatch.selected').getAttribute('data-color')) === '#1e1e2e');
  check('the pane starts on the standard limpet colour', (await paneColor()) === 'rgb(30, 30, 46)');
  await menu.locator('.bg .swatch[data-color="#16294d"]').click();
  check('picking a swatch closes the menu', !!(await waitFor(() => page.locator('.account-menu').count().then((n) => n === 0), 3000)));
  check('picking a swatch recolours the pane', (await paneColor()) === 'rgb(22, 41, 77)');
  await page.click('#newtab');
  await waitFor(() => page.locator('.tab').count().then((n) => n === 2), 10000);
  check('a new tab gets the picked colour too', (await paneColor()) === 'rgb(22, 41, 77)');
  check('the choice is remembered', (await page.evaluate(() => localStorage.getItem('limpet.background'))) === '{"mode":"color","color":"#16294d"}');
  menu = await openMenu();
  await waitFor(() => menu.locator('.bg .gen').count().then((n) => n === 1), 5000);
  await menu.locator('.bg .gen').click();
  await waitFor(() => page.locator('.account-menu').count().then((n) => n === 0), 3000);
  menu = await openMenu();
  await waitFor(() => menu.locator('.bg .gen').count().then((n) => n === 1), 5000);
  check('generative can be picked and shows as selected', (await menu.locator('.bg .gen.selected').count()) === 1);
  check('generative clears the solid colour', (await paneColor()) === 'rgb(30, 30, 46)');
  // Leave the app on its default so a real profile isn't changed by the test.
  await menu.locator('.bg .swatch[data-color="#1e1e2e"]').click();
  await waitFor(() => page.locator('.account-menu').count().then((n) => n === 0), 3000);
  check('back to the default background', (await page.evaluate(() => localStorage.getItem('limpet.background'))) === '{"mode":"color","color":"#1e1e2e"}');

  // ---- picking an agent with nothing running starts it fresh ----
  menu = await openMenu();
  await menuSettled(menu);
  await menu.locator('.item[data-cmd="claude"]').click();
  check('an account picked in an idle tab is started there', !!(await seenOnScreen('SWAPPED_claude_FRESH')));

  check('no renderer page errors', pageErrors.length === 0);
  if (pageErrors.length) console.log('  page errors:', pageErrors.join(' | '));
  await electronApp.close();
  fs.rmSync(home, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('DRIVER ERROR:', e); process.exit(1); });
