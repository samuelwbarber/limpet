// Focused e2e: right-clicking a tab lists the Claude accounts and Codex, spots
// the agent running under that tab's shell, and moving the chat exits it and
// brings the same conversation up under the pick, in the same shell:
//   claude1 -> claude2   resume by session id
//   claude1 -> codex     Codex's importer (stubbed here) or a handoff file
//   codex   -> claude1   a synthesized Claude transcript, resumed
// The agents are stood in for by nested PowerShells (detection needs a live
// pid under the tab's shell plus the files the real agents leave behind), and
// the launch line is captured instead of run.
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
  // A private "home": claude1 signed in, codex signed in, nothing else.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-claude-'));
  const c1 = path.join(home, '.claude-1');
  fs.mkdirSync(path.join(c1, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(c1, '.credentials.json'), '{}');
  fs.writeFileSync(path.join(c1, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'one@example.com' } }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'plain@example.com' } }));
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(path.join(codexDir, 'sessions', '2026', '09', '04'), { recursive: true });
  const idToken = `x.${Buffer.from(JSON.stringify({ email: 'codex@example.com' })).toString('base64url')}.y`;
  fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ tokens: { id_token: idToken } }));
  // A stand-in "codex.exe": PowerShell under another name, so the process tree looks right.
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), path.join(bin, 'codex.exe'));

  const electronApp = await _electron.launch({
    executablePath: path.join(APP, 'node_modules/electron/dist/electron.exe'),
    args: [APP], timeout: 60000,
    env: { ...process.env, LIMPET_DISABLE_BACKDROPS: '1', LIMPET_CLAUDE_HOME: home },
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
    const marker = `SESSPID_`;
    const seen = new Set();
    for (const m of (await screenText(page)).matchAll(/SESSPID_(\d+)/g)) seen.add(m[1]);
    return waitFor(async () => {
      for (const m of (await screenText(page)).matchAll(/SESSPID_(\d+)/g)) if (!seen.has(m[1]) && !pidGone(Number(m[1]))) return Number(m[1]);
      return null;
    }, 15000);
  }
  async function claudeStandIn(sid) {
    const pid = await standIn('powershell.exe');
    fs.writeFileSync(path.join(c1, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd: home, kind: 'interactive', status: 'idle', updatedAt: Date.now() }));
    return pid;
  }
  const openMenu = async () => { await page.locator('.tab.active').click({ button: 'right' }); return page.locator('.account-menu'); };
  const swapTo = async (cmd) => {
    const menu = await openMenu();
    await waitFor(() => menu.locator('.head').textContent().then((t) => /Chat is on|No Claude session/.test(t)), 15000);
    await menu.locator(`.item[data-cmd="${cmd}"]`).click();
    return waitFor(() => page.locator('.account-menu').count().then((n) => n === 0), 30000);
  };
  const seenOnScreen = (needle) => waitFor(async () => (await screenText(page)).includes(needle), 15000);

  // ---- no agent in the tab yet ----
  let menu = await openMenu();
  check('right-click opens the account menu', !!(await waitFor(() => menu.count().then((n) => n === 1), 5000)));
  check('menu lists the three Claude accounts and codex', !!(await waitFor(() => menu.locator('.item').count().then((n) => n === 4), 5000)));
  check('signed-in Claude account shows its email', (await menu.locator('.item[data-cmd="claude1"] .who').textContent()) === 'one@example.com');
  check('missing account shows not signed in', (await menu.locator('.item[data-cmd="claude2"] .who').textContent()) === 'not signed in');
  check('codex shows the email from its token', (await menu.locator('.item[data-cmd="codex"] .who').textContent()) === 'codex@example.com');
  check('plain claude shows its email from ~/.claude.json', (await menu.locator('.item[data-cmd="claude"] .who').textContent()) === 'plain@example.com');
  check('menu reports no session in the tab', !!(await waitFor(() => menu.locator('.head').textContent().then((t) => /No Claude session/.test(t)), 15000)));
  await page.keyboard.press('Escape');
  check('Escape closes the menu', !!(await waitFor(() => menu.count().then((n) => n === 0), 3000)));

  // ---- claude1 -> claude2: resume by id ----
  const sid = '11111111-2222-4333-8444-555555555555';
  const projectDir = path.join(c1, 'projects', home.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sid}.jsonl`), [
    JSON.stringify({ type: 'user', isSidechain: false, uuid: 'u1', parentUuid: null, sessionId: sid, message: { role: 'user', content: 'HANDOFF_ASK make the widget blue' } }),
    JSON.stringify({ type: 'assistant', isSidechain: false, uuid: 'a1', parentUuid: 'u1', sessionId: sid, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'HANDOFF_REPLY done, it is blue now' }] } }),
  ].join('\n') + '\n');
  let pid = await claudeStandIn(sid);
  check('stand-in Claude runs under the tab', !!pid);
  menu = await openMenu();
  check('menu marks the account the chat is on', !!(await waitFor(() => page.locator('.account-menu .item.current[data-cmd="claude1"]').count().then((n) => n === 1), 15000)));
  check('menu head names the current account', /on claude1/.test(await page.locator('.account-menu .head').textContent()));
  await page.keyboard.press('Escape');
  check('claude1 -> claude2: menu closes once the move is done', !!(await swapTo('claude2')));
  check('claude1 -> claude2: the running agent was stopped', !!(await waitFor(() => pidGone(pid), 10000)));
  check('claude1 -> claude2: the same session resumes in the same shell', !!(await seenOnScreen(`SWAPPED_claude2_${sid}`)));

  // ---- claude1 -> codex: native import (stubbed) ----
  await electronApp.evaluate(() => { global.__limpetCodexImport = async () => '01a00000-0000-7000-8000-00000000abcd'; });
  pid = await claudeStandIn(sid);
  check('claude1 -> codex: move completes', !!(await swapTo('codex')));
  check('claude1 -> codex: the imported thread is resumed', !!(await seenOnScreen('SWAPPED_codex_01a00000-0000-7000-8000-00000000abcd')));
  check('claude1 -> codex: the terminal says it was imported', !!(await seenOnScreen('imported into Codex as thread')));

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
  const thread = '01a00000-0000-7000-8000-0000000000aa';
  pid = await standIn(path.join(bin, 'codex.exe'));
  check('stand-in codex runs under the tab', !!pid);
  fs.writeFileSync(path.join(codexDir, 'sessions', '2026', '09', '04', `rollout-2026-09-04T12-00-00-${thread}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: home, timestamp: new Date().toISOString() } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>x</cwd>\n</environment_context>' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CODEX_ASK rename the helper' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'rg helper' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'src/a.js' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CODEX_REPLY renamed it' }] } }),
  ].join('\n') + '\n');
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
  await waitFor(() => menu.locator('.head').textContent().then((t) => /No Claude session/.test(t)), 15000);
  await menu.locator('.item[data-cmd="claude"]').click();
  check('an account picked in an idle tab is started there', !!(await seenOnScreen('SWAPPED_claude_FRESH')));

  check('no renderer page errors', pageErrors.length === 0);
  if (pageErrors.length) console.log('  page errors:', pageErrors.join(' | '));
  await electronApp.close();
  fs.rmSync(home, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('DRIVER ERROR:', e); process.exit(1); });
