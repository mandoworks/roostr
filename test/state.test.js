'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const state = require('../src/state');

const posix = process.platform !== 'win32';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-state-'));
}

test('state: writeJson creates the parent at 0700 and the file at 0600', { skip: !posix }, () => {
  const root = tempDir();
  const file = path.join(root, 'nested', 'deeper', 'pane.json');
  try {
    state.writeJson(file, { pane: 'w1:p2' });
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { pane: 'w1:p2' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('state: writeJson renames a complete temp file into place', () => {
  const root = tempDir();
  const file = path.join(root, 'pane.json');
  const realRename = fs.renameSync;
  let seen = null;
  fs.renameSync = (from, to) => {
    seen = { from, to, data: JSON.parse(fs.readFileSync(from, 'utf8')) };
    realRename(from, to);
  };
  try {
    state.writeJson(file, { a: 1 });
  } finally {
    fs.renameSync = realRename;
  }
  try {
    assert.ok(seen, 'writeJson should rename a temp file');
    assert.equal(seen.to, file);
    assert.deepEqual(seen.data, { a: 1 });
    assert.equal(fs.existsSync(seen.from), false);
    assert.deepEqual(fs.readdirSync(root).filter((f) => f.endsWith('.tmp')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('state: eventFile rejects traversal and paneFile stays inside the state dir', () => {
  const root = tempDir();
  const prev = process.env.CREW_BOARD_STATE_DIR;
  process.env.CREW_BOARD_STATE_DIR = root;
  try {
    assert.throws(() => state.eventFile('../x'), /bad pane id/);
    assert.throws(() => state.eventFile('w1:p2:extra'), /bad pane id/);
    const p = state.paneFile('w1:p2');
    assert.equal(path.dirname(path.resolve(p)), path.resolve(root));
    assert.ok(!p.includes('..'));
  } finally {
    if (prev === undefined) delete process.env.CREW_BOARD_STATE_DIR;
    else process.env.CREW_BOARD_STATE_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
