// What differs between Windows and macOS/Linux, in one place: which shell a
// tab runs and how limpet's integration gets into it, how to list processes
// and find who holds a file open, how to kill a process tree, how to quote a
// line typed into the shell, where the local image generator lives, and where
// Claude Code keeps its login on macOS (the Keychain). Everything that can be
// is a pure function (the parsers), unit tested in tests/platform.test.js. No
// Electron in here: main.js hands in what it knows (the shell folder, the
// token).

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = !isWindows && !isMac;

// ---- the tab's shell -------------------------------------------------------

// The user's login shell: LIMPET_SHELL (tests), $SHELL, the account database,
// else zsh (macOS's default) or sh.
function defaultShell(env = process.env) {
  if (env.LIMPET_SHELL) return env.LIMPET_SHELL;
  if (env.SHELL) return env.SHELL;
  try {
    if (isMac) {
      const out = execFileSync('dscl', ['.', '-read', `/Users/${os.userInfo().username}`, 'UserShell'], { encoding: 'utf8', timeout: 3000 });
      const m = /UserShell:\s*(\S+)/.exec(out);
      if (m) return m[1];
    } else {
      const out = execFileSync('getent', ['passwd', os.userInfo().username], { encoding: 'utf8', timeout: 3000 });
      const sh = out.trim().split(':')[6];
      if (sh) return sh;
    }
  } catch (_) { /* fall through */ }
  return fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh';
}

let warnedShell = '';

// How to start the shell for a tab: { file, args, env, cwd }. On Windows it is
// PowerShell with the Limpet module imported. On macOS/Linux it is the user's
// login shell as an interactive login shell with limpet's integration loaded
// without touching their dotfiles: zsh through ZDOTDIR (shell/rc/zsh/.zshrc
// sources the user's own files, then limpet.sh), bash through --rcfile. Any
// other shell runs plain; the integration is just absent there.
function shellSpawn({ shellDir, token, env = process.env }) {
  const base = { ...env, LIMPET_TOKEN: token };
  if (isWindows) {
    return {
      file: 'powershell.exe',
      args: ['-NoExit', '-NoLogo', '-Command', `Import-Module "${path.join(shellDir, 'Limpet.psd1')}"`],
      env: base,
      cwd: env.USERPROFILE || os.homedir(),
    };
  }
  const file = defaultShell(env);
  const name = path.basename(file);
  const common = { ...base, LIMPET_SHELL_DIR: shellDir };
  if (!common.TERM) common.TERM = 'xterm-256color';
  if (!common.LANG && !common.LC_ALL) common.LANG = 'en_US.UTF-8';
  if (name === 'zsh') {
    return {
      file,
      args: ['-il'],
      env: { ...common, LIMPET_USER_ZDOTDIR: env.ZDOTDIR || os.homedir(), ZDOTDIR: path.join(shellDir, 'rc', 'zsh') },
      cwd: os.homedir(),
    };
  }
  if (name === 'bash') {
    return { file, args: ['--rcfile', path.join(shellDir, 'rc', 'bash', 'limpet-rc.bash'), '-i'], env: common, cwd: os.homedir() };
  }
  if (warnedShell !== file) {
    warnedShell = file;
    console.error(`[limpet] ${name} is not zsh or bash: the tab runs it plain, without limpet's shell commands`);
  }
  return { file, args: ['-il'], env: common, cwd: os.homedir() };
}

// node-pty on macOS/Linux forks through a small `spawn-helper` binary beside
// its prebuilt module. npm's prebuild download doesn't always keep that file
// executable, and then every pty spawn fails with "posix_spawnp failed" and
// the app would silently fall back to pipes. Set the bit on the helpers under
// `ptyDir` (the node-pty package folder) before the first spawn. A signed app
// bundle must not be modified, so the caller only does this unpackaged; the
// build does the same before packaging.
function fixSpawnHelpers(ptyDir) {
  if (isWindows) return [];
  const fixed = [];
  const candidates = [path.join(ptyDir, 'build', 'Release', 'spawn-helper')];
  try {
    for (const d of fs.readdirSync(path.join(ptyDir, 'prebuilds'))) candidates.push(path.join(ptyDir, 'prebuilds', d, 'spawn-helper'));
  } catch (_) { /* no prebuilds folder */ }
  for (const file of candidates) {
    try {
      const st = fs.statSync(file);
      if ((st.mode & 0o111) !== 0o111) { fs.chmodSync(file, st.mode | 0o755); fixed.push(file); }
    } catch (_) { /* not there */ }
  }
  return fixed;
}

// ---- processes -------------------------------------------------------------

// ps's etime ([[dd-]hh:]mm:ss) in milliseconds.
function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return NaN;
  const [, d, h, min, sec] = m;
  return (((Number(d || 0) * 24 + Number(h || 0)) * 60 + Number(min)) * 60 + Number(sec)) * 1000;
}

// `ps -axo pid=,ppid=,etime=,args=` output -> [{ pid, ppid, name, args, startedAt }].
// name is the basename of argv[0] (a login shell's leading '-' dropped), args
// the whole command line; startedAt = now - elapsed, to the second.
function parsePs(text, now = Date.now()) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const elapsed = parseEtime(m[3]);
    const args = m[4].trim();
    const first = args.split(/\s+/)[0] || '';
    const name = path.posix.basename(first).replace(/^-/, '');
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), name, args, startedAt: Number.isNaN(elapsed) ? 0 : now - elapsed });
  }
  return out;
}

function run(file, args, { timeoutMs = 15000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try { child = spawn(file, args, { windowsHide: true, env }); } catch (_) { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* gone */ } finish(null); }, timeoutMs);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.resume();
    child.on('error', () => finish(null));
    child.on('close', () => finish(out));
  });
}

