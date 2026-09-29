// Unit tests for src/remote-copy.js: parsing the xssh/cwd reports, deciding
// paste vs scp vs refuse for a drop, the scp argv, and running it (spawn is
// swapped for a fake, so no scp or network is needed).
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const rc = require('../src/remote-copy');

const b64 = (x) => Buffer.from(x).toString('base64');
const MB = 1024 * 1024;

test('parseXssh: connect, disconnect, and targets scp must not see', () => {
  assert.deepStrictEqual(rc.parseXssh([b64('me@box'), '2222']), { target: 'me@box', port: '2222' });
  assert.deepStrictEqual(rc.parseXssh([b64('box'), '']), { target: 'box', port: '' });
  assert.strictEqual(rc.parseXssh(['', '']), null); // ssh ended
  assert.ok(rc.parseXssh([b64('-oProxyCommand=calc'), '']).error);
  assert.ok(rc.parseXssh([b64('a b'), '']).error);
  assert.ok(rc.parseXssh([b64('box'), '99999']).error);
  assert.ok(rc.parseXssh([b64('box'), '22;x']).error);
});

test('parseCwd: directory and depth', () => {
  assert.deepStrictEqual(rc.parseCwd([b64('/home/me/proj'), '0']), { cwd: '/home/me/proj', depth: 0 });
  assert.deepStrictEqual(rc.parseCwd([b64('/data'), '2']), { cwd: '/data', depth: 2 });
  assert.strictEqual(rc.parseCwd([b64('/x'), '']), null);
  assert.strictEqual(rc.parseCwd([b64('/x'), 'one']), null);
  assert.strictEqual(rc.parseCwd(['', '0']), null);
});

test('splitDrop: folders and big files need scp, small files paste', () => {
  const r = rc.splitDrop([
    { path: 'a.txt', isDir: false, size: 10 },
    { path: 'dir', isDir: true, size: 0 },
    { path: 'big.iso', isDir: false, size: 21 * MB },
    { path: 'edge.bin', isDir: false, size: 20 * MB },
  ], 20 * MB);
  assert.deepStrictEqual(r, { paste: ['a.txt', 'edge.bin'], copy: ['dir', 'big.iso'] });
});

test('planDrop: scp only to a known host and a depth-0 prompt with a plain path', () => {
  const remote = { target: 'me@box', port: '2222' };
  const cwd = (d, depth = 0) => ({ cwd: d, depth });
  assert.deepStrictEqual(rc.planDrop(remote, cwd('/home/me')), { ok: true, target: 'me@box', port: '2222', dir: '/home/me' });
  assert.ok(rc.planDrop(remote, cwd('/home/me/ünï-cödé_1.2,x@y')).ok);
  assert.match(rc.planDrop(null, cwd('/home/me')).reason, /isn't in an xssh session/);
  assert.match(rc.planDrop(remote, null).reason, /isn't known yet/);
  assert.match(rc.planDrop(remote, cwd('/home/me', 1)).reason, /1 xssh hop/);
  assert.match(rc.planDrop({ error: 'unusable host' }, cwd('/x')).reason, /unusable host/);
  for (const bad of ['/home/my dir', '/tmp/$(id)', '/a;b', "/it's", '/a\nb', '/glob*', 'relative/dir']) {
    assert.match(rc.planDrop(remote, cwd(bad)).reason, /mangle/, bad);
  }
});

test('buildScpArgs: an argv, non-interactive, into the directory', () => {
  assert.deepStrictEqual(
    rc.buildScpArgs({ paths: ['C:\\Users\\me\\My Stuff', 'C:\\big.iso'], target: 'me@box', port: '2222', dir: '/srv/in', key: 'C:\\Users\\me\\.ssh\\id_ed25519' }),
    ['-r', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-P', '2222', '-i', 'C:\\Users\\me\\.ssh\\id_ed25519',
      '--', 'C:\\Users\\me\\My Stuff', 'C:\\big.iso', 'me@box:/srv/in/'],
  );
  const noPort = rc.buildScpArgs({ paths: ['x'], target: 'box', port: '', dir: '/', key: null });
  assert.deepStrictEqual(noPort, ['-r', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', 'x', 'box:/']);
});

test('defaultKey: only when id_ed25519 exists', () => {
  assert.match(rc.defaultKey('/h', () => true), /[\\/]h[\\/]\.ssh[\\/]id_ed25519$/);
  assert.strictEqual(rc.defaultKey('/h', () => false), null);
});

test('describeScpFailure: auth errors point at wput', () => {
  assert.match(rc.describeScpFailure(255, 'me@box: Permission denied (publickey,password).\r\nscp: Connection closed\r\n'), /Connection closed -- .*use wput/);
  assert.strictEqual(rc.describeScpFailure(1, 'scp: /srv/in/: No such file or directory\n'), 'scp: /srv/in/: No such file or directory');
  assert.strictEqual(rc.describeScpFailure(1, ''), 'scp exited 1');
});

function fakeSpawn(behave) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    calls.push({ cmd, args, opts });
    setImmediate(() => behave(child));
    return child;
  };
  return { fn, calls };
}

test('runScp: reports progress and success without a real scp', async () => {
  const saved = rc.io.spawn;
  const lines = [];
  try {
    const f = fakeSpawn((c) => c.emit('close', 0));
    rc.io.spawn = f.fn;
    const ok = await rc.runScp({ paths: ['/pc/a', '/pc/b'], target: 'box', port: '', dir: '/srv' }, (color, t) => lines.push([color, t]));
    assert.strictEqual(ok, true);
    assert.strictEqual(f.calls[0].cmd, 'scp');
    assert.strictEqual(f.calls[0].opts.windowsHide, true);
    assert.match(lines[0][1], /copying 2 items to box:\/srv over scp/);
    assert.match(lines[1][1], /^done: 2 items in box:\/srv/);
  } finally { rc.io.spawn = saved; }
});

test('runScp: a missing scp and an auth failure are reported, not thrown', async () => {
  const saved = rc.io.spawn;
  try {
    let lines = [];
    rc.io.spawn = fakeSpawn((c) => c.emit('error', Object.assign(new Error('spawn scp ENOENT'), { code: 'ENOENT' }))).fn;
    assert.strictEqual(await rc.runScp({ paths: ['/pc/a'], target: 'box', dir: '/srv' }, (c, t) => lines.push(t)), false);
    assert.match(lines[1], /scp not found/);
    lines = [];
    rc.io.spawn = fakeSpawn((c) => { c.stderr.emit('data', 'box: Permission denied (publickey).\n'); c.emit('close', 255); }).fn;
    assert.strictEqual(await rc.runScp({ paths: ['/pc/a'], target: 'box', dir: '/srv' }, (c, t) => lines.push(t)), false);
    assert.match(lines[0], /copying a to box:\/srv/);
    assert.match(lines[1], /failed: .*use wput/);
  } finally { rc.io.spawn = saved; }
});
