// limpet - Electron main process.
// A terminal running local PowerShell (with the Limpet Linux-shim module). You
// connect to remote hosts however you like (e.g. `xssh user@host`) right in the
// shell. Dropping files onto the window "pastes" them into whatever shell is in
// front, reconstructing each file in the current directory from base64 — so it
// works inside your SSH session with nothing installed on the remote but
// coreutils (base64). Real ConPTY via node-pty; pipe fallback if unavailable.

const { app, BrowserWindow, ipcMain, clipboard, dialog, screen, shell, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const accounts = require('./accounts');
const agentScan = require('./agent-scan');
const handoff = require('./handoff');
const codexImport = require('./codex-import');
const usage = require('./usage');
const {
  MIN_OUTPUT_CHARS, UPDATE_OUTPUT_CHARS, MIN_UPDATE_MS, MIN_SCENE_CHANGE_CONFIDENCE,
  createTopicProfile, updateTopicProfile, buildBackdropPlan,
  backendStatus, outputPath, generateLocalImage, setupProgress, runSetup, LOCAL_AI_DIR,
} = require('./backdrop');

let ptyLib = null;
try {
  ptyLib = require('@homebridge/node-pty-prebuilt-multiarch');
} catch (e) {
  console.error('[limpet] node-pty unavailable, using pipe fallback:', e.message);
}

const LIMPET_MODULE = path.join(__dirname, '..', '..', 'shell', 'Limpet.psd1');

// Injected into the docked reels page to make the reel float on a
// terminal-matching background with no scrollbars or nav/chat chrome. Instagram's
// class names are randomized, so we hide by shape/position: a wide, short,
// fixed/sticky strip of links at the top/bottom edge is the nav bar; a small
// fixed box in the bottom-right corner is the chat bubble. A centered vertical
// reel matches neither. A MutationObserver re-applies it across SPA re-renders.
const REELS_TIDY = `(function () {
  if (!document.getElementById('limpet-tidy')) {
    var s = document.createElement('style'); s.id = 'limpet-tidy';
    s.textContent =
      // Make EVERYTHING transparent so the host page's #reels div (same CSS
      // context as the terminal) provides the background — guarantees match.
      '*{background:transparent !important;background-color:transparent !important;' +
        'scrollbar-width:none !important}' +
      '::-webkit-scrollbar{width:0 !important;height:0 !important;background:transparent !important}' +
      'nav,[role="navigation"],header[role="banner"]{display:none !important}' +
      'main,[role="main"]{width:100% !important;max-width:100% !important;' +
        'min-width:0 !important;margin:0 auto !important;padding:0 !important;flex:1 1 100% !important}';
    (document.head || document.documentElement).appendChild(s);
  }
  var NAV = { '/': 1, '/explore/': 1, '/reels/': 1, '/direct/inbox/': 1 };
  var mainEl = null;
  function getMain() {
    if (!mainEl || !mainEl.isConnected) mainEl = document.querySelector('main,[role="main"]');
    return mainEl;
  }
  function hideNav() {
    var m = getMain();
    document.querySelectorAll('a[href="/reels/"],a[href="/explore/"]').forEach(function (a) {
      var p = a;
      for (var i = 0; i < 7 && p; i++) {
        p = p.parentElement; if (!p) break;
        var links = p.querySelectorAll('a[href]'), n = 0;
        for (var j = 0; j < links.length; j++) if (NAV[links[j].getAttribute('href')]) n++;
        if (n >= 3) {
          p.style.setProperty('display', 'none', 'important');
          if (m) {
            var up = p.parentElement;
            while (up && up !== document.body && up !== document.documentElement) {
              if (up.contains(m)) {
                up.style.setProperty('width', '100%', 'important');
                up.style.setProperty('max-width', '100%', 'important');
                break;
              }
              up.style.setProperty('display', 'none', 'important');
              up = up.parentElement;
            }
          }
          break;
        }
      }
    });
    if (m) {
      var el = m;
      while (el && el !== document.body) {
        el.style.setProperty('width', '100%', 'important');
        el.style.setProperty('max-width', '100%', 'important');
        el.style.setProperty('min-width', '0', 'important');
        el.style.setProperty('flex', '1 1 100%', 'important');
        el.style.setProperty('padding-left', '0', 'important');
        el.style.setProperty('padding-right', '0', 'important');
        el = el.parentElement;
      }
    }
  }
  // Strip any inline backgrounds Instagram sets so the transparent stylesheet wins.
  function fixBg() {
    document.querySelectorAll('*').forEach(function (el) {
      var tag = el.tagName;
      if (tag === 'VIDEO' || tag === 'IMG' || tag === 'CANVAS' || tag === 'SVG' ||
          tag === 'STYLE' || tag === 'SCRIPT' || tag === 'LINK' || tag === 'META') return;
      if (el.style.background || el.style.backgroundColor || el.style.backgroundImage) {
        el.style.setProperty('background', 'transparent', 'important');
        el.style.setProperty('background-color', 'transparent', 'important');
      }
    });
  }
  function hideBubble() {
    var vw = window.innerWidth, vh = window.innerHeight;
    document.querySelectorAll('div,section').forEach(function (el) {
      if (el.dataset.limpetHid) return;
      var st = getComputedStyle(el);
      if (st.position !== 'fixed' && st.position !== 'sticky') return;
      var r = el.getBoundingClientRect();
      if (r.width > 8 && r.width < vw * 0.5 && r.height > 8 && r.height < 260 &&
          r.bottom >= vh - 160 && r.right >= vw - 160) {
        el.style.setProperty('display', 'none', 'important'); el.dataset.limpetHid = '1';
      }
    });
  }
  // Instagram's reels feed is a vertical scroll-snap list, but each snap item is
  // only as tall as the reel (~462px) while the panel is taller (~625px) — so the
  // current reel sits high and the next one's top peeks in at the bottom. Make
  // each snap item fill the viewport and center its contents, and scale the reel's
  // media up to use that height so it reads as one full-screen reel at a time.
  function centerReel() {
    var vh = window.innerHeight;
    if (!vh) return;
    var snaps = [];
    document.querySelectorAll('div,section,article').forEach(function (el) {
      var a = getComputedStyle(el).scrollSnapAlign;
      if (a && a !== 'none') snaps.push(el);
    });
    if (!snaps.length) return;
    var vw = window.innerWidth;
    snaps.forEach(function (el) {
      el.style.setProperty('height', vh + 'px', 'important');
      el.style.setProperty('min-height', vh + 'px', 'important');
      el.style.setProperty('scroll-snap-align', 'center', 'important');
      el.style.setProperty('display', 'flex', 'important');
      el.style.setProperty('flex-direction', 'column', 'important');
      el.style.setProperty('align-items', 'center', 'important');
      el.style.setProperty('justify-content', 'center', 'important');
      // Scale the whole reel as one unit (video AND its overlays: follow button,
      // creator icon, captions, comment box) so everything stays proportional at
      // any window size. Scaling just the video clip box left the overlays at
      // Instagram's native size, which only looked right at one window size.
      var content = el.firstElementChild;
      if (!content) return;
      // offsetWidth/Height are the layout box (unaffected by our own transform),
      // so the scale stays stable across the MutationObserver's re-runs.
      var natH = content.offsetHeight, natW = content.offsetWidth;
      if (natH < 8 || natW < 8) return;
      // Fit within the panel: fill ~96% of the height, capped so it never spills
      // past the sides.
      var scale = Math.min((vh * 0.96) / natH, (vw * 0.99) / natW);
      if (Math.abs(scale - 1) < 0.01) { content.style.removeProperty('transform'); return; }
      content.style.setProperty('transform', 'scale(' + scale.toFixed(3) + ')', 'important');
      content.style.setProperty('transform-origin', 'center center', 'important');
    });
    var sc = snaps[0].parentElement;
    if (sc) {
      sc.style.setProperty('height', vh + 'px', 'important');
      sc.style.setProperty('scroll-snap-type', 'y mandatory', 'important');
      sc.style.setProperty('overflow-y', 'scroll', 'important');
    }
  }
  function tidy() { hideNav(); fixBg(); hideBubble(); centerReel(); }
  tidy();
  if (!window.__limpetObs) {
    window.__limpetObs = new MutationObserver(function () {
      clearTimeout(window.__limpetT); window.__limpetT = setTimeout(tidy, 80);
    });
    window.__limpetObs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();`;
const MAX_DROP_BYTES = 20 * 1024 * 1024; // pasting more than this through a PTY is impractical
// A held OSC waiting for its BEL is given up on (shown as text) once it grows
// past this or the stream goes quiet this long: real limpet sequences stream
// back-to-back, a stray marker in `cat`-ed binary never gets its BEL.
const MAX_HELD_OSC = 48 * 1024 * 1024;
const HELD_OSC_IDLE_MS = 15000;
const MAX_PEEK_BYTES = 64 * 1024 * 1024;

// Anything printed to the terminal can contain an OSC 5379 sequence: a remote
// host, a `cat`-ed file, a log line. So the verbs that act on this PC (dl,
// upload, reels) must carry this secret, which only reaches limpet's own
// helpers: the shell gets it as LIMPET_TOKEN and xssh bakes it into the helper
// script it injects. Kept across restarts so a resumed tmux session's helpers
// stay valid.
let oscTokenValue = null;
function oscToken() {
  if (oscTokenValue) return oscTokenValue;
  const file = path.join(app.getPath('userData'), 'osc-token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(t)) return (oscTokenValue = t);
  } catch (_) { /* first run */ }
  oscTokenValue = crypto.randomBytes(16).toString('hex');
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, oscTokenValue, { mode: 0o600 }); } catch (_) { /* this run only */ }
  return oscTokenValue;
}
const tokenOk = (t) => typeof t === 'string' && t.length === 32
  && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(oscToken()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep BrowserWindow references alive and route each PTY only to the window
// that currently owns its tab.
const windows = new Map(); // webContents id -> BrowserWindow
// One entry per tab: its PTY plus the OSC-scan state (a marker split across
// PTY chunks must be held back per stream, not globally).
const sessions = new Map(); // id -> { id, proc, ownerId, ready, uiPending, ... }
let nextSessionId = 1;
const backdropQueue = [];
let backdropRunning = false;
let activeBackdropProcess = null;
let backdropSetup = null; // the running one-time install: { child, cancelled, promise }

function sessionWebContents(sess) {
  if (!sess || sess.ownerId == null) return null;
  const wc = webContents.fromId(sess.ownerId);
  return wc && !wc.isDestroyed() ? wc : null;
}

function sendToSession(sess, channel, payload) {
  const wc = sessionWebContents(sess);
  if (sess.ready && wc) {
    wc.send(channel, payload);
  } else {
    // Output and side-channel events can arrive while the new renderer is
    // loading. Preserve ordering and flush them after term:ready.
    sess.uiPending.push({ channel, payload });
  }
}

function flushSessionUi(sess) {
  const wc = sessionWebContents(sess);
  if (!sess.ready || !wc) return;
  const pending = sess.uiPending.splice(0);
  for (const item of pending) wc.send(item.channel, item.payload);
}

const BACKDROP_ANALYSIS_CHUNK = 4000;

function stripTerminalFormatting(data) {
  return String(data)
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '');
}

