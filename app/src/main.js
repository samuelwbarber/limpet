// winux - Electron main process.
// M1: local PowerShell (pipe fallback; ConPTY pending toolchain).
// M3: integrated SSH via ssh2 (pure JS) with resilient auto-reconnect.
// M4: drag-drop upload over SFTP to the remote's current dir (tracked via OSC 7).

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Client } = require('ssh2');

const WINUX_MODULE = path.join(__dirname, '..', '..', 'shell', 'Winux.psd1');
const DEFAULT_KEY = path.join(os.homedir(), '.ssh', 'id_ed25519');

let win = null;
const sessions = new Map();
let activeId = null;
let lastCols = 80;
let lastRows = 24;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function emitData(id, data) {
  if (id === activeId) send('term:data', data);
}
function setActive(id) {
  activeId = id;
  const s = sessions.get(id);
  send('term:reset');
  send('term:active', { id, type: s ? s.type : null, host: s ? s.host : null, cwd: s ? s.cwd : null });
}

// ---------------------------------------------------------------------------
// Local shell (pipe fallback until ConPTY is wired)
// ---------------------------------------------------------------------------
function createLocalSession() {
  const id = 'local';
  const cp = spawn('powershell.exe', ['-NoExit', '-NoLogo', '-Command', `Import-Module "${WINUX_MODULE}"`], { windowsHide: true });
  const s = {
    id, type: 'local', host: null, cwd: null,
    write: (d) => { try { cp.stdin.write(d); } catch (_) { /* ignore */ } },
    resize: () => { /* pipes can't resize */ },
    kill: () => { try { cp.kill(); } catch (_) { /* ignore */ } },
  };
  cp.stdout.on('data', (d) => emitData(id, d.toString()));
  cp.stderr.on('data', (d) => emitData(id, d.toString()));
  cp.on('exit', () => emitData(id, '\r\n\x1b[90m[winux] local shell exited.\x1b[0m\r\n'));
  sessions.set(id, s);
  return s;
}

// ---------------------------------------------------------------------------
// OSC 7 cwd parsing: shells emit ESC ] 7 ; file://HOST/PATH ST
// ---------------------------------------------------------------------------
function parseOsc7(data, session) {
  const re = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let m, last = null;
  while ((m = re.exec(data)) !== null) last = m[1];
  if (last) {
    try { last = decodeURIComponent(last); } catch (_) { /* keep raw */ }
    if (last !== session.cwd) {
      session.cwd = last;
      send('ssh:cwd', { id: session.id, cwd: last });
    }
  }
}

