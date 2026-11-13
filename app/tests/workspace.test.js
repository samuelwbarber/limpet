const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const workspace = require('../src/workspace');

test('workspace persists only bounded directory metadata and survives corrupt input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-workspace-'));
  try {
    const file = path.join(dir, 'workspace.json');
    workspace.write(file, [{ cwd: dir, title: 'project', command: 'secret', output: 'secret' }, { cwd: 'relative' }, null]);
    assert.deepEqual(workspace.read(file), [{ cwd: dir, title: 'project' }]);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('secret'));
    fs.writeFileSync(file, '{broken');
    assert.deepEqual(workspace.read(file), []);
    assert.equal(workspace.directory(path.join(dir, 'missing'), dir), dir);
    assert.equal(workspace.directory(file, dir), dir);
    assert.equal(workspace.directory(dir, 'fallback'), dir);
    assert.equal(workspace.cleanTabs(Array(100).fill({ cwd: dir, title: 'a'.repeat(300) })).length, 50);
    assert.equal(workspace.cleanTabs([{ cwd: dir, title: 'a'.repeat(300) }])[0].title.length, 200);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('untrusted workspace paths cannot probe network shares or device namespaces', () => {
  const unsafe = [
    String.raw`\\server\share\project`, '//server/share/project',
    String.raw`\/server\share`, String.raw`/\server\share`,
    String.raw`\\?\UNC\server\share\project`, String.raw`\\?\C:\project`,
    String.raw`\\.\C:\project`, '//?/UNC/server/share/project', '//./pipe/limpet',
    String.raw`\??\UNC\server\share`, String.raw`\Device\HarddiskVolume1\project`,
    'relative/project', 'C:relative', '/project\0suffix', null, 42,
  ];
  const saved = fs.statSync;
  const probed = [];
  fs.statSync = (value) => { probed.push(value); return { isDirectory: () => true }; };
  try {
    for (const value of unsafe) {
      assert.equal(workspace.directory(value, 'fallback'), 'fallback', `reject ${JSON.stringify(value)}`);
      assert.deepEqual(workspace.cleanTabs([{ cwd: value }]), [], `omit ${JSON.stringify(value)}`);
    }
    assert.deepEqual(probed, [], 'reject before stat can initiate network authentication');
    const local = path.join(os.tmpdir(), 'limpet-local-project');
    assert.equal(workspace.directory(local, 'fallback'), local);
    assert.deepEqual(probed, [local]);
  } finally { fs.statSync = saved; }
});