function recordBackdropOutput(sess, data) {
  const plain = stripTerminalFormatting(data);
  // Count human-readable output, not ANSI redraw traffic or inline image data.
  const visible = plain.replace(/[\u0000-\u001f\u007f]/g, '');
  sess.backdropOutputChars = (sess.backdropOutputChars || 0) + visible.length;

  // Summarize output in small chunks as it arrives. Only the bounded scores in
  // backdropProfile survive; raw output is discarded after each chunk.
  const analysis = plain
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');
  if (!analysis.trim()) return;
  sess.backdropAnalysisBuffer = `${sess.backdropAnalysisBuffer || ''}${analysis}`;
  while (sess.backdropAnalysisBuffer.length >= BACKDROP_ANALYSIS_CHUNK) {
    let end = sess.backdropAnalysisBuffer.lastIndexOf('\n', BACKDROP_ANALYSIS_CHUNK);
    if (end < BACKDROP_ANALYSIS_CHUNK / 2) end = BACKDROP_ANALYSIS_CHUNK;
    updateTopicProfile(sess.backdropProfile, sess.backdropAnalysisBuffer.slice(0, end));
    sess.backdropAnalysisBuffer = sess.backdropAnalysisBuffer.slice(
      end + (sess.backdropAnalysisBuffer[end] === '\n' ? 1 : 0),
    );
  }
}

function flushBackdropAnalysis(sess) {
  const pending = sess.backdropAnalysisBuffer || '';
  if (pending.trim().length >= 20) updateTopicProfile(sess.backdropProfile, pending);
  sess.backdropAnalysisBuffer = '';
}

function sendData(sess, data) {
  recordBackdropOutput(sess, data);
  sendToSession(sess, 'term:data', { id: sess.id, data });
}

// --- limpet shell integration (download/upload from inside an ssh session) ---
// The remote helpers (shell/limpet-remote.sh, loaded by xssh) emit private OSC
// sequences: ESC ]5379; <verb> ; <args...> BEL. We catch those here. `peek`
// emits iTerm2 OSC 1337 File sequences tagged with a limpet-private `rows=N`
// field: those are also intercepted, because ConPTY has no idea an inline image
// occupies N screen rows — letting xterm's image addon place it at the cursor
// desyncs ConPTY's model from the screen and later output overdraws the image.
// Instead peek prints N real newlines after the OSC (advancing ConPTY and xterm
// identically) and we hand the image to the renderer to draw over those
// reserved blank rows. Untagged OSC 1337 (e.g. a third-party imgcat) and all
// other output pass through to xterm.js untouched.
const {
  LIMPET_OSC, OSC_MARKERS, BEL, MAX_IIP_HEADER,
  heldPrefixLen, findMarker, looksLikeVerb, classifyIip, b64dec, transformPeekImage, buildPeekOsc,
} = require('./protocol');

// A trailing partial-prefix of a marker is held back so a marker split across
// two PTY chunks isn't leaked to the screen — but it's flushed on a short timer
// if no more output follows, so a held byte (e.g. a lone trailing ESC, which is
// extremely common) can never leave the screen frozen at an idle prompt. A held
// full marker gets a much longer timer (see HELD_OSC_IDLE_MS).
function scheduleFlush(sess, ms = 30) {
  if (sess.flushTimer) clearTimeout(sess.flushTimer);
  sess.flushTimer = setTimeout(() => {
    sess.flushTimer = null;
    if (sess.outPending) {
      const held = sess.outPending + (sess.heldMore || []).join('');
      dropHeldOsc(sess, held.length > 4096 ? '' : held);
    }
  }, ms);
}

