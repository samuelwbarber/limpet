// Unit tests for the transcript handoff logic (src/handoff.js).
const test = require('node:test');
const assert = require('node:assert');
const {
  parseClaudeTranscript, parseCodexRollout, renderMarkdown, continuePrompt,
  buildClaudeTranscript, claudeProjectDirName, titleFromTurns, cleanUserText,
} = require('../src/handoff');

const SID = '11111111-2222-4333-8444-555555555555';
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

// The shapes Claude Code actually writes (see a real projects/*.jsonl).
const claudeRows = [
  { type: 'permission-mode', permissionMode: 'default', sessionId: SID },
  { type: 'user', isSidechain: false, uuid: 'u1', parentUuid: null, sessionId: SID, message: { role: 'user', content: 'fix the build' } },
  { type: 'assistant', isSidechain: false, uuid: 'a1', parentUuid: 'u1', message: { id: 'msg1', role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Running the tests first.' }] } },
  { type: 'assistant', isSidechain: false, uuid: 'a2', parentUuid: 'a1', message: { id: 'msg1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test', description: 'run tests' } }] } },
  { type: 'user', isSidechain: false, uuid: 'u2', parentUuid: 'a2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '2 failing' }] }] } },
  { type: 'assistant', isSidechain: true, uuid: 's1', parentUuid: null, message: { id: 'msg9', role: 'assistant', content: [{ type: 'text', text: 'SIDECHAIN NOISE' }] } },
  { type: 'assistant', isSidechain: false, uuid: 'a3', parentUuid: 'u2', message: { id: 'msg2', role: 'assistant', content: [{ type: 'text', text: 'Two tests fail in parser.js; fixing.' }, { type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: 'src/parser.js', old_string: 'a', new_string: 'b' } }] } },
  { type: 'user', isSidechain: false, uuid: 'u3', parentUuid: 'a3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] } },
  { type: 'user', isSidechain: false, uuid: 'u4', parentUuid: 'a3', message: { role: 'user', content: '<command-name>/resume</command-name>\n<command-message>resume</command-message>' } },
  { type: 'user', isSidechain: false, uuid: 'u5', parentUuid: 'u4', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>ignore me</system-reminder>now add a test for it' }] } },
  { type: 'assistant', isSidechain: false, uuid: 'a4', parentUuid: 'u5', message: { id: 'msg3', role: 'assistant', content: [{ type: 'text', text: 'Added parser.test.js.' }] } },
  { type: 'last-prompt', lastPrompt: 'now add a test for it', leafUuid: 'a4', sessionId: SID },
];

test('parseClaudeTranscript turns a real-shaped transcript into clean turns with tools attached', () => {
  const turns = parseClaudeTranscript(jsonl(claudeRows));
  assert.deepStrictEqual(turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
  assert.strictEqual(turns[0].text, 'fix the build');
  assert.strictEqual(turns[1].text, 'Running the tests first.\nTwo tests fail in parser.js; fixing.');
  assert.deepStrictEqual(turns[1].tools, [
    { name: 'Bash', input: 'npm test', output: '2 failing' },
    { name: 'Edit', input: 'src/parser.js', output: 'ok' },
  ]);
  assert.strictEqual(turns[2].text, 'now add a test for it');
  assert.ok(!JSON.stringify(turns).includes('SIDECHAIN NOISE'));
  assert.ok(!JSON.stringify(turns).includes('command-name'));
});

const codexRows = [
  { type: 'session_meta', payload: { id: '01a00000-0000-7000-8000-000000000002', cwd: 'C:\\w', timestamp: '2026-09-04T10:00:00Z' } },
  { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>...</skills_instructions>' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>C:\\w</cwd>\n</environment_context>' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rename the helper' }] } },
  { type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'zzz' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking for it.' }] } },
  { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'rg -n helper src' } },
  { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'src/a.js:3:helper' }] } },
  { type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name: 'apply_patch', arguments: '{"path":"src/a.js","patch":"..."}' } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: 'Done' } },
  { type: 'event_msg', payload: { type: 'agent_message', message: 'duplicate of the response item, ignored' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Renamed helper to util.' }] } },
];

test('parseCodexRollout keeps the person and the agent, drops injected context and reasoning', () => {
  const turns = parseCodexRollout(jsonl(codexRows));
  assert.deepStrictEqual(turns.map((t) => t.role), ['user', 'assistant']);
  assert.strictEqual(turns[0].text, 'rename the helper');
  assert.strictEqual(turns[1].text, 'Looking for it.\nRenamed helper to util.');
  assert.deepStrictEqual(turns[1].tools, [
    { name: 'exec', input: 'rg -n helper src', output: 'src/a.js:3:helper' },
    { name: 'apply_patch', input: 'src/a.js', output: 'Done' },
  ]);
  assert.ok(!JSON.stringify(turns).includes('skills_instructions'));
  assert.ok(!JSON.stringify(turns).includes('duplicate of the response item'));
});

test('cleanUserText strips reminders and rejects harness-injected blocks', () => {
  assert.strictEqual(cleanUserText('<system-reminder>x</system-reminder> hi'), 'hi');
  assert.strictEqual(cleanUserText('<environment_context>\n<cwd>x</cwd>\n</environment_context>'), '');
  assert.strictEqual(cleanUserText('<custom_tag>all of it</custom_tag>'), '');
  assert.strictEqual(cleanUserText('use <b>bold</b> here'), 'use <b>bold</b> here');
  assert.strictEqual(cleanUserText('[Request interrupted by user]'), '');
});

test('renderMarkdown writes readable turns and trims the middle when too long', () => {
  const turns = parseClaudeTranscript(jsonl(claudeRows));
  const md = renderMarkdown(turns, { source: 'Claude Code (claude1)', cwd: 'C:\\w', when: new Date('2026-09-04T12:00:00Z') });
  assert.ok(md.startsWith('# Conversation handoff'));
  assert.ok(md.includes('Claude Code (claude1)') && md.includes('`C:\\w`') && md.includes('2026-09-04 12:00'));
  assert.ok(md.includes('## User\n\nfix the build') && md.includes('- tool `Bash`: npm test\n  → 2 failing'));
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i} ${'x'.repeat(500)}`, tools: [] });
  const short = renderMarkdown(many, { maxBytes: 4000 });
  assert.ok(short.includes('turn 0 ') && short.includes('turn 39 ') && !short.includes('turn 20 '));
  assert.match(short, /_\(\d+ earlier turns omitted/);
  assert.ok(Buffer.byteLength(short) < 6000);
});

test('continuePrompt is one line naming the file and the source agent', () => {
  const p = continuePrompt('C:\\h o\\x.md', 'Codex');
  assert.ok(!/[\r\n]/.test(p) && p.includes('C:\\h o\\x.md') && p.includes('Codex'));
});

test('buildClaudeTranscript writes a chained transcript Claude Code can resume', () => {
  const turns = parseCodexRollout(jsonl(codexRows));
  const { sessionId, jsonl: text } = buildClaudeTranscript(turns, { cwd: 'C:\\w', title: 'rename the helper', version: '2.1.260', now: 1000000000000 });
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  const rows = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(rows.map((r) => r.type), ['user', 'assistant', 'ai-title', 'last-prompt']);
  assert.strictEqual(rows[0].parentUuid, null);
  assert.strictEqual(rows[1].parentUuid, rows[0].uuid);
  assert.strictEqual(rows[0].message.content, 'rename the helper');
  assert.ok(rows.every((r) => r.type.includes('-') || (r.sessionId === sessionId && r.cwd === 'C:\\w' && r.version === '2.1.260' && r.isSidechain === false)));
  const reply = rows[1].message.content[0].text;
  assert.ok(reply.startsWith('Looking for it.') && reply.includes('[tool: exec] rg -n helper src') && reply.includes('[result] src/a.js:3:helper'));
  assert.strictEqual(rows[1].message.role, 'assistant');
  assert.strictEqual(rows[1].message.model, undefined);
  assert.deepStrictEqual(rows[2], { type: 'ai-title', aiTitle: 'rename the helper', sessionId });
  assert.deepStrictEqual(rows[3], { type: 'last-prompt', lastPrompt: 'rename the helper', leafUuid: rows[1].uuid, sessionId });
  assert.ok(new Date(rows[0].timestamp) < new Date(rows[1].timestamp));
});

test('buildClaudeTranscript copes with assistant-first chats and refuses empty ones', () => {
  const { jsonl: text } = buildClaudeTranscript([{ role: 'assistant', text: 'hello', tools: [] }], { cwd: 'C:\\w', model: 'claude-x' });
  const rows = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(rows[0].type, 'user');
  assert.strictEqual(rows[1].message.model, 'claude-x');
  assert.throws(() => buildClaudeTranscript([], { cwd: 'C:\\w' }), /no turns/);
});

test('claudeProjectDirName and titleFromTurns', () => {
  assert.strictEqual(claudeProjectDirName('C:\\Users\\sbarb'), 'C--Users-sbarb');
  assert.strictEqual(claudeProjectDirName('C:\\Users\\sbarb\\.claude\\projects'), 'C--Users-sbarb--claude-projects');
  assert.strictEqual(titleFromTurns([{ role: 'assistant', text: 'x', tools: [] }, { role: 'user', text: 'first line\nsecond', tools: [] }]), 'first line');
  assert.strictEqual(titleFromTurns([]), '');
});
