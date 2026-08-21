#!/usr/bin/env node
/**
 * node-pty's prebuilt darwin/linux binaries have shipped without the
 * executable bit on `spawn-helper` before (npm packing/unpacking can drop
 * it) — pty.spawn() then fails at runtime with "Error: posix_spawnp failed"
 * instead of a clear permission error. Windows prebuilds don't ship a
 * spawn-helper at all (conpty.node handles it), so this is a no-op there.
 */
const fs = require('fs');
const path = require('path');

if (process.platform === 'win32') process.exit(0);

const prebuildsDir = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
if (!fs.existsSync(prebuildsDir)) process.exit(0);

for (const entry of fs.readdirSync(prebuildsDir)) {
  const helperPath = path.join(prebuildsDir, entry, 'spawn-helper');
  if (fs.existsSync(helperPath)) {
    fs.chmodSync(helperPath, 0o755);
    console.log(`[fix-node-pty-permissions] chmod +x ${path.relative(process.cwd(), helperPath)}`);
  }
}
