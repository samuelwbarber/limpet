// Unit tests for src/platform.js: the pure parts (ps and lsof parsers, etime,
// quoting, the Keychain service name, how the tab's shell is started) run on
// every platform; the process-touching parts are exercised by the e2e.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const platform = require('../src/platform');

test('parseEtime reads ps elapsed times in every shape', () => {
  assert.strictEqual(platform.parseEtime('05:12'), (5 * 60 + 12) * 1000);
  assert.strictEqual(platform.parseEtime('01:02:03'), (3600 + 120 + 3) * 1000);
  assert.strictEqual(platform.parseEtime('2-00:00:10'), (2 * 86400 + 10) * 1000);
  assert.strictEqual(platform.parseEtime('   00:00'), 0);
  assert.ok(Number.isNaN(platform.parseEtime('garbage')));
});

test('parsePs turns macOS and Linux ps output into pid/ppid/name/args/startedAt rows', () => {
  const now = 1_000_000_000;
  const mac = [
    '    1     0 10-02:03:04 /sbin/launchd',
    '  512     1       03:00 /Applications/limpet.app/Contents/MacOS/limpet',
    '  600   512       02:30 -zsh',
    '  700   600       01:00 node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js resume abc',
    '  701   600       00:05 /opt/homebrew/bin/claude',
    '',
  ].join('\n');
  const rows = platform.parsePs(mac, now);
  assert.deepStrictEqual(rows.map((r) => [r.pid, r.ppid, r.name]), [[1, 0, 'launchd'], [512, 1, 'limpet'], [600, 512, 'zsh'], [700, 600, 'node'], [701, 600, 'claude']]);
  assert.strictEqual(rows[2].startedAt, now - 150 * 1000);
  assert.strictEqual(rows[0].startedAt, now - (10 * 86400 + 2 * 3600 + 3 * 60 + 4) * 1000);
  assert.strictEqual(rows[3].args, 'node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js resume abc');
  // Linux: the same columns, a login shell and a kernel thread in brackets.
  const linux = '      2       0 1-10:00:00 [kthreadd]\n   4000   3999      00:42 -bash\n   4100   4000      00:01 ps -axo pid=,ppid=,etime=,args=\n';
  assert.deepStrictEqual(platform.parsePs(linux, now).map((r) => [r.pid, r.ppid, r.name]), [[2, 0, '[kthreadd]'], [4000, 3999, 'bash'], [4100, 4000, 'ps']]);
  assert.deepStrictEqual(platform.parsePs('', now), []);
});

test('parseLsof maps each asked-about file to the pids holding it', () => {
  const a = '/Users/me/.codex/thread-writer-locks/a.lock';
  const b = '/Users/me/.gemini/antigravity-cli/conversations/b.db';
  const c = '/Users/me/nobody-has-this.lock';
  const out = ['p700', 'f3', `n${a}`, 'p900', 'f5', `n${b}`, 'f6', `n${a}`, ''].join('\n');
  assert.deepStrictEqual(platform.parseLsof(out, [a, b, c]), { [a]: [700, 900], [b]: [900], [c]: [] });
  assert.deepStrictEqual(platform.parseLsof('', [a]), { [a]: [] });
});

test('posixQuote and psQuote make literal single-quoted strings for their shell', () => {
  assert.strictEqual(platform.posixQuote("it's $HOME `x`"), "'it'\\''s $HOME `x`'");
  assert.strictEqual(platform.posixQuote('plain'), "'plain'");
  assert.strictEqual(platform.psQuote("a'b"), "'a''b'");
  assert.strictEqual(platform.psQuote('it\u2019s'), "'it\u2019\u2019s'");
  assert.strictEqual(platform.shellKind, process.platform === 'win32' ? 'powershell' : 'posix');
  assert.strictEqual(platform.shellQuote("x'y"), process.platform === 'win32' ? "'x''y'" : "'x'\\''y'");
});

test('claudeKeychainService is the plain service for ~/.claude and a hashed one per config dir', () => {
  assert.strictEqual(platform.claudeKeychainService('/Users/me/.claude', true), 'Claude Code-credentials');
  const scoped = platform.claudeKeychainService('/Users/me/.claude-3', false);
  assert.match(scoped, /^Claude Code-credentials-[0-9a-f]{8}$/);
  // sha256('/Users/me/.claude-3') starts with these 8 hex chars; the same path
  // in decomposed form (NFD) hashes the same, since the path is NFC-normalised.
  const { createHash } = require('crypto');
  assert.strictEqual(scoped, `Claude Code-credentials-${createHash('sha256').update('/Users/me/.claude-3').digest('hex').slice(0, 8)}`);
  assert.strictEqual(platform.claudeKeychainService('/Users/me/caf\u00e9/.claude-1', false), platform.claudeKeychainService('/Users/me/cafe\u0301/.claude-1', false));
  assert.strictEqual(platform.CLAUDE_KEYCHAIN_ACCOUNT, 'claude-code-user');
});

