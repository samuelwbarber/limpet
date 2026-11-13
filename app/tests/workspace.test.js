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
