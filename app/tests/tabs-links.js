// Focused e2e: a dragged tab moves its live PTY to a new BrowserWindow, and
// terminal URLs are handed to the OS rather than opened as Electron popups.
const { _electron } = require('playwright-core');
const path = require('path');
const p = require('./platform');

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
    executablePath: require(path.join(APP, 'node_modules', 'electron')), // fetched on first use
    args: p.launchArgs(APP), timeout: 60000,
    env: p.launchEnv(),
  });
  const source = await electronApp.firstWindow();
  const pageErrors = [];
  source.on('pageerror', (e) => pageErrors.push(e.message));
  check('first prompt appears', !!(await waitFor(async () => p.promptRe.test(await screenText(source)), 30000)));

  await source.click('#newtab');
  check('second tab opens', !!(await waitFor(() => source.locator('.tab').count().then((n) => n === 2), 10000)));
  await type(source, p.setVar('LimpetDetachMarker', 'LIVE_PTY_7733', 'DETACH_READY_7733'));
  check('second PTY is ready before detach', !!(await waitFor(async () => (await screenText(source)).includes('DETACH_READY_7733'), 8000)));

  const detachedWindow = electronApp.waitForEvent('window', { timeout: 10000 });
  // Native drag events become unreliable when CI runs through a remote Windows
  // desktop with mixed DPI. Dispatch the same browser event sequence at an
  // unambiguously external screen point so the detach path stays deterministic.
  await source.locator('.tab.active').evaluate((tab) => {
    const dataTransfer = new DataTransfer();
    const screenX = window.screenX + window.outerWidth + 120;
    const screenY = window.screenY + 80;
    const eventInit = { bubbles: true, cancelable: true, dataTransfer, screenX, screenY };
    tab.dispatchEvent(new DragEvent('dragstart', eventInit));
    tab.dispatchEvent(new DragEvent('drag', eventInit));
    tab.dispatchEvent(new DragEvent('dragend', eventInit));
  });
  const detached = await detachedWindow;
  detached.on('pageerror', (e) => pageErrors.push(e.message));
  check('source keeps its other tab', !!(await waitFor(() => source.locator('.tab').count().then((n) => n === 1), 10000)));
  check('detached window owns one tab', !!(await waitFor(() => detached.locator('.tab').count().then((n) => n === 1), 10000)));

  await detached.locator('.term-pane.active').click();
  await sleep(500);
  await type(detached, p.testVar('LimpetDetachMarker', 'LIVE_PTY_7733', 'LIVE_PTY_PRESERVED_7733', 'PTY_RESTARTED_7733'));
  check('detached tab keeps the live PTY', !!(await waitFor(async () => (await screenText(detached)).includes('LIVE_PTY_PRESERVED_7733'), 8000)));

  const expectedTitle = 'Claude Code - Building a slot machine app';
  await type(detached, p.setTitle(expectedTitle, 'TITLE_READY_7733'));
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
  await type(detached, p.echoQuoted(url));
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
