// Launch a separate repo copy of Limpet, seed one terminal with enough
// slot-machine work to exercise automatic local backdrop generation, and leave
// the window open until the user closes it.
const path = require('path');
const fs = require('fs');
const { _electron } = require('playwright-core');

const APP = path.join(__dirname, '..');
const previewImage = process.argv[2] ? path.resolve(APP, process.argv[2]) : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, everyMs = 300) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(everyMs);
  }
  return null;
}

(async () => {
  const electronApp = await _electron.launch({
    executablePath: path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [APP],
    timeout: 60000,
  });
  const page = await electronApp.firstWindow();
  page.on('pageerror', (error) => console.error('[demo renderer]', error.message));

  await page.evaluate(() => {
    window.__limpetBackdropDemo = { status: 'waiting', hasImage: false };
    window.limpet.onBackdropStatus(({ state, message }) => {
      window.__limpetBackdropDemo.status = state;
      window.__limpetBackdropDemo.message = message || '';
    });
    window.limpet.onBackdrop(() => {
      window.__limpetBackdropDemo.status = 'ready';
      window.__limpetBackdropDemo.hasImage = true;
    });
  });

  const ready = await waitFor(() => page.evaluate(() => {
    const rows = document.querySelector('.term-pane.active .xterm-rows');
    return rows && /PS [A-Z]:/.test(rows.innerText);
  }), 30000);
  if (!ready) throw new Error('PowerShell prompt did not appear');

  if (previewImage) {
    const dataUrl = `data:image/png;base64,${fs.readFileSync(previewImage).toString('base64')}`;
    await page.evaluate((image) => {
      document.title = 'Limpet clarity preview';
      const pane = document.querySelector('.term-pane.active');
      pane.style.backgroundImage = `url("${image}")`;
      pane.classList.add('has-backdrop');
    }, dataUrl);
    await page.locator('.term-pane.active .xterm-helper-textarea').focus();
    await page.keyboard.type("Write-Output 'Clarity preview: slot-machine development backdrop'; Write-Output 'Terminal text remains readable over the identifiable subject.'", { delay: 1 });
    await page.keyboard.press('Enter');
    console.log('Clarity preview is open and will stay open until you close it.');
    await new Promise((resolve) => electronApp.once('close', resolve));
    return;
  }

  await page.locator('.term-pane.active .xterm-helper-textarea').focus();
  const command = "1..160 | ForEach-Object { Write-Output (\"Building slot machine app stage {0}: spinning fruit reels, paylines, jackpot animation, coin sounds, responsive spin button, testing reel timing and payout logic.\" -f $_) }";
  await page.keyboard.type(command, { delay: 1 });
  await page.keyboard.press('Enter');
  console.log('Demo terminal is ready. Waiting for the idle gate...');
  await sleep(15000);
  const queueResult = await page.evaluate(() => {
    const tab = document.querySelector('.tab.active');
    const rows = document.querySelector('.term-pane.active .xterm-rows');
    const id = Number(tab && tab.dataset.sessionId);
    const visible = rows ? rows.innerText : '';
    const transcript = Array.from({ length: 40 }, (_, i) =>
      `Slot machine development stage ${i}: spinning fruit reels, paylines, jackpot animation, coin sounds, responsive spin button, reel timing and payout logic.`);
    return window.limpet.considerBackdrop(id, `${visible}\n${transcript.join('\n')}`);
  });
  console.log(`Backdrop queue: ${queueResult && queueResult.status}`);
  if (!queueResult || !['queued', 'busy'].includes(queueResult.status)) {
    throw new Error(`Backdrop was not queued: ${JSON.stringify(queueResult)}`);
  }

  let previous = '';
  while (!page.isClosed()) {
    const state = await page.evaluate(() => window.__limpetBackdropDemo);
    if (state.status !== previous) {
      previous = state.status;
      console.log(`Backdrop status: ${state.status}${state.message ? ` (${state.message})` : ''}`);
    }
    if (state.hasImage) {
      console.log('Backdrop ready. The demo window will stay open until you close it.');
      break;
    }
    await sleep(1000);
  }

  if (!page.isClosed()) {
    await new Promise((resolve) => electronApp.once('close', resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
