// Unit tests for the predictive-echo core (app/src/predict.js). We stub a
// minimal DOM + xterm so the confirm / diverge / gating logic can be driven
// synchronously without Electron. Timer-based reveal/expiry is exercised only
// via the "confirm reveals the rest" path (which flips visibility inline).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// ---- fakes -----------------------------------------------------------------
function makeEl() {
  return {
    style: {}, textContent: '', children: [], parent: null,
    set cssText(v) { this.style.cssText = v; }, // (unused shim; cssText goes on style)
    appendChild(c) { c.parent = this; this.children.push(c); },
    remove() { const p = this.parent; if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); } },
  };
}
global.window = {};
global.document = { createElement: () => makeEl() };
require(path.join(__dirname, '..', 'src', 'predict.js'));
const { create } = global.window.Predict;

function harness(cols = 80, rows = 24) {
  const term = {
    cols, rows,
    options: { fontFamily: 'mono', fontSize: 14 },
    buffer: { active: { cursorX: 0, cursorY: 0 } },
    _core: {}, // no _renderService -> cell() falls back to screenEl geometry
  };
  const screenEl = { clientWidth: cols * 9, clientHeight: rows * 17, appendChild() {}, children: [] };
  screenEl.appendChild = (c) => screenEl.children.push(c);
  const p = create(term, screenEl);
  const cur = (x, y) => { term.buffer.active.cursorX = x; term.buffer.active.cursorY = y; };
  // overlay is the single child appended to screenEl; its children are the glyphs
  const glyphs = () => (screenEl.children[0] ? screenEl.children[0].children : []);
  return { term, p, cur, glyphs };
}

test('confirms predictions as the server cursor advances past them', () => {
  const { p, cur, glyphs } = harness();
  p.onKey('a'); p.onKey('b');
  assert.equal(glyphs().length, 2, 'two predicted glyphs queued');
  cur(2, 0);                 // server echoed "ab"
  p.reconcile();
  assert.equal(glyphs().length, 0, 'both confirmed and removed');
});

test('nothing is shown until an echo is observed (password-prompt safety)', () => {
  const { p, glyphs } = harness();
  p.onKey('s');
  assert.equal(glyphs().length, 1);
  assert.equal(glyphs()[0].style.visibility, 'hidden', 'unconfirmed + untrusted context stays hidden');
});

test('a confirmation reveals the remaining queued predictions', () => {
  const { p, cur, glyphs } = harness();
  p.onKey('a'); p.onKey('b'); p.onKey('c'); // cols 0,1,2
  cur(1, 0);                 // server echoed just "a"
  p.reconcile();
  assert.equal(glyphs().length, 2, 'a confirmed, b/c remain');
  assert.equal(glyphs()[0].style.visibility, 'visible', 'trusted now -> b revealed');
  assert.equal(glyphs()[1].style.visibility, 'visible', 'trusted now -> c revealed');
});

test('divergent echo (cursor not where we predicted) drops all predictions', () => {
  const { p, cur, glyphs } = harness();
  cur(3, 0);                 // cursor starts at col 3
  p.onKey('x');              // glyph seeded at col 3
  assert.equal(glyphs().length, 1);
  cur(1, 0);                 // server put the cursor somewhere we didn't predict
  p.reconcile();
  assert.equal(glyphs().length, 0, 'diverged -> flushed');
});

test('Enter and other non-printable keys clear predictions', () => {
  const h1 = harness();
  h1.p.onKey('l'); h1.p.onKey('s');
  assert.equal(h1.glyphs().length, 2);
  h1.p.onKey('\r');          // Enter
  assert.equal(h1.glyphs().length, 0, 'Enter flushed');

  const h2 = harness();
  h2.p.onKey('a');
  h2.p.onKey('\x1b[A');      // Up arrow (escape sequence)
  assert.equal(h2.glyphs().length, 0, 'escape sequence flushed');

  const h3 = harness();
  h3.p.onKey('a');
  h3.p.onKey('abc');         // multi-char (paste) is not predicted
  assert.equal(h3.glyphs().length, 0, 'paste flushed');
});

test('predictions wrap to the next row at the right edge', () => {
  const { p, cur, glyphs } = harness(3, 5); // 3 columns wide
  cur(2, 0);
  p.onKey('a');              // col 2, row 0
  p.onKey('b');              // wraps -> col 0, row 1
  const g = glyphs();
  assert.equal(g.length, 2);
  assert.equal(g[1].style.top, (1 * 17) + 'px', 'second glyph is on row 1');
  assert.equal(g[1].style.left, (0 * 9) + 'px', 'second glyph is at column 0');
});
