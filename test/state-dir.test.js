'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = require('../src/state-dir');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-state-dir-'));

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('state-dir: migrates missing legacy ~/.crew-board files into ~/.roostr without overwriting existing files', () => {
  const fakeHome = path.join(tmpRoot, 'home-migrate');
  const legacy = path.join(fakeHome, '.crew-board');
  const roostr = path.join(fakeHome, '.roostr');

  fs.mkdirSync(path.join(legacy, 'state', 'events'), { recursive: true });
  fs.mkdirSync(path.join(legacy, 'backups', 'ws1'), { recursive: true });
  fs.mkdirSync(roostr, { recursive: true });

  fs.writeFileSync(path.join(legacy, 'sessions.json'), JSON.stringify({ legacy: true }));
  fs.writeFileSync(path.join(legacy, 'daemon-state.json'), JSON.stringify({ panes: {} }));
  fs.writeFileSync(path.join(legacy, 'escalations.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(legacy, 'operator-hold.json'), JSON.stringify({ heldCount: 0 }));
  fs.writeFileSync(path.join(legacy, 'transitions.jsonl'), '{"pane":"w1:p1"}\n');
  fs.writeFileSync(path.join(legacy, 'state', 'events', 'w1_p1.json'), JSON.stringify({ status: 'working' }));
  fs.writeFileSync(path.join(legacy, 'backups', 'ws1', 'v1.json'), JSON.stringify({ version: 1 }));

  // Existing file in ~/.roostr/ must NOT be overwritten by legacy copy.
  fs.writeFileSync(path.join(legacy, 'names.json'), JSON.stringify({ names: ['legacy-name'] }));
  fs.writeFileSync(path.join(roostr, 'names.json'), JSON.stringify({ names: ['newer-roostr-name'] }));

  const first = stateDir.migrateLegacyDir({ homeDir: fakeHome });
  assert.ok(first.migrated.includes('sessions.json'));
  assert.ok(first.migrated.includes('daemon-state.json'));
  assert.ok(first.migrated.includes('escalations.json'));
  assert.ok(first.migrated.includes('operator-hold.json'));
  assert.ok(first.migrated.includes('transitions.jsonl'));
  assert.ok(first.migrated.includes('state'));
  assert.ok(first.migrated.includes('backups'));
  assert.ok(!first.migrated.includes('names.json'));

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(roostr, 'sessions.json'), 'utf8')), { legacy: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(roostr, 'names.json'), 'utf8')), { names: ['newer-roostr-name'] });
  assert.ok(fs.existsSync(path.join(roostr, 'state', 'events', 'w1_p1.json')));
  assert.ok(fs.existsSync(path.join(roostr, 'backups', 'ws1', 'v1.json')));

  // Idempotent on second call.
  const second = stateDir.migrateLegacyDir({ homeDir: fakeHome });
  assert.deepEqual(second.migrated, []);
});

test('state-dir: resolvePath returns ~/.roostr/<rel> and respects env overrides', () => {
  const fakeHome = path.join(tmpRoot, 'home-resolve');
  const resolved = stateDir.resolvePath('sessions.json', ['ROOSTR_TEST_NONE'], { homeDir: fakeHome });
  assert.equal(resolved, path.join(fakeHome, '.roostr', 'sessions.json'));

  const saved = process.env.ROOSTR_TEST_OVERRIDE;
  process.env.ROOSTR_TEST_OVERRIDE = path.join(tmpRoot, 'custom.json');
  try {
    assert.equal(
      stateDir.resolvePath('sessions.json', ['ROOSTR_TEST_OVERRIDE'], { homeDir: fakeHome }),
      path.join(tmpRoot, 'custom.json')
    );
  } finally {
    if (saved === undefined) delete process.env.ROOSTR_TEST_OVERRIDE;
    else process.env.ROOSTR_TEST_OVERRIDE = saved;
  }
});
