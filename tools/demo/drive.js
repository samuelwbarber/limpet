// Drive the limpet Electron app: launch, run commands in the terminal, screenshot.
// Usage: node drive.js <scenario>
//   scenario "peek"  : run peek on a test image
//   scenario "reels" : toggle the reels panel
const { _electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const APP = 'C:/Users/sbarb/limpet/app';
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const TEST_PNG = path.join(__dirname, 'test.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function typeCmd(page, text) {
  await page.keyboard.type(text, { delay: 15 });
  await page.keyboard.press('Enter');
}

(async () => {
  const scenario = process.argv[2] || 'peek';
  const app = await _electron.launch({
    executablePath: path.join(APP, 'node_modules/electron/dist/electron.exe'),
    args: [APP],
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('#term .xterm', { timeout: 15000 }).catch(() => {});
  await sleep(5000); // let PowerShell + module load
  await page.screenshot({ path: path.join(SHOTS, `${scenario}-01-start.png`) });

  await page.click('#term');
  if (scenario === 'peek') {
    await typeCmd(page, `peek ${TEST_PNG.replace(/\//g, '\\')}`);
    await sleep(4000);
    await page.screenshot({ path: path.join(SHOTS, 'peek-02-after.png') });
    await typeCmd(page, 'echo done-after-peek');
    await sleep(1500);
    await page.screenshot({ path: path.join(SHOTS, 'peek-03-next-prompt.png') });
    // scroll case: push the prompt to the bottom, then peek again
    await typeCmd(page, '1..25 | ForEach-Object { "line $_" }');
    await sleep(1500);
    await typeCmd(page, `peek ${TEST_PNG.replace(/\//g, '\\')}`);
    await sleep(3500);
    await page.screenshot({ path: path.join(SHOTS, 'peek-04-at-bottom.png') });
    await typeCmd(page, 'echo after-scrolled-peek');
    await sleep(1500);
    await page.screenshot({ path: path.join(SHOTS, 'peek-05-after-bottom.png') });
  } else if (scenario === 'reels') {
    const rects = () => page.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null;
        const b = e.getBoundingClientRect(); return { x: b.x, w: b.width, h: b.height, shown: b.width > 0 }; };
      return { term: r('#term'), reels: r('#reels'), win: { w: window.innerWidth, h: window.innerHeight } };
    });
    console.log('before:', JSON.stringify(await rects()));
    await typeCmd(page, 'reels');
    await sleep(8000);
    console.log('open:', JSON.stringify(await rects()));
    await page.screenshot({ path: path.join(SHOTS, 'reels-02-open.png') });
    await typeCmd(page, 'ls');
    await sleep(1500);
    await page.screenshot({ path: path.join(SHOTS, 'reels-03-terminal-refit.png') });
    await typeCmd(page, 'reels');
    await sleep(2000);
    console.log('closed:', JSON.stringify(await rects()));
    await typeCmd(page, 'echo cols-check');
    await sleep(1200);
    await page.screenshot({ path: path.join(SHOTS, 'reels-04-closed.png') });
  } else if (scenario === 'banner') {
    await typeCmd(page, 'limpet');
    await sleep(2000);
    await page.screenshot({ path: path.join(SHOTS, 'banner-02.png') });
  } else if (scenario === 'remote-sim') {
    // simulate an xssh session: WSL bash with the limpet-remote.sh rcfile
    const toWsl = (p) => p.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
    await typeCmd(page, `bash --rcfile ${toWsl('C:\\Users\\sbarb\\limpet\\shell\\limpet-remote.sh')} -i`);
    await sleep(3000);
    await typeCmd(page, `cd "${toWsl(path.dirname(TEST_PNG))}"`);
    await sleep(800);
    await typeCmd(page, 'peek test.png');
    await sleep(4000);
    await page.screenshot({ path: path.join(SHOTS, 'rsim-02-peek.png') });
    await typeCmd(page, 'echo after-remote-peek');
    await sleep(1200);
    await typeCmd(page, 'download test.png');
    await sleep(2500);
    await page.screenshot({ path: path.join(SHOTS, 'rsim-03-download.png') });
    await typeCmd(page, 'exit');
    await sleep(1000);
  }
  await app.close();
})().catch((e) => { console.error('DRIVER ERROR:', e); process.exit(1); });