// ---------------------------------------------------------------------------
// SSH session: key auth, keepalive, auto-reconnect, SFTP upload
// ---------------------------------------------------------------------------
function createSshSession(opts) {
  const id = 'ssh:' + opts.username + '@' + opts.host;
  if (sessions.has(id)) { try { sessions.get(id).kill(); } catch (_) { /* ignore */ } sessions.delete(id); }

  let client = null;
  let stream = null;
  let intentional = false;
  let reconnecting = false;
  let readyThisAttempt = false;
  let attemptStart = 0;

  const s = {
    id, type: 'ssh', host: opts.host, port: opts.port, username: opts.username, cwd: null,
    write: (d) => { try { if (stream) stream.write(d); } catch (_) { /* ignore */ } },
    resize: (c, r) => { try { if (stream) stream.setWindow(r, c, 0, 0); } catch (_) { /* ignore */ } },
    kill: () => { intentional = true; try { if (client) client.end(); } catch (_) { /* ignore */ } },
  };

  function connect() {
    client = new Client();
    readyThisAttempt = false;
    attemptStart = Date.now();

    client.on('ready', () => {
      readyThisAttempt = true;
      emitData(id, `\r\n\x1b[32m[winux] connected to ${opts.username}@${opts.host}\x1b[0m\r\n`);
      client.shell({ term: 'xterm-256color', cols: lastCols, rows: lastRows }, (err, ch) => {
        if (err) { emitData(id, `\r\n\x1b[31m[winux] shell error: ${err.message}\x1b[0m\r\n`); return; }
        stream = ch;
        if (activeId !== id) setActive(id);
        // Ask the remote shell to report its cwd via OSC 7 (bash/zsh). One
        // setup line will echo on the first prompt; harmless on other shells.
        ch.write("export PROMPT_COMMAND='printf \"\\033]7;file://%s%s\\033\\\\\" \"$(hostname)\" \"$PWD\"'\n");
        ch.on('data', (d) => { const str = d.toString('utf8'); parseOsc7(str, s); emitData(id, str); });
        ch.on('exit', () => { intentional = true; emitData(id, '\r\n\x1b[90m[winux] session closed.\x1b[0m\r\n'); send('ssh:ended', { id }); });
      });
    });

    client.on('error', (err) => { emitData(id, `\r\n\x1b[31m[winux] ssh error: ${err.message}\x1b[0m\r\n`); });

    client.on('close', () => {
      if (intentional) return;
      const quick = (Date.now() - attemptStart) < 5000;
      if (!readyThisAttempt && quick) {
        emitData(id, '\r\n\x1b[31m[winux] could not connect (host/auth). Not retrying.\x1b[0m\r\n');
        send('ssh:ended', { id });
        return;
      }
      scheduleReconnect();
    });

    const cfg = {
      host: opts.host, port: opts.port || 22, username: opts.username,
      keepaliveInterval: 15000, keepaliveCountMax: 3, readyTimeout: 20000,
    };
    if (opts.keyPath && fs.existsSync(opts.keyPath)) {
      try { cfg.privateKey = fs.readFileSync(opts.keyPath); } catch (_) { /* ignore */ }
    }
    cfg.agent = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK;
    client.connect(cfg);
  }

  let reconnectTimer = null;
  function scheduleReconnect() {
    if (intentional || reconnecting) return;
    reconnecting = true;
    emitData(id, '\r\n\x1b[33m[winux] link dropped — reconnecting in 2s... (no password needed)\x1b[0m\r\n');
    reconnectTimer = setTimeout(() => {
      reconnecting = false;
      try { if (client) client.end(); } catch (_) { /* ignore */ }
      connect();
    }, 2000);
  }

  s.upload = (paths) => new Promise((resolve) => {
    if (!client) { resolve({ ok: false }); return; }
    client.sftp((err, sftp) => {
      if (err) { emitData(id, `\r\n\x1b[31m[winux] sftp error: ${err.message}\x1b[0m\r\n`); resolve({ ok: false }); return; }
      const destDir = s.cwd || '.';
      const done = [];
      let i = 0;
      const next = () => {
        if (i >= paths.length) {
          emitData(id, `\r\n\x1b[32m[winux] uploaded ${done.length} item(s) to ${destDir}\x1b[0m\r\n`);
          resolve({ ok: true, count: done.length, dir: destDir });
          return;
        }
        const local = paths[i++];
        const base = path.basename(local);
        const remote = (destDir.endsWith('/') ? destDir : destDir + '/') + base;
        let st;
        try { st = fs.statSync(local); } catch (e) { emitData(id, `\r\n\x1b[31m[winux] skip ${base}: ${e.message}\x1b[0m\r\n`); next(); return; }
        if (st.isDirectory()) { emitData(id, `\r\n\x1b[33m[winux] skipping folder (files only for now): ${base}\x1b[0m\r\n`); next(); return; }
        emitData(id, `\r\n\x1b[36m[winux] uploading ${base} → ${remote}\x1b[0m\r\n`);
        sftp.fastPut(local, remote, (e) => {
          if (e) emitData(id, `\r\n\x1b[31m[winux] upload failed ${base}: ${e.message}\x1b[0m\r\n`);
          else done.push(base);
          next();
        });
      };
      next();
    });
  });

  sessions.set(id, s);
  connect();
  return s;
}

// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 660, backgroundColor: '#1e1e2e', title: 'winux',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.on('did-finish-load', () => {
    createLocalSession();
    setActive('local');
  });

  ipcMain.on('term:input', (_e, d) => { const s = sessions.get(activeId); if (s) s.write(d); });
  ipcMain.on('term:resize', (_e, { cols, rows }) => {
    lastCols = cols; lastRows = rows;
    const s = sessions.get(activeId); if (s) s.resize(cols, rows);
  });
  ipcMain.on('ssh:connect', (_e, opts) => {
    createSshSession({ host: opts.host, port: opts.port || 22, username: opts.username, keyPath: DEFAULT_KEY });
  });
  ipcMain.on('ssh:disconnect', () => {
    const s = sessions.get(activeId);
    if (s && s.type === 'ssh') { s.kill(); sessions.delete(s.id); setActive('local'); }
  });
  ipcMain.handle('ssh:upload', async (_e, { paths }) => {
    const s = sessions.get(activeId);
    if (s && s.type === 'ssh' && s.upload) return s.upload(paths);
    return { ok: false, reason: 'not-ssh' };
  });

  win.on('closed', () => { for (const s of sessions.values()) s.kill(); sessions.clear(); win = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
