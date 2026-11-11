'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function readVersion(root = ROOT) {
  try {
    const text = fs.readFileSync(path.join(root, 'herdr-plugin.toml'), 'utf8');
    const m = /^version\s*=\s*"([^"]+)"/m.exec(text);
    return m ? m[1] : '0.0.0';
  } catch (e) {
    return '0.0.0';
  }
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    timeout: 2000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).toString();
}

// The checkout's short commit, or null for a release tarball or a machine
// without git. Two devices on the same commit run the same code, which the
// release version alone cannot prove while a branch is ahead of its last tag.
function readCommit(root = ROOT) {
  try {
    if (!fs.existsSync(path.join(root, '.git'))) return null;
    const out = git(root, ['rev-parse', '--short=7', 'HEAD']).trim();
    return /^[0-9a-f]{4,40}$/.test(out) ? out : null;
  } catch (e) {
    return null;
  }
}

// Uncommitted edits to tracked files. A dirty checkout can differ from another
// device on the same commit, so its label carries a star.
function readDirty(root = ROOT) {
  try {
    if (!fs.existsSync(path.join(root, '.git'))) return false;
    return git(root, ['status', '--porcelain', '--untracked-files=no']).trim().length > 0;
  } catch (e) {
    return false;
  }
}

// "v0.2.0" for a release archive, "v0.2.0@2fef3aa" for a clean git checkout,
// "v0.2.0@2fef3aa*" when that checkout has uncommitted edits.
function label(version = readVersion(), commit = readCommit(), dirty = readDirty()) {
  if (!commit) return `v${version}`;
  return `v${version}@${commit}${dirty ? '*' : ''}`;
}

module.exports = { VERSION: readVersion(), COMMIT: readCommit(), DIRTY: readDirty(), readVersion, readCommit, readDirty, label };