test('readClaudeCredentials asks the Keychain on macOS only, parses the JSON and caches a miss', () => {
  const calls = [];
  const exec = (file, args) => { calls.push([file, ...args]); return JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }); };
  const r = platform.readClaudeCredentials('/Users/me/.claude-9', { plain: false, exec, now: 1 });
  if (process.platform !== 'darwin') {
    assert.strictEqual(r, null);
    assert.deepStrictEqual(calls, []);
    return;
  }
  assert.deepStrictEqual(r, { claudeAiOauth: { accessToken: 'tok' } });
  assert.deepStrictEqual(calls, [['security', 'find-generic-password', '-a', 'claude-code-user', '-w', '-s', platform.claudeKeychainService('/Users/me/.claude-9', false)]]);
  const again = platform.readClaudeCredentials('/Users/me/.claude-9', { plain: false, exec, now: 2 });
  assert.deepStrictEqual(again, r);
  assert.strictEqual(calls.length, 1, 'cached for a minute');
  const fail = () => { throw new Error('not found'); };
  assert.strictEqual(platform.readClaudeCredentials('/Users/me/.claude-10', { plain: false, exec: fail, now: 1 }), null);
});

test('shellSpawn starts PowerShell with the module on Windows and the login shell with the rc files elsewhere', () => {
  const shellDir = path.join('res', 'shell');
  const win = platform.shellSpawn({ shellDir, token: 'tok', env: { PATH: 'x', USERPROFILE: 'C:\\u' } });
  const unix = platform.shellSpawn({ shellDir, token: 'tok', env: { PATH: 'x', SHELL: '/bin/zsh', HOME: '/Users/me' } });
  const bash = platform.shellSpawn({ shellDir, token: 'tok', env: { PATH: 'x', SHELL: '/usr/local/bin/bash', TERM: 'screen', LANG: 'fr_FR.UTF-8' } });
  const fish = platform.shellSpawn({ shellDir, token: 'tok', env: { PATH: 'x', LIMPET_SHELL: '/opt/fish', SHELL: '/bin/zsh' } });
  if (process.platform === 'win32') {
    assert.strictEqual(win.file, 'powershell.exe');
    assert.deepStrictEqual(win.args.slice(0, 3), ['-NoExit', '-NoLogo', '-Command']);
    assert.match(win.args[3], /Import-Module ".*Limpet\.psd1"/);
    assert.strictEqual(win.env.LIMPET_TOKEN, 'tok');
    assert.strictEqual(win.cwd, 'C:\\u');
    return;
  }
  assert.strictEqual(unix.file, '/bin/zsh');
  assert.deepStrictEqual(unix.args, ['-il']);
  assert.strictEqual(unix.env.ZDOTDIR, path.join(shellDir, 'rc', 'zsh'));
  assert.strictEqual(unix.env.LIMPET_USER_ZDOTDIR, os.homedir());
  assert.strictEqual(unix.env.LIMPET_SHELL_DIR, shellDir);
  assert.strictEqual(unix.env.LIMPET_TOKEN, 'tok');
  assert.strictEqual(unix.env.TERM, 'xterm-256color');
  assert.strictEqual(unix.env.LANG, 'en_US.UTF-8');
  assert.strictEqual(unix.cwd, os.homedir());
  assert.deepStrictEqual(bash.args, ['--rcfile', path.join(shellDir, 'rc', 'bash', 'limpet-rc.bash'), '-i']);
  assert.strictEqual(bash.env.TERM, 'screen');
  assert.strictEqual(bash.env.LANG, 'fr_FR.UTF-8');
  assert.strictEqual(bash.env.ZDOTDIR, undefined);
  assert.strictEqual(fish.file, '/opt/fish', 'LIMPET_SHELL wins');
  assert.deepStrictEqual(fish.args, ['-il']);
});

test('the generator and app-server commands follow the platform', () => {
  if (process.platform === 'win32') {
    assert.strictEqual(platform.backdrop.exeName, 'sd-cli.exe');
    assert.strictEqual(platform.backdrop.setupScriptName, 'setup-local-backdrop.ps1');
    assert.deepStrictEqual(platform.backdrop.setupCommand('s.ps1', 'D:\\ai'), { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 's.ps1', '-LocalRoot', 'D:\\ai'] });
    assert.deepStrictEqual(platform.codexAppServerCommand, { file: 'cmd.exe', args: ['/c', 'codex', 'app-server'] });
    assert.strictEqual(platform.backdrop.unsupported, '');
  } else {
    assert.strictEqual(platform.backdrop.exeName, 'sd-cli');
    assert.strictEqual(platform.backdrop.setupScriptName, 'setup-local-backdrop.sh');
    assert.deepStrictEqual(platform.backdrop.setupCommand('s.sh', '/ai'), { file: 'bash', args: ['s.sh', '--local-root', '/ai'] });
    assert.deepStrictEqual(platform.codexAppServerCommand, { file: 'codex', args: ['app-server'] });
    assert.strictEqual(typeof platform.backdrop.unsupported, 'string');
  }
});
