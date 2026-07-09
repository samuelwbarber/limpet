// limpet terminal protocol: the pure logic for scanning PTY output for our
// private OSC 5379 channel and peek's tagged OSC 1337 images, and rewriting
// peek sequences for xterm's image addon. No Electron dependencies -- unit
// tested by tests/protocol.test.js.

const LIMPET_OSC = '\x1b]5379;';
const IIP_OSC = '\x1b]1337;';
const OSC_MARKERS = [LIMPET_OSC, IIP_OSC];
const BEL = '\x07';
const KNOWN_VERBS = ['download', 'upload', 'reels', 'peek', 'dl'];
const MAX_IIP_HEADER = 2048;

// Longest suffix of `s` that is a (partial) prefix of any OSC marker.
function heldPrefixLen(s) {
  let best = 0;
  for (const m of OSC_MARKERS) {
    const max = Math.min(s.length, m.length - 1);
    for (let n = max; n > best; n--) {
      if (m.startsWith(s.slice(s.length - n))) { best = n; break; }
    }
  }
  return best;
}

// Earliest marker occurrence in the buffer.
function findMarker(buf) {
  let idx = -1;
  let marker = null;
  for (const m of OSC_MARKERS) {
    const i = buf.indexOf(m);
    if (i !== -1 && (idx === -1 || i < idx)) { idx = i; marker = m; }
  }
  return { idx, marker };
}

// Is what follows the marker still a plausible limpet verb? Lets us bail out fast
// (emit literally) if a stray `\x1b]5379;` ever shows up in normal output,
// instead of buffering the rest of the stream forever waiting for a BEL.
function looksLikeVerb(after) {
  const semi = after.indexOf(';');
  if (semi === -1) return KNOWN_VERBS.some((v) => v.startsWith(after));
  return KNOWN_VERBS.includes(after.slice(0, semi));
}

// Classify an OSC 1337 body (may be incomplete): 'ours' = a peek image we must
// intercept (File= header carrying rows=), 'other' = pass through to xterm,
// 'maybe' = header not complete yet, keep buffering.
function classifyIip(after) {
  const colon = after.indexOf(':');
  const header = colon === -1 ? after : after.slice(0, colon);
  if (header.length < 5) {
    if (!'File='.startsWith(header)) return 'other';
    return colon === -1 ? 'maybe' : 'other';
  }
  if (!header.startsWith('File=')) return 'other';
  if (colon === -1) return header.length > MAX_IIP_HEADER ? 'other' : 'maybe';
  return /(^|;)rows=\d+($|;)/.test(header.slice(5)) ? 'ours' : 'other';
}

const b64dec = (s) => Buffer.from(s || '', 'base64');

// Formats xterm's image addon can decode.
function sniffImageMime(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length >= 6 && buf.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  return null;
}

// A peek image (OSC 1337 File tagged with rows=N). The shell printed N real
// newlines right after the sequence, reserving N blank rows in ConPTY's model.
// Rewrite the sequence so the image addon renders exactly N cell rows (the
// image lives in buffer cells, so it scrolls — and is overwritten — exactly
// like text), and append cursor-up + CR to undo the addon's cursor advance.
// xterm's cursor then stays where ConPTY believes it is, the reserved newlines
// advance both models identically, and the prompt lands below the image
// instead of overdrawing it.
// Build the xterm image sequence from decoded fields. Shared by the legacy
// single-OSC path (transformPeekImage) and the chunked OSC 5379 path in main.js.
function buildPeekOsc({ size, rows, name, b64 }) {
  const r = Math.max(1, parseInt(rows, 10) || 1);
  const mime = sniffImageMime(b64dec(b64.slice(0, 44)));
  if (!mime) {
    return `\x1b[31m[limpet] peek: ${name || 'image'}: not a supported image (png/jpeg/gif)\x1b[0m`;
  }
  const sz = parseInt(size, 10) || Math.floor(b64.length * 3 / 4);
  const up = r > 1 ? `\x1b[${r - 1}A` : '';
  return `\x1b]1337;File=inline=1;size=${sz};height=${r};preserveAspectRatio=1:${b64}\x07${up}\r`;
}

function transformPeekImage(body) {
  const colon = body.indexOf(':');
  const fields = {};
  for (const kv of body.slice(5, colon).split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) fields[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  const name = fields.name ? b64dec(fields.name).toString('utf8') : 'image';
  return buildPeekOsc({ size: fields.size, rows: fields.rows, name, b64: body.slice(colon + 1) });
}

module.exports = {
  LIMPET_OSC, IIP_OSC, OSC_MARKERS, BEL, KNOWN_VERBS, MAX_IIP_HEADER,
  heldPrefixLen, findMarker, looksLikeVerb, classifyIip, b64dec,
  sniffImageMime, transformPeekImage, buildPeekOsc,
};
