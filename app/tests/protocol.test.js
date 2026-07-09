// Unit tests for the limpet terminal protocol (node --test).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  LIMPET_OSC, IIP_OSC,
  heldPrefixLen, findMarker, looksLikeVerb, classifyIip, b64dec,
  sniffImageMime, transformPeekImage, buildPeekOsc,
} = require('../src/protocol');

const b64 = (s) => Buffer.from(s).toString('base64');
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const BMP_HEADER = Buffer.from('BM????????????', 'ascii');

test('heldPrefixLen holds partial markers, not complete ones', () => {
  assert.equal(heldPrefixLen(''), 0);
  assert.equal(heldPrefixLen('plain text'), 0);
  assert.equal(heldPrefixLen('output\x1b'), 1);          // lone trailing ESC
  assert.equal(heldPrefixLen('output\x1b]53'), 4);       // partial limpet marker
  assert.equal(heldPrefixLen('output\x1b]1337'), 6);     // partial IIP marker
  assert.equal(heldPrefixLen('output\x1b]9999'), 0);     // can never become a marker
  assert.equal(heldPrefixLen('all of \x1b]1337;'), 0);   // full marker: findMarker's job
});

test('findMarker returns the earliest marker', () => {
  assert.deepEqual(findMarker('nothing here'), { idx: -1, marker: null });
  assert.deepEqual(findMarker('ab\x1b]5379;x'), { idx: 2, marker: LIMPET_OSC });
  assert.deepEqual(findMarker('ab\x1b]1337;x'), { idx: 2, marker: IIP_OSC });
  const both = 'a\x1b]1337;img b\x1b]5379;verb';
  assert.equal(findMarker(both).marker, IIP_OSC);
});

test('looksLikeVerb accepts limpet verbs and their prefixes only', () => {
  assert.equal(looksLikeVerb('download;name;data'), true);
  assert.equal(looksLikeVerb('upload;p;d'), true);
  assert.equal(looksLikeVerb('reels;'), true);
  assert.equal(looksLikeVerb('peek;d;AAAA'), true);      // chunked image: must keep buffering
  assert.equal(looksLikeVerb('dl;d;AAAA'), true);        // streamed download chunk: keep buffering
  assert.equal(looksLikeVerb('down'), true);             // incomplete: keep buffering
  assert.equal(looksLikeVerb(''), true);
  assert.equal(looksLikeVerb('notaverb;x'), false);
  assert.equal(looksLikeVerb('xyz'), false);
});

test('classifyIip: ours / other / maybe', () => {
  assert.equal(classifyIip(`File=rows=3:${b64('x')}`), 'ours');
  assert.equal(classifyIip('File=name=eA==;size=9;rows=12;inline=1:AAAA'), 'ours');
  assert.equal(classifyIip('File=size=9;inline=1:AAAA'), 'other');   // untagged imgcat
  assert.equal(classifyIip('File=arrows=3:AAAA'), 'other');          // rows= must be its own field
  assert.equal(classifyIip('Fi'), 'maybe');                           // header still arriving
  assert.equal(classifyIip('File=rows=3'), 'maybe');                  // no colon yet
  assert.equal(classifyIip('Fi:x'), 'other');
  assert.equal(classifyIip('SetProfile=x:y'), 'other');
  assert.equal(classifyIip('File=' + 'a'.repeat(3000)), 'other');     // runaway header
});

test('sniffImageMime knows exactly what the image addon decodes', () => {
  assert.equal(sniffImageMime(PNG_HEADER), 'image/png');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(sniffImageMime(BMP_HEADER), null);
  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
});

test('transformPeekImage rewrites rows= to height= cells and compensates the cursor', () => {
  const png = PNG_HEADER.toString('base64');
  const body = `File=name=${b64('graph.png')};size=12;inline=1;preserveAspectRatio=1;rows=12:${png}`;
  const out = transformPeekImage(body);
  assert.ok(out.startsWith('\x1b]1337;File=inline=1;size=12;height=12;preserveAspectRatio=1:'));
  assert.ok(out.endsWith(`${png}\x07\x1b[11A\r`)); // rows-1 up, then CR
});

test('transformPeekImage: single row needs no cursor-up', () => {
  const png = PNG_HEADER.toString('base64');
  const out = transformPeekImage(`File=size=12;rows=1:${png}`);
  assert.ok(out.endsWith(`${png}\x07\r`));
  assert.ok(!out.includes('\x1b['));
});

test('transformPeekImage: unsupported format becomes a readable error, not a broken image', () => {
  const out = transformPeekImage(`File=name=${b64('logo.bmp')};rows=5:${BMP_HEADER.toString('base64')}`);
  assert.ok(out.includes('logo.bmp'));
  assert.ok(out.includes('not a supported image'));
  assert.ok(!out.includes('1337'));
});

test('transformPeekImage: missing size is computed from the payload', () => {
  const png = PNG_HEADER.toString('base64');
  const out = transformPeekImage(`File=rows=2:${png}`);
  assert.ok(out.includes(`size=${Math.floor(png.length * 3 / 4)};`));
});

test('buildPeekOsc: chunked payload reassembles to the same image sequence', () => {
  // `peek` streams the base64 as many small OSC chunks (so no single escape
  // sequence overflows ConPTY's buffer over a fragmented link); main.js joins
  // the chunks and calls buildPeekOsc. Reassembly must be byte-identical to a
  // one-shot image and must survive an arbitrary split point.
  const png = PNG_HEADER.toString('base64');
  const whole = buildPeekOsc({ size: 12, rows: 4, name: 'graph.png', b64: png });
  const chunks = [png.slice(0, 5), png.slice(5)];
  const joined = buildPeekOsc({ size: 12, rows: 4, name: 'graph.png', b64: chunks.join('') });
  assert.equal(joined, whole);
  assert.ok(whole.startsWith('\x1b]1337;File=inline=1;size=12;height=4;preserveAspectRatio=1:'));
  assert.ok(whole.endsWith(`${png}\x07\x1b[3A\r`));
});

test('b64dec tolerates empty input', () => {
  assert.equal(b64dec('').length, 0);
  assert.equal(b64dec(undefined).length, 0);
  assert.equal(b64dec(b64('hello')).toString(), 'hello');
});
