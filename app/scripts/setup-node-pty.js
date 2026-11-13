'use strict';

// Windows and macOS use the binaries shipped in node-pty. Linux has no
// prebuild in node-pty 1.1.0, so run its install hooks after the main install
// (which deliberately skips dependency scripts).
if (process.platform === 'linux') {
  const { spawnSync } = require('node:child_process');
  if (!process.env.npm_execpath) {
    console.error('Run this setup through npm run setup.');
    process.exitCode = 1;
  } else {
    const result = spawnSync(process.execPath, [
      process.env.npm_execpath, 'rebuild', 'node-pty', '--ignore-scripts=false',
      '--no-audit', '--no-fund',
    ], { stdio: 'inherit' });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status === null ? 1 : result.status;
  }
}
