// Record winux demo videos: launch the app with Playwright video recording,
// drive a real flow, save webm per scenario. Usage: node record.js <scenario>
const { _electron } = require('playwright-core');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('ffmpeg-static');

const APP = 'C:/Users/sbarb/winux/app';
const VIDS = path.join(__dirname, 'vids');
fs.mkdirSync(VIDS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function typeCmd(page, text, delay = 45) {
  await page.keyboard.type(text, { delay });
  await sleep(300);
  await page.keyboard.press('Enter');
}

(async () => {
  const scenario = process.argv[2];
  let keepAlive = null;
  if (['xssh', 'remote', 'drop'].includes(scenario)) {
    // WSL2 terminates the distro (and sshd) when the last wsl.exe exits — hold
    // it open for the whole recording and make sure sshd is up.
    keepAlive = spawn('wsl', ['-e', 'sleep', '600'], { stdio: 'ignore' });
    execSync('wsl -u root service ssh start', { timeout: 60000 });
    execSync('ssh -o BatchMode=yes -o ConnectTimeout=5 sbarb@localhost true', { timeout: 20000 });
  }
  process.on('exit', () => { if (keepAlive) try { keepAlive.kill(); } catch (_) {} });
  const app = await _electron.launch({
    executablePath: path.join(APP, 'node_modules/electron/dist/electron.exe'),
    args: [APP],
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('#term .xterm', { timeout: 15000 }).catch(() => {});
  await sleep(4500); // PowerShell + Winux module load

  // Capture the desktop region under the window (gdigrab window-capture of a
  // GPU-composited Electron window comes out white). 'q' on stdin stops it.
  const b = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setAlwaysOnTop(true);
    w.focus();
    return { ...w.getContentBounds(), sf: screen.getPrimaryDisplay().scaleFactor };
  });
  const even = (v) => 2 * Math.floor((v * b.sf) / 2);
  const outFile = path.join(VIDS, `${scenario}.mp4`);
  const errLog = fs.openSync(path.join(VIDS, 'ffmpeg-err.log'), 'w');
  const rec = spawn(ffmpeg, ['-y', '-f', 'gdigrab', '-framerate', '15',
    '-offset_x', String(Math.round(b.x * b.sf)), '-offset_y', String(Math.round(b.y * b.sf)),
    '-video_size', `${even(b.width)}x${even(b.height)}`, '-i', 'desktop',
    '-pix_fmt', 'yuv420p', outFile],
  { stdio: ['pipe', 'ignore', errLog] });
  await sleep(1200);
  await page.click('#term');

  if (scenario === 'shell') {
    await typeCmd(page, 'winux');
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
      return window.winux.dropFiles([p]);
    }, path.join(__dirname, 'report.pdf'));
    await sleep(3500);
    await typeCmd(page, 'ls -la report.pdf');
    await sleep(2600);
  } else {
    console.error('unknown scenario:', scenario);
  }

  await sleep(600);
  rec.stdin.write('q');
  await new Promise((r) => { rec.on('exit', r); setTimeout(r, 8000); });
  await app.close();
  console.log('saved:', outFile, fs.existsSync(outFile) ? fs.statSync(outFile).size : 'MISSING');
})().catch((e) => { console.error('RECORD ERROR:', e); process.exit(1); });
