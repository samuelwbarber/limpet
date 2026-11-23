// Real Electron clipboard -> IPC -> xterm -> PTY. No agent requests are sent.
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const p = require('./platform');

(async () => {
  const userData = path.join(p.userData, 'with spaces');
  const app = await _electron.launch({
    executablePath: require('electron'), args: [path.join(__dirname, '..'), `--user-data-dir=${userData}`],
    timeout: 60000, env: p.launchEnv(),
  });
  try {
    await app.evaluate(async ({ clipboard }) => { global.limpetSavedClipboard = await clipboard.read(); });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof tabs !== 'undefined' && tabs.size === 1);
    await page.waitForFunction((pattern) => {
      const term = tabs.get(activeId).term;
      const text = Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString()).join('\n');
      return new RegExp(pattern, 'm').test(text);
    }, p.promptRe.source);
    await page.evaluate(() => {
      globalThis.clipboardEvents = [];
      tabs.get(activeId).term.onData((data) => clipboardEvents.push(data));
    });
    const fixture = path.join(__dirname, '../../tools/demo/test.png');
    const shortcuts = [...new Set([...p.pasteKeys, 'Control+v'])];
    for (const shortcut of [...shortcuts, 'right-click']) {
      await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, file) => {
        const bytes = nativeImage.createFromPath(file).toPNG();
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes]), 'text/plain': 'IMAGE_TEXT_MUST_NOT_WIN' })]);
      }, fixture);
      await page.evaluate(async () => {
        clipboardEvents.length = 0;
        await new Promise((resolve) => tabs.get(activeId).term.write('\x1b[?2004h', resolve));
      });
      await page.locator('.term-pane.active .xterm-helper-textarea').focus();
      if (shortcut === 'right-click') await page.locator('.term-pane.active').click({ button: 'right' });
      else await page.keyboard.press(shortcut);
      await page.waitForFunction(() => !tabs.get(activeId).clipboardPending && clipboardEvents.length > 0);
      const events = await page.evaluate(() => clipboardEvents);
      assert.equal(events.length, 1, `${shortcut}: one PTY event`);
      assert.ok(events[0].startsWith('\x1b[200~') && events[0].endsWith('\x1b[201~'), `${shortcut}: bracketed paste`);
      const pasted = events[0].slice(6, -6);
      assert.doesNotMatch(pasted, /[\r\n]/, 'no automatic submit');
      const file = pasted.replace(/^['"]|['"]$/g, '');
      assert.equal(fs.realpathSync(path.dirname(file)), fs.realpathSync(path.join(userData, 'clipboard-images')));
      assert.ok(fs.readFileSync(file).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
      assert.equal(await app.evaluate(async ({ clipboard }) => clipboard.has('image/png')), true, 'clipboard remains an image');
      await page.keyboard.press('Control+c');
      console.log(`PASS ${shortcut}: saved PNG, pasted once, no Enter`);
    }

    for (const text of ['ordinary text', 'first\nsecond', '']) {
      await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
      await page.evaluate(async () => {
        clipboardEvents.length = 0;
        await new Promise((resolve) => tabs.get(activeId).term.write('\x1b[?2004h', resolve));
        await pasteClipboard(activeId);
      });
      assert.deepEqual(await page.evaluate(() => clipboardEvents), text ? [`\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~`] : []);
      await page.keyboard.press('Control+c');
    }
    console.log('PASS ordinary, multiline and empty clipboard text');
    await app.evaluate(({ clipboard }) => clipboard.clear());
    await page.evaluate(async () => { clipboardEvents.length = 0; await pasteClipboard(activeId); });
    assert.deepEqual(await page.evaluate(() => clipboardEvents), []);
    console.log('PASS empty clipboard');
  } finally {
    await app.evaluate(async ({ clipboard }) => {
      if (global.limpetSavedClipboard) await clipboard.write(global.limpetSavedClipboard);
    }).catch(() => {});
    await p.closeApp(app);
    p.cleanup();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
