// Focused e2e: Ctrl+C copies the selection (even after the selection is cleared
// by a repaint), and a plain Ctrl+C with nothing selected still interrupts.
const { _electron } = require('playwright-core');
const path = require('path');
const APP = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; }
const screenText = (page) => page.evaluate(() => { const el = document.querySelector('.term-pane.active .xterm-rows'); return el ? el.innerText : ''; });
async function waitFor(fn, timeout, every = 300) { const end = Date.now() + timeout; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every); } }
async function type(page, t) { await page.keyboard.type(t, { delay: 10 }); await page.keyboard.press('Enter'); }

(async () => {
  const app = await _electron.launch({ executablePath: path.join(APP, 'node_modules/electron/dist/electron.exe'), args: [APP], timeout: 60000 });
  const page = await app.firstWindow();
  await waitFor(() => screenText(page).then((t) => /PS [A-Z]:/.test(t)), 30000);
  const clip = (t) => app.evaluate(({ clipboard }, v) => (v === undefined ? clipboard.readText() : clipboard.writeText(v)), t);

  // ---- Ctrl+C copies a selection ----
  await clip('');
  await type(page, 'echo COPYME_MARKER_7788');
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
    await page.keyboard.press('Control+c');
    await sleep(400);
    const got = await clip();
    check('Ctrl+C copied the selection', /COPYME_MARKER_7788/.test(got));
  }

  // ---- plain Ctrl+C still interrupts ----
  await clip('SENTINEL_UNCHANGED');
  await type(page, 'Start-Sleep -Seconds 30');
  await sleep(1200); // now sleeping; nothing selected, cache cleared by typing
  await page.keyboard.press('Control+c');
  const returned = await waitFor(async () => {
    const t = await screenText(page);
    // prompt returns quickly (well before 30s) if the sleep was interrupted
    return /PS [A-Z]:\\[^\n]*>\s*$/.test(t.trimEnd() + ' ');
  }, 6000);
  check('plain Ctrl+C interrupted the sleep (prompt returned < 6s)', !!returned);
  check('plain Ctrl+C did not touch the clipboard', (await clip()) === 'SENTINEL_UNCHANGED');

  await app.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('DRIVER ERROR:', e); process.exit(1); });
