// winux - Electron main process.
// A terminal running local PowerShell (with the Winux Linux-shim module). You
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
  console.error('[winux] node-pty unavailable, using pipe fallback:', e.message);
}

const WINUX_MODULE = path.join(__dirname, '..', '..', 'shell', 'Winux.psd1');

// Injected into the docked reels page to make the reel float on a
// terminal-matching background with no scrollbars or nav/chat chrome. Instagram's
// class names are randomized, so we hide by shape/position: a wide, short,
// fixed/sticky strip of links at the top/bottom edge is the nav bar; a small
// fixed box in the bottom-right corner is the chat bubble. A centered vertical
// reel matches neither. A MutationObserver re-applies it across SPA re-renders.
const REELS_TIDY = `(function () {
  if (!document.getElementById('winux-tidy')) {
    var s = document.createElement('style'); s.id = 'winux-tidy';
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
      if (el.dataset.winuxHid) return;
      var st = getComputedStyle(el);
      if (st.position !== 'fixed' && st.position !== 'sticky') return;
      var r = el.getBoundingClientRect();
      if (r.width > 8 && r.width < vw * 0.5 && r.height > 8 && r.height < 260 &&
          r.bottom >= vh - 160 && r.right >= vw - 160) {
        el.style.setProperty('display', 'none', 'important'); el.dataset.winuxHid = '1';
      }
    });
  }
  function tidy() { hideNav(); fixBg(); hideBubble(); }
  tidy();
  if (!window.__winuxObs) {
    window.__winuxObs = new MutationObserver(function () {
      clearTimeout(window.__winuxT); window.__winuxT = setTimeout(tidy, 80);
    });
    window.__winuxObs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();`;
const MAX_DROP_BYTES = 20 * 1024 * 1024; // pasting more than this through a PTY is impractical
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
let term = null;
let lastCols = 80;
let lastRows = 24;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// --- winux shell integration (download/upload from inside an ssh session) ---
// The remote helpers (shell/winux-remote.sh, loaded by xssh) emit private OSC
// sequences: ESC ]5379; <verb> ; <args...> BEL. We catch those here and let
// everything else (normal output, OSC 1337 inline images for `peek`) pass
// straight through to xterm.js untouched.
const WINUX_OSC = '\x1b]5379;';
const BEL = '\x07';
const KNOWN_VERBS = ['download', 'upload', 'reels'];
let outPending = '';
let flushTimer = null;

// A trailing partial-prefix of the marker is held back so a marker split across
// two PTY chunks isn't leaked to the screen — but it's flushed on a short timer
// if no more output follows, so a held byte (e.g. a lone trailing ESC, which is
// extremely common) can never leave the screen frozen at an idle prompt.
function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (outPending) { send('term:data', outPending); outPending = ''; }
  }, 30);
}

