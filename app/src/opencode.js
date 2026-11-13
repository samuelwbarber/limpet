const { execFile } = require('child_process');

// Use the public OpenCode 1.x exporter. Never read a private session database.
function exportOpenCodeSession(id, { run = execFile, platform = process.platform } = {}) {
  if (!/^ses_[a-zA-Z0-9_-]+$/.test(String(id))) return Promise.reject(new Error('Invalid OpenCode session id.'));
  const file = platform === 'win32' ? 'powershell.exe' : 'opencode';
  const args = platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', '& opencode export $env:LIMPET_OC_SESSION; exit $LASTEXITCODE']
    : ['export', id];
  return new Promise((resolve, reject) => {
    run(file, args, { windowsHide: true, timeout: 30000, maxBuffer: 30 * 1024 * 1024,
      encoding: 'utf8', env: { ...process.env, LIMPET_OC_SESSION: id } }, (error, stdout) => {
      if (error) return reject(new Error('Could not export the OpenCode conversation. Check that OpenCode supports `export <sessionID>` and the session exists.'));
      try {
        const data = JSON.parse(stdout);
        if (!data || !Array.isArray(data.messages)) throw new Error('Missing messages');
        if (!data.info || data.info.id !== id) throw new Error('Missing or wrong session identity');
        resolve(stdout);
      } catch (_) { reject(new Error('OpenCode returned an invalid conversation export.')); }
    });
  });
}
module.exports = { exportOpenCodeSession };
