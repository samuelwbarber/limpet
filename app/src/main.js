// limpet - Electron main process.
// A terminal running local PowerShell (with the Limpet Linux-shim module). You
// connect to remote hosts however you like (e.g. `xssh user@host`) right in the
// shell. Dropping files onto the window "pastes" them into whatever shell is in
// front, reconstructing each file in the current directory from base64 — so it
// works inside your SSH session with nothing installed on the remote but
// coreutils (base64). Real ConPTY via node-pty; pipe fallback if unavailable.

const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
// One entry per tab: its PTY plus the OSC-scan state (a marker split across
// PTY chunks must be held back per stream, not globally).
const sessions = new Map(); // id -> { id, proc, cols, rows, outPending, flushTimer }
let nextSessionId = 1;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function sendData(sess, data) {
  send('term:data', { id: sess.id, data });
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
  LIMPET_OSC, OSC_MARKERS, BEL,
  heldPrefixLen, findMarker, looksLikeVerb, classifyIip, b64dec, transformPeekImage, buildPeekOsc,
} = require('./protocol');

// A trailing partial-prefix of a marker is held back so a marker split across
// two PTY chunks isn't leaked to the screen — but it's flushed on a short timer
// if no more output follows, so a held byte (e.g. a lone trailing ESC, which is
// extremely common) can never leave the screen frozen at an idle prompt.
function scheduleFlush(sess) {
  if (sess.flushTimer) clearTimeout(sess.flushTimer);
  sess.flushTimer = setTimeout(() => {
    sess.flushTimer = null;
    if (sess.outPending) { sendData(sess, sess.outPending); sess.outPending = ''; }
  }, 30);
}

function forwardOutput(sess, data) {
  if (sess.flushTimer) { clearTimeout(sess.flushTimer); sess.flushTimer = null; }
  let buf = sess.outPending + data;
  sess.outPending = '';
  let out = '';
  while (buf.length) {
    const { idx: start, marker } = findMarker(buf);
    if (start === -1) {
      const hold = heldPrefixLen(buf);
      out += buf.slice(0, buf.length - hold);
      sess.outPending = buf.slice(buf.length - hold);
      break;
    }
    out += buf.slice(0, start);
    buf = buf.slice(start);
    const afterMark = marker.length;
    const end = buf.indexOf(BEL, afterMark);
    if (end === -1) {
      // Real limpet sequence still arriving (a download or image can be large) →
      // wait for BEL. A false marker is dropped back to the screen right away.
      const after = buf.slice(afterMark);
      const wait = marker === LIMPET_OSC ? looksLikeVerb(after) : classifyIip(after) !== 'other';
      if (wait) { sess.outPending = buf; }
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
  // back-to-back, so it isn't on this timer.
  if (sess.outPending && !OSC_MARKERS.some((m) => sess.outPending.startsWith(m))) scheduleFlush(sess);
}

// Returns text to emit to the terminal ('' for side-effect-only verbs). `peek`
// streams an image as many small OSC chunks so no single escape sequence is big
// enough to overflow ConPTY's OSC buffer when a slow/lossy link delivers it in
// fragments (a large one-shot OSC gets silently dropped whole). We reassemble
// the chunks here and hand the complete image to the renderer over IPC, which
// never passes back through ConPTY.
function handleLimpetOsc(sess, seq) {
  const parts = seq.split(';');
  if (parts[0] === 'dl') {
    const sub = parts[1];
    if (sub === 'h') startDownload(sess, b64dec(parts[2]).toString('utf8'), parts[3]);
    else if (sub === 'd') writeDownloadChunk(sess, parts[2]);
    else if (sub === 'f') finishDownload(sess);
  } else if (parts[0] === 'upload') {
    injectFiles(sess, [b64dec(parts[1]).toString('utf8')]);
  } else if (parts[0] === 'reels') {
    send('reels:toggle', b64dec(parts[1]).toString('utf8'));
  } else if (parts[0] === 'peek') {
    const sub = parts[1];
    if (sub === 'h') {
      sess.peekImg = { name: b64dec(parts[2]).toString('utf8'), size: parts[3], rows: parts[4], chunks: [] };
    } else if (sub === 'd') {
      if (sess.peekImg) sess.peekImg.chunks.push(parts[2] || '');
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
    const safe = path.basename(name) || 'download';
    if (kind === 'dir') {
      const proc = spawn('tar', ['-xf', '-', '-C', dir], { windowsHide: true });
      const dl = { kind, name: safe, bytes: 0, proc, failed: false };
      proc.on('error', () => { dl.failed = true; sendData(sess, `\r\n\x1b[31m[limpet] download failed: tar not available\x1b[0m\r\n`); });
      proc.stdin.on('error', () => { /* closed early */ });
      sess.dl = dl;
    } else {
      const dest = uniqueDest(dir, safe);
      const dl = { kind: 'file', name: path.basename(dest), bytes: 0, failed: false };
      dl.ws = fs.createWriteStream(dest);
      dl.ws.on('error', (e) => { dl.failed = true; sendData(sess, `\r\n\x1b[31m[limpet] download failed: ${e.message}\x1b[0m\r\n`); });
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
  if (sink && sink.writable) { try { sink.write(buf); } catch (_) { /* sink gone */ } }
}

function finishDownload(sess) {
  const dl = sess.dl;
  sess.dl = null;
  if (!dl || dl.failed) return;
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

// Abort a partially-received download (a new one starting, or the session ended).
function endDownload(sess) {
  const dl = sess && sess.dl;
  if (!dl) return;
  sess.dl = null;
  try { if (dl.ws) dl.ws.destroy(); } catch (_) { /* ignore */ }
  try { if (dl.proc) dl.proc.kill(); } catch (_) { /* ignore */ }
}

// The shell ended on its own (`exit`, crash) — drop the session and tell the
// renderer so the tab closes. Deliberate closes delete from `sessions` first,
// so this is a no-op for them.
function sessionExited(sess) {
  if (!sessions.has(sess.id)) return;
  endDownload(sess);
  sessions.delete(sess.id);
  send('term:exit', { id: sess.id });
}

function startShell(sess) {
  const args = ['-NoExit', '-NoLogo', '-Command', `Import-Module "${LIMPET_MODULE}"`];

  if (ptyLib) {
    try {
      const p = ptyLib.spawn('powershell.exe', args, {
        name: 'xterm-256color', cols: sess.cols, rows: sess.rows,
        cwd: process.env.USERPROFILE || process.cwd(), env: process.env,
      });
      p.onData((d) => forwardOutput(sess, d));
      p.onExit(() => sessionExited(sess));
      return {
        write: (d) => { try { p.write(d); } catch (_) { /* ignore */ } },
        resize: (c, r) => { try { p.resize(c, r); } catch (_) { /* ignore */ } },
        kill: () => { try { p.kill(); } catch (_) { /* ignore */ } },
      };
    } catch (e) {
      console.error('[limpet] pty spawn failed, pipe fallback:', e.message);
    }
  }

  const cp = spawn('powershell.exe', args, { windowsHide: true });
  cp.stdout.on('data', (d) => forwardOutput(sess, d.toString()));
  cp.stderr.on('data', (d) => forwardOutput(sess, d.toString()));
  cp.on('exit', () => sessionExited(sess));
  return {
    write: (d) => { try { cp.stdin.write(d); } catch (_) { /* ignore */ } },
    resize: () => { /* pipes can't resize */ },
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
  for (const p of files) {
    sess.proc.write(buildDropPayload(p));
    sent.push(path.basename(p));
  }
  sess.proc.write('stty echo 2>/dev/null\n');
  return { ok: true, sent };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 660, backgroundColor: '#1e1e2e', title: 'limpet',
    icon: path.join(__dirname, '..', 'build', 'limpet.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));

  // Inject our preload into the reels <webview> so we can tidy the page from the
  // inside (the reliable injection point — runs in the guest at document-start).
  // Tidy the docked page (background, scrollbars, nav/chat chrome) by injecting
  // from the main process — webview `preload` set via will-attach-webview does
  // not run reliably here, but executeJavaScript on the guest does. Re-injected
  // on every load and SPA navigation; a MutationObserver inside keeps it applied.
  win.webContents.on('did-attach-webview', (_e, wc) => {
    // Paint the webview's native backing store the exact terminal background.
    // (Going transparent and letting the host div show through composites the
    // color slightly lighter, so set it solid here instead.)
    try { wc.setBackgroundColor('#1e1e2e'); } catch (_) {}
    const tidy = () => wc.executeJavaScript(REELS_TIDY).catch(() => {});
    wc.on('dom-ready', tidy);
    wc.on('did-finish-load', tidy);
    wc.on('did-navigate-in-page', tidy);
  });

  ipcMain.handle('clip:write', (_e, text) => { clipboard.writeText(String(text || '')); });
  ipcMain.handle('clip:read', () => clipboard.readText());

  // Tabs: the renderer creates one session per tab and tags every message with
  // its id.
  ipcMain.handle('term:create', () => {
    const sess = { id: nextSessionId++, proc: null, cols: 80, rows: 24, outPending: '', flushTimer: null };
    sessions.set(sess.id, sess);
    sess.proc = startShell(sess);
    return sess.id;
  });
  ipcMain.on('term:close', (_e, id) => {
    const sess = sessions.get(id);
    if (!sess) return;
    sessions.delete(id); // deliberate close: keep sessionExited() quiet
    sess.proc.kill();
  });
  ipcMain.on('term:input', (_e, { id, data }) => { const s = sessions.get(id); if (s) s.proc.write(data); });
  ipcMain.on('term:resize', (_e, { id, cols, rows }) => {
    const s = sessions.get(id);
    if (s) { s.cols = cols; s.rows = rows; s.proc.resize(cols, rows); }
  });

  ipcMain.handle('term:drop-files', (_e, { id, paths }) => injectFiles(sessions.get(id), paths));

  win.on('closed', () => {
    for (const s of sessions.values()) s.proc.kill();
    sessions.clear();
    win = null;
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
