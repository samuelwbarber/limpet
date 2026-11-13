const assert = require('node:assert/strict');
const { _electron } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const p = require('./platform');
(async () => {
  const profile = p.userData;
  let app;
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: p.launchArgs(path.join(__dirname, '..')), env: p.launchEnv(), timeout: 60000 });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForFunction(() => typeof tabs !== 'undefined' && tabs.size === 1);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await page.locator('.tab .close').click();
    assert.equal(await page.locator('.tab').count(), 1, 'cancel preserves tab');
    await page.evaluate(() => window.limpet.sendInput(activeId, 'exit 7\r'));
    await page.getByText('Shell stopped (code 7). Output is kept above.', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.tab').count(), 1, 'failed exit preserves tab');
    await page.getByText('Restart shell', { exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.session-exit'));
    await page.waitForFunction(() => !tabs.get(activeId).term.options.disableStdin);
    await page.evaluate(() => window.limpet.sendInput(activeId, 'echo RECOVERY_OK_7733\r'));
    await page.waitForFunction(() => terminalSnapshot(tabs.get(activeId).term).includes('RECOVERY_OK_7733'));
    // Save a second tab in a scratch directory and verify the persisted layout.
    const restoredDir = path.join(p.testHome, 'project with spaces');
    fs.mkdirSync(restoredDir);
    await page.evaluate((cwd) => newTab(null, 'saved project', cwd), restoredDir);
    await page.waitForFunction(() => tabs.size === 2);
    // zsh's default prompt need not include its working directory.
    await page.evaluate(() => window.limpet.sendInput(activeId, 'pwd\r'));
    await page.waitForFunction(() => terminalSnapshot(tabs.get(activeId).term).includes('project with spaces'));
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'workspace.json'), 'utf8'));
    assert.equal(saved.tabs.length, 2);
    // Windows shell prompts expand 8.3 temp paths (RUNNER~1) to long names.
    const canonicalPath = (value) => {
      const resolved = fs.realpathSync.native(value);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    assert.equal(canonicalPath(saved.tabs[1].cwd), canonicalPath(restoredDir));
    assert.deepEqual(errors, []);
    await p.closeApp(app);
    app = null;
    // A test-only entrypoint answers the restore prompt before the first IPC.
    const entry = path.join(p.testHome, 'restore-entry.cjs');
    fs.writeFileSync(entry, `require('electron').dialog.showMessageBox = async (...args) => ({ response: args.at(-1).message.startsWith('Restore ') ? 0 : 1 }); require(${JSON.stringify(path.join(__dirname, '..', 'src', 'main.js'))});`);
    app = await _electron.launch({ executablePath: require('electron'), args: p.launchArgs(entry), env: p.launchEnv(), timeout: 60000 });
    const restored = await app.firstWindow();
    await restored.waitForFunction(() => typeof tabs !== 'undefined' && tabs.size === 2);
    await restored.evaluate(() => window.limpet.sendInput(activeId, 'pwd\r'));
    await restored.waitForFunction(() => terminalSnapshot(tabs.get(activeId).term).includes('project with spaces'));
    assert.equal(await restored.locator('.session-exit').count(), 0);
    console.log('PASS saved tab directories restored into fresh local shells');
    console.log('PASS cancellation, retained exit status, restart and terminal input');
  } finally {
    if (app) await p.closeApp(app);
    p.cleanup();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });

