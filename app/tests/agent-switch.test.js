const { test } = require('node:test');
const assert = require('node:assert/strict');
const { switchAgent, verifyLaunch } = require('../src/agent-switch');

function fixture(overrides = {}) {
  const calls = [];
  const sess = { proc: { write: (line) => calls.push(['write', line]) } };
  const deps = {
    accountFor: (cmd) => ({ cmd, kind: 'codex' }),
    detect: async () => ({ cmd: 'claude1', kind: 'claude', pid: 12, sessionId: 'saved' }),
    signedIn: () => true,
    prepare: async () => { calls.push(['prepare']); return { launch: { resume: 'imported' }, how: 'import' }; },
    launch: (cmd, options) => `${cmd} resume ${options.resume}`,
    stop: async () => { calls.push(['stop']); return true; },
    pause: async () => {}, note: (s) => calls.push(['note', s]), ...overrides,
  };
  return { calls, sess, deps };
}

test('prepares and validates the launch before stopping; reports launch, not verified readiness', async () => {
  const f = fixture();
  const result = await switchAgent(f.sess, 'codex1', f.deps);
  assert.deepEqual(f.calls, [['prepare'], ['stop'], ['write', 'codex1 resume imported\r']]);
  assert.equal(result.resumeSessionId, 'imported');
  assert.equal(result.crossProvider, true);
  assert.equal(result.verified, false);
  assert.equal(result.status, 'launching');
  assert.equal(f.sess.switching, false);
});

test('preparation errors, absent sessions, signed-out targets and fresh fallbacks never stop the current agent', async () => {
  for (const overrides of [
    { prepare: async () => { throw new Error('unreadable transcript'); } },
    { detect: async () => ({ cmd: 'claude1', pid: 12 }) },
    { signedIn: () => false },
    { prepare: async () => ({ launch: {}, how: 'fresh' }) },
    { launch: () => { throw new Error('invalid session ID'); } },
  ]) {
    const f = fixture(overrides);
    const result = await switchAgent(f.sess, 'codex1', f.deps);
    assert.equal(result.ok, false);
    assert.equal(f.calls.some(([call]) => call === 'stop' || call === 'write'), false);
    assert.equal(f.sess.switching, false);
  }
});

test('a failed stop never launches a second agent', async () => {
  const f = fixture({ stop: async () => false });
  assert.equal((await switchAgent(f.sess, 'codex1', f.deps)).ok, false);
  assert.equal(f.calls.some(([call]) => call === 'write'), false);
});

test('cross-provider confirmation happens before preparation and cancel preserves the running agent', async () => {
  const f = fixture();
  f.deps.confirmCrossProvider = async (current, target) => {
    assert.equal(current.cmd, 'claude1');
    assert.equal(target.cmd, 'codex1');
    assert.deepEqual(f.calls, []);
    return false;
  };
  const result = await switchAgent(f.sess, 'codex1', f.deps);
  assert.equal(result.cancelled, true);
  assert.deepEqual(f.calls, []);
  assert.equal(f.sess.switching, false);
});

test('cross-provider consent is invalidated when the running session changes during confirmation', async () => {
  let scans = 0;
  const f = fixture({
    confirmCrossProvider: async () => true,
    detect: async () => ({ cmd: 'claude1', kind: 'claude', pid: 12, sessionId: ++scans === 1 ? 'saved' : 'different' }),
  });
  const result = await switchAgent(f.sess, 'codex1', f.deps);
  assert.equal(result.ok, false);
  assert.match(result.reason, /changed while confirming/);
  assert.equal(f.calls.some(([name]) => ['prepare', 'stop', 'write'].includes(name)), false);
});

test('same-provider transfers do not request cross-provider consent', async () => {
  const f = fixture({ accountFor: (cmd) => ({ cmd, kind: 'claude' }), confirmCrossProvider: async () => { throw new Error('unexpected dialog'); } });
  assert.equal((await switchAgent(f.sess, 'claude2', f.deps)).ok, true);
});

test('a write failure supplies the saved source resume command', async () => {
  const f = fixture();
  f.sess.proc.write = () => { throw new Error('closed PTY'); };
  const result = await switchAgent(f.sess, 'codex1', f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.equal(result.recovery, 'claude1 resume saved');
});

test('final saved turns are refreshed after stopping; refresh failure never launches stale content', async () => {
  const f = fixture({ refresh: async () => ({ launch: { resume: 'latest' }, how: 'import' }) });
  assert.equal((await switchAgent(f.sess, 'codex1', f.deps)).resumeSessionId, 'latest');
  assert.deepEqual(f.calls.at(-1), ['write', 'codex1 resume latest\r']);
  const broken = fixture({ refresh: async () => { throw new Error('final transcript unavailable'); } });
  const result = await switchAgent(broken.sess, 'codex1', broken.deps);
  assert.equal(result.ok, false);
  assert.equal(result.recovery, 'claude1 resume saved');
  assert.equal(broken.calls.some(([call]) => call === 'write'), false);
});

test('simultaneous switches cannot interrupt each other', async () => {
  let release;
  const f = fixture({ prepare: () => new Promise((resolve) => { release = resolve; }) });
  const pending = switchAgent(f.sess, 'codex1', f.deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await switchAgent(f.sess, 'codex2', f.deps)).reason, 'busy');
  release({ launch: { resume: 'imported' }, how: 'import' });
  assert.equal((await pending).ok, true);
});

test('readiness requires the destination account and exact resumed session', async () => {
  const f = fixture();
  const found = [null, { cmd: 'claude1', sessionId: 'imported' }, { cmd: 'codex1', sessionId: 'stale' }, { cmd: 'codex1', sessionId: 'imported', sessionEvidence: 'writer-lock' }];
  const verify = await verifyLaunch(f.sess, { cmd: 'codex1' }, { resume: 'imported' }, {
    detect: async () => found.shift(), pause: async () => {}, attempts: 4,
  });
  assert.deepEqual(verify, { verified: true, level: 'session' });
  f.deps.verify = async () => verify;
  assert.equal((await switchAgent(f.sess, 'codex1', f.deps)).status, 'ready');
});

test('verification reports timeout, wrong conversations, and handoff process detection honestly', async () => {
  const f = fixture();
  const target = { cmd: 'codex1' };
  const base = { pause: async () => {}, attempts: 2 };
  assert.deepEqual(await verifyLaunch(f.sess, target, { resume: 'imported' }, { ...base, detect: async () => null }), { verified: false, level: 'timeout' });
  const wrong = await verifyLaunch(f.sess, target, { resume: 'imported' }, { ...base, detect: async () => ({ cmd: 'codex1', sessionId: 'other', sessionEvidence: 'writer-lock' }) });
  assert.match(wrong.error, /different conversation/);
  assert.deepEqual(await verifyLaunch(f.sess, target, { prompt: 'continue' }, { ...base, detect: async () => ({ cmd: 'codex1' }) }), { verified: false, level: 'process' });
  f.sess.exited = true;
  assert.match((await verifyLaunch(f.sess, target, {}, { ...base, detect: async () => null })).error, /shell exited/);
});

test('a freshly imported rollout selected heuristically cannot prove readiness', async () => {
  const f = fixture();
  const target = { cmd: 'codex1' };
  for (const sessionEvidence of ['heuristic', 'none', undefined]) {
    const result = await verifyLaunch(f.sess, target, { resume: 'imported' }, {
      attempts: 2, pause: async () => {},
      detect: async () => ({ cmd: 'codex1', sessionId: 'imported', sessionEvidence }),
    });
    assert.deepEqual(result, { verified: false, level: 'timeout' });
  }
});
