const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const platform = require('./platform');
(async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-terminal-ui-'));
  fs.mkdirSync(path.join(fixture, 'home'));
  const app = await _electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, '..'), `--user-data-dir=${path.join(fixture, 'profile')}`], env: platform.launchEnv({ LIMPET_CLAUDE_HOME: path.join(fixture, 'home'), LIMPET_AGENT_RUN: path.join(fixture, 'agents'), LIMPET_FAILOVER: 'off' }) });
  try {
    const page = await app.firstWindow();
    async function clickAction(selector) {
      if (!platform.isMac) return page.click(selector);
      const labels = { '#find-output': 'Find in Output…', '#accounts-button': 'Accounts…', '#settings-button': 'Settings…', '#limpet-help': 'Getting Started…' };
      await app.evaluate(({ Menu }, label) => {
        const find = (menu) => menu.items.map((item) => item.label === label ? item : item.submenu ? find(item.submenu) : null).find(Boolean);
        const item = find(Menu.getApplicationMenu());
        if (!item) throw new Error(`Missing menu action: ${label}`);
        item.click();
      }, labels[selector]);
    }

    const errors = []; page.on('pageerror', (e) => { errors.push(e.message); console.error('PAGE ERROR', e.message); });
    await page.waitForFunction(() => typeof tabs !== 'undefined' && tabs.size === 1);
    await page.waitForFunction((pattern) => { const term = tabs.get(activeId).term; return new RegExp(pattern.source, pattern.flags).test(Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString()).join('\n')); }, { source: platform.promptRe.source, flags: platform.promptRe.flags });
    if (platform.isMac) await page.waitForFunction(() => document.getElementById('terminal-status').hidden);
    await page.evaluate(() => new Promise((resolve) => tabs.get(activeId).term.write('\r\nneedle-one\r\nneedle-two\r\n', resolve)));
    await clickAction('#find-output');
    await page.locator('#terminal-search input').fill('needle');
    await page.waitForFunction(() => tabs.get(activeId).term.getSelection() === 'needle');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#terminal-search .result').textContent(), 'Match found');
    await page.locator('#terminal-search input').fill('missing-3948');
    assert.equal(await page.locator('#terminal-search .result').textContent(), 'No matches');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#terminal-search').isVisible(), false);
    await page.evaluate(() => window.limpet.setSettings({ keybindings: { findOutput: 'Ctrl+Alt+F' } }));
    await page.keyboard.press('Control+Alt+F');
    assert.equal(await page.locator('#terminal-search').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.limpet.setSettings({ keybindings: { findOutput: window.limpet.platform === 'darwin' ? 'Cmd+F' : 'Ctrl+Shift+F' } }));
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('term:status');
      ipcMain.handle('term:status', () => ({ remote: { target: 'user@gpu-box', port: '2222' }, remoteCwd: { cwd: '/workspace/project', depth: 1 }, exited: false }));
    });
    await page.waitForFunction(() => document.getElementById('terminal-connection').textContent.includes('user@gpu-box - /workspace/project (1 further hop(s))'));
    assert.equal(await page.locator('#terminal-status').isVisible(), true);
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('term:status'); ipcMain.handle('term:status', () => ({ remote: null, remoteCwd: null, exited: false })); });
    await page.evaluate(() => { const dialog = document.createElement('dialog'); dialog.id = 'test-modal'; dialog.textContent = 'Modal'; document.body.append(dialog); dialog.showModal(); });
    await page.keyboard.press('Control+Shift+F');
    assert.equal(await page.locator('#terminal-search').isVisible(), false);
    await page.evaluate(() => { document.getElementById('test-modal').close(); document.getElementById('test-modal').remove(); });
    if (await page.locator('#limpet-help').count()) {
      await clickAction('#limpet-help');
      await page.keyboard.press('Control+Shift+F');
      assert.equal(await page.locator('#terminal-search').isVisible(), false);
      assert.equal(await page.evaluate(() => document.getElementById('limpet-welcome').contains(document.activeElement)), true);
      await page.keyboard.press('Escape');
    }
    await clickAction('#settings-button');
    await page.waitForFunction(() => window.LimpetSettings.isOpen());
    await page.keyboard.press('Escape');
    await page.click('#newtab');
    await page.waitForFunction(() => tabs.size === 2);
    await page.locator('[role=tab][aria-selected=true]').focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.activeElement === document.querySelector('[role=tab][aria-selected=true]'));
    assert.equal(await page.locator('[role=tab]').first().getAttribute('aria-selected'), 'true');
    await clickAction('#accounts-button');
    await page.waitForSelector('.account-menu .open-settings');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('open-settings')), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction((id) => document.activeElement.id === id, platform.isMac ? 'newtab' : 'accounts-button');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(420, 600));
    assert.ok((await page.locator('#tabstrip').boundingBox()).width >= 64);
    assert.equal(await page.locator('#newtab').isVisible(), true);
    await clickAction('#accounts-button');
    const bounds = await page.locator('.account-menu').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= await page.evaluate(() => innerWidth));
    await page.keyboard.press('Escape');
    await page.evaluate(() => showAgentSwitchResult(activeId, 'codex1', { ok: false, reason: 'Launch failed; the previous conversation is saved.', recovery: 'claude --resume fixture-123' }));
    assert.match(await page.locator('.term-pane.active .agent-switch-result').textContent(), /Launch failed/);
    assert.equal(await page.locator('.agent-switch-result textarea').inputValue(), 'claude --resume fixture-123');
    assert.equal(await page.locator('.agent-switch-result textarea').getAttribute('readonly'), '');
    await page.evaluate(() => activate([...tabs.keys()][1]));
    assert.equal(await page.locator('.agent-switch-result').isVisible(), false);
    assert.doesNotMatch(await page.locator('#terminal-status').textContent(), /Launch failed/);
    await page.evaluate(() => activate([...tabs.keys()][0]));
    assert.equal(await page.locator('.agent-switch-result').isVisible(), true);
    assert.match(await page.locator('#terminal-status').textContent(), /Launch failed/);
    await page.evaluate(() => showAgentSwitchResult(activeId, 'codex1', { ok: true, status: 'launching', verified: false, verification: 'process', how: 'handoff', crossProvider: true }));
    assert.match(await page.locator('.agent-switch-result').textContent(), /continuity is not verified/);
    assert.match(await page.locator('.agent-switch-result').textContent(), /destination provider/);
    await page.evaluate(() => showAgentSwitchResult(activeId, 'codex1', { ok: true, status: 'launching', verified: false, verification: 'timeout', how: 'import' }));
    assert.match(await page.locator('.agent-switch-result').textContent(), /could not be verified yet/);
    await page.evaluate(() => showAgentSwitchResult(activeId, 'codex1', { ok: true, status: 'ready', verified: true, verification: 'session', how: 'resume' }));
    assert.match(await page.locator('.agent-switch-result').textContent(), /resumed the requested saved conversation/);
    assert.equal(await page.locator('.agent-switch-result').count(), 1);
    await page.locator('.agent-switch-result button').click();
    assert.equal(await page.locator('.agent-switch-result').count(), 0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 720));
    // macOS full screen hides the title bar and its buttons: the tab bar shows
    // its own while it lasts. The window events are emitted by hand, so the
    // test never takes over the screen; close is stubbed to keep the window.
    assert.equal(await page.locator('#window-controls').isVisible(), false);
    if (platform.isMac) {
      await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.close = () => { globalThis.limpetTestCloseAsked = true; }; win.emit('enter-full-screen'); });
      await page.waitForFunction(() => document.body.classList.contains('fullscreen'));
      assert.equal(await page.locator('#window-controls button').count(), 3);
      await page.locator('.term-pane.active .xterm-helper-textarea').focus();
      await page.click('#window-controls [data-action=close]');
      await app.evaluate(() => new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const check = () => globalThis.limpetTestCloseAsked ? resolve() : Date.now() >= deadline ? reject(new Error('Close action was not received')) : setTimeout(check, 10);
        check();
      }));
      assert.equal(await page.evaluate(() => document.activeElement.classList.contains('xterm-helper-textarea')), true);
      // Keyboard users can reach the replacement controls, while mouse clicks
      // keep terminal focus. Check the main-process actions without moving the
      // user's desktop into another Space or minimising their current window.
      await page.locator('#window-controls [data-action=close]').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'minimize');
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        globalThis.limpetTestWindowActions = [];
        win.isFullScreen = () => true;
        win.setFullScreen = (value) => globalThis.limpetTestWindowActions.push(['fullscreen', value]);
        win.minimize = () => globalThis.limpetTestWindowActions.push(['minimize']);
      });
      await page.keyboard.press('Enter');
      await app.evaluate(() => new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const check = () => globalThis.limpetTestWindowActions.length ? resolve() : Date.now() >= deadline ? reject(new Error('Minimise action was not received')) : setTimeout(check, 10);
        check();
      }));
      assert.deepEqual(await app.evaluate(() => globalThis.limpetTestWindowActions), [['fullscreen', false]]);
      await app.evaluate(({ BrowserWindow }) => new Promise((resolve) => {
        BrowserWindow.getAllWindows()[0].emit('leave-full-screen');
        setImmediate(resolve);
      }));
      assert.deepEqual(await app.evaluate(() => globalThis.limpetTestWindowActions), [['fullscreen', false], ['minimize']]);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('enter-full-screen'));
      await page.locator('#window-controls [data-action=exit-fullscreen]').click();
      await app.evaluate(() => new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const check = () => globalThis.limpetTestWindowActions.length === 3 ? resolve() : Date.now() >= deadline ? reject(new Error('Exit fullscreen action was not received')) : setTimeout(check, 10);
        check();
      }));
      assert.deepEqual(await app.evaluate(() => globalThis.limpetTestWindowActions[2]), ['fullscreen', false]);
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        delete win.close; delete win.isFullScreen; delete win.setFullScreen; delete win.minimize;
        win.emit('leave-full-screen');
      });
      assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.some((item) => item.role === 'window')), true);
      // These chords must remain unconsumed for the native Window menu, and
      // must not emit terminal input. Ordinary Home still reaches xterm.
      assert.deepEqual(await page.evaluate(() => {
        const textarea = document.querySelector('.term-pane.active .xterm-helper-textarea');
        const output = [];
        const subscription = tabs.get(activeId).term.onData((data) => output.push(data));
        const consumed = [];
        for (const [key, keyCode] of [['Home', 36], ['End', 35], ['PageUp', 33], ['PageDown', 34]]) {
          for (const modifiers of [{}, { shiftKey: true }, { altKey: true }]) {
            const event = new KeyboardEvent('keydown', { key, keyCode, ctrlKey: true, bubbles: true, cancelable: true, ...modifiers });
            textarea.dispatchEvent(event);
            consumed.push(event.defaultPrevented);
          }
        }
        const tilingOutput = output.join('');
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', keyCode: 36, bubbles: true, cancelable: true }));
        subscription.dispose();
        return { consumed, tilingOutput, homeSent: output.length > 0 };
      }), { consumed: Array(12).fill(false), tilingOutput: '', homeSent: true });
      await page.waitForFunction(() => !document.body.classList.contains('fullscreen'));
      assert.equal(await page.locator('#window-controls').isVisible(), false);
    }
    await page.evaluate(() => new Promise((resolve) => tabs.get(activeId).term.write('\r\nLimpet terminal UX smoke test\r\nSearch output - switch accounts - open settings - recover sessions\r\n', resolve)));
    if (platform.isMac) {
      await page.evaluate(() => window.LimpetTerminalUI.announce(''));
      await page.waitForFunction(() => document.getElementById('terminal-status').hidden);
      assert.equal(await page.locator('#find-output').isVisible(), false);
    }
    const screenshot = process.env.LIMPET_TEST_SCREENSHOT || path.join(fixture, 'terminal-ui.png');
    await page.mouse.move(300, 200);
    await page.screenshot({ path: screenshot });
    console.log(`Screenshot: ${screenshot}`);
    assert.deepEqual(errors, []);
    console.log('PASS terminal search, toolbar, tab keyboard navigation, account focus and compact layout');
  } finally {
    if (platform.closeApp) await platform.closeApp(app); else await app.close();
    platform.cleanup?.();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
