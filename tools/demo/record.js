// Record limpet demo videos: launch the app with Playwright, drive a real flow,
// save an mp4 per scenario. Usage: node record.js <scenario>
//
// Capture is either a desktop-region grab of the window (ffmpeg gdigrab; the
// original scenarios) or, for `switch` and `backdrop`, a stream of Playwright
// screenshots stitched with ffmpeg: those run for a minute or more, and a
// desktop grab records whatever window happens to come in front meanwhile.
// LIMPET_RECORD=shots|desktop overrides the choice.
const { _electron } = require('playwright-core');
const { execSync, spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('ffmpeg-static');

const APP = path.join(__dirname, '..', '..', 'app');
const VIDS = path.join(__dirname, 'vids');
fs.mkdirSync(VIDS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Visible terminal text, and waits on it: for a pattern, or for the screen to
// stop changing (an agent finished replying).
const screenText = (page) => page.evaluate(() => {
  const el = document.querySelector('.term-pane.active .xterm-rows');
  return el ? el.innerText : '';
});
async function waitForScreen(page, re, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (re.test(await screenText(page))) return true;
    await sleep(300);
  }
  return false;
}
async function waitForIdle(page, timeout, quiet = 4000) {
  const end = Date.now() + timeout;
  let last = await screenText(page);
  let since = Date.now();
  while (Date.now() < end) {
    await sleep(500);
    const now = await screenText(page);
    if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= quiet) return true;
  }
  return false;
}

async function typeCmd(page, text, delay = 45) {
  await page.keyboard.type(text, { delay });
  await sleep(300);
  await page.keyboard.press('Enter');
}

