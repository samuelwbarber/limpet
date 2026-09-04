// Unit tests for the Codex app-server import client (src/codex-import.js),
// driven against tests/fake-appserver.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { importClaudeSession, recordedThread } = require('../src/codex-import');

const fake = (mode) => ({ file: process.execPath, args: [path.join(__dirname, 'fake-appserver.js'), mode] });
const A = 'C:\\anywhere\\11111111-2222-4333-8444-555555555555.jsonl';
const PRIOR = '01a00000-0000-7000-8000-0000000000ee';

// A codex home with an import record for A, optionally with the thread's rollout present.
function codexHomeWith({ rollout }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-codex-home-'));
  fs.writeFileSync(path.join(home, 'external_agent_session_imports.json'), JSON.stringify({ records: [
    { source_path: `\\\\?\\C:\\elsewhere\\${path.basename(A)}`, imported_thread_id: PRIOR, imported_at: 5 },
    { source_path: 'C:\\x\\other.jsonl', imported_thread_id: '01a00000-0000-7000-8000-0000000000ff', imported_at: 9 },
  ] }));
  if (rollout) {
    fs.mkdirSync(path.join(home, 'sessions', '2026', '09', '04'), { recursive: true });
    fs.writeFileSync(path.join(home, 'sessions', '2026', '09', '04', `rollout-2026-09-04T10-00-00-${PRIOR}.jsonl`), '{}\n');
  }
  return home;
}

test('imports exactly the requested session and returns the new thread id', async () => {
  const id = await importClaudeSession(A, { command: fake('ok'), codexHome: codexHomeWith({ rollout: false }) });
  assert.strictEqual(id, '01a00000-0000-7000-8000-00000000abcd');
});

test('falls back to the recorded thread when codex has already imported the transcript', async () => {
  const home = codexHomeWith({ rollout: true });
  assert.strictEqual(recordedThread(A, home), PRIOR);
  assert.strictEqual(await importClaudeSession(A, { command: fake('missing'), codexHome: home }), PRIOR);
});

test('rejects when codex does not list the session and no live thread is recorded', async () => {
  await assert.rejects(importClaudeSession(A, { command: fake('missing'), codexHome: codexHomeWith({ rollout: false }) }), /did not detect/);
  await assert.rejects(importClaudeSession('C:\\x\\99999999-9999-4999-8999-999999999999.jsonl', { command: fake('ok'), codexHome: codexHomeWith({ rollout: true }) }), /did not detect/);
  assert.strictEqual(recordedThread(A, path.join(os.tmpdir(), 'no-such-codex-home')), null);
});

test('rejects with the importer message when the import fails', async () => {
  await assert.rejects(importClaudeSession(A, { command: fake('fail'), codexHome: codexHomeWith({ rollout: false }) }), /boom/);
});

test('times out when the import never completes', async () => {
  await assert.rejects(importClaudeSession(A, { command: fake('hang'), timeoutMs: 800, codexHome: codexHomeWith({ rollout: false }) }), /timed out/);
});

test('rejects when the app-server cannot be started', async () => {
  await assert.rejects(importClaudeSession(A, { command: { file: 'no-such-codex-binary.exe', args: [] }, timeoutMs: 5000 }), /could not start|exited/);
});
