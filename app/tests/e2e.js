// End-to-end test: launches the real limpet app (Electron + ConPTY PowerShell),
// exercises peek (including resize survival), the reels OSC toggle, and the
// download OSC channel, asserting on terminal DOM text and canvas pixels.
// Run: npm run test:e2e   (needs a display; works on GitHub windows runners)
const { _electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = path.join(__dirname, '..');
const TEST_PNG = path.join(APP, '..', 'tools', 'demo', 'test.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// Visible terminal text (xterm DOM renderer keeps rows as text).
const screenText = (page) => page.evaluate(() => {
  const el = document.querySelector('.term-pane.active .xterm-rows');
  return el ? el.innerText : '';
});

// Count "image-looking" pixels: non-transparent and not the terminal
// background, sampled across the top-left area where peek draws.
const imagePixels = (page) => page.evaluate(() => {
  let count = 0;
  for (const canvas of document.querySelectorAll('.term-pane.active canvas')) {
    const ctx = canvas.getContext('2d');
    if (!ctx || !canvas.width || !canvas.height) continue;
    const w = Math.min(canvas.width, 600);
    const h = Math.min(canvas.height, 320);
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let y = 20; y < h; y += 8) {
      for (let x = 8; x < w; x += 8) {
        const i = (y * w + x) * 4;
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a > 200 && !(Math.abs(r - 0x1e) < 12 && Math.abs(g - 0x1e) < 12 && Math.abs(b - 0x2e) < 12)) count++;
      }
    }
  }
  return count;
});

async function waitFor(fn, timeout, every = 500) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

async function type(page, text) {
  await page.keyboard.type(text, { delay: 10 });
  await page.keyboard.press('Enter');
}

(async () => {
  const app = await _electron.launch({
    executablePath: path.join(APP, 'node_modules/electron/dist/electron.exe'),
    args: [APP],
    timeout: 60000,
  });
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  check('prompt appears', !!(await waitFor(async () => /PS [A-Z]:/.test(await screenText(page)), 30000)));

  // ---- peek renders pixels, prompt returns below ----
  const before = await imagePixels(page);
  await type(page, `peek ${TEST_PNG}`);
  await sleep(4000);
  const withImage = await imagePixels(page);
  check(`peek paints the image (${before} -> ${withImage} px)`, withImage > before + 50);
  await type(page, 'echo peek-done');
  await sleep(1500);
  check('prompt keeps working under the image', (await screenText(page)).includes('peek-done'));

  // ---- images survive a window resize (ConPTY repaint) ----
  const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [W, H]) => {
    BrowserWindow.getAllWindows()[0].setSize(W, H);
  }, [w, h]);
  await setSize(760, 520);
  await sleep(2000);
  check('image survives shrink', (await imagePixels(page)) > 50);
  await setSize(1100, 700);
  await sleep(2000);
  check('image survives grow', (await imagePixels(page)) > 50);

  // ---- reels OSC toggles the side panel ----
  const reelsShown = () => page.evaluate(() => document.getElementById('reels').classList.contains('show'));
  await type(page, 'reels https://example.com');
  check('reels opens', !!(await waitFor(reelsShown, 8000)));
  await type(page, 'reels');
  check('reels closes', !!(await waitFor(async () => !(await reelsShown()), 8000)));

  // ---- streamed download (dl;h/dl;d/dl;f) drops the file into Downloads ----
  const dl = path.join(os.homedir(), 'Downloads', 'limpet-ci.txt');
  fs.rmSync(dl, { force: true });
  // header (name "limpet-ci.txt", kind file), one data chunk ("hello limpet"), finish
  const E = '$([char]27)'; const B = '$([char]7)';
  await type(page, `Write-Host -NoNewline ("${E}]5379;dl;h;bGltcGV0LWNpLnR4dA==;file${B}${E}]5379;dl;d;aGVsbG8gbGltcGV0${B}${E}]5379;dl;f${B}")`);
  const saved = await waitFor(() => fs.existsSync(dl) && fs.readFileSync(dl, 'utf8') === 'hello limpet', 8000);
  check('streamed download saves to Downloads', !!saved);
  check('streamed download content intact', saved && fs.readFileSync(dl, 'utf8') === 'hello limpet');
  fs.rmSync(dl, { force: true });

  check('no renderer page errors', pageErrors.length === 0);
  if (pageErrors.length) console.log('  page errors:', pageErrors.join(' | '));

  await app.close();
  console.log(failures ? `${failures} e2e check(s) FAILED` : 'all e2e checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('E2E DRIVER ERROR:', e); process.exit(1); });
