// What the e2e drivers need to know about the shell under the tab, per
// platform: on Windows the app runs PowerShell, on macOS/Linux the login shell
// (pinned to LIMPET_SHELL by the tests: zsh on the macOS runner, bash on
// Linux). Every command the tests type, every prompt they wait for and every
// stand-in agent they start comes from here, so the drivers themselves carry
// no shell-specific text.
const fs = require('fs');
const path = require('path');
const os = require('os');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const shell = isWin ? 'powershell.exe' : (process.env.LIMPET_SHELL || (isMac ? '/bin/zsh' : '/bin/bash'));

// POSIX single-quote a string for a command line typed into sh/bash/zsh.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Each driver gets a scratch home/profile by default. Never discover real
// accounts, mutate real shell history, or restore a user's saved workspace.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'limpet-e2e-'));
const testHome = path.join(testRoot, 'home');
const userData = path.join(testRoot, 'userData');
for (const dir of [testHome, userData, path.join(testHome, 'AppData', 'Roaming'), path.join(testHome, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
function launchArgs(appDir) {
  return [appDir, `--user-data-dir=${userData}`];
}
function launchEnv(extra = {}) {
  const env = {
    ...process.env, HOME: testHome, USERPROFILE: testHome, ZDOTDIR: testHome,
    APPDATA: path.join(testHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(testHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(testHome, '.config'), XDG_DATA_HOME: path.join(testHome, '.local', 'share'),
    LIMPET_CLAUDE_HOME: testHome, LIMPET_DISABLE_BACKDROPS: '1',
    CLAUDE_CONFIG_DIR: path.join(testHome, '.claude'), CODEX_HOME: path.join(testHome, '.codex'),
    ...extra,
  };
  if (!isWin) env.LIMPET_SHELL = shell;
  return env;
}
async function closeApp(app) {
  // This is teardown only. Actual close/cancel behaviour is covered separately.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
  await app.close();
}
function cleanup() { fs.rmSync(testRoot, { recursive: true, force: true }); }

const win = {
  isWin, isMac, shell,
  // A prompt is on screen (anywhere in the visible text).
  promptRe: /PS [A-Z]:/,
  // The visible text ends with a prompt (the shell is idle).
  promptEndRe: /PS [A-Z]:\\[^\n]*>\s*$/,
  // The screen holds nothing but a prompt (after a clear).
  promptOnly: (t) => /^PS [A-Z]:[^\n]*>$/.test(t.trim()),
  echo: (text) => `Write-Output ${text}`,
  echoQuoted: (text) => `Write-Output '${text.replace(/'/g, "''")}'`,
  sleep: (seconds) => `Start-Sleep -Seconds ${seconds}`,
  clear: 'Clear-Host',
  shellPid: 'Write-Output "SHELLPID_$PID"',
  // Set a shell variable and say so; then a line that prints `yes` if it is
  // still set (the same shell) or `no` (a new one).
  setVar: (name, value, ready) => `$global:${name} = '${value}'; Write-Output ${ready}`,
  testVar: (name, value, yes, no) => `if ($global:${name} -eq '${value}') { Write-Output ${yes} } else { Write-Output ${no} }`,
  // Set the window title (OSC 2), hold it for a moment, then say so.
  setTitle: (title, ready) => `[Console]::Write([char]27); [Console]::Write(']2;${title}'); [Console]::Write([char]7); Start-Sleep -Milliseconds 1500; Write-Output ${ready}`,
  // A streamed download over the private OSC channel: header, one chunk, finish.
  // `token` is `true` for the app's own token, else a literal (bad) one.
  rawDownload: (name64, data64, token) => {
    const E = '$([char]27)'; const B = '$([char]7)';
    const tok = token === true ? '" + $env:LIMPET_TOKEN + "' : token;
    return `Write-Host -NoNewline ("${E}]5379;dl;h;${name64};file;${tok}${B}${E}]5379;dl;d;${data64}${B}${E}]5379;dl;f${B}")`;
  },
  // Keys: the settings page and copy/paste.
  openSettingsKey: 'Control+Comma',
  copyKey: 'Control+c',
  pasteKeys: ['Control+v', 'Control+Shift+v'],
  symlinkType: 'junction',
  // Stand-in agents: a copy of the shell under the agent's name, run so the
  // process tree looks like the real agent under the tab's shell.
  standIn: {
    exe: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    name: (kind) => `${kind}.exe`,
    // Typed into the tab: prints SESSPID_<pid>, holds `lock` open (as Codex
    // holds its thread, agy its conversation) and drops Copilot's in-use mark
    // in `markDir`, then sleeps.
    run: (exe, lock = '', markDir = '') => {
      const hold = lock ? `$l=[IO.File]::Open(''${lock}'',''OpenOrCreate'',''ReadWrite'',''None''); ` : '';
      const mark = markDir ? `Set-Content -LiteralPath (Join-Path ''${markDir}'' (''inuse.'' + $PID + ''.lock'')) -Value $PID; ` : '';
      return `& '${exe}' -NoProfile -Command '${hold}${mark}Write-Output SESSPID_$PID; Start-Sleep 120'`;
    },
    // A detached process (another tab's agent) holding `lock` open.
    holdLock: (lock) => require('child_process').spawn('powershell.exe', ['-NoProfile', '-Command',
      `$l=[IO.File]::Open('${lock}','OpenOrCreate','ReadWrite','None'); Start-Sleep 120`], { windowsHide: true }),
  },
  // The stand-in for the backdrop setup script, installing into a scratch
  // folder: the first run fails, the second hangs mid-download (to be
  // cancelled), the third finishes. Returns its path.
  fakeSetup: (home) => {
    const file = path.join(home, 'fake-setup.ps1');
    fs.writeFileSync(file, [
      'param([switch]$Force, [string]$LocalRoot)',
      '$ErrorActionPreference = "Stop"',
      '$home_ = Split-Path $LocalRoot',
      '$runs = Join-Path $home_ "setup-runs"',
      '$n = 1 + [int](Get-Content $runs -ErrorAction SilentlyContinue)',
      'Set-Content $runs $n',
      'Set-Content (Join-Path $home_ "setup-pid") $PID',
      'if ($n -eq 1) { $host.UI.WriteErrorLine("Simulated: no network"); exit 1 }',
      'New-Item -ItemType Directory -Force (Join-Path $LocalRoot "bin"), (Join-Path $LocalRoot "models") | Out-Null',
      'Set-Content (Join-Path $LocalRoot "bin\\sd-cli.exe") "stand-in"',
      '$model = Join-Path $LocalRoot "models\\sdxs-512-tinySDdistilled_Q8_0.gguf"',
      '[IO.File]::WriteAllBytes("$model.partial", (New-Object byte[] 3145728))',
      'Start-Sleep -Seconds $(if ($n -eq 2) { 120 } else { 2 })',
      'Move-Item "$model.partial" $model -Force',
    ].join('\r\n'));
    return file;
  },
};

const unix = {
  isWin, isMac, shell,
  // zsh ends its default prompt with %, bash with $ (# as root).
  promptRe: /[%$#][ \t]*$/m,
  promptEndRe: /[%$#][ \t]*$/,
  promptOnly: (t) => { const lines = t.trim().split('\n'); return lines.length === 1 && /[%$#]\s*$/.test(lines[0]); },
  echo: (text) => `echo ${text}`,
  echoQuoted: (text) => `echo ${q(text)}`,
  sleep: (seconds) => `sleep ${seconds}`,
  clear: 'clear',
  shellPid: 'echo "SHELLPID_$$"',
  setVar: (name, value, ready) => `${name}='${value}'; echo ${ready}`,
  testVar: (name, value, yes, no) => `if [ "$${name}" = '${value}' ]; then echo ${yes}; else echo ${no}; fi`,
  setTitle: (title, ready) => `printf '\\033]2;%s\\007' ${q(title)}; sleep 1.5; echo ${ready}`,
  rawDownload: (name64, data64, token) => {
    const tok = token === true ? '"$LIMPET_TOKEN"' : q(token);
    return `printf '\\033]5379;dl;h;%s;file;%s\\007\\033]5379;dl;d;%s\\007\\033]5379;dl;f\\007' ${q(name64)} ${tok} ${q(data64)}`;
  },
  openSettingsKey: isMac ? 'Meta+Comma' : 'Control+Comma',
  copyKey: isMac ? 'Meta+c' : 'Control+c',
  pasteKeys: isMac ? ['Meta+v', 'Control+Shift+v'] : ['Control+v', 'Control+Shift+v'],
  symlinkType: 'dir',
  standIn: {
    exe: '/bin/sh',
    name: (kind) => kind,
    // The lock and mark dir travel as $1 and $2 (quoted once, by the outer
    // shell) rather than being spliced into the -c script.
    run: (exe, lock = '', markDir = '') => {
      const hold = lock ? 'exec 3<>"$1"; ' : '';
      const mark = markDir ? 'echo $$ > "$2/inuse.$$.lock"; ' : '';
      return `${q(exe)} -c '${hold}${mark}echo SESSPID_$$; sleep 120' sh ${q(lock)} ${q(markDir)}`;
    },
    holdLock: (lock) => require('child_process').spawn('/bin/sh', ['-c', `exec 3<>${q(lock)}; sleep 120`], { stdio: 'ignore' }),
  },
  fakeSetup: (home) => {
    const file = path.join(home, 'fake-setup.sh');
    fs.writeFileSync(file, [
      '#!/bin/bash',
      'localRoot=""',
      'while [ $# -gt 0 ]; do case "$1" in --local-root|-LocalRoot) shift; localRoot=$1;; esac; shift; done',
      'home_=$(dirname "$localRoot"); runs="$home_/setup-runs"',
      'n=$(( $(cat "$runs" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$runs"',
      'echo $$ > "$home_/setup-pid"',
      'if [ "$n" = 1 ]; then echo "Simulated: no network" >&2; exit 1; fi',
      'mkdir -p "$localRoot/bin" "$localRoot/models"',
      'echo stand-in > "$localRoot/bin/sd-cli"; chmod +x "$localRoot/bin/sd-cli"',
      'model="$localRoot/models/sdxs-512-tinySDdistilled_Q8_0.gguf"',
      'dd if=/dev/zero of="$model.partial" bs=1048576 count=3 2>/dev/null',
      'if [ "$n" = 2 ]; then sleep 120; else sleep 2; fi',
      'mv -f "$model.partial" "$model"',
    ].join('\n') + '\n', { mode: 0o755 });
    return file;
  },
};

module.exports = { ...(isWin ? win : unix), launchArgs, launchEnv, closeApp, cleanup, testHome, userData, q };
