// Focused e2e: paste enters the PTY once, the copy shortcut copies the
// selection (even after it is cleared by a repaint), and plain Ctrl+C still
// interrupts. On Windows and Linux copy is Ctrl+C and paste Ctrl+V /
// Ctrl+Shift+V; on macOS copy is Cmd+C and paste Cmd+V (Ctrl+Shift+V too).
const { _electron } = require('playwright-core');
const path = require('path');
const p = require('./platform');
const APP = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; }
const screenText = (page) => page.evaluate(() => { const el = document.querySelector('.term-pane.active .xterm-rows'); return el ? el.innerText : ''; });
async function waitFor(fn, timeout, every = 300) { const end = Date.now() + timeout; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every); } }
async function type(page, t) { // Focus the terminal first: on macOS a fresh Electron window does not take the keyboard on its own.
  await page.locator('.term-pane.active .xterm-helper-textarea').focus().catch(() => {});
  await page.keyboard.type(t, { delay: 10 }); await page.keyboard.press('Enter'); }

(async () => {
  const app = await _electron.launch({
    executablePath: require(path.join(APP, 'node_modules', 'electron')), // fetched on first use
    args: p.launchArgs(APP), timeout: 60000,
    env: p.launchEnv(),
  });
  const page = await app.firstWindow();
  await waitFor(() => screenText(page).then((t) => p.promptRe.test(t)), 30000);
  const clip = (t) => app.evaluate(({ clipboard }, v) => (v === undefined ? clipboard.readText() : clipboard.writeText(v)), t);

  // A hidden stock Electron menu used to keep a second Ctrl+V accelerator
  // alive. Together with xterm's paste event that injected clipboard text
  // twice. Every paste shortcut must have one and only one PTY path.
  for (const [i, shortcut] of p.pasteKeys.entries()) {
    const marker = `PASTE_ONCE_${i}_99${i}1`;
    await type(page, p.clear);
    // Paste only once the clear has landed and the prompt is back, or a slow
    // shell can wipe the pasted line after it's echoed (the first iteration
    // runs right after startup, and flaked on CI that way).
    await waitFor(() => screenText(page).then((t) => p.promptOnly(t)), 10000);
    await clip(p.echo(marker));
    const seen = async () => ((await screenText(page)).match(new RegExp(marker, 'g')) || []).length;
    await page.keyboard.press(shortcut);
    // The paste is asynchronous (the renderer fetches the clipboard from the
    // main process before feeding the terminal) while Enter goes straight to
    // the pty, so wait for the pasted line to show before pressing it; on a
    // slow runner Enter otherwise ran an empty line first, and the marker was
    // seen once. A double paste shows up here already, as two on one line.
    await waitFor(async () => (await seen()) >= 1, 8000);
    await sleep(300);
    const pasted = await seen();
    await page.keyboard.press('Enter');
    await waitFor(async () => (await seen()) >= 2, 8000);
    await sleep(300);
    const count = await seen();
    check(`${shortcut} pastes exactly once${pasted === 1 && count === 2 ? '' : ` (marker seen ${pasted}x before Enter, ${count}x after; want 1 and 2)`}`, pasted === 1 && count === 2);
  }

  // ---- the copy shortcut copies a selection ----
  await clip('');
  await type(page, p.echo('COPYME_MARKER_7788'));
  await waitFor(() => screenText(page).then((t) => /COPYME_MARKER_7788/.test((t.match(/COPYME_MARKER_7788/g) || []).length > 1 ? t : '')), 8000);
  await sleep(500);
  // Triple-click the output line to select it (find the row with the echoed value).
  const box = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.term-pane.active .xterm-rows > div')];
    // The echoed *output* line is the last one that is exactly the marker.
    const hit = rows.reverse().find((r) => r.textContent.trim() === 'COPYME_MARKER_7788');
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: r.x + 40, y: r.y + r.height / 2 };
  });
  check('found the output line to select', !!box);
  if (box) {
    await page.mouse.click(box.x, box.y, { clickCount: 3 });
    await sleep(300);
    // Force the "selection cleared just before keypress" race: repaint the screen.
    await page.evaluate(() => { const el = document.querySelector('.term-pane.active'); if (el) el.dispatchEvent(new Event('mouseleave')); });
    await page.keyboard.press(p.copyKey);
    await sleep(400);
    const got = await clip();
    check(`${p.copyKey} copied the selection`, /COPYME_MARKER_7788/.test(got));
  }

  // ---- plain Ctrl+C still interrupts ----
  await clip('SENTINEL_UNCHANGED');
  await type(page, p.sleep(30));
  await sleep(1200); // now sleeping; nothing selected, cache cleared by typing
  await page.keyboard.press('Control+c');
  const returned = await waitFor(async () => {
    const t = await screenText(page);
    // prompt returns quickly (well before 30s) if the sleep was interrupted
    return p.promptEndRe.test(t.trimEnd() + ' ');
  }, 6000);
  check('plain Ctrl+C interrupted the sleep (prompt returned < 6s)', !!returned);
  check('plain Ctrl+C did not touch the clipboard', (await clip()) === 'SENTINEL_UNCHANGED');

  await p.closeApp(app);
  p.cleanup();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('DRIVER ERROR:', e); process.exit(1); });
