const test = require('node:test');
const assert = require('node:assert/strict');
const { exportOpenCodeSession } = require('../src/opencode');

test('OpenCode export uses its public command on Unix and Windows with bounded execution', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const output = JSON.stringify({ info: { id: 'ses_test' }, messages: [] });
    const result = await exportOpenCodeSession('ses_test', { platform, run(file, args, options, done) {
      assert.equal(file, platform === 'win32' ? 'powershell.exe' : 'opencode');
      if (platform !== 'win32') assert.deepEqual(args, ['export', 'ses_test']);
      else assert.match(args.at(-1), /opencode export/);
      assert.equal(options.env.LIMPET_OC_SESSION, 'ses_test');
      assert.equal(options.timeout, 30000);
      assert.equal(options.maxBuffer, 30 * 1024 * 1024);
      done(null, output);
    } });
    assert.equal(result, output);
  }
});
test('OpenCode export rejects invalid ids, CLI failures and mismatched or malformed exports', async () => {
  await assert.rejects(exportOpenCodeSession('ses_x;evil', { run() { assert.fail('must not execute'); } }));
  for (const [error, output] of [[new Error('failed'), ''], [null, 'banner'], [null, '{}'], [null, '{"messages":[]}'], [null, '{"info":{},"messages":[]}'], [null, '{"info":{"id":"ses_other"},"messages":[]}']]) {
    await assert.rejects(exportOpenCodeSession('ses_test', { run(_file, _args, _options, done) { done(error, output); } }));
  }
});
