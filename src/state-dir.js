'use strict';
// Canonical ~/.roostr/ state directory and idempotent migration from legacy ~/.crew-board/.
// Zero external dependencies; respects ROOSTR_*, CREW_BOARD_*, and HOME overrides.

const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_FILES = [
  'config.json',
  'sessions.json',
  'sessions.json.bak',
  'daemon-state.json',
  'daemon-state.json.bak',
  'escalations.json',
  'escalations.json.bak',
  'names.json',
  'operator-hold.json',
  'operator-hold.json.bak',
  'orchestration.jsonl',
  'transitions.jsonl',
  'summary.json',
  'summary.json.bak',
  'usage.jsonl',
  'models.json',
  'prices.json',
];

const RUNTIME_DIRS = [
  'backups',
  'state',
];

function roostrDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.roostr');
}

function legacyDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.crew-board');
}

function copyMissingFile(src, dst) {
  if (!fs.existsSync(src) || fs.existsSync(dst)) return false;
  const st = fs.statSync(src);
  if (!st.isFile()) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, dst);
  try {
    fs.chmodSync(dst, 0o600);
  } catch {
    // Non-POSIX filesystems can ignore chmod.
  }
  return true;
}

function copyMissingDir(src, dst) {
  if (!fs.existsSync(src)) return 0;
  let st;
  try {
    st = fs.statSync(src);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return 0;
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  let copied = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copied += copyMissingDir(s, d);
    } else if (entry.isFile()) {
      if (copyMissingFile(s, d)) copied++;
    }
  }
  return copied;
}

// Safely migrate missing runtime files and dirs from ~/.crew-board/ to ~/.roostr/.
// Never overwrites existing files in ~/.roostr/.
function migrateLegacyDir(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const roostr = roostrDir(homeDir);
  const legacy = legacyDir(homeDir);
  const migrated = [];
  if (!fs.existsSync(legacy)) return { roostr, legacy, migrated };

  try {
    fs.mkdirSync(roostr, { recursive: true, mode: 0o700 });
  } catch {
    return { roostr, legacy, migrated };
  }

  for (const rel of RUNTIME_FILES) {
    try {
      if (copyMissingFile(path.join(legacy, rel), path.join(roostr, rel))) {
        migrated.push(rel);
      }
    } catch {
      // Best-effort migration; never crash caller.
    }
  }
  for (const rel of RUNTIME_DIRS) {
    try {
      const count = copyMissingDir(path.join(legacy, rel), path.join(roostr, rel));
      if (count > 0) migrated.push(rel);
    } catch {
      // Best-effort migration; never crash caller.
    }
  }
  return { roostr, legacy, migrated };
}

// Resolve a canonical path under ~/.roostr/, migrating from ~/.crew-board/ if needed.
// Explicit env overrides are checked first so tests stay isolated.
function resolvePath(relPath, envNames = [], options = {}) {
  for (const name of envNames) {
    const val = process.env[name];
    if (val) return val;
  }
  if (options.dirEnvNames) {
    for (const name of options.dirEnvNames) {
      const dirVal = process.env[name];
      if (dirVal) return path.join(dirVal, relPath);
    }
  }
  const homeDir = options.homeDir || os.homedir();
  migrateLegacyDir({ homeDir });
  return path.join(roostrDir(homeDir), relPath);
}

module.exports = {
  RUNTIME_FILES,
  RUNTIME_DIRS,
  roostrDir,
  legacyDir,
  migrateLegacyDir,
  resolvePath,
};
