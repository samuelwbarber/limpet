// Focused e2e: a dragged tab moves its live PTY to a new BrowserWindow, and
// terminal URLs are handed to the OS rather than opened as Electron popups.
const { _electron } = require('playwright-core');
const path = require('path');

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

(async () => {
  const electronApp = await _electron.launch({
    executablePath: path.join(APP, 'node_modules/electron/dist/electron.exe'),
    args: [APP], timeout: 60000,
    env: { ...process.env, LIMPET_DISABLE_BACKDROPS: '1' },
  });
  const source = await electronApp.firstWindow();
  const pageErrors = [];
  source.on('pageerror', (e) => pageErrors.push(e.message));
  check('first prompt appears', !!(await waitFor(async () => /PS [A-Z]:/.test(await screenText(source)), 30000)));

  await source.click('#newtab');
  check('second tab opens', !!(await waitFor(() => source.locator('.tab').count().then((n) => n === 2), 10000)));
  await type(source, "$global:LimpetDetachMarker = 'LIVE_PTY_7733'; Write-Output DETACH_READY_7733");
  check('second PTY is ready before detach', !!(await waitFor(async () => (await screenText(source)).includes('DETACH_READY_7733'), 8000)));

  const detachedWindow = electronApp.waitForEvent('window', { timeout: 10000 });
  const tabBox = await source.locator('.tab.active').boundingBox();
  const viewport = await source.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await source.mouse.move(tabBox.x + 30, tabBox.y + tabBox.height / 2);
  await source.mouse.down();
  await source.mouse.move(tabBox.x + 50, tabBox.y + tabBox.height / 2, { steps: 4 });
  await source.mouse.move(viewport.width + 120, Math.min(120, viewport.height - 10), { steps: 12 });
  await source.mouse.up();
  const detached = await detachedWindow;
  detached.on('pageerror', (e) => pageErrors.push(e.message));
  check('source keeps its other tab', !!(await waitFor(() => source.locator('.tab').count().then((n) => n === 1), 10000)));
  check('detached window owns one tab', !!(await waitFor(() => detached.locator('.tab').count().then((n) => n === 1), 10000)));

  await detached.locator('.term-pane.active').click();
  await sleep(500);
  await type(detached, "if ($global:LimpetDetachMarker -eq 'LIVE_PTY_7733') { Write-Output LIVE_PTY_PRESERVED_7733 } else { Write-Output PTY_RESTARTED_7733 }");
  check('detached tab keeps the live PTY', !!(await waitFor(async () => (await screenText(detached)).includes('LIVE_PTY_PRESERVED_7733'), 8000)));

  await type(detached, "[Console]::Write([char]27); [Console]::Write(']2;Claude Code - Building a slot machine app'); [Console]::Write([char]7); Start-Sleep -Milliseconds 1500; Write-Output TITLE_READY_7733");
  const expectedTitle = 'Claude Code - Building a slot machine app';
  const titleSeen = await waitFor(async () => {
    const observed = await detached.locator('.tab.active .title').textContent();
    return observed === expectedTitle ? observed : null;
  }, 8000);
  check('agent OSC title reaches the detached tab', titleSeen === expectedTitle);
  if (!titleSeen) console.log('  observed tab title:', await detached.locator('.tab.active .title').textContent());
  await waitFor(async () => (await screenText(detached)).includes('TITLE_READY_7733'), 5000);

  // Replace shell.openExternal inside the Electron main process so this test
  // records the URL without launching the user's real browser.
  await electronApp.evaluate(({ shell }) => {
    global.__limpetOpenedUrl = null;
    shell.openExternal = async (url) => { global.__limpetOpenedUrl = url; };
  });
  const url = 'https://example.com/limpet-link-check';
  await type(detached, `Write-Output '${url}'`);
  const linkPoint = await waitFor(() => detached.evaluate((needle) => {
    const rows = [...document.querySelectorAll('.term-pane.active .xterm-rows > div')];
    const row = rows.reverse().find((el) => el.textContent.includes(needle));
    if (!row) return null;
    const range = document.createRange();
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !text.textContent.includes(needle)) text = walker.nextNode();
    if (!text) return null;
    const offset = text.textContent.indexOf(needle);
    range.setStart(text, offset + 5);
    range.setEnd(text, offset + 6);
    const box = range.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, url), 8000);
  check('plain URL is linkified', !!linkPoint);
  if (linkPoint) {
    await detached.mouse.click(linkPoint.x, linkPoint.y);
    const opened = await waitFor(() => electronApp.evaluate(() => global.__limpetOpenedUrl), 5000);
    check('URL opens through the system-browser handler', opened === url);
    check('link click does not create an Electron popup', electronApp.windows().length === 2);
  }

  check('no renderer page errors', pageErrors.length === 0);
  if (pageErrors.length) console.log('  page errors:', pageErrors.join(' | '));
  await electronApp.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('DRIVER ERROR:', e); process.exit(1); });
