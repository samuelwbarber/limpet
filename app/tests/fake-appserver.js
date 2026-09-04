// A stand-in for `codex app-server` (newline-delimited JSON-RPC on stdio) for
// tests/codex-import.test.js. Modes (argv[2]): ok (default), fail, missing, hang.
const mode = process.argv[2] || 'ok';
const A = 'C:\\h\\.claude\\projects\\C--w\\11111111-2222-4333-8444-555555555555.jsonl';
const B = 'C:\\h\\.claude\\projects\\C--w\\66666666-7777-4888-9999-aaaaaaaaaaaa.jsonl';
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
    else if (m.method === 'externalAgentConfig/detect') {
      const sessions = mode === 'missing' ? [] : [{ path: A, cwd: 'C:\\w', title: 'A' }, { path: B, cwd: 'C:\\w', title: 'B' }];
      send({ id: m.id, result: { items: [
        { itemType: 'PLUGINS', description: 'plugins', details: { plugins: [] } },
        { itemType: 'SESSIONS', description: 'sessions', cwd: null, details: { sessions } },
      ] } });
    } else if (m.method === 'externalAgentConfig/import') {
      const item = m.params.migrationItems.find((it) => it.itemType === 'SESSIONS');
      const chosen = item.details.sessions;
      if (chosen.length !== 1) { send({ id: m.id, error: { message: `expected exactly one session, got ${chosen.length}` } }); return; }
      send({ id: m.id, result: { importId: 'imp-1' } });
      if (mode === 'hang') return;
      setTimeout(() => {
        const results = mode === 'fail'
          ? [{ itemType: 'SESSIONS', successes: [], failures: [{ itemType: 'SESSIONS', failureStage: 'convert', message: 'boom' }] }]
          : [{ itemType: 'SESSIONS', successes: [{ itemType: 'SESSIONS', source: `\\\\?\\${chosen[0].path}`, target: '01a00000-0000-7000-8000-00000000abcd', title: 'A' }], failures: [] }];
        send({ method: 'externalAgentConfig/import/progress', params: { importId: 'imp-1', itemTypeResults: results } });
        send({ method: 'externalAgentConfig/import/completed', params: { importId: 'imp-1', itemTypeResults: results } });
      }, 50);
    } else if (m.id !== undefined) send({ id: m.id, result: {} });
  }
});
