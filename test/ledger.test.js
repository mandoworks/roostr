'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ledger = require('../src/ledger');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-ledger-'));
process.env.CREW_BOARD_LEDGER = path.join(tmpRoot, 'none.jsonl');
process.env.CREW_BOARD_SUMMARY = path.join(tmpRoot, 'missing-summary.json');
process.env.CREW_BOARD_MODELS = path.join(tmpRoot, 'missing-models.json');

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function withLedger(file, fn) {
  const saved = process.env.CREW_BOARD_LEDGER;
  process.env.CREW_BOARD_LEDGER = file;
  try {
    return fn();
  } finally {
    process.env.CREW_BOARD_LEDGER = saved;
  }
}

test('ledger: append and read entries, mode 0600, directory 0700', () => {
  const file = path.join(tmpRoot, 'state', 'orchestration.jsonl');
  withLedger(file, () => {
    ledger.append({ at: '2026-11-01T00:00:00.000Z', event: 'spawn', runId: 'r1' }, file);
    ledger.append({ at: '2026-11-01T00:01:00.000Z', event: 'outcome', runId: 'r1', outcome: 'pass' }, file);
    const entries = ledger.readEntries(file);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].runId, 'r1');
    assert.equal(entries[1].event, 'outcome');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  });
});

test('ledger: a missing file reads as empty', () => {
  assert.deepEqual(ledger.readEntries(path.join(tmpRoot, 'missing.jsonl')), []);
});

test('ledger: a malformed line is skipped, not fatal', () => {
  const file = path.join(tmpRoot, 'malformed.jsonl');
  fs.writeFileSync(file, 'not json\n{"event":"spawn","runId":"ok"}\n\n[1,2]\n');
  assert.deepEqual(ledger.readEntries(file), [{ event: 'spawn', runId: 'ok' }]);
});

test('ledger: spawn fills the recommendation and outcome joins by run id', () => {
  const file = path.join(tmpRoot, 'join.jsonl');
  withLedger(file, () => {
    const { entry: spawnEntry } = ledger.spawn({ paneId: 'w1:p2', task: 'fix the login timeout' }, file);
    assert.ok(spawnEntry.runId);
    assert.equal(spawnEntry.event, 'spawn');
    assert.equal(spawnEntry.kind, 'feature');
    assert.equal(spawnEntry.tier, 'balanced');
    assert.equal(spawnEntry.effort, 'medium');
    assert.equal(spawnEntry.model, null);
    assert.equal(spawnEntry.recommendedTier, 'balanced');
    assert.equal(spawnEntry.outcome, null);

    const out = ledger.outcome({
      runId: spawnEntry.runId,
      result: 'pass',
      rework: '1',
      cost: '0.42',
      note: 'tests green',
    }, file);
    assert.equal(out.outcome, 'pass');
    assert.equal(out.rework, 1);
    assert.equal(out.cost, 0.42);
    assert.equal(out.note, 'tests green');
    assert.ok(Number.isFinite(out.durationMs));

    const entries = ledger.readEntries(file);
    assert.equal(entries.length, 2);
    assert.equal(entries[1].runId, spawnEntry.runId);
  });
});

test('ledger: unknown run id and duplicate outcomes are refused', () => {
  const file = path.join(tmpRoot, 'dupes.jsonl');
  withLedger(file, () => {
    assert.throws(() => ledger.outcome({ runId: 'nope', result: 'pass' }, file), /unknown run id/);
    const { entry } = ledger.spawn({ paneId: 'w1:p2', task: 'format markdown files' }, file);
    ledger.outcome({ runId: entry.runId, result: 'pass' }, file);
    assert.throws(() => ledger.outcome({ runId: entry.runId, result: 'fail' }, file), /already has an outcome/);
  });
});

test('ledger: spawn and outcome validate inputs', () => {
  const file = path.join(tmpRoot, 'validation.jsonl');
  withLedger(file, () => {
    assert.throws(() => ledger.spawn({ task: 'no pane' }, file), /pane id is required/);
    assert.throws(() => ledger.spawn({ paneId: 'w1:p2' }, file), /task is required/);
    assert.throws(() => ledger.spawn({ paneId: 'w1:p2', task: 'x', tier: 'turbo' }, file), /unknown tier/);
    assert.throws(() => ledger.spawn({ paneId: 'w1:p2', task: 'x', effort: 'max' }, file), /unknown effort/);
  });
});

test('ledger: spawn main prints a run id and writes one entry', () => {
  const file = path.join(tmpRoot, 'cli-spawn.jsonl');
  withLedger(file, () => {
    const savedLog = console.log;
    const logs = [];
    console.log = (msg) => logs.push(msg);
    try {
      const code = ledger.main(['spawn', '--pane', 'w1:p2', '--task', 'fix the login timeout']);
      assert.equal(code, 0);
    } finally {
      console.log = savedLog;
    }
    assert.ok(logs[0].includes('run:'));
    assert.ok(logs[0].includes('tier:'));
    const entries = ledger.readEntries(file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, 'spawn');
    assert.equal(entries[0].paneId, 'w1:p2');
  });
});

test('ledger: outcome main accepts the documented flags', () => {
  const file = path.join(tmpRoot, 'cli-outcome.jsonl');
  withLedger(file, () => {
    const { entry } = ledger.spawn({ paneId: 'w1:p2', task: 'format markdown files' }, file);
    const savedLog = console.log;
    console.log = () => {};
    try {
      const code = ledger.main(['outcome', '--run', entry.runId, '--result', 'pass', '--rework', '0', '--cost', '0.1', '--note', 'done']);
      assert.equal(code, 0);
    } finally {
      console.log = savedLog;
    }
    const out = ledger.readEntries(file).find((e) => e.event === 'outcome');
    assert.equal(out.outcome, 'pass');
    assert.equal(out.cost, 0.1);
    assert.equal(out.note, 'done');
  });
});

test('ledger: spawn main reports usage when required flags are missing', () => {
  const file = path.join(tmpRoot, 'cli-usage.jsonl');
  withLedger(file, () => {
    const savedErr = console.error;
    console.error = () => {};
    try {
      assert.equal(ledger.main(['spawn', '--pane', 'w1:p2']), 2);
    } finally {
      console.error = savedErr;
    }
  });
});

test('ledger: a read only state dir fails clearly', { skip: process.getuid && process.getuid() === 0 }, () => {
  const dir = path.join(tmpRoot, 'readonly');
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o500);
  const file = path.join(dir, 'orchestration.jsonl');
  try {
    assert.throws(() => ledger.spawn({ paneId: 'w1:p2', task: 'fix it' }, file));
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});
