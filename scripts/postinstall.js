#!/usr/bin/env node
// scripts/postinstall.js: auto-link the roostr CLI binary into ~/.local/bin
// Runs during `herdr plugin install` via the [[build]] manifest hook.

const fs = require('fs');
const path = require('path');
const os = require('os');

function main() {
  const pluginRoot = process.cwd();
  const binSrc = path.join(pluginRoot, 'bin', 'roostr');
  if (!fs.existsSync(binSrc)) return;

  try {
    fs.chmodSync(binSrc, 0o755);
  } catch (e) {}

  const home = os.homedir();
  const targets = [
    path.join(home, '.local', 'bin'),
    '/usr/local/bin',
  ];

  let linked = false;
  for (const dir of targets) {
    try {
      if (!fs.existsSync(dir)) {
        if (dir === '/usr/local/bin') continue;
        fs.mkdirSync(dir, { recursive: true });
      }
      for (const name of ['roostr', 'crew-board']) {
        const dest = path.join(dir, name);
        try {
          const st = fs.lstatSync(dest);
          if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(dest);
        } catch (e) {}
        fs.symlinkSync(binSrc, dest);
      }
      linked = true;
    } catch (e) {}
  }

  if (linked) {
    process.stdout.write('🐓 roostr: linked CLI to ~/.local/bin/roostr\n');
  }
}

main();
