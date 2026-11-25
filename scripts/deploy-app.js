#!/usr/bin/env node
/**
 * Post-package deploy script.
 *
 * Replaces both Desktop and /Applications copies of Stock Tracker.app with
 * the freshly built bundle, re-signs them ad-hoc (so macOS doesn't reject
 * the broken signature that survives a cp -R), and clears any quarantine
 * attribute so the user can double-click straight away.
 *
 * Why both locations: the user can launch from either the Desktop icon or
 * Launchpad/Spotlight (which uses /Applications). Updating only one leaves
 * the other stale and causes "the changes didn't apply" confusion.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = path.resolve(__dirname, '..', 'out', 'Stock Tracker-darwin-arm64', 'Stock Tracker.app');
const TARGETS = [
  path.join(os.homedir(), 'Desktop', 'Stock Tracker.app'),
  '/Applications/Stock Tracker.app',
];

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

function safe(cmd) {
  try { execSync(cmd, { stdio: 'ignore' }); } catch { /* best-effort */ }
}

if (!fs.existsSync(SRC)) {
  // 跨平台打包（如 win32）的話 Mac .app 不會存在，這個 hook 沒事做，靜默跳過
  console.log('ℹ️  Mac build output not found, skipping macOS deploy (cross-platform build?)');
  process.exit(0);
}

// Kill any running instances so we can replace the bundles.
safe(`pkill -9 -f "Stock Tracker"`);

for (const target of TARGETS) {
  console.log(`→ Deploying to ${target}`);
  try {
    run(`rm -rf "${target}"`);
    run(`cp -R "${SRC}" "${target}"`);
    run(`codesign --force --deep --sign - "${target}"`);
    safe(`xattr -dr com.apple.quarantine "${target}"`);
    console.log(`  ✅ ${target}`);
  } catch (err) {
    console.warn(`  ⚠️  Failed to deploy to ${target}: ${err.message}`);
  }
}

console.log('✅ Deploy complete — open from Desktop or Launchpad');
