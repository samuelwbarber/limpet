const assert = require('node:assert/strict');
const { _electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const p = require('./platform');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-recovery-e2e-'));
  let app;
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, '..'), `--user-data-dir=${profile}`], env: p.launchEnv(), timeout: 60000 });
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
    assert.deepEqual(errors, []);
    console.log('PASS cancellation, retained exit status, restart and terminal input');
  } finally {
    if (app) { await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {}); await app.close(); }
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });

