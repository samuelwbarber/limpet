// Moving a chat between agents: read any agent's transcript (Claude Code,
// Codex, Antigravity, Copilot) into plain turns, and write those turns back
// out as (a) a Claude Code transcript that
// `claude --resume` loads as if the chat had always been Claude's, or (b) a
// Markdown handoff file plus a one-line "continue from here" prompt for
// whichever agent can't import natively. Pure functions, no Electron; unit
// tested by tests/handoff.test.js.
//
// A turn is { role: 'user' | 'assistant', text, tools: [{ name, input, output }] }.
// Tool calls hang off the assistant turn that made them; their results are
// attached when the matching output line comes past.

const crypto = require('crypto');

const TOOL_INPUT_CHARS = 400;
const TOOL_OUTPUT_CHARS = 600;
const HANDOFF_MAX_BYTES = 180 * 1024;

const clip = (s, n) => {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n)}… (${str.length - n} more chars)` : str;
};

// Text of a content block list ({type:'text'|'input_text'|'output_text', text}) or a plain string.
function blocksText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b.text === 'string' ? b.text : (b && b.type === 'image' ? '[image]' : ''))).filter(Boolean).join('\n');
}

// Something the harness injected rather than the person typed: a slash-command
// echo, a system reminder, Codex's <environment_context> and friends.
const INJECTED_RE = /^\s*<(command-name|command-message|local-command-stdout|local-command-caveat|system-reminder|environment_context|user_instructions|permissions_instructions|skills_instructions|app_context|turn_aborted|system_instructions|collaboration_mode|agent_instructions|memory_citation|apps_instructions)\b/i;
function cleanUserText(text) {
  let t = String(text || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
  if (!t || INJECTED_RE.test(t)) return '';
  // Whole message is one XML-ish block: injected context, not a prompt.
  const m = /^<([a-z_]+)>[\s\S]*<\/\1>\s*$/i.exec(t);
  if (m) return '';
  if (/^\[Request interrupted by user/i.test(t)) return '';
  return t;
}

// The argument that says most about a tool call, by name in any case (agy
// writes CommandLine, AbsolutePath, TargetFile, ...).
const TOOL_INPUT_KEYS = ['command', 'commandline', 'cmd', 'file_path', 'absolutepath', 'targetfile', 'path', 'pattern', 'query', 'url', 'description', 'prompt'];
function summarizeToolInput(name, input) {
  if (input && typeof input === 'object') {
    const byKey = new Map(Object.entries(input).map(([k, v]) => [k.toLowerCase(), v]));
    for (const key of TOOL_INPUT_KEYS) {
      const v = byKey.get(key);
      if (typeof v === 'string' && v.trim()) return clip(v, TOOL_INPUT_CHARS);
    }
    try { return clip(JSON.stringify(input), TOOL_INPUT_CHARS); } catch (_) { return ''; }
  }
  return clip(input, TOOL_INPUT_CHARS);
}

function pushTurn(turns, role, text, tools = []) {
  const last = turns[turns.length - 1];
  if (last && last.role === role) {
    if (text) last.text = last.text ? `${last.text}\n${text}` : text;
    last.tools.push(...tools);
    return last;
  }
  const turn = { role, text: text || '', tools: [...tools] };
  turns.push(turn);
  return turn;
}

// Claude Code transcript (projects/<cwd>/<session>.jsonl) -> turns.
function parseClaudeTranscript(text) {
  const turns = [];
  const pending = new Map(); // tool_use id -> tool entry awaiting its result
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || o.isSidechain || !o.message) continue;
    if (o.type === 'user') {
      const c = o.message.content;
      if (typeof c === 'string') {
        const t = cleanUserText(c);
        if (t) pushTurn(turns, 'user', t);
        continue;
      }
      if (!Array.isArray(c)) continue;
      const texts = [];
      for (const b of c) {
        if (!b) continue;
        if (b.type === 'text') { const t = cleanUserText(b.text); if (t) texts.push(t); }
        else if (b.type === 'image') texts.push('[image]');
        else if (b.type === 'tool_result') { const tool = pending.get(b.tool_use_id); if (tool) tool.output = blocksText(b.content); }
      }
      if (texts.length) pushTurn(turns, 'user', texts.join('\n'));
    } else if (o.type === 'assistant') {
      const c = Array.isArray(o.message.content) ? o.message.content : [];
      const texts = [];
      const tools = [];
      for (const b of c) {
        if (!b) continue;
        if (b.type === 'text' && String(b.text || '').trim()) texts.push(b.text.trim());
        else if (b.type === 'tool_use') {
          const tool = { name: String(b.name || 'tool'), input: summarizeToolInput(b.name, b.input), output: '' };
          tools.push(tool);
          if (b.id) pending.set(b.id, tool);
        }
      }
      if (texts.length || tools.length) pushTurn(turns, 'assistant', texts.join('\n'), tools);
    }
  }
  return turns;
}

// Codex rollout (~/.codex/sessions/.../rollout-*.jsonl) -> turns.
function parseCodexRollout(text) {
  const turns = [];
  const pending = new Map(); // call_id -> tool entry awaiting its output
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || o.type !== 'response_item' || !o.payload) continue;
    const p = o.payload;
    if (p.type === 'message') {
      const t = blocksText(p.content).trim();
      if (p.role === 'user') { const clean = cleanUserText(t); if (clean) pushTurn(turns, 'user', clean); }
      else if (p.role === 'assistant' && t) pushTurn(turns, 'assistant', t);
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let input = p.arguments !== undefined ? p.arguments : p.input;
      if (typeof input === 'string' && p.type === 'function_call') { try { input = JSON.parse(input); } catch (_) { /* keep raw */ } }
      const tool = { name: String(p.name || 'tool'), input: summarizeToolInput(p.name, input), output: '' };
      pushTurn(turns, 'assistant', '', [tool]);
      if (p.call_id) pending.set(p.call_id, tool);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const tool = pending.get(p.call_id);
      if (tool) tool.output = blocksText(p.output);
    }
  }
  return turns;
}

// Antigravity transcript (~/.gemini/antigravity-cli/brain/<conversation>/
// .system_generated/logs/transcript.jsonl) -> turns. Each step is one line:
// USER_INPUT (the request wrapped in <USER_REQUEST>), PLANNER_RESPONSE (reply
// text and tool_calls), then one step per tool call with its output.
function parseAgyTranscript(text) {
  const turns = [];
  const pending = []; // tool entries awaiting their output step, in call order
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'USER_INPUT') {
      const raw = String(o.content || '');
      const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
      const t = cleanUserText(m ? m[1] : raw);
      if (t) pushTurn(turns, 'user', t);
      pending.length = 0;
    } else if (o.type === 'PLANNER_RESPONSE') {
      const tools = (Array.isArray(o.tool_calls) ? o.tool_calls : []).map((c) => {
        let input = c && c.args;
        if (input && typeof input === 'object') {
          // agy stores each argument JSON-encoded ("\"ls\"").
          input = Object.fromEntries(Object.entries(input).map(([k, v]) => { try { return [k, JSON.parse(v)]; } catch (_) { return [k, v]; } }));
        }
        return { name: String((c && c.name) || 'tool'), input: summarizeToolInput(c && c.name, input), output: '' };
      });
      const t = String(o.content || '').trim();
      if (t || tools.length) pushTurn(turns, 'assistant', t, tools);
      pending.push(...tools);
    } else if (pending.length && o.source === 'MODEL' && typeof o.content === 'string') {
      // A tool's output: drop the "Created At / Completed At" header.
      pending.shift().output = o.content.replace(/^(Created At|Completed At):.*\n/gm, '').trim();
    }
  }
  return turns;
}

// Copilot CLI chat (<COPILOT_HOME>/session-state/<session>/events.jsonl) ->
// turns: user.message, assistant.message (text and toolRequests) and
// tool.execution_complete carrying each result.
function parseCopilotEvents(text) {
  const turns = [];
  const pending = new Map(); // toolCallId -> tool entry awaiting its result
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    const d = o && o.data;
    if (!d || typeof d !== 'object') continue;
    if (o.type === 'user.message') {
      const t = cleanUserText(blocksText(d.content));
      if (t) pushTurn(turns, 'user', t);
    } else if (o.type === 'assistant.message') {
      const tools = [];
      for (const r of Array.isArray(d.toolRequests) ? d.toolRequests : []) {
        let input = r && r.arguments;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch (_) { /* keep raw */ } }
        const tool = { name: String((r && r.name) || 'tool'), input: summarizeToolInput(r && r.name, input), output: '' };
        tools.push(tool);
        if (r && r.toolCallId) pending.set(r.toolCallId, tool);
      }
      const t = blocksText(d.content).trim();
      if (t || tools.length) pushTurn(turns, 'assistant', t, tools);
    } else if (o.type === 'tool.execution_complete') {
      const tool = pending.get(d.toolCallId);
      if (tool) tool.output = blocksText(d.result && d.result.content) || (d.error && d.error.message) || '';
    }
  }
  return turns;
}

// A transcript of any agent -> turns.
function parseTranscript(kind, text) {
  switch (kind) {
    case 'claude': return parseClaudeTranscript(text);
    case 'codex': return parseCodexRollout(text);
    case 'agy': return parseAgyTranscript(text);
    case 'copilot': return parseCopilotEvents(text);
    default: return [];
  }
}

// The turns as Markdown for a handoff file. When it would be too long, the
// opening request is kept and the oldest turns after it are dropped, so the
// recent state of the work survives intact.
function renderMarkdown(turns, { source = 'another coding agent', cwd = '', when = new Date(), maxBytes = HANDOFF_MAX_BYTES } = {}) {
  const blocks = turns.map((t) => {
    let s = `## ${t.role === 'user' ? 'User' : 'Assistant'}\n\n${t.text || ''}`.trimEnd();
    for (const tool of t.tools) {
      s += `\n\n- tool \`${tool.name}\`: ${tool.input || ''}`;
      if (tool.output) s += `\n  → ${clip(tool.output, TOOL_OUTPUT_CHARS).replace(/\n/g, '\n    ')}`;
    }
    return `${s}\n`;
  });
  const head = `# Conversation handoff\n\nThis is the transcript of a chat with ${source}${cwd ? ` in \`${cwd}\`` : ''}, handed over on ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC. Continue it exactly where it left off.\n\n`;
  const size = (arr) => Buffer.byteLength(arr.join('\n'), 'utf8');
  let body = blocks;
  let omitted = 0;
  if (size(body) > maxBytes && body.length > 2) {
    const first = body[0];
    let tail = body.slice(1);
    while (tail.length > 1 && Buffer.byteLength(first, 'utf8') + size(tail) > maxBytes) { tail.shift(); omitted++; }
    body = [first, `_(${omitted} earlier turn${omitted === 1 ? '' : 's'} omitted to keep this short)_\n`, ...tail];
  }
  return head + body.join('\n');
}

// The one-line prompt that starts the other agent on the handoff file.
function continuePrompt(handoffPath, source = 'another coding agent') {
  return `Continue our conversation exactly where it left off. It was with ${source} in this same directory and the full transcript is in ${handoffPath} - read that file first, then carry on with the last request without redoing finished work, and don't mention the handoff unless something in it is unclear.`;
}

// Turns -> a Claude Code transcript (one JSON line per message) that
// `claude --resume <sessionId>` loads. Tool calls become lines of text inside
// the assistant message, the same shape Codex's own importer uses the other
// way. The chat must start with a user turn; assistant-first turns are folded
// into an opening note.
function buildClaudeTranscript(turns, { cwd, sessionId = crypto.randomUUID(), model = '', version = '2.1.0', title = '', now = Date.now() } = {}) {
  const merged = [];
  for (const t of turns) pushTurn(merged, t.role, t.text, t.tools);
  if (!merged.length) throw new Error('nothing to hand over: the transcript has no turns');
  if (merged[0].role !== 'user') merged.unshift({ role: 'user', text: '(continuing an earlier conversation)', tools: [] });
  const lines = [];
  let parent = null;
  let lastUserText = '';
  const step = Math.max(1000, Math.floor((10 * 60 * 1000) / merged.length));
  merged.forEach((t, i) => {
    const uuid = crypto.randomUUID();
    const timestamp = new Date(now - (merged.length - i) * step).toISOString();
    const common = { parentUuid: parent, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId, version, gitBranch: '', uuid, timestamp };
    if (t.role === 'user') {
      lastUserText = t.text;
      lines.push({ ...common, type: 'user', message: { role: 'user', content: t.text }, permissionMode: 'default', origin: { kind: 'human' }, promptSource: 'typed' });
    } else {
      let text = t.text || '';
      for (const tool of t.tools) {
        text += `${text ? '\n\n' : ''}[tool: ${tool.name}] ${tool.input || ''}`;
        if (tool.output) text += `\n[result] ${clip(tool.output, TOOL_OUTPUT_CHARS)}`;
      }
      const message = { id: `msg_limpet_${i}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: text || '(no reply recorded)' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
      if (model) message.model = model;
      lines.push({ ...common, type: 'assistant', message, requestId: `req_limpet_${i}` });
    }
    parent = uuid;
  });
  if (title) lines.push({ type: 'ai-title', aiTitle: String(title).slice(0, 120), sessionId });
  lines.push({ type: 'last-prompt', lastPrompt: String(lastUserText).slice(0, 2000), leafUuid: parent, sessionId });
  return { sessionId, jsonl: `${lines.map((l) => JSON.stringify(l)).join('\n')}\n` };
}

// Claude Code's project folder name for a working directory.
const claudeProjectDirName = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');

// A short title for a handed-over chat: its first request.
function titleFromTurns(turns) {
  const first = turns.find((t) => t.role === 'user' && t.text);
  return first ? first.text.split('\n')[0].slice(0, 80) : '';
}

module.exports = {
  HANDOFF_MAX_BYTES, parseClaudeTranscript, parseCodexRollout, parseAgyTranscript, parseCopilotEvents, parseTranscript,
  renderMarkdown, continuePrompt, buildClaudeTranscript, claudeProjectDirName, titleFromTurns, cleanUserText,
};
