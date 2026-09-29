// Drag-and-drop of folders and big files into an xssh session. Small files are
// "pasted" through the live shell (see injectFiles in main.js); anything that
// can't be (a folder, or a file over the paste limit) is copied with scp
// instead, straight to the directory the remote prompt is sitting in. That
// takes two facts the terminal stream alone doesn't carry, so limpet's own
// helpers report them over the tokened OSC 5379 channel:
//   xssh;<b64 target>;<port>;<token>   xssh is connecting to target (port may be '')
//   xssh;;;<token>                      that ssh has ended
//   cwd;<b64 dir>;<depth>;<token>       a remote prompt: its $PWD and hop depth
// depth is 0 on the host xssh connected to and counts up per remote `xssh`
// hop. scp can only reach the first host, so a deeper prompt disables it.
// Pure helpers (no Electron) plus runScp; unit tested by tests/remote-copy.test.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Swappable so tests can stand in for scp without a real one on PATH.
const io = { spawn };

const b64dec = (s) => Buffer.from(s || '', 'base64').toString('utf8');

// Characters a remote path must not contain. Windows 10's scp (OpenSSH 8.x)
// still uses the legacy protocol, which hands the destination to the remote
// shell unquoted: whitespace, quotes and shell/glob metacharacters would be
// split or expanded there. Rather than guess the scp version, refuse them.
const UNSAFE_REMOTE_PATH = /[\s'"`$\\;&|<>()*?[\]{}!#\x00-\x1f\x7f]/;
const UNSAFE_TARGET = /[\s'"`$\\;&|<>()*?[\]{}!#\x00-\x1f\x7f/]/;

// `xssh;<b64 target>;<port>;<token>` fields (after the verb). Returns
// { target, port } for a connect, null for a disconnect, or { error } when the
// fields don't describe something scp could safely be pointed at.
function parseXssh(fields) {
  const target = b64dec(fields[0]).trim();
  const port = String(fields[1] || '').trim();
  if (!target) return null;
  if (target.startsWith('-') || UNSAFE_TARGET.test(target)) return { error: `unusable host ${JSON.stringify(target)}` };
  if (port && !(/^\d{1,5}$/.test(port) && +port >= 1 && +port <= 65535)) return { error: `bad port ${JSON.stringify(port)}` };
  return { target, port };
}

// `cwd;<b64 dir>;<depth>;<token>` fields (after the verb) -> { cwd, depth }, or
// null if malformed. The dir is kept as-is; planDrop decides whether scp can
// use it (a refusal should name the directory, so don't drop it here).
function parseCwd(fields) {
  const cwd = b64dec(fields[0]);
  const depth = /^\d{1,3}$/.test(String(fields[1] || '')) ? parseInt(fields[1], 10) : NaN;
  if (!cwd || Number.isNaN(depth)) return null;
  return { cwd, depth };
}

// Split dropped items into the ones pasted through the shell and the ones that
// need scp. entries: [{ path, isDir, size }].
function splitDrop(entries, maxPasteBytes) {
  const paste = [];
  const copy = [];
  for (const e of entries) (e.isDir || e.size > maxPasteBytes ? copy : paste).push(e.path);
  return { paste, copy };
}

// Can the items that need scp go to this tab's remote prompt? Returns
// { ok: true, target, port, dir } or { ok: false, reason } with a sentence
// the user sees. remote = sess.remote ({ target, port } from xssh), cwd =
// sess.remoteCwd ({ cwd, depth } from the last prompt).
function planDrop(remote, cwd) {
  if (!remote) return { ok: false, reason: "this tab isn't in an xssh session limpet knows about" };
  if (remote.error) return { ok: false, reason: `the xssh destination can't be used with scp (${remote.error})` };
  if (!cwd) return { ok: false, reason: `the remote directory on ${remote.target} isn't known yet (no prompt reported one; xssh -Raw and plain sh don't)` };
  if (cwd.depth !== 0) return { ok: false, reason: `the prompt is ${cwd.depth} xssh hop(s) past ${remote.target}, which scp can't reach directly` };
  const dir = cwd.cwd;
  if (!dir.startsWith('/') || UNSAFE_REMOTE_PATH.test(dir)) {
    return { ok: false, reason: `the remote directory ${JSON.stringify(dir)} has characters scp would mangle` };
  }
  return { ok: true, target: remote.target, port: remote.port, dir };
}

// wput's default key, used only when it exists (ssh-agent/config cover the rest).
function defaultKey(home = os.homedir(), exists = fs.existsSync) {
  const key = path.join(home, '.ssh', 'id_ed25519');
  return exists(key) ? key : null;
}

// The scp argv (never a shell string): recursive, non-interactive (BatchMode:
// a password/passphrase prompt would hang with nobody to answer it), into
// target:dir/ -- the trailing slash makes scp fail rather than rename a single
// item if dir isn't a directory.
function buildScpArgs({ paths, target, port, dir, key }) {
  const args = ['-r', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
  if (port) args.push('-P', String(port));
  if (key) args.push('-i', key);
  args.push('--', ...paths, `${target}:${dir.endsWith('/') ? dir : `${dir}/`}`);
  return args;
}

// One line for a failed scp. Auth failures get pointed at wput, which runs in
// the shell and so can prompt for a password or passphrase.
function describeScpFailure(code, stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || `scp exited ${code}`;
  if (/permission denied|host key verification failed|too many authentication failures|no supported authentication/i.test(stderr || '')) {
    return `${last} -- scp can't prompt here; use wput, which can ask for a password`;
  }
  return last;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Run scp without touching the PTY. say(color, text) prints a status line;
// resolves true on success. A missing scp (ENOENT) is reported, not thrown.
function runScp({ paths, target, port, dir, key }, say) {
  const where = `${target}:${dir}`;
  say(36, `copying ${paths.length === 1 ? path.basename(paths[0]) : plural(paths.length, 'item')} to ${where} over scp…`);
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    let stderr = '';
    let settled = false;
    const finish = (ok, color, text) => {
      if (settled) return;
      settled = true;
      say(color, text);
      resolve(ok);
    };
    try {
      child = io.spawn('scp', buildScpArgs({ paths, target, port, dir, key }), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      finish(false, 31, `scp failed to start: ${e.message}`);
      return;
    }
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4096); });
    child.on('error', (e) => finish(false, 31, e.code === 'ENOENT'
      ? 'scp not found (install the Windows OpenSSH client), or use wput'
      : `scp failed: ${e.message}`));
    child.on('close', (code) => {
      if (code === 0) finish(true, 32, `done: ${plural(paths.length, 'item')} in ${where} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      else finish(false, 31, `copy to ${where} failed: ${describeScpFailure(code, stderr)}`);
    });
  });
}

module.exports = {
  io, parseXssh, parseCwd, splitDrop, planDrop, defaultKey, buildScpArgs, describeScpFailure, runScp,
};