(async () => {
  const scenario = process.argv[2];
  const shots = process.env.LIMPET_RECORD ? process.env.LIMPET_RECORD === 'shots' : ['switch', 'backdrop'].includes(scenario);
  // Stand-in addresses in the account menu, so the recording shows no real email.
  if (scenario === 'switch' || scenario === 'backdrop') process.env.LIMPET_DEMO_EMAILS = 'claude=you@home.example,claude1=you@work.example,codex=you@openai.example';
  let keepAlive = null;
  if (['xssh', 'remote', 'drop'].includes(scenario)) {
    // WSL2 terminates the distro (and sshd) when the last wsl.exe exits — hold
    // it open for the whole recording and make sure sshd is up.
    keepAlive = spawn('wsl', ['-e', 'sleep', '600'], { stdio: 'ignore' });
    execSync('wsl -u root service ssh start', { timeout: 60000 });
    execSync('ssh -o BatchMode=yes -o ConnectTimeout=5 sbarb@localhost true', { timeout: 20000 });
  }
  process.on('exit', () => { if (keepAlive) try { keepAlive.kill(); } catch (_) {} });
  // A clean environment: launched from inside a Claude Code session the app's
  // shells would inherit its markers and Claude would stop saving transcripts.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k)));
  const app = await _electron.launch({
    executablePath: path.join(APP, 'node_modules/electron/dist/electron.exe'),
    args: [APP], env,
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.term-pane .xterm', { timeout: 15000 }).catch(() => {});
  await sleep(4500); // PowerShell + Limpet module load

  const outFile = path.join(VIDS, `${scenario}.mp4`);
  let rec = null;
  let frames = null;
  if (shots) {
    // Compositor screenshots at ~10 fps, stitched afterwards.
    frames = { dir: path.join(VIDS, `${scenario}-frames`), n: 0, busy: false, start: Date.now() };
    fs.rmSync(frames.dir, { recursive: true, force: true });
    fs.mkdirSync(frames.dir, { recursive: true });
    frames.timer = setInterval(async () => {
      if (frames.busy) return;
      frames.busy = true;
      try { await page.screenshot({ path: path.join(frames.dir, `${String(frames.n++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 85 }); } catch (_) { /* window closing */ }
      frames.busy = false;
    }, 80);
  } else {
    // Capture the desktop region under the window (gdigrab window-capture of a
    // GPU-composited Electron window comes out white). 'q' on stdin stops it.
    const b = await app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setAlwaysOnTop(true);
      w.focus();
      return { ...w.getContentBounds(), sf: screen.getPrimaryDisplay().scaleFactor };
    });
    const even = (v) => 2 * Math.floor((v * b.sf) / 2);
    const errLog = fs.openSync(path.join(VIDS, 'ffmpeg-err.log'), 'w');
    rec = spawn(ffmpeg, ['-y', '-f', 'gdigrab', '-framerate', '15',
      '-offset_x', String(Math.round(b.x * b.sf)), '-offset_y', String(Math.round(b.y * b.sf)),
      '-video_size', `${even(b.width)}x${even(b.height)}`, '-i', 'desktop',
      '-pix_fmt', 'yuv420p', outFile],
    { stdio: ['pipe', 'ignore', errLog] });
  }
  await sleep(1200);
  await page.click('.term-pane.active');

  if (scenario === 'shell') {
    await typeCmd(page, 'limpet');
    await sleep(2600);
    await typeCmd(page, 'ls -la | head -6');
    await sleep(2600);
    await typeCmd(page, 'grep -i gpu train.log | head -3');
    await sleep(2600);
  } else if (scenario === 'peek') {
    await typeCmd(page, 'ls');
    await sleep(1800);
    await typeCmd(page, 'peek gpu_util.png');
    await sleep(4500);
    await typeCmd(page, 'echo the terminal keeps flowing');
    await sleep(2500);
  } else if (scenario === 'xssh') {
    await typeCmd(page, 'xssh sbarb@localhost');
    await sleep(5200);
    await typeCmd(page, 'hostname && uptime');
    await sleep(2600);
    // yank the link out from under it
    try { execSync('wsl -u root pkill -f "sshd: sbarb"'); } catch (_) {}
    await sleep(9500); // drop detected -> 2s -> reconnected
    await typeCmd(page, 'echo still here, same window');
    await sleep(3000);
  } else if (scenario === 'remote') {
    await typeCmd(page, 'xssh sbarb@localhost');
    await sleep(5200);
    await typeCmd(page, 'peek gpu_util.png');
    await sleep(4500);
    await typeCmd(page, 'download gpu_util.png');
    await sleep(3500);
  } else if (scenario === 'drop') {
    await typeCmd(page, 'xssh sbarb@localhost');
    await sleep(5200);
    await page.evaluate(() => { window.dispatchEvent(new Event('dragenter')); });
    await sleep(1400);
    await page.evaluate((p) => {
      window.dispatchEvent(new Event('dragleave'));
      return window.limpet.dropFiles(1, [p]); // session 1 = the first tab
    }, path.join(__dirname, 'report.pdf'));
    await sleep(3500);
    await typeCmd(page, 'ls -la report.pdf');
    await sleep(2600);
  } else if (scenario === 'tabs') {
    await typeCmd(page, 'ping -t localhost');
    await sleep(2200);
    await page.keyboard.press('Control+Shift+T');
    await sleep(4500); // second shell loads
    await typeCmd(page, 'echo a fresh shell, same window');
    await sleep(2200);
    await page.keyboard.press('Control+Tab'); // back to tab 1 — ping kept going
    await sleep(2600);
    await page.keyboard.press('Control+C');
    await sleep(1400);
    await typeCmd(page, 'exit'); // shell ends -> its tab closes itself
    await sleep(2400);
  } else if (scenario === 'switch') {
    // A real Claude Code chat on one account, moved to Codex from the tab menu:
    // Claude exits, Codex imports the transcript and resumes it, same shell.
    await typeCmd(page, 'claude1');
    await waitForScreen(page, /trust this folder|Claude Code v/i, 30000);
    if (/trust this folder/i.test(await screenText(page))) {
      // Move the cursor onto "Yes" and check it got there before confirming.
      await sleep(1200);
      for (let i = 0; i < 5 && !/❯\s*Yes, I trust/i.test(await screenText(page)); i++) { await page.keyboard.press('ArrowDown'); await sleep(500); }
      await page.keyboard.press('Enter');
      await waitForScreen(page, /Claude Code v/i, 30000);
    }
    await sleep(2500);
    await typeCmd(page, 'Write me a two-line limerick opening about a limpet clinging to its rock.', 30);
    await waitForScreen(page, /limpet/i, 8000);
    await waitForIdle(page, 60000);
    await sleep(2500);
    await page.locator('.tab.active').click({ button: 'right' });
    await page.waitForSelector('.account-menu .item.current', { timeout: 20000 }).catch(() => {});
    await sleep(2500);
    await page.locator('.account-menu .item[data-cmd="codex"]').click();
    await waitForScreen(page, /Update available|OpenAI Codex|Ask Codex/i, 60000);
    if (/Update available/i.test(await screenText(page))) {
      // Codex's update nag: pick "skip until next version" and carry on.
      await sleep(1000);
      for (let i = 0; i < 4 && !/›\s*3\. Skip until/i.test(await screenText(page)); i++) { await page.keyboard.press('ArrowDown'); await sleep(400); }
      await page.keyboard.press('Enter');
      await waitForScreen(page, /OpenAI Codex|Ask Codex/i, 60000);
    }
    await waitForScreen(page, /limerick/i, 30000); // the imported conversation renders
    await sleep(4000);
    await typeCmd(page, 'Carry on from where Claude left off: add the last three lines.', 30);
    await waitForIdle(page, 90000);
    await sleep(3500);
  } else if (scenario === 'backdrop') {
    // The tab menu's Background row: colours, and the generative backdrop that
    // paints a pixel-art scene of whatever the tab is working on.
    await typeCmd(page, 'limpet');
    await sleep(1500);
    await typeCmd(page, 'Get-Content winux/README.md -TotalCount 30');
    await sleep(2500);
    await page.locator('.tab.active').click({ button: 'right' });
    await page.waitForSelector('.account-menu .bg .gen', { timeout: 10000 });
    await sleep(2000);
    await page.locator('.account-menu .bg .swatch[data-color="#16294d"]').click();
    await sleep(2500);
    await page.locator('.tab.active').click({ button: 'right' });
    await page.waitForSelector('.account-menu .bg .gen', { timeout: 10000 });
    await sleep(1500);
    await page.locator('.account-menu .bg .gen').click();
    await page.waitForSelector('.term-pane.active.has-backdrop', { timeout: 180000 }).catch(() => {});
    await sleep(5000);
    await page.locator('.tab.active').click({ button: 'right' });
    await page.waitForSelector('.account-menu .bg .gen', { timeout: 10000 });
    await sleep(1500);
    await page.locator('.account-menu .bg .swatch[data-color="#1e1e2e"]').click();
    await sleep(2500);
  } else {
    console.error('unknown scenario:', scenario);
  }

  await sleep(600);
  if (rec) {
    rec.stdin.write('q');
    await new Promise((r) => { rec.on('exit', r); setTimeout(r, 8000); });
  }
  if (frames) {
    clearInterval(frames.timer);
    await sleep(400);
    // Real capture rate (screenshots take a variable time), even dimensions for yuv420p.
    const fps = Math.max(1, Math.round((frames.n / ((Date.now() - frames.start) / 1000)) * 10) / 10);
    const stitched = spawnSync(ffmpeg, ['-y', '-framerate', String(fps), '-i', path.join(frames.dir, '%05d.jpg'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', outFile], { encoding: 'utf8' });
    if (stitched.status !== 0) console.error('stitch failed:', String(stitched.stderr || '').slice(-400));
    fs.rmSync(frames.dir, { recursive: true, force: true });
  }
  await app.close();
  console.log('saved:', outFile, fs.existsSync(outFile) ? fs.statSync(outFile).size : 'MISSING');
})().catch((e) => { console.error('RECORD ERROR:', e); process.exit(1); });
