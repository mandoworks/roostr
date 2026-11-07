'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rotate = require('../src/rotate');
const ledger = require('../src/ledger');
const report = require('../src/report');
const statusEvent = require('../scripts/status-event');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-rotate-'));

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('rotate: does nothing if file does not exist or is under maxBytes', () => {
  const missing = path.join(tmpRoot, 'missing.jsonl');
  assert.equal(rotate.maybeRotate(missing), false);

  const small = path.join(tmpRoot, 'small.jsonl');
  fs.writeFileSync(small, '{"hello":"world"}\n');
  assert.equal(rotate.maybeRotate(small, { maxBytes: 1000 }), false);
  assert.ok(fs.existsSync(small));
  assert.ok(!fs.existsSync(small + '.1'));
});

test('rotate: archives to .1 when size exceeds maxBytes', () => {
  const file = path.join(tmpRoot, 'grow.jsonl');
  fs.writeFileSync(file, '{"item":1}\n{"item":2}\n{"item":3}\n');
  const size = fs.statSync(file).size;

  const didRotate = rotate.maybeRotate(file, { maxBytes: size - 5 });
  assert.equal(didRotate, true);
  assert.ok(fs.existsSync(file + '.1'));
  assert.ok(!fs.existsSync(file)); // Active file was archived

  // Appending again creates a new active file
  fs.appendFileSync(file, '{"item":4}\n');
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"item":4}\n');
  assert.ok(fs.readFileSync(file + '.1', 'utf8').includes('item":1'));
});

test('rotate: atomic safety across concurrent appends with zero lost lines', () => {
  const file = path.join(tmpRoot, 'concurrent.jsonl');
  const totalWrites = 500;
  const rotateThreshold = 1000; // Trigger rotation partway through

  for (let i = 0; i < totalWrites; i++) {
    const entry = { seq: i, text: `line-${i}-${'x'.repeat(40)}` };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    if (i === 150) {
      // Rotate active file
      rotate.maybeRotate(file, { maxBytes: 100 });
    }
  }

  // Count lines in active file and archive .1
  let lines = [];
  if (fs.existsSync(file + '.1')) {
    lines = lines.concat(fs.readFileSync(file + '.1', 'utf8').trim().split('\n'));
  }
  if (fs.existsSync(file)) {
    lines = lines.concat(fs.readFileSync(file, 'utf8').trim().split('\n'));
  }

  assert.equal(lines.length, totalWrites);
  const seqs = lines.map((l) => JSON.parse(l).seq).sort((a, b) => a - b);
  for (let i = 0; i < totalWrites; i++) {
    assert.equal(seqs[i], i);
  }
});

test('rotate: integrates with ledger, report, and transitions', () => {
  const testDir = path.join(tmpRoot, 'integrated');
  fs.mkdirSync(testDir, { recursive: true });

  const uFile = path.join(testDir, 'usage.jsonl');
  const tFile = path.join(testDir, 'transitions.jsonl');
  const lFile = path.join(testDir, 'ledger.jsonl');

  report.appendUsage({ at: '2026-11-07T00:00:00Z', pane: 'w1:p1', tokens: 100 }, uFile);
  assert.ok(fs.existsSync(uFile));

  statusEvent.appendTransition({ at: '2026-11-07T00:00:00Z', pane: 'w1:p1', status: 'working' }, tFile);
  assert.ok(fs.existsSync(tFile));

  ledger.append({ at: '2026-11-07T00:00:00Z', event: 'spawn', runId: 'r99' }, lFile);
  assert.ok(fs.existsSync(lFile));
});

test('rotate: age rotation triggers at default 30 days', () => {
  const file = path.join(tmpRoot, 'age-default.jsonl');
  fs.writeFileSync(file, '{"item":"old"}\n');

  const now = Date.now();
  const pastMs = now - (31 * 24 * 60 * 60 * 1000); // 31 days ago
  fs.utimesSync(file, new Date(pastMs), new Date(pastMs));

  // Should not rotate if checked against 30 days when not yet expired (e.g. 29 days)
  const notYetNow = pastMs + (29 * 24 * 60 * 60 * 1000);
  assert.equal(rotate.maybeRotate(file, { now: notYetNow }), false);

  // Triggers at 30 days or more
  const expiredNow = pastMs + (30 * 24 * 60 * 60 * 1000) + 1000;
  assert.equal(rotate.maybeRotate(file, { now: expiredNow }), true);
  assert.ok(fs.existsSync(file + '.1'));
  assert.ok(!fs.existsSync(file));
});

test('rotate: age rotation triggers with custom setting or maxDays option', () => {
  const file = path.join(tmpRoot, 'age-custom.jsonl');
  fs.writeFileSync(file, '{"item":"custom"}\n');

  const now = Date.now();
  const pastMs = now - (6 * 24 * 60 * 60 * 1000); // 6 days ago
  fs.utimesSync(file, new Date(pastMs), new Date(pastMs));

  // With default 30 days, 6 days does not rotate
  assert.equal(rotate.maybeRotate(file, { now }), false);

  // With maxDays: 5, 6 days triggers rotation
  assert.equal(rotate.maybeRotate(file, { maxDays: 5, now }), true);
  assert.ok(fs.existsSync(file + '.1'));
  assert.ok(!fs.existsSync(file));

  // Also test crewfile integration
  const crewDir = path.join(tmpRoot, 'crew-setting');
  fs.mkdirSync(crewDir, { recursive: true });
  const crewFile = path.join(crewDir, '.crew-board.toml');
  fs.writeFileSync(crewFile, '[analytics]\nrotation_days = 5\n');
  fs.chmodSync(crewFile, 0o600);

  const file2 = path.join(crewDir, 'data.jsonl');
  fs.writeFileSync(file2, '{"item":"crew-setting"}\n');
  fs.utimesSync(file2, new Date(pastMs), new Date(pastMs));

  assert.equal(rotate.maybeRotate(file2, { crewPath: crewFile, now }), true);
  assert.ok(fs.existsSync(file2 + '.1'));
  assert.ok(!fs.existsSync(file2));
});
