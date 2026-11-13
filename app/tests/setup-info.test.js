const test = require('node:test');
const assert = require('node:assert/strict');
const { setupInfo } = require('../src/setup-info');

test('Windows setup checks recognize executable extensions and quoted PATH entries without executing anything', () => {
  const seen = [];
  const result = setupInfo({ platform: 'win32', env: { Path: '"C:\\Tools";C:\\Windows', PATHEXT: '.EXE;.CMD' }, stat: (file) => {
    seen.push(file);
    if (file === 'C:\\Tools\\codex.CMD') return { isFile: () => true };
    throw new Error('missing');
  } });
  assert.equal(result.tools.find((t) => t.name === 'codex').present, true);
  assert.equal(result.tools.find((t) => t.name === 'ssh').present, false);
  assert.ok(seen.every((file) => !file.includes('"')));
});

test('POSIX checks reject directories and files without execute permission', () => {
  const result = setupInfo({ platform: 'linux', env: { PATH: '/tools' }, stat: (file) => ({
    isFile: () => !file.endsWith('/scp'), mode: file.endsWith('/ssh') ? 0o755 : 0o644,
  }) });
  assert.deepEqual(result.tools.filter((t) => t.present).map((t) => t.name), ['ssh']);
});

test('missing PATH reports unavailable tools and never reads the current directory', () => {
  const result = setupInfo({ env: {}, stat: () => { throw new Error('must not be called'); } });
  assert.ok(result.tools.every((t) => !t.present));
});