// pid, parent pid, name, command line and start time of every process.
async function listProcesses() {
  if (isWindows) return require('./agent-scan').listProcessesWindows();
  const out = await run('ps', ['-axo', 'pid=,ppid=,etime=,args=']);
  return out ? parsePs(out) : [];
}

// `lsof -F pn` output -> { path: [pid, ...] } for the paths asked about.
function parseLsof(text, paths) {
  const holders = {};
  for (const p of paths) holders[p] = [];
  let pid = null;
  for (const line of String(text).split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid !== null) {
      const name = line.slice(1);
      if (holders[name] && !holders[name].includes(pid)) holders[name].push(pid);
    }
  }
  return holders;
}

// Which pids hold each of these files open, or null if that can't be found out.
async function fileHolders(paths) {
  if (!paths.length) return {};
  if (isWindows) return require('./agent-scan').fileHoldersWindows(paths);
  const out = await run('lsof', ['-n', '-P', '-F', 'pn', '--', ...paths], { timeoutMs: 20000 });
  // lsof exits 1 when some file has no holder, with the rest still listed;
  // only a missing lsof (null) means we don't know.
  return out === null ? null : parseLsof(out, paths);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Kill a process and everything under it.
async function killTree(pid) {
  if (isWindows) {
    try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch (_) { /* ignore */ }
    return;
  }
  const procs = await listProcesses();
  const { descendants } = require('./accounts');
  const targets = [pid, ...descendants(procs, pid)];
  const signal = (sig) => { for (const p of targets) { try { process.kill(p, sig); } catch (_) { /* gone */ } } };
  signal('SIGTERM');
  for (let i = 0; i < 10 && targets.some(alive); i++) await sleep(100);
  if (targets.some(alive)) signal('SIGKILL');
}

// ---- quoting ---------------------------------------------------------------

// A PowerShell single-quoted literal: only the quote itself needs escaping and
// nothing inside is interpolated. PowerShell also reads U+2018..U+201B as
// single quotes; doubling escapes those.
function psQuote(s) {
  return `'${String(s).replace(/['‘-‛]/g, '$&$&')}'`;
}

// A POSIX single-quoted literal: nothing inside is interpolated; a quote is
// closed, escaped and reopened.
function posixQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const shellKind = isWindows ? 'powershell' : 'posix';
const shellQuote = (s) => (isWindows ? psQuote(s) : posixQuote(s));

// ---- the local image generator --------------------------------------------

const backdrop = {
  exeName: isWindows ? 'sd-cli.exe' : 'sd-cli',
  setupScriptName: isWindows ? 'setup-local-backdrop.ps1' : 'setup-local-backdrop.sh',
  // The pinned stable-diffusion.cpp release has Windows x64, macOS arm64 and
  // Linux x86_64 builds, nothing for Intel Macs or Linux arm64.
  unsupported: isMac && process.arch !== 'arm64' ? 'the local image model has no build for Intel Macs'
    : isLinux && process.arch !== 'x64' ? `the local image model has no build for Linux ${process.arch}` : '',
  setupCommand(script, localRoot) {
    if (isWindows) {
      return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-LocalRoot', localRoot] };
    }
    return { file: 'bash', args: [script, '--local-root', localRoot] };
  },
};

const codexAppServerCommand = isWindows
  ? { file: 'cmd.exe', args: ['/c', 'codex', 'app-server'] }
  : { file: 'codex', args: ['app-server'] };

// ---- Claude Code's login on macOS -----------------------------------------
// Claude Code keeps its OAuth login in the login Keychain as a generic
// password: service "Claude Code-credentials" for ~/.claude, and
// "Claude Code-credentials-<h>" when CLAUDE_CONFIG_DIR is set, h being the
// first 8 hex chars of sha256 of that directory's path (NFC); account
// "claude-code-user". The password is the same JSON .credentials.json holds.

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_KEYCHAIN_ACCOUNT = 'claude-code-user';

function claudeKeychainService(configDir, plain) {
  if (plain) return CLAUDE_KEYCHAIN_SERVICE;
  const h = crypto.createHash('sha256').update(String(configDir).normalize('NFC')).digest('hex').slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${h}`;
}

const credCache = new Map(); // service -> { at, value }
const CRED_TTL_MS = 60 * 1000;

// The parsed credentials JSON for a config dir from the Keychain, or null.
// macOS only; elsewhere Claude writes .credentials.json, which accounts.js
// reads itself.
function readClaudeCredentials(configDir, { plain = false, now = Date.now(), exec = execFileSync } = {}) {
  if (!isMac) return null;
  const service = claudeKeychainService(configDir, plain);
  const hit = credCache.get(service);
  if (hit && now - hit.at < CRED_TTL_MS) return hit.value;
  let value = null;
  try {
    const out = exec('security', ['find-generic-password', '-a', CLAUDE_KEYCHAIN_ACCOUNT, '-w', '-s', service], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    value = JSON.parse(String(out).trim());
  } catch (_) { value = null; }
  credCache.set(service, { at: now, value });
  return value;
}

module.exports = {
  isWindows, isMac, isLinux,
  defaultShell, shellSpawn, fixSpawnHelpers,
  parseEtime, parsePs, listProcesses, parseLsof, fileHolders, killTree,
  psQuote, posixQuote, shellQuote, shellKind,
  backdrop, codexAppServerCommand,
  CLAUDE_KEYCHAIN_SERVICE, CLAUDE_KEYCHAIN_ACCOUNT, claudeKeychainService, readClaudeCredentials,
};