// Give up on a held sequence: show `text` in its place (a short stray marker is
// just output) and abandon any transfer it belonged to.
function dropHeldOsc(sess, text) {
  const wasHeld = OSC_MARKERS.some((m) => sess.outPending.startsWith(m)) && (sess.heldScanned || sess.outPending.length) > 4096;
  sess.outPending = '';
  sess.heldMore = [];
  sess.heldScanned = 0;
  if (wasHeld) {
    endDownload(sess);
    sess.peekImg = null;
    text = `${text}\r\n\x1b[33m[limpet] dropped an unfinished escape sequence\x1b[0m\r\n`;
  }
  if (text) sendData(sess, text);
}

function forwardOutput(sess, data) {
  if (sess.flushTimer) { clearTimeout(sess.flushTimer); sess.flushTimer = null; }
  // Still inside a held sequence and no BEL in this chunk: just queue it (joining
  // into one string per chunk would copy the whole held sequence every time).
  if (sess.heldScanned && data.indexOf(BEL) === -1) {
    sess.heldMore.push(data);
    sess.heldScanned += data.length;
    if (sess.heldScanned > MAX_HELD_OSC) dropHeldOsc(sess, '');
    else scheduleFlush(sess, HELD_OSC_IDLE_MS);
    return;
  }
  let buf = sess.outPending + (sess.heldMore || []).join('') + data;
  sess.heldMore = [];
  // A held full marker was already searched for its BEL up to heldScanned, so
  // only the new data needs scanning (a big transfer would otherwise rescan
  // everything held on every chunk).
  let scanFrom = sess.heldScanned || 0;
  sess.outPending = '';
  sess.heldScanned = 0;
  let out = '';
  while (buf.length) {
    const held = scanFrom ? OSC_MARKERS.find((m) => buf.startsWith(m)) : null;
    const { idx: start, marker } = held ? { idx: 0, marker: held } : findMarker(buf);
    if (start === -1) {
      const hold = heldPrefixLen(buf);
      out += buf.slice(0, buf.length - hold);
      sess.outPending = buf.slice(buf.length - hold);
      break;
    }
    out += buf.slice(0, start);
    buf = buf.slice(start);
    const afterMark = marker.length;
    const end = buf.indexOf(BEL, Math.max(afterMark, scanFrom));
    scanFrom = 0;
    if (end === -1) {
      // Real limpet sequence still arriving (a download or image can be large) →
      // wait for BEL. A false marker is dropped back to the screen right away.
      const after = buf.slice(afterMark, afterMark + MAX_IIP_HEADER + 64);
      const wait = marker === LIMPET_OSC ? looksLikeVerb(after) : classifyIip(after) !== 'other';
      if (wait && buf.length > MAX_HELD_OSC) { sess.outPending = buf; dropHeldOsc(sess, ''); break; }
      if (wait) { sess.outPending = buf; sess.heldScanned = buf.length; }
      else { out += buf.slice(0, afterMark); buf = buf.slice(afterMark); continue; }
      break;
    }
    const body = buf.slice(afterMark, end);
    if (marker === LIMPET_OSC) {
      out += handleLimpetOsc(sess, body);
    } else if (classifyIip(body) === 'ours') {
      out += transformPeekImage(body);
    } else {
      out += buf.slice(0, end + 1); // untagged OSC 1337: xterm's business
    }
    buf = buf.slice(end + 1);
  }
  if (out) sendData(sess, out);
  // A held *partial-prefix* (no full marker yet) must never linger — flush it if
  // the stream goes quiet. A held full marker (real download in flight) streams
  // back-to-back, so it only gets a long timer: a stray marker from `cat`-ed
  // binary with no BEL after it must not freeze the tab.
  if (sess.outPending) {
    scheduleFlush(sess, OSC_MARKERS.some((m) => sess.outPending.startsWith(m)) ? HELD_OSC_IDLE_MS : 30);
  }
}

const isWebUrl = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch (_) { return false; } };

// A dl/upload/reels request without this app's token came from something other
// than limpet's helpers (or from helpers injected before the token existed).
function untrusted(sess, verb) {
  sendData(sess, `\r\n\x1b[33m[limpet] ignored a ${verb} request that didn't come from limpet's helpers (reconnect with xssh to refresh them)\x1b[0m\r\n`);
}