// Longest suffix of `s` that is a (partial) prefix of the OSC marker.
function heldPrefixLen(s) {
  const max = Math.min(s.length, WINUX_OSC.length - 1);
  for (let n = max; n > 0; n--) {
    if (WINUX_OSC.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

// Is what follows the marker still a plausible winux verb? Lets us bail out fast
// (emit literally) if a stray `\x1b]5379;` ever shows up in normal output,
// instead of buffering the rest of the stream forever waiting for a BEL.
function looksLikeVerb(after) {
  const semi = after.indexOf(';');
  if (semi === -1) return KNOWN_VERBS.some((v) => v.startsWith(after));
  return KNOWN_VERBS.includes(after.slice(0, semi));
}

function forwardOutput(data) {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  let buf = outPending + data;
  outPending = '';
  let out = '';
  while (buf.length) {
    const start = buf.indexOf(WINUX_OSC);
    if (start === -1) {
      const hold = heldPrefixLen(buf);
      out += buf.slice(0, buf.length - hold);
      outPending = buf.slice(buf.length - hold);
      break;
    }
    out += buf.slice(0, start);
    const afterMark = start + WINUX_OSC.length;
    const end = buf.indexOf(BEL, afterMark);
    if (end === -1) {
      // Real winux sequence still arriving (a download can be large) → wait for
      // BEL. A false marker is dropped back to the screen right away.
      if (looksLikeVerb(buf.slice(afterMark))) { outPending = buf.slice(start); }
      else { out += buf.slice(start, afterMark); buf = buf.slice(afterMark); continue; }
      break;
    }
    handleWinuxOsc(buf.slice(afterMark, end));
    buf = buf.slice(end + 1);
  }
  if (out) send('term:data', out);
  // A held *partial-prefix* (no full marker yet) must never linger — flush it if
  // the stream goes quiet. A held full marker (real download in flight) streams
  // back-to-back, so it isn't on this timer.
  if (outPending && !outPending.startsWith(WINUX_OSC)) scheduleFlush();
}

const b64dec = (s) => Buffer.from(s || '', 'base64');

function handleWinuxOsc(seq) {
  const parts = seq.split(';');
  if (parts[0] === 'download') {
    saveDownload(b64dec(parts[1]).toString('utf8'), b64dec(parts[2]));
  } else if (parts[0] === 'upload') {
    injectFiles([b64dec(parts[1]).toString('utf8')]);
  } else if (parts[0] === 'reels') {
    send('reels:toggle', b64dec(parts[1]).toString('utf8'));
  }
}

function saveDownload(name, buf) {
  try {
    const safe = path.basename(name) || 'download';
    const dir = path.join(os.homedir(), 'Downloads');
    fs.mkdirSync(dir, { recursive: true });
    let dest = path.join(dir, safe);
    if (fs.existsSync(dest)) {
      const ext = path.extname(safe);
      const stem = path.basename(safe, ext);
      let n = 1;
      do { dest = path.join(dir, `${stem} (${n})${ext}`); n++; } while (fs.existsSync(dest));
    }
    fs.writeFileSync(dest, buf);
    send('term:data', `\r\n\x1b[32m[winux] saved ${path.basename(dest)} to Downloads\x1b[0m\r\n`);
  } catch (e) {
    send('term:data', `\r\n\x1b[31m[winux] download failed: ${e.message}\x1b[0m\r\n`);
  }
}

function startShell() {
  const args = ['-NoExit', '-NoLogo', '-Command', `Import-Module "${WINUX_MODULE}"`];

  if (ptyLib) {
    try {
      const p = ptyLib.spawn('powershell.exe', args, {
        name: 'xterm-256color', cols: lastCols, rows: lastRows,
        cwd: process.env.USERPROFILE || process.cwd(), env: process.env,
      });
      p.onData((d) => forwardOutput(d));
      p.onExit(() => send('term:data', '\r\n\x1b[90m[winux] shell exited.\x1b[0m\r\n'));
      return {
        write: (d) => { try { p.write(d); } catch (_) { /* ignore */ } },
        resize: (c, r) => { try { p.resize(c, r); } catch (_) { /* ignore */ } },
        kill: () => { try { p.kill(); } catch (_) { /* ignore */ } },
      };
    } catch (e) {
      console.error('[winux] pty spawn failed, pipe fallback:', e.message);
    }
  }

  const cp = spawn('powershell.exe', args, { windowsHide: true });
  cp.stdout.on('data', (d) => forwardOutput(d.toString()));
  cp.stderr.on('data', (d) => forwardOutput(d.toString()));
  cp.on('exit', () => send('term:data', '\r\n\x1b[90m[winux] shell exited.\x1b[0m\r\n'));
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
  return `base64 -d > '${name}'\n${b64}\n\x04printf '[winux] received %s\\n' '${name}'\n`;
}

// "Paste" one or more PC files into the current session by base64-streaming them
// into the live prompt. Used by drag-drop and by the in-session `upload` command
// (whose prompt is already in the target remote directory). Folders and oversized
// files are skipped with a note.
async function injectFiles(paths) {
  if (!term) return { ok: false };
  const files = [];
  for (const p of paths) {
    let st;
    try { st = fs.statSync(p); } catch (_) {
      send('term:data', `\r\n\x1b[31m[winux] not found: ${p}\x1b[0m\r\n`);
      continue;
    }
    const base = path.basename(p);
    if (st.isDirectory()) {
      send('term:data', `\r\n\x1b[33m[winux] skipping folder (files only): ${base}\x1b[0m\r\n`);
      continue;
    }
    if (st.size > MAX_DROP_BYTES) {
      send('term:data', `\r\n\x1b[31m[winux] ${base} is ${(st.size / 1048576).toFixed(0)} MB — too big to paste; use scp/wput.\x1b[0m\r\n`);
      continue;
    }
    files.push(p);
  }
  if (!files.length) return { ok: true, sent: [] };

  // Silence the remote terminal's echo so the base64 doesn't flood the screen,
  // and erase the command line it was typed on. stty echo is restored after.
  // The base64 echo is done by the remote tty, so wait for stty to take effect
  // before streaming the data.
  term.write("stty -echo 2>/dev/null; printf '\\033[1A\\r\\033[2K'\n");
  await sleep(250);
  const sent = [];
  for (const p of files) {
    term.write(buildDropPayload(p));
    sent.push(path.basename(p));
  }
  term.write('stty echo 2>/dev/null\n');
  return { ok: true, sent };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 660, backgroundColor: '#1e1e2e', title: 'winux',
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
    // Make the webview's native backing store fully transparent so the host
    // page's #reels div (#1e1e2e, same CSS as the terminal) shows through.
    try { wc.setBackgroundColor('#00000000'); } catch (_) {}
    const tidy = () => wc.executeJavaScript(REELS_TIDY).catch(() => {});
    wc.on('dom-ready', tidy);
    wc.on('did-finish-load', tidy);
    wc.on('did-navigate-in-page', tidy);
  });

  win.webContents.on('did-finish-load', () => { term = startShell(); });

  ipcMain.handle('clip:write', (_e, text) => { clipboard.writeText(String(text || '')); });
  ipcMain.handle('clip:read', () => clipboard.readText());

  ipcMain.on('term:input', (_e, d) => { if (term) term.write(d); });
  ipcMain.on('term:resize', (_e, { cols, rows }) => { lastCols = cols; lastRows = rows; if (term) term.resize(cols, rows); });

  ipcMain.handle('term:drop-files', (_e, paths) => injectFiles(paths));

  win.on('closed', () => { if (term) term.kill(); term = null; win = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