// `upload` sends a file off this PC, so the user confirms every one, whatever
// asked: the token proves limpet's helpers sent it, not that the remote end is
// friendly. UNC and device paths are refused outright; even stat-ing
// \\host\share makes Windows authenticate to that host.
async function confirmUpload(sess, p) {
  if (/^[\\/]{2}/.test(p)) {
    sendData(sess, `\r\n\x1b[31m[limpet] upload: network paths aren't allowed: ${p}\x1b[0m\r\n`);
    return;
  }
  const wc = sessionWebContents(sess);
  const win = wc && BrowserWindow.fromWebContents(wc);
  const opts = {
    type: 'question', buttons: ['Upload', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    title: 'limpet', message: 'Send this file from your PC into the terminal session?', detail: path.resolve(p),
  };
  try {
    const { response } = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
    if (response !== 0) { sendData(sess, '\r\n\x1b[33m[limpet] upload cancelled\x1b[0m\r\n'); return; }
    await injectFiles(sess, [p]);
  } catch (e) {
    sendData(sess, `\r\n\x1b[31m[limpet] upload failed: ${e.message}\x1b[0m\r\n`);
  }
}

// Returns text to emit to the terminal ('' for side-effect-only verbs). `peek`
// streams an image as many small OSC chunks so no single escape sequence is big
// enough to overflow ConPTY's OSC buffer when a slow/lossy link delivers it in
// fragments (a large one-shot OSC gets silently dropped whole). We reassemble
// the chunks here and hand the complete image to the renderer over IPC, which
// never passes back through ConPTY.
function handleLimpetOsc(sess, seq) {
  const parts = seq.split(';');
  // dl;d/dl;f only feed a download a tokened dl;h started.
  if (parts[0] === 'dl') {
    const sub = parts[1];
    if (sub === 'h') {
      if (tokenOk(parts[4])) startDownload(sess, b64dec(parts[2]).toString('utf8'), parts[3]);
      else untrusted(sess, 'download');
    } else if (sub === 'd') writeDownloadChunk(sess, parts[2]);
    else if (sub === 'f') finishDownload(sess);
  } else if (parts[0] === 'upload') {
    if (tokenOk(parts[3])) confirmUpload(sess, b64dec(parts[1]).toString('utf8'));
    else untrusted(sess, 'upload');
  } else if (parts[0] === 'reels') {
    const url = b64dec(parts[1]).toString('utf8');
    if (!tokenOk(parts[2])) untrusted(sess, 'reels');
    else if (url && !isWebUrl(url)) sendData(sess, '\r\n\x1b[31m[limpet] reels: only http(s) URLs\x1b[0m\r\n');
    else sendToSession(sess, 'reels:toggle', url);
  } else if (parts[0] === 'peek') {
    const sub = parts[1];
    if (sub === 'h') {
      sess.peekImg = { name: b64dec(parts[2]).toString('utf8'), size: parts[3], rows: parts[4], chunks: [], bytes: 0 };
    } else if (sub === 'd') {
      const p = sess.peekImg;
      if (p) {
        p.bytes += (parts[2] || '').length;
        if (p.bytes > MAX_PEEK_BYTES) sess.peekImg = null; // never finishes; don't grow forever
        else p.chunks.push(parts[2] || '');
      }
    } else if (sub === 'f') {
      const p = sess.peekImg;
      sess.peekImg = null;
      if (p) return buildPeekOsc({ size: p.size, rows: p.rows, name: p.name, b64: p.chunks.join('') });
    }
  }
  return '';
}

// A download arrives as many small base64 OSC chunks (dl;h header, dl;d data,
// dl;f finish) so a large file or folder never builds one giant OSC in memory or
// overflows ConPTY's buffer. Bytes are written straight to disk as they stream:
// a file lands in Downloads; a folder arrives as a tar we pipe through `tar -x`,
// so a 10 GB download costs a couple of buffers of memory, not 10 GB.
function downloadsDir() {
  const dir = path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function uniqueDest(dir, name) {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let n = 1;
  do { dest = path.join(dir, `${stem} (${n})${ext}`); n++; } while (fs.existsSync(dest));
  return dest;
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
}

function startDownload(sess, name, kind) {
  endDownload(sess); // drop any half-received one first
  try {
    const dir = downloadsDir();
    const base = path.basename(name);
    const safe = /^\.*$/.test(base) ? 'download' : base; // '', '.', '..'
    if (kind === 'dir') {
      // Unpack into a folder of its own, never over what's already in
      // Downloads: the tar's top-level folder is stripped and its contents land
      // in "<name>" (or "<name> (1)"...), which we create fresh.
      const dest = uniqueDest(dir, safe);
      fs.mkdirSync(dest);
      const proc = spawn('tar', ['-xf', '-', '--strip-components=1', '-C', dest], { windowsHide: true });
      const dl = { kind, name: path.basename(dest), dest, bytes: 0, proc, failed: false };
      proc.on('error', () => { dl.failed = true; unpause(sess, dl); sendData(sess, `\r\n\x1b[31m[limpet] download failed: tar not available\x1b[0m\r\n`); });
      proc.stdin.on('error', () => { /* closed early */ });
      sess.dl = dl;
    } else {
      const dest = uniqueDest(dir, safe);
      const dl = { kind: 'file', name: path.basename(dest), dest, bytes: 0, failed: false };
      dl.ws = fs.createWriteStream(dest);
      dl.ws.on('error', (e) => { dl.failed = true; unpause(sess, dl); sendData(sess, `\r\n\x1b[31m[limpet] download failed: ${e.message}\x1b[0m\r\n`); });
      sess.dl = dl;
    }
  } catch (e) {
    sess.dl = null;
    sendData(sess, `\r\n\x1b[31m[limpet] download failed: ${e.message}\x1b[0m\r\n`);
  }
}

function writeDownloadChunk(sess, b64) {
  const dl = sess.dl;
  if (!dl || dl.failed) return;
  const buf = Buffer.from(b64 || '', 'base64');
  dl.bytes += buf.length;
  const sink = dl.ws || (dl.proc && dl.proc.stdin);
  if (!sink || !sink.writable) return;
  let ok = true;
  try { ok = sink.write(buf); } catch (_) { return; /* sink gone */ }
  // The disk (or tar) is slower than the link: stop reading the shell until it
  // catches up, so the backlog never piles up in memory.
  if (!ok && sess.proc && sess.proc.pause && !dl.paused) {
    dl.paused = true;
    sess.proc.pause();
    sink.once('drain', () => unpause(sess, dl));
  }
}

function unpause(sess, dl) {
  if (!dl.paused) return;
  dl.paused = false;
  if (sess.proc && sess.proc.resume) sess.proc.resume();
}

function finishDownload(sess) {
  const dl = sess.dl;
  if (!dl) return;
  if (dl.failed) { endDownload(sess); return; }
  sess.dl = null;
  const done = (verb) => sendData(sess, `\r\n\x1b[32m[limpet] ${verb} ${dl.name} (${fmtBytes(dl.bytes)}) to Downloads\x1b[0m\r\n`);
  if (dl.ws) {
    dl.ws.end(() => done('saved'));
  } else if (dl.proc) {
    dl.proc.on('close', (code) => {
      if (code === 0 || code == null) done('extracted');
      else sendData(sess, `\r\n\x1b[31m[limpet] download: tar exited ${code}\x1b[0m\r\n`);
    });
    try { dl.proc.stdin.end(); } catch (_) { /* already closed */ }
  }
}

// Abort a partially-received download (a new one starting, or the session
// ended) and remove what it wrote, so no truncated copy passes for the real one.
function endDownload(sess) {
  const dl = sess && sess.dl;
  if (!dl) return;
  sess.dl = null;
  unpause(sess, dl);
  const cleanup = () => { try { fs.rmSync(dl.dest, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
  try { if (dl.ws) { dl.ws.on('close', cleanup); dl.ws.destroy(); } } catch (_) { /* ignore */ }
  try { if (dl.proc) { dl.proc.on('close', cleanup); dl.proc.kill(); } } catch (_) { /* ignore */ }
}

// The shell ended on its own (`exit`, crash) — drop the session and tell the
// renderer so the tab closes. Deliberate closes delete from `sessions` first,
// so this is a no-op for them.
function sessionExited(sess) {
  if (!sessions.has(sess.id)) return;
  endDownload(sess);
  sess.proc = null;
  sess.exited = true;
  if (sess.ready) {
    sendToSession(sess, 'term:exit', { id: sess.id });
    sessions.delete(sess.id);
    if (sess.backdropPath) fs.unlink(sess.backdropPath, () => {});
  }
}

function startShell(sess) {
  const args = ['-NoExit', '-NoLogo', '-Command', `Import-Module "${LIMPET_MODULE}"`];

  if (ptyLib) {
    try {
      const p = ptyLib.spawn('powershell.exe', args, {
        name: 'xterm-256color', cols: sess.cols, rows: sess.rows,
        cwd: process.env.USERPROFILE || process.cwd(), env: { ...process.env, LIMPET_TOKEN: oscToken() },
      });
      p.onData((d) => forwardOutput(sess, d));
      p.onExit(() => sessionExited(sess));
      return {
        pid: p.pid,
        write: (d) => { try { p.write(d); } catch (_) { /* ignore */ } },
        resize: (c, r) => { try { p.resize(c, r); } catch (_) { /* ignore */ } },
        pause: () => { try { p.pause(); } catch (_) { /* ignore */ } },
        resume: () => { try { p.resume(); } catch (_) { /* ignore */ } },
        kill: () => { try { p.kill(); } catch (_) { /* ignore */ } },
      };
    } catch (e) {
      console.error('[limpet] pty spawn failed, pipe fallback:', e.message);
    }
  }

  const cp = spawn('powershell.exe', args, { windowsHide: true, env: { ...process.env, LIMPET_TOKEN: oscToken() } });
  cp.stdout.on('data', (d) => forwardOutput(sess, d.toString()));
  cp.stderr.on('data', (d) => forwardOutput(sess, d.toString()));
  cp.on('exit', () => sessionExited(sess));
  return {
    pid: cp.pid,
    write: (d) => { try { cp.stdin.write(d); } catch (_) { /* ignore */ } },
    resize: () => { /* pipes can't resize */ },
    pause: () => { cp.stdout.pause(); cp.stderr.pause(); },
    resume: () => { cp.stdout.resume(); cp.stderr.resume(); },
    kill: () => { try { cp.kill(); } catch (_) { /* ignore */ } },
  };
}

// Decode base64 into a file in the shell's *current* directory. We feed the
// data straight into `base64 -d` reading stdin and end it with EOT (Ctrl+D, the
// \x04). No here-doc means bash prints no "> " continuation prompts, so with
// echo off nothing scrolls past — just the confirmation line at the end.
function buildDropPayload(localPath) {
  const buf = fs.readFileSync(localPath);
  const name = path.basename(localPath).replace(/'/g, `'\\''`);
  const b64 = buf.toString('base64').replace(/(.{120})/g, '$1\n');
  return `base64 -d > '${name}'\n${b64}\n\x04printf '[limpet] received %s\\n' '${name}'\n`;
}

// "Paste" one or more PC files into the current session by base64-streaming them
// into the live prompt. Used by drag-drop and by the in-session `upload` command
// (whose prompt is already in the target remote directory). Folders and oversized
// files are skipped with a note.
async function injectFiles(sess, paths) {
  if (!sess || !sess.proc) return { ok: false };
  const files = [];
  for (const p of paths) {
    let st;
    try { st = fs.statSync(p); } catch (_) {
      sendData(sess, `\r\n\x1b[31m[limpet] not found: ${p}\x1b[0m\r\n`);
      continue;
    }
    const base = path.basename(p);
    if (st.isDirectory()) {
      sendData(sess, `\r\n\x1b[33m[limpet] skipping folder (files only): ${base}\x1b[0m\r\n`);
      continue;
    }
    if (st.size > MAX_DROP_BYTES) {
      sendData(sess, `\r\n\x1b[31m[limpet] ${base} is ${(st.size / 1048576).toFixed(0)} MB — too big to paste; use scp/wput.\x1b[0m\r\n`);
      continue;
    }
    files.push(p);
  }
  if (!files.length) return { ok: true, sent: [] };

  // Silence the remote terminal's echo so the base64 doesn't flood the screen,
  // and erase the command line it was typed on. stty echo is restored after.
  // The base64 echo is done by the remote tty, so wait for stty to take effect
  // before streaming the data.
  sess.proc.write("stty -echo 2>/dev/null; printf '\\033[1A\\r\\033[2K'\n");
  await sleep(250);
  const sent = [];
  try {
    for (const p of files) {
      let payload;
      // Locked, unreadable or deleted since the stat: skip it, keep going.
      try { payload = buildDropPayload(p); } catch (e) {
        sendData(sess, `\r\n\x1b[31m[limpet] couldn't read ${path.basename(p)}: ${e.code || e.message}\x1b[0m\r\n`);
        continue;
      }
      if (!sess.proc) break;
      sess.proc.write(payload);
      sent.push(path.basename(p));
    }
  } finally {
    // Echo must come back whatever happened above.
    if (sess.proc) sess.proc.write('stty echo 2>/dev/null\n');
  }
  return { ok: true, sent };
}

function backdropStatus(sess, state, message = '') {
  sendToSession(sess, 'term:backdrop-status', { id: sess.id, state, message });
}

function considerBackdrop(sess, snapshot, conversationTitle = '') {
  if (process.env.LIMPET_DISABLE_BACKDROPS === '1') return { status: 'disabled' };
  const backend = backendStatus();
  if (!backend.ready) return { status: 'not-installed' };
  if (sess.backdropQueued) return { status: 'busy' };
  const now = Date.now();
  const nextAt = sess.backdropNextAt || MIN_OUTPUT_CHARS;
  if ((sess.backdropOutputChars || 0) < nextAt) return { status: 'waiting' };
  if (sess.backdropLastAt && now - sess.backdropLastAt < MIN_UPDATE_MS) return { status: 'cooldown' };
  flushBackdropAnalysis(sess);
  const plan = buildBackdropPlan(snapshot, sess.backdropProfile, conversationTitle);
  if (!plan) return { status: 'not-enough-context' };
  if (sess.backdropSceneKey && plan.sceneKey !== sess.backdropSceneKey &&
      plan.confidence < MIN_SCENE_CHANGE_CONFIDENCE) {
    return { status: 'low-confidence' };
  }

  sess.backdropQueued = true;
  // Reserve the next interval as soon as the job enters the queue, preventing
  // repeated idle snapshots from adding duplicate jobs.
  sess.backdropNextAt = (sess.backdropOutputChars || 0) + UPDATE_OUTPUT_CHARS;
  backdropQueue.push({ sessionId: sess.id, prompt: plan.prompt, sceneKey: plan.sceneKey });
  backdropStatus(sess, 'generating');
  runBackdropQueue();
  return { status: 'queued' };
}

async function runBackdropQueue() {
  if (backdropRunning) return;
  const job = backdropQueue.shift();
  if (!job) return;
  const initialSession = sessions.get(job.sessionId);
  if (!initialSession) { runBackdropQueue(); return; }
  backdropRunning = true;
  const destination = outputPath(job.sessionId);
  try {
    await generateLocalImage({
      prompt: job.prompt, destination,
      onSpawn: (child) => { activeBackdropProcess = child; },
    });
    const sess = sessions.get(job.sessionId);
    if (!sess) {
      fs.unlink(destination, () => {});
    } else {
      const image = fs.readFileSync(destination);
      if (image.length > 12 * 1024 * 1024) throw new Error('generated background is unexpectedly large');
      const previous = sess.backdropPath;
      sess.backdropPath = destination;
      sess.backdropDataUrl = `data:image/png;base64,${image.toString('base64')}`;
      sess.backdropSceneKey = job.sceneKey;
      sess.backdropLastAt = Date.now();
      sess.backdropQueued = false;
      sendToSession(sess, 'term:backdrop', { id: sess.id, dataUrl: sess.backdropDataUrl });
      backdropStatus(sess, 'ready');
      if (previous && previous !== destination) fs.unlink(previous, () => {});
    }
  } catch (error) {
    fs.unlink(destination, () => {});
    const sess = sessions.get(job.sessionId);
    if (sess) {
      sess.backdropQueued = false;
      // Wait for some more activity before retrying a failed local generation.
      sess.backdropNextAt = (sess.backdropOutputChars || 0) + 1500;
      backdropStatus(sess, 'error', error.message);
      console.error('[limpet] local backdrop failed:', error.message);
    }
  } finally {
    activeBackdropProcess = null;
    backdropRunning = false;
    runBackdropQueue();
  }
}

// ---- One-time install of the local generator and model ----
// Offered the first time Generative is picked. Every window hears the
// progress, since the install serves all of them.
function broadcast(channel, payload) {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function backdropSetupState() {
  if (backdropSetup) return { state: 'installing', ...setupProgress() };
  return {
    state: backendStatus().ready ? 'ready' : 'missing',
    dir: LOCAL_AI_DIR,
    disabled: process.env.LIMPET_DISABLE_BACKDROPS === '1',
  };
}

function installBackdrop() {
  if (backdropSetup) return backdropSetup.promise;
  if (backendStatus().ready) return Promise.resolve({ state: 'ready' });
  const job = { child: null, cancelled: false };
  const ticker = setInterval(() => broadcast('backdrop:setup', backdropSetupState()), 500);
  job.promise = runSetup({ onSpawn: (child) => { job.child = child; } })
    .then(() => ({ state: 'ready' }))
    .catch((error) => (job.cancelled ? { state: 'cancelled' } : { state: 'error', message: error.message }))
    .then((result) => {
      clearInterval(ticker);
      backdropSetup = null;
      if (result.state === 'error') console.error('[limpet] backdrop setup failed:', result.message);
      broadcast('backdrop:setup', result);
      return result;
    });
  backdropSetup = job;
  broadcast('backdrop:setup', backdropSetupState());
  return job.promise;
}

// Stop the install and the curl under it. What has downloaded so far is kept;
// the next install resumes it.
function cancelBackdropSetup() {
  const job = backdropSetup;
  if (!job || !job.child) return false;
  job.cancelled = true;
  try { spawn('taskkill', ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true }); } catch (_) { /* ignore */ }
  return true;
}

// ---- Agent switching (right-click a tab) ----
// Which agent/account is this tab's chat on, and move it to another. Between
// accounts of one agent it is resuming the same chat by id in the same shell:
// Claude's projects/ folders are one shared store (Sync-LimpetClaudeHistory),
// Codex, Copilot and agy accounts share plain codex's / copilot's / agy's
// chats (Sync-LimpetCodexHistory, Sync-LimpetCopilotHistory; agy has one
// store anyway), and a Codex home not wired up yet gets the rollout copied in
// first. Claude -> Codex goes through Codex's own importer (codex-import.js);
// anything -> Claude writes a Claude transcript from the other agent's
// (handoff.js) and resumes it. Any other pair, or a conversion that fails,
// renders the chat to a Markdown handoff file and starts the new agent with a
// one-line prompt to continue from it.
//
// Accounts (claude, claude1, ..., codex1, ..., agy1, ..., copilot1, ...) are
// whatever config directories exist under the home (accounts.listAccounts);
// nothing is fixed.
const claudeHome = () => process.env.LIMPET_CLAUDE_HOME || os.homedir();
const accountIo = {
  exists: (p) => { try { return fs.existsSync(p); } catch (_) { return false; } },
  readJson: (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } },
  listDir: (p) => { try { return fs.readdirSync(p); } catch (_) { return []; } },
};
const knownAccounts = () => accounts.listAccounts(claudeHome(), accountIo);
const claudeAccounts = () => knownAccounts().filter((a) => a.kind === 'claude');
const agentHomes = (kind) => knownAccounts().filter((a) => a.kind === kind).map(({ cmd, dir }) => ({ cmd, home: path.join(claudeHome(), dir) }));

// The session file Claude Code keeps for every live process, tagged by account.
function readClaudeSessionFiles() {
  const out = [];
  for (const { cmd, dir } of claudeAccounts()) {
    const sessionsDir = path.join(claudeHome(), dir, 'sessions');
    let names = [];
    try { names = fs.readdirSync(sessionsDir); } catch (_) { continue; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const info = accountIo.readJson(path.join(sessionsDir, name));
      if (info) out.push({ cmd, info });
    }
  }
  return out;
}

// Where the shell's codexN wrapper notes which account it launched (see
// agent-scan.js). LIMPET_AGENT_RUN moves the folder (tests).
const agentRunDir = () => process.env.LIMPET_AGENT_RUN || path.join(app.getPath('appData'), 'limpet', 'agents');

async function detectAgentSession(sess) {
  const shellPid = sess && sess.proc && sess.proc.pid;
  if (!shellPid) return null;
  const { procs, input } = await agentScan.scanAgents({
    shellPid,
    claudeSessionFiles: readClaudeSessionFiles(),
    codexHomes: agentHomes('codex'),
    copilotHomes: agentHomes('copilot'),
    geminiDir: path.join(claudeHome(), '.gemini'),
    agyActiveFile: path.join(claudeHome(), '.agy', 'active'),
    runDir: agentRunDir(),
  });
  return accounts.findSession(input, procs, shellPid);
}

// The transcript file behind a Claude session id, wherever its project folder is.
function findClaudeTranscript(sessionId) {
  for (const { dir } of claudeAccounts()) {
    const root = path.join(claudeHome(), dir, 'projects');
    let projects = [];
    try { projects = fs.readdirSync(root); } catch (_) { continue; }
    for (const project of projects) {
      const file = path.join(root, project, `${sessionId}.jsonl`);
      if (accountIo.exists(file)) return file;
    }
  }
  return null;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Leave the agent the way a person would: Ctrl+C (interrupts a reply, then
// "press again to exit", then exit), with a beat between presses. If it is
// still there after that, kill the process tree.
async function stopAgent(sess, pid) {
  for (let i = 0; i < 20 && pidAlive(pid); i++) {
    if (i < 6 && sess.proc) sess.proc.write('\x03');
    await sleep(250);
  }
  if (pidAlive(pid)) {
    try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch (_) { /* ignore */ }
    for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(100);
  }
  return !pidAlive(pid);
}

const handoffDir = () => path.join(app.getPath('userData'), 'handoff');

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity', copilot: 'Copilot' };

// Carry the stopped agent's chat over to another account (of another agent,
// or of Codex, Copilot or agy). Returns the launch options for
// accounts.launchCommand and how it was done.
async function carryAcross(current, target, note) {
  const source = `${AGENT_NAMES[current.kind] || current.kind} (${current.cmd})`;
  // Copilot and agy accounts share one chat store (agy only has one), so the
  // chat is already where the other account looks.
  if (current.kind === target.kind && (target.kind === 'copilot' || target.kind === 'agy')) {
    note(36, `resuming ${current.sessionId} under ${target.cmd} (shared history).`);
    return { launch: { resume: current.sessionId }, how: 'resume' };
  }
  const transcript = current.kind === 'claude' ? findClaudeTranscript(current.sessionId) : current.rolloutPath;
  if (!transcript) {
    note(33, `couldn't find the ${current.cmd} transcript; starting ${target.cmd} fresh.`);
    return { launch: {}, how: 'fresh' };
  }
  // Native where there's a way in: Codex resumes its own threads and imports
  // Claude transcripts; Claude resumes a transcript we write in its format
  // from any agent's. The rest go by handoff file.
  const native = target.kind === 'claude' || (target.kind === 'codex' && (current.kind === 'codex' || current.kind === 'claude'));
  if (native) try {
    if (target.kind === 'codex') {
      const codexHome = path.join(claudeHome(), target.dir);
      if (current.kind === 'codex') {
        // Same agent, other login: the rollout file is the thread. Homes that
        // share plain codex's sessions folder already have it, so just resume.
        const targetSessions = agentScan.realPath(path.join(codexHome, 'sessions'));
        const rollout = agentScan.realPath(transcript);
        if (targetSessions && rollout && rollout.toLowerCase().startsWith(`${targetSessions.toLowerCase()}${path.sep}`)) {
          note(36, `resuming thread ${current.sessionId} under ${target.cmd} (shared history).`);
          return { launch: { resume: current.sessionId }, how: 'resume' };
        }
        // Otherwise copy it into the other home at the same dated path.
        const at = transcript.toLowerCase().lastIndexOf(`${path.sep}sessions${path.sep}`);
        let rel = at === -1 ? '' : transcript.slice(at + 1);
        if (!rel) {
          const d = new Date();
          rel = path.join('sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'), path.basename(transcript));
        }
        const dest = path.join(codexHome, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(transcript, dest);
        note(36, `chat copied to ${target.cmd} as thread ${current.sessionId}.`);
        return { launch: { resume: current.sessionId }, how: 'copy' };
      }
      const importer = global.__limpetCodexImport || codexImport.importClaudeSession;
      const threadId = await importer(transcript, { codexHome });
      if (!accounts.UUID_RE.test(String(threadId))) throw new Error('codex returned no thread id');
      note(36, `chat imported into Codex as thread ${threadId}.`);
      return { launch: { resume: threadId }, how: 'import' };
    }
    const turns = handoff.parseTranscript(current.kind, fs.readFileSync(transcript, 'utf8'));
    const cwd = current.cwd || process.env.USERPROFILE || os.homedir();
    const built = handoff.buildClaudeTranscript(turns, { cwd, title: handoff.titleFromTurns(turns), version: '2.1.0' });
    const dir = path.join(claudeHome(), target.dir, 'projects', handoff.claudeProjectDirName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${built.sessionId}.jsonl`), built.jsonl);
    note(36, `chat carried over from ${AGENT_NAMES[current.kind]} as Claude session ${built.sessionId}.`);
    return { launch: { resume: built.sessionId }, how: 'transcript' };
  } catch (e) {
    note(33, `native handover failed (${e.message}); using a handoff file instead.`);
  }
  // Otherwise: the chat as Markdown plus a one-line prompt to continue from it.
  try {
    const turns = handoff.parseTranscript(current.kind, fs.readFileSync(transcript, 'utf8'));
    const dir = handoffDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${current.cmd}-to-${target.cmd}.md`);
    fs.writeFileSync(file, handoff.renderMarkdown(turns, { source, cwd: current.cwd }));
    return { launch: { prompt: handoff.continuePrompt(file, source), addDir: dir }, how: 'handoff' };
  } catch (e) {
    note(31, `couldn't hand the chat over (${e.message}); starting ${target.cmd} fresh.`);
    return { launch: {}, how: 'fresh' };
  }
}

// Usage left per signed-in account (usage.js), fetched in parallel and kept for
// a minute so repeated right-clicks don't hammer the endpoints. Tests and demo
// recordings point LIMPET_USAGE_FIXTURE at a JSON file of { cmd: result } to
// stay offline.
const usageCache = new Map(); // cmd -> { at, result }
const USAGE_TTL_MS = 60 * 1000;
function readAllUsage() {
  const signedIn = accounts.describeAccounts(claudeHome(), accountIo).filter((a) => a.loggedIn);
  const fixture = process.env.LIMPET_USAGE_FIXTURE ? accountIo.readJson(process.env.LIMPET_USAGE_FIXTURE) : null;
  const now = Date.now();
  return Promise.all(signedIn.map(async (a) => {
    if (fixture) return { cmd: a.cmd, usage: fixture[a.cmd] || { error: 'no fixture' } };
    const hit = usageCache.get(a.cmd);
    if (hit && now - hit.at < USAGE_TTL_MS) return { cmd: a.cmd, usage: hit.result };
    const result = await usage.readUsage(a, accountIo);
    usageCache.set(a.cmd, { at: Date.now(), result });
    return { cmd: a.cmd, usage: result };
  }));
}

// Demo recordings (tools/demo) show stand-in addresses instead of real ones:
// LIMPET_DEMO_EMAILS="claude=you@home.example,claude1=you@work.example".
function demoEmails() {
  const out = {};
  for (const pair of String(process.env.LIMPET_DEMO_EMAILS || '').split(',')) {
    const [cmd, email] = pair.split('=');
    if (cmd && email) out[cmd.trim()] = email.trim();
  }
  return out;
}

// Move the tab's chat to `cmd`. With nothing running, just start that agent.
async function switchAgent(sess, cmd) {
  if (!sess || !sess.proc || sess.exited) return { ok: false, reason: 'no shell' };
  const target = accounts.accountFor(cmd);
  if (!target) return { ok: false, reason: 'unknown account' };
  if (sess.switching) return { ok: false, reason: 'busy' };
  sess.switching = true;
  const note = (color, msg) => sendData(sess, `\r\n\x1b[${color}m[limpet] ${msg}\x1b[0m\r\n`);
  try {
    const current = await detectAgentSession(sess);
    if (current && current.cmd === cmd) return { ok: false, reason: 'already' };
    if (current && !(await stopAgent(sess, current.pid))) {
      note(31, `couldn't stop the running ${current.cmd} (pid ${current.pid}); not switching.`);
      return { ok: false, reason: 'still running' };
    }
    // Let the shell redraw its prompt before anything is printed or typed.
    if (current) await sleep(300);
    // Tests capture the command instead of launching an agent.
    const launch = global.__limpetClaudeLaunch || accounts.launchCommand;
    let options = {};
    let how = 'fresh';
    if (!current) {
      // nothing to carry
    } else if (!current.sessionId) {
      note(33, `no session found for the running ${current.cmd}; starting ${cmd} fresh.`);
    } else if (current.kind === 'claude' && target.kind === 'claude') {
      options = { resume: current.sessionId };
      how = 'resume';
    } else {
      ({ launch: options, how } = await carryAcross(current, target, note));
    }
    const line = launch(cmd, options);
    if (current) await sleep(150); // let the prompt come back before typing
    // The shell may have exited during the awaits above.
    if (!sess.proc || sess.exited) return { ok: false, reason: 'no shell' };
    sess.proc.write(`${line}\r`);
    return { ok: true, from: current ? current.cmd : null, to: cmd, sessionId: current ? current.sessionId : null, how };
  } finally {
    sess.switching = false;
  }
}

function stopSession(sess) {
  if (!sess || !sessions.has(sess.id)) return;
  sessions.delete(sess.id); // deliberate close: keep sessionExited() quiet
  endDownload(sess);
  if (sess.flushTimer) clearTimeout(sess.flushTimer);
  if (sess.proc) sess.proc.kill();
  if (sess.backdropPath) fs.unlink(sess.backdropPath, () => {});
}

function detachedWindowBounds(sourceWindow, point) {
  const source = sourceWindow && !sourceWindow.isDestroyed()
    ? sourceWindow.getBounds() : { x: 100, y: 100, width: 1000, height: 660 };
  const target = point && Number.isFinite(point.x) && Number.isFinite(point.y)
    ? { x: Math.round(point.x), y: Math.round(point.y) }
    : { x: source.x + 40, y: source.y + 40 };
  const work = screen.getDisplayNearestPoint(target).workArea;
  const width = Math.min(source.width, work.width);
  const height = Math.min(source.height, work.height);
  return {
    width, height,
    x: Math.max(work.x, Math.min(target.x - 120, work.x + work.width - width)),
    y: Math.max(work.y, Math.min(target.y - 18, work.y + work.height - height)),
  };
}

function openExternalUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    Promise.resolve(shell.openExternal(url.toString())).catch((error) => {
      console.error('[limpet] failed to open external URL:', error.message);
    });
    return true;
  } catch (_) {
    return false;
  }
}

function createWindow({ sessionId = null, sourceWindow = null, point = null, title = 'limpet' } = {}) {
  const detached = sessionId !== null;
  const bounds = detached ? detachedWindowBounds(sourceWindow, point) : { width: 1000, height: 660 };
  const browserWin = new BrowserWindow({
    ...bounds, backgroundColor: '#1e1e2e', title: 'limpet',
    icon: path.join(__dirname, '..', 'build', 'limpet.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true },
  });
  const windowId = browserWin.webContents.id;
  windows.set(windowId, browserWin);

  // Hiding the stock menu leaves its Ctrl+C/Ctrl+V accelerators active. Those
  // race xterm's handlers and were the source of intermittent copy and double
  // paste, so remove the menu rather than merely hiding it.
  browserWin.removeMenu();

  if (detached) {
    const sess = sessions.get(sessionId);
    if (!sess) { browserWin.destroy(); return null; }
    sess.ownerId = windowId;
    sess.ready = false;
  }
  const query = detached ? { session: String(sessionId), title: String(title || 'limpet').slice(0, 200) } : {};
  browserWin.loadFile(path.join(__dirname, 'index.html'), { query });

  // Any renderer-created popup or navigation belongs in the user's normal
  // browser. The app itself remains a terminal, not a second web browser.
  browserWin.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });

  // Inject our preload into the reels <webview> so we can tidy the page from the
  // inside (the reliable injection point — runs in the guest at document-start).
  // Tidy the docked page (background, scrollbars, nav/chat chrome) by injecting
  // from the main process — webview `preload` set via will-attach-webview does
  // not run reliably here, but executeJavaScript on the guest does. Re-injected
  // on every load and SPA navigation; a MutationObserver inside keeps it applied.
  browserWin.webContents.on('did-attach-webview', (_e, wc) => {
    // Paint the webview's native backing store the exact terminal background.
    // (Going transparent and letting the host div show through composites the
    // color slightly lighter, so set it solid here instead.)
    try { wc.setBackgroundColor('#1e1e2e'); } catch (_) {}
    const tidy = () => wc.executeJavaScript(REELS_TIDY).catch(() => {});
    wc.on('dom-ready', tidy);
    wc.on('did-finish-load', tidy);
    wc.on('did-navigate-in-page', tidy);
    wc.setWindowOpenHandler(({ url }) => {
      openExternalUrl(url);
      return { action: 'deny' };
    });
    // The docked page is the web; keep it there (no file:, no app pages).
    wc.on('will-navigate', (e, url) => { if (!isWebUrl(url)) e.preventDefault(); });
  });
  // Pin the reels webview's settings whatever the page asked for: no preload,
  // no Node, isolated, and only ever pointed at an http(s) page.
  browserWin.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    if (params.src && !isWebUrl(params.src)) e.preventDefault();
  });

  browserWin.on('closed', () => {
    windows.delete(windowId);
    // Closing one window closes only its tabs. Sessions already handed to a
    // detached window have a different ownerId and stay alive.
    for (const sess of [...sessions.values()]) {
      if (sess.ownerId === windowId) stopSession(sess);
    }
  });
  return browserWin;
}

function ownedSession(event, id) {
  const sess = sessions.get(id);
  return sess && sess.ownerId === event.sender.id ? sess : null;
}

function registerIpc() {
  ipcMain.handle('clip:write', (_e, text) => { clipboard.writeText(String(text || '')); });
  ipcMain.handle('clip:read', () => clipboard.readText());
  ipcMain.handle('external:open', (_e, url) => openExternalUrl(url));

  ipcMain.handle('term:create', (event) => {
    const sess = {
      id: nextSessionId++, proc: null, ownerId: event.sender.id, ready: false,
      uiPending: [], cols: 80, rows: 24, outPending: '', flushTimer: null, exited: false,
      backdropOutputChars: 0, backdropNextAt: MIN_OUTPUT_CHARS, backdropLastAt: 0,
      backdropQueued: false, backdropPath: null, backdropDataUrl: null,
      backdropProfile: createTopicProfile(), backdropAnalysisBuffer: '', backdropSceneKey: null,
    };
    sessions.set(sess.id, sess);
    sess.proc = startShell(sess);
    return sess.id;
  });
  ipcMain.handle('term:ready', (event, id) => {
    const sess = ownedSession(event, id);
    if (!sess) return false;
    sess.ready = true;
    flushSessionUi(sess);
    if (sess.backdropDataUrl) {
      sendToSession(sess, 'term:backdrop', { id: sess.id, dataUrl: sess.backdropDataUrl });
    }
    if (sess.exited) {
      sendToSession(sess, 'term:exit', { id: sess.id });
      sessions.delete(sess.id);
      if (sess.backdropPath) fs.unlink(sess.backdropPath, () => {});
    }
    return true;
  });
  ipcMain.handle('term:detach', (event, { id, options } = {}) => {
    const sess = ownedSession(event, id);
    if (!sess || sess.exited) return false;
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    const x = Number(options && options.x);
    const y = Number(options && options.y);
    const point = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    return !!createWindow({ sessionId: id, sourceWindow, point, title: options && options.title });
  });
  ipcMain.on('term:close', (event, id) => stopSession(ownedSession(event, id)));
  ipcMain.on('term:input', (event, { id, data }) => {
    const sess = ownedSession(event, id);
    if (sess && sess.proc) sess.proc.write(data);
  });
  ipcMain.on('term:resize', (event, { id, cols, rows }) => {
    const sess = ownedSession(event, id);
    if (sess && sess.proc) { sess.cols = cols; sess.rows = rows; sess.proc.resize(cols, rows); }
  });
  ipcMain.handle('term:drop-files', (event, { id, paths }) => {
    const sess = ownedSession(event, id);
    return sess ? injectFiles(sess, paths) : { ok: false };
  });
  ipcMain.handle('claude:accounts', (event, id) => {
    if (!ownedSession(event, id)) return { accounts: [], more: [] };
    const demo = demoEmails();
    const described = accounts.describeAccounts(claudeHome(), accountIo);
    return {
      accounts: described.map(({ cmd, kind, email, loggedIn }) => ({ cmd, kind, email: demo[cmd] || email, loggedIn })),
      more: accounts.signInHints(described),
    };
  });
  ipcMain.handle('claude:usage', (event, id) => (ownedSession(event, id) ? readAllUsage() : []));
  ipcMain.handle('claude:session', async (event, id) => {
    const sess = ownedSession(event, id);
    const found = sess ? await detectAgentSession(sess) : null;
    return found ? { cmd: found.cmd, kind: found.kind, sessionId: found.sessionId, status: found.status } : null;
  });
  ipcMain.handle('claude:switch', (event, { id, cmd } = {}) => switchAgent(ownedSession(event, id), String(cmd || '')));
  ipcMain.handle('term:backdrop-candidate', (event, { id, snapshot, title } = {}) => {
    const sess = ownedSession(event, id);
    if (!sess || typeof snapshot !== 'string') return { status: 'invalid' };
    return considerBackdrop(sess, snapshot.slice(-24000), String(title || '').slice(0, 240));
  });
  ipcMain.handle('backdrop:setup-state', () => backdropSetupState());
  ipcMain.handle('backdrop:install', () => installBackdrop());
  ipcMain.handle('backdrop:cancel', () => cancelBackdropSetup());
}

registerIpc();
app.whenReady().then(() => createWindow());
app.on('before-quit', () => {
  if (activeBackdropProcess) { try { activeBackdropProcess.kill(); } catch (_) {} }
  cancelBackdropSetup();
});
app.on('window-all-closed', () => app.quit());
